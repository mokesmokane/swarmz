package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import dev.swarmz.phone.data.OutputSession
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.state.ScreenState
import dev.swarmz.phone.state.TileKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

/** The wait after a real answer before asking the screen again: `answer` returns before Claude closes its dialog. */
internal const val ASK_RETRY_MS = 2_000L
private const val ASK_RETRY_MAX_MS = 30_000L

/** Tool errors that retrying `pending` cannot fix. */
private val FINAL_PENDING_CODES = setOf("old_session", "not_running", "invalid")

/** 2 s, 4 s, 8 s, 16 s, then 30 s. */
internal fun pendingRetryMs(attempt: Int): Long = minOf(ASK_RETRY_MAX_MS, ASK_RETRY_MS shl minOf(attempt, 5))

private data class OpenTrigger(val kind: String?, val running: Boolean, val online: Boolean)

@OptIn(ExperimentalCoroutinesApi::class)
/** How an attachment is doing (phone attachments spec §4.3). */
sealed interface AttachState {
    data class Uploading(val sent: Long) : AttachState
    data class Done(val path: String) : AttachState
    data class Failed(val message: String) : AttachState
}

data class Attachment(val id: Long, val name: String, val size: Long, val state: AttachState)

/** The largest file the phone sends (the tool's own limit). */
const val MAX_ATTACHMENT = 25L * 1024 * 1024

