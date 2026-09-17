package dev.swarmz.phone.ui.tile

import android.graphics.BitmapFactory
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import dev.swarmz.phone.data.OutputSession
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.data.TranscriptSession
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.state.ScreenState
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TranscriptState
import dev.swarmz.phone.state.lastId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
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
import kotlinx.coroutines.withContext
import java.time.Instant
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

/** The wait after a real answer before asking the screen again: `answer` returns before Claude closes its dialog. */
internal const val ASK_RETRY_MS = 2_000L
private const val ASK_RETRY_MAX_MS = 30_000L

/** Tool errors that retrying `pending` cannot fix. */
private val FINAL_PENDING_CODES = setOf("old_session", "not_running", "invalid")

/** 2 s, 4 s, 8 s, 16 s, then 30 s. */
internal fun pendingRetryMs(attempt: Int): Long = minOf(ASK_RETRY_MAX_MS, ASK_RETRY_MS shl minOf(attempt, 5))

/** The long side images are decoded down to (at most a power of two above it). */
internal const val IMAGE_TARGET_PX = 1024

/** The largest power-of-two sample size that keeps the long side at or above [target]. */
internal fun sampleSize(width: Int, height: Int, target: Int = IMAGE_TARGET_PX): Int {
    val long = maxOf(width, height)
    var sample = 1
    while (long / (sample * 2) >= target) sample *= 2
    return sample
}

private fun decodeSampled(bytes: ByteArray): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}

/**
 * What the screen shows after a reopen: the new session's messages, preceded by the [carried] ones older than its
 * first page, so a reconnect does not blank the conversation or lose pages already loaded.
 */
internal fun mergeTranscript(carried: TranscriptState?, fresh: TranscriptState): TranscriptState {
    if (carried == null) return fresh
    if (!fresh.loaded) return carried
    val first = fresh.messages.firstOrNull() ?: return fresh
    val at = carried.messages.indexOfFirst { it.id == first.id }
    if (at <= 0) return fresh
    return fresh.copy(messages = carried.messages.take(at) + fresh.messages, hasMore = carried.hasMore)
}

private data class OpenTrigger(val kind: String?, val running: Boolean, val online: Boolean)

