package dev.swarmz.phone.ui.dictation

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HoldToTalkTest {
    @Test
    fun insertingAtTheCursorAddsSpacesOnlyWhereNeeded() {
        assertEquals(TextFieldValue("hello world", TextRange(11)), insertAt(TextFieldValue("hello", TextRange(5)), "world"))
        assertEquals(TextFieldValue("say hi there", TextRange(6)), insertAt(TextFieldValue("say there", TextRange(4)), "hi"))
        assertEquals(TextFieldValue("fix it", TextRange(6)), insertAt(TextFieldValue("fix bug", TextRange(4, 7)), "it"))
        assertEquals(TextFieldValue("go", TextRange(2)), insertAt(TextFieldValue("", TextRange(0)), "go"))
        assertEquals(TextFieldValue("x", TextRange(1)), insertAt(TextFieldValue("x", TextRange(1)), ""))
    }

    @Test
    fun holdSlideAndRelease() {
        val h = HoldToTalk(cancelDistancePx = 100f)
        h.press()
        h.partial("hel")
        assertEquals(Talk.Listening("hel", cancelling = false), h.state)
        h.drag(-150f)
        assertEquals(Talk.Listening("hel", cancelling = true), h.state)
        h.drag(-20f)
        assertTrue(h.release())
        assertEquals(Talk.Finishing, h.state)
        h.finish()
        assertEquals(Talk.Idle, h.state)
        h.press()
        h.drag(-101f)
        assertFalse(h.release())
        assertEquals(Talk.Idle, h.state)
    }
}
