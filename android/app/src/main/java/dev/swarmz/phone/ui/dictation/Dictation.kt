package dev.swarmz.phone.ui.dictation

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import dev.swarmz.phone.ui.components.MicSlot
import dev.swarmz.phone.ui.theme.Sw

/** Speech to text. Every call happens on the main thread. */
interface Recognizer {
    fun start(language: String?, listener: Listener)
    fun stop()
    fun cancel()

    /** False when the phone has no speech recognition service. */
    fun available(): Boolean = true

    /** Frees the recognizer; a later [start] may create a new one. */
    fun release() {}

    interface Listener {
        fun onPartial(text: String)
        fun onFinal(text: String)
        fun onLevel(rms: Float)
        fun onError(code: Int)
    }
}

/** Wraps [SpeechRecognizer], created lazily on the first [start] (the main thread). */
class AndroidRecognizer(private val context: Context) : Recognizer {
    private var sr: SpeechRecognizer? = null

    override fun start(language: String?, listener: Recognizer.Listener) {
        val r = sr ?: SpeechRecognizer.createSpeechRecognizer(context).also { sr = it }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) = listener.onLevel(rmsdB)
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) = listener.onError(error)
            override fun onResults(results: Bundle?) =
                listener.onFinal(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
            override fun onPartialResults(partialResults: Bundle?) {
                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(listener::onPartial)
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            if (language != null) putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        }
        r.startListening(intent)
    }

    override fun stop() {
        sr?.stopListening()
    }

    override fun cancel() {
        sr?.cancel()
    }

    override fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    override fun release() {
        sr?.destroy()
        sr = null
    }
}

private const val ERROR_SPEECH_TIMEOUT = 6
private const val ERROR_NO_MATCH = 7
private const val FINAL_TIMEOUT_MS = 3_000L
private const val MESSAGE_MS = 5_000L
const val NO_RECOGNIZER_MESSAGE = "Speech recognition isn't available on this phone"

/**
 * Hold-to-talk into a text field. It only ever edits the field: it has no way to send.
 */
class Dictation(
    private val recognizer: Recognizer,
    private val language: () -> String?,
    cancelDistancePx: Float = 160f,
) {
    private val machine = HoldToTalk(cancelDistancePx)
    private val handler = Handler(Looper.getMainLooper())
    private val _talk = mutableStateOf<Talk>(Talk.Idle)
    val talk: State<Talk> = _talk
    private val _level = mutableFloatStateOf(0f)
    val level: State<Float> = _level
    private val _message = mutableStateOf<String?>(null)
    val message: State<String?> = _message

    private var target: MutableState<TextFieldValue>? = null
    private var base: TextFieldValue = TextFieldValue("")
    private var lastPartial = ""
    private var session = 0
    private val timeout = Runnable { complete(lastPartial) }
    private val clearMessage = Runnable { _message.value = null }

    private fun sync() {
        _talk.value = machine.state
    }

    private fun show(message: String) {
        handler.removeCallbacks(clearMessage)
        _message.value = message
        handler.postDelayed(clearMessage, MESSAGE_MS)
    }

    fun begin(target: MutableState<TextFieldValue>) {
        if (machine.state != Talk.Idle) return
        handler.removeCallbacks(clearMessage)
        _message.value = null
        if (!recognizer.available()) {
            show(NO_RECOGNIZER_MESSAGE)
            return
        }
        this.target = target
        base = target.value
        lastPartial = ""
        val mine = ++session
        machine.press()
        sync()
        recognizer.start(language(), object : Recognizer.Listener {
            override fun onPartial(text: String) {
                if (mine != session || machine.state !is Talk.Listening) return
                lastPartial = text
                machine.partial(text)
                sync()
                target.value = insertAt(base, text)
            }

            override fun onFinal(text: String) {
                if (mine != session) return
                complete(text.ifBlank { lastPartial })
            }

            override fun onLevel(rms: Float) {
                if (mine == session) _level.floatValue = rms
            }

            override fun onError(code: Int) {
                if (mine != session) return
                if (code != ERROR_NO_MATCH && code != ERROR_SPEECH_TIMEOUT) show("Dictation failed (code $code)")
                complete(lastPartial)
            }
        })
    }

    fun drag(totalDy: Float) {
        machine.drag(totalDy)
        sync()
    }

    fun end() {
        if (machine.state !is Talk.Listening) return
        if (machine.release()) {
            sync()
            recognizer.stop()
            handler.postDelayed(timeout, FINAL_TIMEOUT_MS)
        } else {
            session++
            recognizer.cancel()
            target?.value = base
            target = null
            sync()
            _level.floatValue = 0f
        }
    }

    /** Ends any hold without inserting and frees the recognizer. */
    fun release() {
        handler.removeCallbacks(timeout)
        handler.removeCallbacks(clearMessage)
        session++
        if (machine.state != Talk.Idle) {
            target?.value = base
            machine.finish()
            sync()
        }
        target = null
        _level.floatValue = 0f
        recognizer.release()
    }

    private fun complete(text: String) {
        handler.removeCallbacks(timeout)
        if (machine.state == Talk.Idle) return
        target?.value = if (text.isBlank()) base else insertAt(base, text)
        target = null
        session++
        machine.finish()
        sync()
        _level.floatValue = 0f
    }
}

/** The round mic: press and hold to talk, slide up to cancel. */
class DictationMic(
    private val dictation: Dictation,
    private val hasPermission: () -> Boolean,
    private val requestPermission: () -> Unit,
) : MicSlot {
    @Composable
    override fun Content(target: MutableState<TextFieldValue>, modifier: Modifier) {
        Box(
            modifier
                .semantics { contentDescription = "Hold to talk" }
                .pointerInput(target) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        if (!hasPermission()) {
                            requestPermission()
                            return@awaitEachGesture
                        }
                        down.consume()
                        dictation.begin(target)
                        // finally: a gesture cancelled mid-hold (the mic leaving composition) still ends.
                        try {
                            var dy = 0f
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                dy += change.positionChange().y
                                change.consume()
                                dictation.drag(dy)
                                if (!change.pressed) break
                            }
                        } finally {
                            dictation.end()
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Mic, contentDescription = null, tint = Sw.Title)
        }
    }
}