@OptIn(ExperimentalCoroutinesApi::class)
class TileController(
    val key: TileKey,
    private val repo: Repository,
    parent: CoroutineScope,
    private val now: () -> Instant,
) {
    private val job = SupervisorJob(parent.coroutineContext[Job])
    private val scope = CoroutineScope(parent.coroutineContext + job)

    val draft: MutableState<TextFieldValue> = mutableStateOf(TextFieldValue(""))
    val listState = LazyListState()

    /** Where images are decoded; tests replace it. */
    internal var decoder: CoroutineDispatcher = Dispatchers.Default

    /** How sessions are opened; tests replace these to make an open fail. */
    internal var openTranscript: (TileKey) -> TranscriptSession = repo::openTranscript
    internal var openOutput: (TileKey) -> OutputSession = repo::openOutput

    val row: StateFlow<TileRow?> = repo.tiles.map { t -> t.firstOrNull { it.key == key }?.row }
        .stateIn(scope, SharingStarted.Eagerly, repo.tiles.value.firstOrNull { it.key == key }?.row)
    private val mac = repo.macs.map { m -> m.firstOrNull { it.name == key.mac } }
        .stateIn(scope, SharingStarted.Eagerly, null)
    val macOnline: StateFlow<Boolean> = mac.map { it?.online == true }.stateIn(scope, SharingStarted.Eagerly, false)
    val macLabel: StateFlow<String> = mac.map { it?.label ?: key.mac }.stateIn(scope, SharingStarted.Eagerly, key.mac)
    val lastSeen: StateFlow<Instant?> = mac.map { it?.lastSeen }.stateIn(scope, SharingStarted.Eagerly, null)

    private val transcriptSession = MutableStateFlow<TranscriptSession?>(null)
    private val outputSession = MutableStateFlow<OutputSession?>(null)
    private val openError = MutableStateFlow<String?>(null)
    private val carried = MutableStateFlow<TranscriptState?>(null)

    val transcript: StateFlow<TranscriptState> = combine(
        transcriptSession.flatMapLatest { it?.state ?: flowOf(TranscriptState()) },
        carried,
    ) { fresh, old -> mergeTranscript(old, fresh) }
        .stateIn(scope, SharingStarted.Eagerly, TranscriptState())
    val screen: StateFlow<ScreenState> = outputSession.flatMapLatest { it?.state ?: flowOf(ScreenState()) }
        .stateIn(scope, SharingStarted.Eagerly, ScreenState())
    val streamError: StateFlow<String?> = combine(
        transcriptSession.flatMapLatest { it?.error ?: flowOf(null) },
        outputSession.flatMapLatest { it?.error ?: flowOf(null) },
        openError,
    ) { a, b, c -> a ?: b ?: c }.stateIn(scope, SharingStarted.Eagerly, null)

    private val _pending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = _pending.asStateFlow()
    private val _outgoing = MutableStateFlow<List<Outgoing>>(emptyList())
    val outgoing: StateFlow<List<Outgoing>> = _outgoing.asStateFlow()
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()
    private val _images = MutableStateFlow<Map<String, ImageBitmap?>>(emptyMap())
    val images: StateFlow<Map<String, ImageBitmap?>> = _images.asStateFlow()
    private val loadingImages = mutableSetOf<String>()
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
                    val session: Any? = if (kind == "shell") outputSession.value else transcriptSession.value
                    // The tile came (back) into view, its Mac came back online, or it was restarted.
                    val fresh = before == null || before.kind == null || !before.online || (t.running && !before.running)
                    when {
                        session == null -> open(kind)
                        currentError() != null && t.online && fresh -> open(kind)
                    }
                }
        }
        scope.launch {
            transcript.collect { t -> _outgoing.update { reconcile(it, t.messages) } }
        }
        scope.launch {
            row.map { it?.needs to it?.since }.distinctUntilChanged().collect { (needs, _) ->
                if (needs != "permission") {
                    cancelAsk()
                    _pending.value = null
                } else {
                    fetchPending()
                }
            }
        }
    }

    private fun currentError(): String? =
        transcriptSession.value?.error?.value ?: outputSession.value?.error?.value ?: openError.value

    /** Opens (or reopens) the session for [kind], carrying the conversation shown so far across. */
    private fun open(kind: String) {
        transcriptSession.value?.let {
            it.close()
            carried.value = transcript.value
            transcriptSession.value = null
        }
        outputSession.value?.let {
            it.close()
            outputSession.value = null
        }
        try {
            if (kind == "shell") outputSession.value = openOutput(key)
            else transcriptSession.value = openTranscript(key)
            openError.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            openError.value = e.message ?: "Couldn't open this tile"
        }
    }

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
                if (row.value?.needs != "permission") {
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

    private val isShell get() = row.value?.kind == "shell"

    private fun fail(e: Exception, prefix: String = "") {
        _notice.value = prefix + (e.message ?: "something went wrong")
    }

    fun send() {
        val text = draft.value.text.trim()
        if (text.isEmpty()) return
        draft.value = TextFieldValue("")
        if (isShell) {
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
            return
        }
        val entry = Outgoing(ids.incrementAndGet(), text, SendState.Sending, after = transcript.value.lastId)
        _outgoing.update { it + entry }
        deliver(entry)
    }

    private fun deliver(entry: Outgoing) {
        scope.launch {
            val state = try {
                repo.send(key, entry.text)
                SendState.Sent
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                SendState.Failed
            }
            _outgoing.update { list -> reconcile(list.map { if (it.id == entry.id) it.copy(state = state) else it }, transcript.value.messages) }
        }
    }

    fun retry(id: Long) {
        val entry = _outgoing.value.firstOrNull { it.id == id && it.state == SendState.Failed } ?: return
        // It never arrived, so only messages from now on can be its echo.
        val again = entry.copy(state = SendState.Sending, after = transcript.value.lastId)
        _outgoing.update { list -> list.map { if (it.id == id) again else it } }
        deliver(again)
    }

    fun answer(option: Opt) {
        val ask = _pending.value ?: return
        cancelAsk()
        _pending.value = null
        val hold = Job()
        answerHold?.complete()
        answerHold = hold
        scope.launch {
            try {
                val answered = try {
                    repo.answer(key, option.n.toString(), ask.summary).answered
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail(e)
                    false
                }
                // Still blocked? Ask the screen again once the hold ends: at once after an ignored or failed answer,
                // shortly after a real one, since Claude closes its dialog a moment after `answer` returns.
                if (row.value?.needs == "permission") fetchPending()
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

    suspend fun loadOlder() {
        try {
            transcriptSession.value?.loadOlder()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Fetches and decodes an image once; a failed load is recorded as null and tried again on the next call. */
    fun loadImage(id: String) {
        if (_images.value[id] != null || !loadingImages.add(id)) return
        scope.launch {
            val bitmap = try {
                val reply = repo.image(key, id)
                withContext(decoder) { decodeSampled(Base64.getDecoder().decode(reply.base64)) }
            } catch (e: CancellationException) {
                loadingImages.remove(id)
                throw e
            } catch (_: Exception) {
                null
            }
            loadingImages.remove(id)
            _images.update { it + (id to bitmap) }
        }
    }

    fun dismissNotice() {
        _notice.value = null
    }

    fun close() {
        transcriptSession.value?.close()
        outputSession.value?.close()
        job.cancel()
    }
}
