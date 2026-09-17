package dev.swarmz.phone.state

import dev.swarmz.phone.proto.TileRow
import java.time.Duration
import java.time.Instant

data class TileKey(val mac: String, val id: String)
data class TileView(val key: TileKey, val row: TileRow, val macLabel: String, val macOnline: Boolean)
data class MacInfo(val name: String, val label: String, val online: Boolean, val lastSeen: Instant?)

enum class Need { Permission, Question, Finished }
enum class Dot { Working, NeedsYou, Idle, Error, Offline }

fun parseTime(s: String?): Instant? = s?.let { runCatching { Instant.parse(it) }.getOrNull() }

/** Spec §6.4: `needs` set, or a finished turn newer than when this phone last looked at the tile. */
fun needOf(row: TileRow, seenAt: Instant?): Need? {
    when (row.needs) {
        "permission" -> return Need.Permission
        "question" -> return Need.Question
    }
    if (!row.running || row.status == "working") return null
    val ended = parseTime(row.turnEndedAt) ?: return null
    return if (seenAt == null || ended.isAfter(seenAt)) Need.Finished else null
}

data class HomeModel(val needs: List<TileView>, val quiet: List<TileView>)

private fun TileView.newest(): Instant = parseTime(row.since) ?: parseTime(row.turnEndedAt) ?: Instant.EPOCH

fun homeModel(tiles: List<TileView>, seen: Map<TileKey, Instant>): HomeModel {
    val (needs, rest) = tiles.partition { needOf(it.row, seen[it.key]) != null }
    return HomeModel(
        needs = needs.sortedByDescending { it.newest() },
        quiet = rest.filter { it.row.running }.sortedBy { it.row.name.lowercase() },
    )
}

/** A tile list section; [mac] is the Mac's name for a per-Mac section (labels need not be unique), null for NEEDS YOU. */
data class ListSection(val title: String, val needsYou: Boolean, val dimmed: Boolean, val lastSeen: Instant?, val rows: List<TileView>, val mac: String? = null) {
    val key: String get() = mac?.let { "mac-$it" } ?: "needs"
}

fun tileListSections(tiles: List<TileView>, seen: Map<TileKey, Instant>, macs: List<MacInfo>): List<ListSection> {
    val (needs, rest) = tiles.partition { needOf(it.row, seen[it.key]) != null }
    val out = mutableListOf<ListSection>()
    if (needs.isNotEmpty()) out += ListSection("NEEDS YOU", needsYou = true, dimmed = false, lastSeen = null, rows = needs.sortedByDescending { it.newest() })
    for (mac in macs) {
        val rows = rest.filter { it.key.mac == mac.name }.sortedBy { it.row.name.lowercase() }
        if (rows.isEmpty()) continue
        out += ListSection(mac.label.uppercase(), needsYou = false, dimmed = !mac.online, lastSeen = mac.lastSeen, rows = rows, mac = mac.name)
    }
    return out
}

fun folderName(path: String): String {
    val trimmed = path.trimEnd('/')
    return if (trimmed.isEmpty()) "/" else trimmed.substringAfterLast('/')
}

fun subLine(view: TileView, need: Need?): String {
    val row = view.row
    return when {
        need == Need.Permission -> "${view.macLabel} · permission"
        need == Need.Question -> "${view.macLabel} · question"
        !row.running && row.exitCode != null && row.exitCode != 0 -> "exited ${row.exitCode}"
        !row.running -> "${folderName(row.cwd)} · stopped"
        else -> "${folderName(row.cwd)} · ${row.status}"
    }
}

fun dotOf(row: TileRow, need: Need?): Dot = when {
    need != null -> Dot.NeedsYou
    !row.running && row.exitCode != null && row.exitCode != 0 -> Dot.Error
    !row.running -> Dot.Offline
    row.status == "working" -> Dot.Working
    else -> Dot.Idle
}

fun modeLabel(row: TileRow): String = when {
    row.kind == "shell" -> "shell"
    row.mode == null -> "default"
    row.mode == "acceptEdits" || row.mode == "accept edits" -> "accept edits"
    row.mode == "bypassPermissions" -> "skip permissions"
    else -> row.mode
}

fun relativeTime(then: Instant, now: Instant): String {
    val s = Duration.between(then, now).seconds.coerceAtLeast(0)
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}
