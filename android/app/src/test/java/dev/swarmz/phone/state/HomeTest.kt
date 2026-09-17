package dev.swarmz.phone.state

import dev.swarmz.phone.proto.TileRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class HomeTest {
    private fun row(
        id: String, name: String = id, needs: String? = null, status: String = "idle", running: Boolean = true,
        since: String? = null, turnEndedAt: String? = null, kind: String = "claude", exitCode: Int? = null,
        cwd: String = "/Users/me/projects/$id", mode: String? = null,
    ) = TileRow(id = id, name = name, cwd = cwd, kind = kind, running = running, exitCode = exitCode, status = status,
        needs = needs, since = since, turnEndedAt = turnEndedAt, mode = mode)

    private fun v(r: TileRow, mac: String = "mini", online: Boolean = true) = TileView(TileKey(mac, r.id), r, mac, online)

    @Test
    fun needs() {
        val t = Instant.parse("2026-09-17T08:00:00Z")
        assertEquals(Need.Permission, needOf(row("a", needs = "permission"), null))
        assertEquals(Need.Question, needOf(row("a", needs = "question"), null))
        assertEquals(Need.Finished, needOf(row("a", turnEndedAt = "2026-09-17T08:00:00Z"), null))
        assertEquals(Need.Finished, needOf(row("a", turnEndedAt = "2026-09-17T08:00:00Z"), t.minusSeconds(1)))
        assertNull(needOf(row("a", turnEndedAt = "2026-09-17T08:00:00Z"), t))
        assertNull(needOf(row("a", turnEndedAt = "2026-09-17T08:00:00Z", status = "working"), null))
        assertNull(needOf(row("a"), null))
    }

    @Test
    fun homeSortsNeedsNewestFirstAndQuietByName() {
        val a = v(row("a", needs = "permission", since = "2026-09-17T08:00:00Z"))
        val b = v(row("b", needs = "question", since = "2026-09-17T09:00:00Z"))
        val c = v(row("c", name = "zeta", status = "working"))
        val d = v(row("d", name = "alpha"))
        val e = v(row("e", running = false))
        val model = homeModel(listOf(a, b, c, d, e), emptyMap())
        assertEquals(listOf("b", "a"), model.needs.map { it.row.id })
        assertEquals(listOf("alpha", "zeta"), model.quiet.map { it.row.name })
    }

    @Test
    fun sectionsPutNeedsFirstThenOnePerMac() {
        val a = v(row("a", needs = "permission"), mac = "mini")
        val b = v(row("b"), mac = "mini")
        val c = v(row("c"), mac = "studio", online = false)
        val seen = Instant.parse("2026-09-17T07:00:00Z")
        val macs = listOf(MacInfo("mini", "Mini", true, null), MacInfo("studio", "Studio", false, seen))
        val sections = tileListSections(listOf(a, b, c), emptyMap(), macs)
        assertEquals(listOf("NEEDS YOU", "MINI", "STUDIO"), sections.map { it.title })
        assertEquals(listOf("a"), sections[0].rows.map { it.row.id })
        assertEquals(listOf("b"), sections[1].rows.map { it.row.id })
        assertEquals(true, sections[2].dimmed)
        assertEquals(seen, sections[2].lastSeen)
    }

    @Test
    fun subLinesDotsModesAndTimes() {
        assertEquals("mini · permission", subLine(v(row("a", needs = "permission")), Need.Permission))
        assertEquals("api · working", subLine(v(row("api", status = "working")), null))
        assertEquals("exited 1", subLine(v(row("a", running = false, exitCode = 1)), null))
        assertEquals("a · stopped", subLine(v(row("a", running = false)), null))
        assertEquals(Dot.NeedsYou, dotOf(row("a"), Need.Finished))
        assertEquals(Dot.Working, dotOf(row("a", status = "working"), null))
        assertEquals(Dot.Error, dotOf(row("a", running = false, exitCode = 2), null))
        assertEquals(Dot.Offline, dotOf(row("a", running = false), null))
        assertEquals(Dot.Idle, dotOf(row("a"), null))
        assertEquals("shell", modeLabel(row("a", kind = "shell")))
        assertEquals("accept edits", modeLabel(row("a", mode = "acceptEdits")))
        assertEquals("skip permissions", modeLabel(row("a", mode = "bypassPermissions")))
        assertEquals("default", modeLabel(row("a")))
        val now = Instant.parse("2026-09-17T10:00:00Z")
        assertEquals("now", relativeTime(now.minusSeconds(20), now))
        assertEquals("3m", relativeTime(now.minusSeconds(180), now))
        assertEquals("2h", relativeTime(now.minusSeconds(7300), now))
        assertEquals("3d", relativeTime(now.minusSeconds(3 * 86400 + 5), now))
        assertEquals("projects", folderName("/Users/me/projects/"))
        assertEquals("/", folderName("/"))
        assertNull(parseTime("junk"))
    }
}
