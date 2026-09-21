package dev.swarmz.phone.proto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/** The tool's protocol version this app speaks (spec §4); a lower one on a Mac gets a banner. */
const val APP_PROTOCOL = 1

@Serializable
data class TileRow(
    val id: String,
    val name: String,
    val cwd: String,
    val kind: String,
    val running: Boolean,
    val exitCode: Int? = null,
    val status: String = "offline",
    val needs: String? = null,
    val since: String? = null,
    val lastEvent: String? = null,
    val mode: String? = null,
    val lastMessage: String? = null,
    val turnEndedAt: String? = null,
    val sessionId: String? = null,
    val summary: String? = null,
    val machine: String? = null,
    /** The card's title, else the session's first prompt (conversation cards spec §3.2); null before either. */
    val title: String? = null,
    val recap: String? = null,
    val cardAt: String? = null,
    val cardBy: String? = null,
) {
    /** What rows and headers show: the title when there is one, else the name. */
    val shownTitle: String get() = title?.takeIf { it.isNotBlank() } ?: name
    val hasTitle: Boolean get() = !title.isNullOrBlank()
}

@Serializable data class TileList(val tiles: List<TileRow>)

/** A tile's card as `card` returns it (spec §2). */
@Serializable data class Card(val title: String? = null, val recap: String? = null, val updatedAt: String? = null, val by: String? = null)
@Serializable data class CardReply(val card: Card? = null)
/** What `upload` prints: where the file landed on the Mac (phone attachments spec §3.1). */
@Serializable data class UploadReply(val path: String, val size: Long)

@Serializable
data class Machine(
    val name: String,
    val alias: String? = null,
    val color: String? = null,
    val online: Boolean? = null,
    @SerialName("self") val isSelf: Boolean = false,
)

@Serializable data class MachineList(val machines: List<Machine>)
@Serializable data class Folders(val path: String, val parent: String? = null, val dirs: List<String>)
@Serializable data class ToolView(val name: String, val summary: String, val ok: Boolean? = null)
@Serializable data class ImageRef(val id: String, val mime: String)

@Serializable
data class Message(
    val id: String,
    val ts: String = "",
    val role: String,
    val text: String,
    val images: List<ImageRef> = emptyList(),
    val tools: List<ToolView> = emptyList(),
)

/** [reset]: the tool did not know the `--after` id, so this is a fresh newest page that replaces what the phone has. */
@Serializable data class TranscriptPage(val messages: List<Message>, val hasMore: Boolean = false, val reset: Boolean = false)

@Serializable
data class Span(
    val text: String,
    val fg: JsonPrimitive? = null,
    val bg: JsonPrimitive? = null,
    val bold: Boolean = false,
    val inverse: Boolean = false,
)

typealias Line = List<Span>

@Serializable data class Screen(val cols: Int, val rows: Int, val cursor: List<Int>? = null, val lines: List<Line>)
@Serializable data class LinesUpdate(val drop: Int, val from: Int, val lines: List<Line>, val cursor: List<Int>? = null)
/** A dialog option: [description] and [checked] (a multi-select box) come with a question's options only. */
@Serializable data class Opt(val n: Int, val label: String, val description: String? = null, val checked: Boolean? = null)

/**
 * What a tile is asking (spec §4.4): a `permission` prompt, or a `question` Claude asks with
 * AskUserQuestion. [multi] is a multi-select question, whose digits tick boxes; [submit] says its
 * Submit entry is on screen, so `answer submit` can press it.
 */
@Serializable
data class Pending(
    val tool: String,
    val summary: String,
    val options: List<Opt>,
    val kind: String = "permission",
    val multi: Boolean = false,
    val submit: Boolean = false,
)
@Serializable data class PendingReply(val pending: Pending? = null)

@Serializable
data class AnswerReply(val answered: Boolean = false, val option: Opt? = null, val ignored: Boolean = false, val reason: String? = null, val toggled: Boolean = false)

@Serializable data class SentReply(val sent: Boolean = false)
@Serializable data class TileReply(val tile: TileRow)
@Serializable data class Version(val tool: String, val protocol: Int, val build: Long? = null)
@Serializable data class MachineResult(val machine: String? = null, val ok: Boolean, val error: String? = null)
@Serializable data class PhoneAddReply(val added: Boolean, val machines: List<MachineResult> = emptyList())
@Serializable data class ImageReply(val mime: String, val base64: String)
@Serializable data class SessionClosed(val closed: Boolean)
