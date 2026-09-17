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
    override fun start(language: String?, listener: Recognizer.Listener) {
        calls += "start"
        this.language = language
        this.listener = listener
    }
    override fun stop() { calls += "stop" }
    override fun cancel() { calls += "cancel" }
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
}
