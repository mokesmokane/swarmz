package dev.swarmz.phone.ui.dictation

import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

open class FakeRecognizer : Recognizer {
    var listener: Recognizer.Listener? = null
    var language: String? = "unset"
    val calls = mutableListOf<String>()
    /** Like SpeechRecognizer: a stopped session that was never cancelled may still deliver a result. */
    var lateResult: String? = null
    private var stoppedLive = false
    override fun start(language: String?, listener: Recognizer.Listener) {
        calls += "start"
        this.language = language
        this.listener = listener
        val late = lateResult
        if (stoppedLive && late != null) listener.onFinal(late) // the old result reaches the new listener
        stoppedLive = false
    }
    override fun stop() { calls += "stop"; stoppedLive = true }
    override fun cancel() { calls += "cancel"; stoppedLive = false }
    override fun release() { calls += "release" }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DictationTest {
    private val rec = FakeRecognizer()
    private val d = Dictation(rec, { "en-GB" }, cancelDistancePx = 100f)
    private val field = mutableStateOf(TextFieldValue("please ", TextRange(7)))

    @Test
    fun partialsShowWhileHoldingAndTheFinalTextIsInserted() {
        d.begin(field)
        assertEquals("en-GB", rec.language)
        rec.listener!!.onPartial("run the")
        assertEquals("please run the", field.value.text)
        d.end()
        assertEquals(listOf("start", "stop"), rec.calls)
        rec.listener!!.onFinal("run the tests")
        assertEquals(TextFieldValue("please run the tests", TextRange(20)), field.value)
        assertEquals(Talk.Idle, d.talk.value)
    }

    @Test
    fun slidingUpCancelsAndRestoresTheField() {
        d.begin(field)
        rec.listener!!.onPartial("oops")
        d.drag(-120f)
        d.end()
        assertEquals(listOf("start", "cancel"), rec.calls)
        assertEquals("please ", field.value.text)
        assertEquals(Talk.Idle, d.talk.value)
    }

    @Test
    fun noFinalResultFallsBackToTheLastPartial() {
        d.begin(field)
        rec.listener!!.onPartial("almost")
        d.end()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
        assertEquals("please almost", field.value.text)
        assertEquals(Talk.Idle, d.talk.value)
        assertNull(d.message.value)
    }

    @Test
    fun errorsAreReportedExceptNoMatch() {
        d.begin(field)
        rec.listener!!.onError(7)
        assertNull(d.message.value)
        assertEquals("please ", field.value.text)
        d.begin(field)
        rec.listener!!.onError(2)
        assertEquals("Dictation failed (code 2)", d.message.value)
    }

    @Test
    fun aMissingRecognizerIsReportedInsteadOfListening() {
        val none = object : FakeRecognizer() {
            override fun available() = false
        }
        val d = Dictation(none, { null })
        d.begin(field)
        assertTrue(none.calls.isEmpty())
        assertEquals("Speech recognition isn't available on this phone", d.message.value)
        assertEquals(Talk.Idle, d.talk.value)
        d.end()
        assertEquals("please ", field.value.text)
    }

    @Test
    fun lateResultsAfterReleasingTheRecognizerAreIgnored() {
        d.begin(field)
        val stale = rec.listener!!
        d.release()
        assertEquals(listOf("start", "release"), rec.calls)
        stale.onFinal("too late")
        assertEquals("please ", field.value.text)
        assertEquals(Talk.Idle, d.talk.value)
    }

    @Test
    fun theTimeoutCancelsTheRecognizerSoNoOldResultLeaksIntoTheNextHold() {
        rec.lateResult = "stale words"
        d.begin(field)
        rec.listener!!.onPartial("almost")
        d.end()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
        assertEquals(listOf("start", "stop", "cancel"), rec.calls)
        assertEquals("please almost", field.value.text)
        d.begin(field)
        assertEquals(Talk.Listening("", cancelling = false), d.talk.value)
        assertEquals("please almost", field.value.text)
        rec.listener!!.onFinal("fresh")
        assertEquals("please almost fresh", field.value.text)
    }

    @Test
    fun speechTimeoutShowsNoMessage() {
        d.begin(field)
        rec.listener!!.onPartial("half")
        rec.listener!!.onError(6)
        assertNull(d.message.value)
        assertEquals("please half", field.value.text)
        assertEquals(Talk.Idle, d.talk.value)
    }

    @Test
    fun onlyTheGestureThatStartedAHoldCanMoveOrEndIt() {
        val first = d.begin(field)
        val other = mutableStateOf(TextFieldValue("other"))
        assertNull(d.begin(other))
        rec.listener!!.onPartial("mine")
        d.drag(-500f, token = first!! + 1)
        d.end(token = first + 1)
        d.cancel(token = first + 1)
        assertEquals(Talk.Listening("mine", cancelling = false), d.talk.value)
        assertEquals(listOf("start"), rec.calls)
        d.end(first)
        assertEquals(listOf("start", "stop"), rec.calls)
        assertEquals("other", other.value.text)
    }

    @Test
    fun aSystemCancelRestoresTheFieldWithoutInserting() {
        val token = d.begin(field)!!
        rec.listener!!.onPartial("never")
        d.cancel(token)
        assertEquals(listOf("start", "cancel"), rec.calls)
        assertEquals("please ", field.value.text)
        assertEquals(Talk.Idle, d.talk.value)
        rec.listener!!.onFinal("never mind")
        assertEquals("please ", field.value.text)
    }

    @Test
    fun pressingWhileFinishingInsertsTheLastPartialAndStartsAgain() {
        d.begin(field)
        rec.listener!!.onPartial("first")
        d.end()
        assertEquals(Talk.Finishing, d.talk.value)
        val old = rec.listener!!
        d.begin(field)
        assertEquals(listOf("start", "stop", "cancel", "start"), rec.calls)
        assertEquals("please first", field.value.text)
        assertEquals(Talk.Listening("", cancelling = false), d.talk.value)
        old.onFinal("first words")
        rec.listener!!.onPartial("second")
        assertEquals("please first second", field.value.text)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
        assertEquals(Talk.Listening("second", cancelling = false), d.talk.value)
    }

    @Test
    fun aDeniedMicPermissionSaysWhereToTurnItOn() {
        onMicPermissionResult(d, granted = true)
        assertNull(d.message.value)
        onMicPermissionResult(d, granted = false)
        assertEquals("Microphone permission is off. Turn it on in Android Settings", d.message.value)
        assertEquals(MIC_PERMISSION_MESSAGE, d.message.value)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(6))
        assertNull(d.message.value)
    }
}
