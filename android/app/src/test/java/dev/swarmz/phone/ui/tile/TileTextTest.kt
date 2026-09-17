package dev.swarmz.phone.ui.tile

import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.TranscriptState
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class TileTextTest {
    private val now = Instant.parse("2026-09-17T10:03:04Z")
    private fun row(status: String, running: Boolean = true, exit: Int? = null, needs: String? = null, since: String? = "2026-09-17T10:00:00Z") =
        TileRow(id = "t", name = "n", cwd = "/", kind = "claude", running = running, exitCode = exit, status = status, needs = needs, since = since)

    @Test
    fun statusLines() {
        assertEquals("working · 3m 04s", statusLine(row("working"), now))
        assertEquals("working · 12s", statusLine(row("working", since = "2026-09-17T10:02:52Z"), now))
        assertEquals("waiting on you", statusLine(row("blocked", needs = "permission"), now))
        assertEquals("idle", statusLine(row("idle"), now))
        assertEquals("exited 2", statusLine(row("offline", running = false, exit = 2), now))
        assertEquals("stopped", statusLine(row("offline", running = false), now))
    }

    @Test
    fun codeFencesSplitOut() {
        val md = "Run this:\n```bash\nnpm test\n```\nthen\n```\nunclosed"
        assertEquals(
            listOf(
                Segment.Prose("Run this:"),
                Segment.Code("bash", "npm test"),
                Segment.Prose("then"),
                Segment.Code("", "unclosed"),
            ),
            splitCode(md),
        )
        assertEquals(listOf(Segment.Prose("plain")), splitCode("plain"))
    }

    @Test
    fun sentMessagesDisappearOnceTheTranscriptHasThem() {
        val out = listOf(Outgoing(1, "hi", SendState.Sent), Outgoing(2, "later", SendState.Sending), Outgoing(3, "oops", SendState.Failed))
        val msgs = listOf(Message(id = "a", role = "user", text = " hi "), Message(id = "b", role = "assistant", text = "later"))
        assertEquals(listOf(2L, 3L), reconcile(out, msgs).map { it.id })
    }

    @Test
    fun aRepeatedReplyOnlyMatchesAnEchoAfterItWasSent() {
        val before = listOf(Message(id = "u1", role = "user", text = "yes"), Message(id = "a1", role = "assistant", text = "ok"))
        val out = listOf(Outgoing(1, "yes", SendState.Sent, after = "a1"))
        assertEquals(listOf(1L), reconcile(out, before).map { it.id })
        val echoed = before + Message(id = "u2", role = "user", text = "yes")
        assertEquals(emptyList<Long>(), reconcile(out, echoed).map { it.id })
        // One echo answers one entry.
        val twice = out + Outgoing(2, "yes", SendState.Sent, after = "a1")
        assertEquals(listOf(2L), reconcile(twice, echoed).map { it.id })
    }

    @Test
    fun imagesAreSampledToAboutAThousandPixels() {
        assertEquals(1, sampleSize(800, 600))
        assertEquals(1, sampleSize(2047, 100))
        assertEquals(2, sampleSize(100, 2048))
        assertEquals(2, sampleSize(4032, 3024))
        assertEquals(8, sampleSize(8192, 10))
    }

    @Test
    fun reopenedTranscriptsKeepTheOlderMessages() {
        fun m(id: String) = Message(id = id, role = "assistant", text = id)
        val old = TranscriptState(listOf(m("1"), m("2"), m("3")), hasMore = true, loaded = true)
        assertEquals(old, mergeTranscript(old, TranscriptState()))
        val fresh = TranscriptState(listOf(m("2"), m("3"), m("4")), hasMore = false, loaded = true)
        assertEquals(TranscriptState(listOf(m("1"), m("2"), m("3"), m("4")), hasMore = true, loaded = true), mergeTranscript(old, fresh))
        val unrelated = TranscriptState(listOf(m("9")), loaded = true)
        assertEquals(unrelated, mergeTranscript(old, unrelated))
        assertEquals(fresh, mergeTranscript(null, fresh))
    }
}
