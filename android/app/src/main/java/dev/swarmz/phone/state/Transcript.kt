package dev.swarmz.phone.state

import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.proto.TranscriptEvent
import dev.swarmz.phone.proto.TranscriptPage

data class TranscriptState(val messages: List<Message> = emptyList(), val hasMore: Boolean = false, val loaded: Boolean = false)

val TranscriptState.lastId: String? get() = messages.lastOrNull()?.id
val TranscriptState.oldestId: String? get() = messages.firstOrNull()?.id

/** Adds or replaces each message by id, keeping order (new ids go at the end). */
private fun List<Message>.upsert(incoming: List<Message>): List<Message> {
    val out = toMutableList()
    for (m in incoming) {
        val i = out.indexOfFirst { it.id == m.id }
        if (i >= 0) out[i] = m else out += m
    }
    return out
}

fun TranscriptState.apply(event: TranscriptEvent): TranscriptState = when (event) {
    // A first page arrives on open (newest page) and on every resume (`--after lastId`); a reset page starts over.
    is TranscriptEvent.First -> {
        if (!loaded || event.page.reset) TranscriptState(event.page.messages, event.page.hasMore, loaded = true)
        else copy(messages = messages.upsert(event.page.messages))
    }
    is TranscriptEvent.New -> copy(messages = messages.upsert(listOf(event.message)))
    is TranscriptEvent.Update -> copy(messages = messages.upsert(listOf(event.message)))
    is TranscriptEvent.Session -> TranscriptState(loaded = true)
    TranscriptEvent.Ping -> this
}

fun TranscriptState.withOlder(page: TranscriptPage): TranscriptState {
    val known = messages.map { it.id }.toSet()
    val older = page.messages.filter { it.id !in known }
    return copy(messages = older + messages, hasMore = page.hasMore)
}
