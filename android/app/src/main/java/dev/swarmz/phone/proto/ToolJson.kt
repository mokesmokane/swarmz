package dev.swarmz.phone.proto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A `{"v":1,"error":…,"code":…}` reply from the tool. */
class ToolFailure(val code: String, override val message: String) : Exception(message)

sealed interface WatchEvent {
    data class Snapshot(val tiles: List<TileRow>) : WatchEvent
    data class Tile(val tile: TileRow) : WatchEvent
    data class Gone(val id: String) : WatchEvent
    data object Ping : WatchEvent
}

sealed interface TranscriptEvent {
    data class First(val page: TranscriptPage) : TranscriptEvent
    data class New(val message: Message) : TranscriptEvent
    data class Update(val message: Message) : TranscriptEvent
    data class Session(val sessionId: String?) : TranscriptEvent
    data object Ping : TranscriptEvent
}

sealed interface OutputEvent {
    data class First(val screen: Screen) : OutputEvent
    data class Update(val update: LinesUpdate) : OutputEvent
    data object Exit : OutputEvent
    data object Ping : OutputEvent
}

object ToolJson {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    /** Parses one document, turning a tool error into a [ToolFailure]. */
    fun obj(text: String): JsonObject {
        val o = json.parseToJsonElement(text).jsonObject
        val error = o["error"]?.jsonPrimitive?.contentOrNull
        if (error != null) {
            throw ToolFailure(o["code"]?.jsonPrimitive?.contentOrNull ?: "failed", error)
        }
        return o
    }

    inline fun <reified T> decode(text: String): T = json.decodeFromJsonElement(obj(text))

    private fun type(o: JsonObject): String? = o["type"]?.jsonPrimitive?.contentOrNull

    /** Null for a kind this app does not know (newer tool). */
    fun watchEvent(line: String): WatchEvent? {
        val o = obj(line)
        return when (type(o)) {
            "snapshot" -> WatchEvent.Snapshot(json.decodeFromJsonElement<TileList>(o).tiles)
            "tile" -> WatchEvent.Tile(json.decodeFromJsonElement(o["tile"]!!))
            "gone" -> WatchEvent.Gone(o["id"]!!.jsonPrimitive.content)
            "ping" -> WatchEvent.Ping
            else -> null
        }
    }

    fun transcriptEvent(line: String): TranscriptEvent? {
        val o = obj(line)
        return when (type(o)) {
            null -> TranscriptEvent.First(json.decodeFromJsonElement(o))
            "message" -> TranscriptEvent.New(json.decodeFromJsonElement(o["message"]!!))
            "update" -> TranscriptEvent.Update(json.decodeFromJsonElement(o["message"]!!))
            "session" -> TranscriptEvent.Session(o["sessionId"]?.jsonPrimitive?.contentOrNull)
            "ping" -> TranscriptEvent.Ping
            else -> null
        }
    }

    fun outputEvent(line: String): OutputEvent? {
        val o = obj(line)
        return when (type(o)) {
            null -> OutputEvent.First(json.decodeFromJsonElement(o))
            "update" -> OutputEvent.Update(json.decodeFromJsonElement(o))
            "exit" -> OutputEvent.Exit
            "ping" -> OutputEvent.Ping
            else -> null
        }
    }
}
