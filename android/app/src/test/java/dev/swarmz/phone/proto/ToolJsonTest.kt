package dev.swarmz.phone.proto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ToolJsonTest {
    private fun fixture(name: String): String =
        javaClass.getResource("/fixtures/$name")!!.readText()

    @Test
    fun tileListDecodes() {
        val list = ToolJson.decode<TileList>(fixture("ls.json"))
        assertEquals(2, list.tiles.size)
        val api = list.tiles[0]
        assertEquals("permission", api.needs)
        assertEquals("npm test", api.summary)
        assertEquals("acceptEdits", api.mode)
        assertTrue(api.running)
        assertEquals(2, list.tiles[1].exitCode)
        assertEquals("shell", list.tiles[1].kind)
    }

    @Test
    fun toolErrorsBecomeFailures() {
        try {
            ToolJson.decode<PendingReply>(fixture("error-old-session.json"))
            fail("expected a ToolFailure")
        } catch (e: ToolFailure) {
            assertEquals("old_session", e.code)
            assertEquals("restart this tile to use it from the phone", e.message)
        }
    }

    @Test
    fun simpleReplies() {
        assertEquals("Bash command", ToolJson.decode<PendingReply>(fixture("pending.json")).pending!!.tool)
        assertEquals(3, ToolJson.decode<PendingReply>(fixture("pending.json")).pending!!.options.size)
        assertNull(ToolJson.decode<PendingReply>(fixture("pending-null.json")).pending)
        assertEquals(1, ToolJson.decode<AnswerReply>(fixture("answer.json")).option!!.n)
        val ignored = ToolJson.decode<AnswerReply>(fixture("answer-ignored.json"))
        assertTrue(ignored.ignored)
        assertFalse(ignored.answered)
        val machines = ToolJson.decode<MachineList>(fixture("machines.json")).machines
        assertTrue(machines[0].isSelf)
        assertEquals("Studio", machines[1].alias)
        assertEquals(false, machines[1].online)
        assertEquals(listOf("api", "web"), ToolJson.decode<Folders>(fixture("folders.json")).dirs)
        assertEquals(1, ToolJson.decode<Version>(fixture("version.json")).protocol)
        val add = ToolJson.decode<PhoneAddReply>(fixture("phone-add.json"))
        assertTrue(add.added)
        assertEquals("not reachable", add.machines[1].error)
        assertEquals("api-2", ToolJson.decode<TileReply>(fixture("new.json")).tile.name)
    }

    @Test
    fun transcriptPageDecodes() {
        val page = ToolJson.decode<TranscriptPage>(fixture("transcript.json"))
        assertTrue(page.hasMore)
        assertEquals("Ran mkdir", page.messages[1].tools[0].summary)
        assertEquals("image/png", page.messages[2].images[0].mime)
    }

    @Test
    fun watchStream() {
        val events = fixture("watch.jsonl").lines().filter { it.isNotBlank() }.map { ToolJson.watchEvent(it) }
        assertEquals(1, (events[0] as WatchEvent.Snapshot).tiles.size)
        assertEquals("working", (events[1] as WatchEvent.Tile).tile.status)
        assertEquals(WatchEvent.Ping, events[2])
        assertEquals("t1", (events[3] as WatchEvent.Gone).id)
        assertNull(ToolJson.watchEvent("""{"type":"future-kind","v":1}"""))
    }

    @Test
    fun transcriptStream() {
        val events = fixture("transcript-follow.jsonl").lines().filter { it.isNotBlank() }.map { ToolJson.transcriptEvent(it) }
        assertTrue(events[0] is TranscriptEvent.First)
        assertEquals("a2", (events[1] as TranscriptEvent.New).message.id)
        assertEquals("Edited main.rs", (events[2] as TranscriptEvent.Update).message.tools[0].summary)
        assertNull((events[2] as TranscriptEvent.Update).message.tools[0].ok)
        assertEquals("s2", (events[3] as TranscriptEvent.Session).sessionId)
        assertEquals(TranscriptEvent.Ping, events[4])
    }

    @Test
    fun outputStreamAndScreen() {
        val screen = ToolJson.decode<Screen>(fixture("output.json"))
        assertEquals(listOf(3, 2), screen.cursor)
        assertTrue(screen.lines[2][1].bold)
        assertTrue(screen.lines[3][1].inverse)
        val events = fixture("output-follow.jsonl").lines().filter { it.isNotBlank() }.map { ToolJson.outputEvent(it) }
        assertNull((events[0] as OutputEvent.First).screen.cursor)
        val u = (events[1] as OutputEvent.Update).update
        assertEquals(1, u.drop)
        assertEquals(1, u.from)
        assertEquals(OutputEvent.Ping, events[2])
        assertEquals(OutputEvent.Exit, events[3])
    }

    @Test
    fun errorsInsideStreamsThrow() {
        try {
            ToolJson.outputEvent("""{"code":"failed","error":"the session did not answer","v":1}""")
            fail("expected a ToolFailure")
        } catch (e: ToolFailure) {
            assertEquals("failed", e.code)
        }
    }
}
