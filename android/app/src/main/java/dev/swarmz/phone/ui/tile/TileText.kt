package dev.swarmz.phone.ui.tile

import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.parseTime
import java.time.Duration
import java.time.Instant

/** A tile's state in words for the stopped-tile line: exited, stopped, waiting on you, working for how long, idle. */
fun statusLine(row: TileRow, now: Instant): String = when {
    !row.running && row.exitCode != null && row.exitCode != 0 -> "exited ${row.exitCode}"
    !row.running -> "stopped"
    row.needs != null -> "waiting on you"
    row.status == "working" -> {
        val s = parseTime(row.since)?.let { Duration.between(it, now).seconds.coerceAtLeast(0) } ?: 0
        if (s < 60) "working · ${s}s" else "working · ${s / 60}m ${"%02d".format(s % 60)}s"
    }
    else -> "idle"
}

/** The slash commands the Claude quick keys offer. */
val SLASH_COMMANDS = listOf("/clear", "/compact", "/context", "/cost", "/model", "/help")
