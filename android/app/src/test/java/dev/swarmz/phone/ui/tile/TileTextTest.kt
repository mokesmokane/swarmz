package dev.swarmz.phone.ui.tile

import dev.swarmz.phone.proto.TileRow
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
}
