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
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
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
            // Discourage ending on a pause while the finger is still down (recognizers may ignore these).
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
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
private const val SILENCE_MS = 5_000L
const val NO_RECOGNIZER_MESSAGE = "Speech recognition isn't available on this phone"

/**
 * Hold-to-talk into a text field. It only ever edits the field: it has no way to send.
 *
 * Each [begin] that starts listening returns a hold token; only that gesture may [drag], [end] or
 * [cancel] it (the no-argument forms act on the latest hold). A press while the previous hold is
 * still finishing inserts that hold's last partial, cancels its recognition and starts afresh.
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
    private var hold = 0
    private val timeout = Runnable {
        // The recognizer is still busy with this session: stop it before a late result can reach
        // the next session's listener.
        recognizer.cancel()
        complete(lastPartial)
    }
    private val clearMessage = Runnable { _message.value = null }

    private fun sync() {
        _talk.value = machine.state
    }

    private fun show(message: String) {
        handler.removeCallbacks(clearMessage)
        _message.value = message
        handler.postDelayed(clearMessage, MESSAGE_MS)
    }

    /** Starts a hold on [target]. Returns its token, or null when this press started nothing. */
    fun begin(target: MutableState<TextFieldValue>): Int? {
        if (machine.state is Talk.Listening) return null
        if (machine.state == Talk.Finishing) {
            handler.removeCallbacks(timeout)
            recognizer.cancel()
            complete(lastPartial)
        }
        handler.removeCallbacks(clearMessage)
        _message.value = null
        if (!recognizer.available()) {
            show(NO_RECOGNIZER_MESSAGE)
            return null
        }
        this.target = target
        base = target.value
        lastPartial = ""
        val mine = ++session
        val token = ++hold
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
        return token
    }

    fun drag(totalDy: Float, token: Int = hold) {
        if (token != hold) return
        machine.drag(totalDy)
        sync()
    }

    /** The finger lifted: insert, or cancel when it was past the cancel line. */
    fun end(token: Int = hold) {
        if (token != hold || machine.state !is Talk.Listening) return
        if (machine.release()) {
            sync()
            recognizer.stop()
            handler.postDelayed(timeout, FINAL_TIMEOUT_MS)
        } else {
            abandon()
        }
    }

    /** The gesture was taken away (system cancel, mic left composition): restore, never insert. */
    fun cancel(token: Int = hold) {
        if (token != hold || machine.state !is Talk.Listening) return
        machine.finish()
        abandon()
    }

    private fun abandon() {
        session++
        recognizer.cancel()
        target?.value = base
        target = null
        sync()
        _level.floatValue = 0f
    }

    /** Ends any hold without inserting and frees the recognizer. */
    fun release() {
        handler.removeCallbacks(timeout)
        handler.removeCallbacks(clearMessage)
        session++
        hold++
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

/** Consumes [id]'s events until it lifts or is cancelled. */
private suspend fun AwaitPointerEventScope.consumeUntilUp(id: PointerId) {
    while (true) {
        val change = awaitPointerEvent().changes.firstOrNull { it.id == id } ?: return
        change.consume()
        if (!change.pressed) return
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
                        // Every path consumes the whole gesture so a clickable parent never sees a tap.
                        down.consume()
                        if (!hasPermission()) {
                            requestPermission()
                            consumeUntilUp(down.id)
                            return@awaitEachGesture
                        }
                        val token = dictation.begin(target)
                        if (token == null) {
                            // Another mic owns the hold (or there is no recognizer): stay out of it.
                            consumeUntilUp(down.id)
                            return@awaitEachGesture
                        }
                        var finished = false
                        try {
                            var dy = 0f
                            while (true) {
                                val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) {
                                    // A release that arrives already consumed is a system cancel.
                                    if (!change.isConsumed) {
                                        change.consume()
                                        finished = true
                                    }
                                    break
                                }
                                dy += change.positionChange().y
                                change.consume()
                                dictation.drag(dy, token)
                            }
                        } finally {
                            // Mic left composition, or the pointer was cancelled: never insert.
                            if (finished) dictation.end(token) else dictation.cancel(token)
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Mic, contentDescription = null, tint = Sw.Title)
        }
    }
}
