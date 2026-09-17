package dev.swarmz.phone.ui.tile

import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.parseTime
import java.time.Duration
import java.time.Instant

enum class SendState { Sending, Sent, Failed }

/** A message typed on the phone; [after] is the transcript's last message id when it was sent. */
data class Outgoing(val id: Long, val text: String, val state: SendState, val after: String? = null)

/**
 * Drops each `Sent` entry that can never stick: its echo has arrived (a user message with the same trimmed text
 * after the entry's [Outgoing.after], or among the last 10 messages when that id is unknown - each message echoes
 * one entry), or the turn has moved on without it (a newer message exists past that point but none of them is this
 * entry's text). `Sending` and `Failed` entries are untouched; their timeout lives in [TileController].
 */
fun reconcile(outgoing: List<Outgoing>, messages: List<Message>): List<Outgoing> {
    val used = mutableSetOf<Int>()
    return outgoing.filterNot { o ->
        if (o.state != SendState.Sent) return@filterNot false
        val from = o.after?.let { id -> messages.indexOfLast { it.id == id } }?.takeIf { it >= 0 }?.plus(1)
            ?: (messages.size - 10).coerceAtLeast(0)
        val text = o.text.trim()
        val hit = (from until messages.size).firstOrNull { i ->
            i !in used && messages[i].role == "user" && messages[i].text.trim() == text
        }
        if (hit != null) {
            used += hit
            return@filterNot true
        }
        // The turn moved on without echoing it: an unclaimed later message exists, but none of them is this one.
        // A message already claimed by another entry's echo (two identical sends) does not count.
        (from until messages.size).any { it !in used }
    }
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
