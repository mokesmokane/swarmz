package dev.swarmz.phone.ui.tile

import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.parseTime
import java.time.Duration
import java.time.Instant

enum class SendState { Sending, Sent, Failed }

data class Outgoing(val id: Long, val text: String, val state: SendState)

fun reconcile(outgoing: List<Outgoing>, messages: List<Message>): List<Outgoing> {
    val recent = messages.takeLast(10).filter { it.role == "user" }.map { it.text.trim() }.toSet()
    return outgoing.filterNot { it.state == SendState.Sent && it.text.trim() in recent }
}

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

sealed interface Segment {
    data class Prose(val text: String) : Segment
    data class Code(val lang: String, val text: String) : Segment
}

fun splitCode(markdown: String): List<Segment> {
    val out = mutableListOf<Segment>()
    val prose = StringBuilder()
    var code: StringBuilder? = null
    var lang = ""
    fun flushProse() {
        val t = prose.toString().trim('\n')
        if (t.isNotBlank()) out += Segment.Prose(t)
        prose.clear()
    }
    for (line in markdown.lines()) {
        val fence = line.trimStart().startsWith("```")
        when {
            code == null && fence -> {
                flushProse()
                lang = line.trimStart().removePrefix("```").trim()
                code = StringBuilder()
            }
            code != null && fence -> {
                out += Segment.Code(lang, code.toString().trimEnd('\n'))
                code = null
            }
            code != null -> code.append(line).append('\n')
            else -> prose.append(line).append('\n')
        }
    }
    code?.let { out += Segment.Code(lang, it.toString().trimEnd('\n')) }
    flushProse()
    return out
}

val SLASH_COMMANDS = listOf("/clear", "/compact", "/context", "/cost", "/model", "/help")
