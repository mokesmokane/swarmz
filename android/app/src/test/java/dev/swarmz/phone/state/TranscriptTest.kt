package dev.swarmz.phone.state

import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.proto.ToolView
import dev.swarmz.phone.proto.TranscriptEvent
import dev.swarmz.phone.proto.TranscriptPage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun m(id: String, text: String = id, tools: List<ToolView> = emptyList()) = Message(id = id, role = "assistant", text = text, tools = tools)

    @Test
    fun firstPageThenFollow() {
        var s = TranscriptState().apply(TranscriptEvent.First(TranscriptPage(listOf(m("a"), m("b")), hasMore = true)))
        assertTrue(s.loaded)
        assertTrue(s.hasMore)
        assertEquals("b", s.lastId)
        assertEquals("a", s.oldestId)
        s = s.apply(TranscriptEvent.New(m("c")))
        s = s.apply(TranscriptEvent.Update(m("c", tools = listOf(ToolView("Bash", "Ran ls", true)))))
        assertEquals(listOf("a", "b", "c"), s.messages.map { it.id })
        assertEquals("Ran ls", s.messages[2].tools[0].summary)
        // An update for a message we have not seen is added.
        s = s.apply(TranscriptEvent.Update(m("d")))
        assertEquals("d", s.lastId)
    }

    @Test
    fun resumingAfterAnIdReplacesThatMessage() {
        var s = TranscriptState().apply(TranscriptEvent.First(TranscriptPage(listOf(m("a"), m("b", "old")))))
        // `--after b` returns b (possibly changed) and newer messages.
        s = s.apply(TranscriptEvent.First(TranscriptPage(listOf(m("b", "new"), m("c")))))
        assertEquals(listOf("a", "b", "c"), s.messages.map { it.id })
        assertEquals("new", s.messages[1].text)
    }

    @Test
    fun sessionSwitchClears() {
        var s = TranscriptState().apply(TranscriptEvent.First(TranscriptPage(listOf(m("a")), hasMore = true)))
        s = s.apply(TranscriptEvent.Session("s2"))
        assertTrue(s.messages.isEmpty())
        assertFalse(s.hasMore)
        assertNull(s.lastId)
    }

    @Test
    fun olderPagesPrepend() {
        var s = TranscriptState().apply(TranscriptEvent.First(TranscriptPage(listOf(m("c"), m("d")), hasMore = true)))
        s = s.withOlder(TranscriptPage(listOf(m("a"), m("b"), m("c")), hasMore = false))
        assertEquals(listOf("a", "b", "c", "d"), s.messages.map { it.id })
        assertFalse(s.hasMore)
    }
}