class TileController(
    val key: TileKey,
    private val repo: Repository,
    parent: CoroutineScope,
    private val now: () -> Instant,
) {
    private val job = SupervisorJob(parent.coroutineContext[Job])
    private val scope = CoroutineScope(parent.coroutineContext + job)

    val draft: MutableState<TextFieldValue> = mutableStateOf(TextFieldValue(""))

    /**
     * Where the terminal is scrolled to. It lives here, not in the composition, so folding keeps it, as it keeps
     * the draft (phone terminal-only spec §1: the terminal is the tile, for every kind).
     */
    val screenListState = LazyListState()

    /** How the screen is followed; tests replace it to make an open fail. */
    internal var openOutput: (TileKey) -> OutputSession = repo::openOutput

    val row: StateFlow<TileRow?> = repo.tiles.map { t -> t.firstOrNull { it.key == key }?.row }
        .stateIn(scope, SharingStarted.Eagerly, repo.tiles.value.firstOrNull { it.key == key }?.row)
    private val mac = repo.macs.map { m -> m.firstOrNull { it.name == key.mac } }
        .stateIn(scope, SharingStarted.Eagerly, null)
    val macOnline: StateFlow<Boolean> = mac.map { it?.online == true }.stateIn(scope, SharingStarted.Eagerly, false)
    val macLabel: StateFlow<String> = mac.map { it?.label ?: key.mac }.stateIn(scope, SharingStarted.Eagerly, key.mac)
    val lastSeen: StateFlow<Instant?> = mac.map { it?.lastSeen }.stateIn(scope, SharingStarted.Eagerly, null)

    private val outputSession = MutableStateFlow<OutputSession?>(null)
    private val openError = MutableStateFlow<String?>(null)

    val screen: StateFlow<ScreenState> = outputSession.flatMapLatest { it?.state ?: flowOf(ScreenState()) }
        .stateIn(scope, SharingStarted.Eagerly, ScreenState())
    val streamError: StateFlow<String?> = combine(
        outputSession.flatMapLatest { it?.error ?: flowOf(null) },
        openError,
    ) { a, b -> a ?: b }.stateIn(scope, SharingStarted.Eagerly, null)

    private val _pending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = _pending.asStateFlow()
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()
    private val _noticeRound = MutableStateFlow(0)
    /** Bumped by every notice, so the same text twice in a row still re-arms the screen's dismissal timer. */
    val noticeRound: StateFlow<Int> = _noticeRound.asStateFlow()
    private val ids = AtomicLong()

    /** The one pending fetch (with its retries); a newer fetch or an answer cancels it. */
    private var askJob: Job? = null
    private val askGeneration = AtomicLong()

    /**
     * Completes when fetching may resume after an answer: at once after an ignored or failed answer, [ASK_RETRY_MS]
     * after a real one. Any fetch started meanwhile (e.g. by a new `since`) waits for it, as on the home screen.
     */
    private var answerHold: CompletableJob? = null

    init {
        scope.launch {
            var prev: OpenTrigger? = null
            combine(row, macOnline) { r, online -> OpenTrigger(r?.kind, r?.running == true, online) }
                .distinctUntilChanged()
                .collect { t ->
                    val before = prev
                    prev = t
                    val kind = t.kind ?: return@collect
                    // Restarted: the old session ended with the shell (the tool reports the exit and closes the
                    // stream cleanly), so follow the new one.
                    val restarted = before?.kind != null && t.running && !before.running
                    // The tile came (back) into view, or its Mac came back online.
                    val fresh = before == null || before.kind == null || !before.online
                    // Failed or finished: the follow ended, so follow again.
                    val ended = outputSession.value?.let { it.error.value != null || !it.job.isActive } == true
                    when {
                        outputSession.value == null -> open()
                        t.online && (restarted || (fresh && ended)) -> open()
                    }
                }
        }
        scope.launch {
            // The summary is in the key so a form's next question (a new summary under the same
            // `needs`) is fetched too.
            row.map { Triple(it?.needs, it?.since, it?.summary) }.distinctUntilChanged().collect {
                if (!asksOnScreen(row.value)) {
                    cancelAsk()
                    _pending.value = null
                } else {
                    fetchPending()
                }
            }
        }
    }

    /** Follows (or follows again) the tile's screen. */
    private fun open() {
        outputSession.value?.let {
            it.close()
            outputSession.value = null
        }
        try {
            outputSession.value = openOutput(key)
            openError.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            openError.value = e.message ?: "Couldn't open this tile"
        }
    }

    /**
     * The tile has a dialog `pending` can read: a permission prompt, or a question Claude asks
     * (only ever seen on the screen, so it carries a summary; a question block the hook log
     * reports on its own has none, and no card).
     */
    private fun asksOnScreen(r: TileRow?): Boolean =
        r?.needs == "permission" || (r?.needs == "question" && r.summary != null)

    private fun cancelAsk() {
        askGeneration.incrementAndGet()
        askJob?.cancel()
        askJob = null
    }

    /** Fetches the question once any answer hold ends, retrying with backoff until one shows or the tile stops needing it. */
    private fun fetchPending() {
        cancelAsk()
        val gen = askGeneration.get()
        fun current() = askGeneration.get() == gen
        val hold = answerHold
        askJob = scope.launch {
            hold?.join()
            var attempt = 0
            while (true) {
                if (!asksOnScreen(row.value)) {
                    if (current()) _pending.value = null
                    return@launch
                }
                val p = try {
                    repo.pending(key)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ToolFailure) {
                    if (e.code in FINAL_PENDING_CODES) {
                        if (current()) _pending.value = null
                        return@launch
                    }
                    null
                } catch (_: Exception) {
                    null
                }
                if (!current()) return@launch
                if (p != null) {
                    _pending.value = p
                    return@launch
                }
                // Nothing to show yet: the hook log can run ahead of the screen, or the link is down.
                _pending.value = null
                delay(pendingRetryMs(attempt++))
            }
        }
    }

    private val _attachments = MutableStateFlow<List<Attachment>>(emptyList())
    /** Files being sent to the tile's Mac, and the ones sent this session (spec §4.3). */
    val attachments: StateFlow<List<Attachment>> = _attachments.asStateFlow()
    private val attachmentBytes = mutableMapOf<Long, ByteArray>()
    private val attachmentJobs = mutableMapOf<Long, Job>()
    /** Uploads run one at a time: the Mac's link is not shared between two stdin writers. */
    private val uploads = Mutex()

    /**
     * Sends [bytes] to the tile's Mac as [name]; on success the path it landed at is inserted into the
     * draft at the cursor, followed by a space, so words can be added before sending.
     */
    fun attach(name: String, bytes: ByteArray) {
        val id = ids.incrementAndGet()
        if (bytes.size > MAX_ATTACHMENT) {
            _attachments.update { it + Attachment(id, name, bytes.size.toLong(), AttachState.Failed("too large (limit 25 MiB)")) }
            return
        }
        attachmentBytes[id] = bytes
        _attachments.update { it + Attachment(id, name, bytes.size.toLong(), AttachState.Uploading(0)) }
        startUpload(id)
    }

    private fun startUpload(id: Long) {
        val bytes = attachmentBytes[id] ?: return
        val name = _attachments.value.firstOrNull { it.id == id }?.name ?: return
        attachmentJobs[id] = scope.launch {
            try {
                val path = uploads.withLock {
                    repo.upload(key.mac, name, bytes) { sent -> setAttachState(id, AttachState.Uploading(sent)) }
                }
                attachmentBytes.remove(id)
                setAttachState(id, AttachState.Done(path))
                insertAtCursor("$path ")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setAttachState(id, AttachState.Failed(e.message ?: "could not send $name"))
            } finally {
                attachmentJobs.remove(id)
            }
        }
    }

    private fun setAttachState(id: Long, state: AttachState) {
        _attachments.update { list -> list.map { if (it.id == id) it.copy(state = state) else it } }
    }

    fun retryAttachment(id: Long) {
        if (attachmentJobs.containsKey(id) || !attachmentBytes.containsKey(id)) return
        setAttachState(id, AttachState.Uploading(0))
        startUpload(id)
    }

    /** Cancels an upload in flight (the closed channel makes the Mac keep nothing) or drops a chip. */
    fun removeAttachment(id: Long) {
        attachmentJobs.remove(id)?.cancel()
        attachmentBytes.remove(id)
        _attachments.update { list -> list.filterNot { it.id == id } }
    }

    private fun insertAtCursor(text: String) {
        val cur = draft.value
        val at = cur.selection.end.coerceIn(0, cur.text.length)
        draft.value = TextFieldValue(cur.text.substring(0, at) + text + cur.text.substring(at), TextRange(at + text.length))
    }

    private fun fail(e: Exception, prefix: String = "") {
        notify(prefix + (e.message ?: "something went wrong"))
    }

    /** Types the draft into the tile; the terminal shows it arrive. A failure puts it back in the composer. */
    fun send() {
        val text = draft.value.text.trim()
        if (text.isEmpty()) return
        draft.value = TextFieldValue("")
        scope.launch {
            try {
                repo.send(key, text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (draft.value.text.isEmpty()) draft.value = TextFieldValue(text, TextRange(text.length))
                fail(e, "Couldn't send: ")
            }
        }
    }

    fun answer(option: Opt) = answerWith(option.n.toString())

    /** Presses a multi-select question's Submit entry (`answer submit`). */
    fun submit() = answerWith("submit")

    private fun answerWith(choice: String) {
        val ask = _pending.value ?: return
        cancelAsk()
        _pending.value = null
        val hold = Job()
        answerHold?.complete()
        answerHold = hold
        scope.launch {
            try {
                val answered = try {
                    repo.answer(key, choice, ask.summary).answered
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail(e)
                    false
                }
                // Still blocked? Ask the screen again once the hold ends: at once after an ignored or failed answer,
                // shortly after a real one, since Claude closes its dialog a moment after `answer` returns.
                if (asksOnScreen(row.value)) fetchPending()
                if (answered) delay(ASK_RETRY_MS)
            } finally {
                hold.complete()
                if (answerHold === hold) answerHold = null
            }
        }
    }

    fun key(k: Key) {
        scope.launch {
            try {
                repo.key(key, k)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    /** The user typed a title for this tile's card (conversation cards spec §6); empty hands it back. */
    fun setTitle(title: String) {
        scope.launch {
            try {
                repo.setTitle(key, title)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun restart() {
        scope.launch {
            try {
                repo.restart(key)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e, "Couldn't restart: ")
            }
        }
    }

    /** Shows a one-off line under the body, the way a failed action does. Saying the same thing twice shows twice. */
    fun notify(text: String) {
        _notice.value = text
        _noticeRound.value++
    }

    fun dismissNotice() {
        _notice.value = null
    }

    fun close() {
        outputSession.value?.close()
        job.cancel()
    }
}
