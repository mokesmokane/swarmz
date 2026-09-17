package dev.swarmz.phone.ui.tile

import android.graphics.BitmapFactory
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.input.TextFieldValue
import dev.swarmz.phone.data.OutputSession
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.data.TranscriptSession
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.Opt
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.ScreenState
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TranscriptState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

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

    val transcript: StateFlow<TranscriptState> = transcriptSession.flatMapLatest { it?.state ?: flowOf(TranscriptState()) }
        .stateIn(scope, SharingStarted.Eagerly, TranscriptState())
    val screen: StateFlow<ScreenState> = outputSession.flatMapLatest { it?.state ?: flowOf(ScreenState()) }
        .stateIn(scope, SharingStarted.Eagerly, ScreenState())
    val streamError: StateFlow<String?> = kotlinx.coroutines.flow.combine(
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
    private val ids = AtomicLong()

    init {
        scope.launch {
            val first = row.filterNotNull().first()
            try {
                if (first.kind == "shell") outputSession.value = repo.openOutput(key)
                else transcriptSession.value = repo.openTranscript(key)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                openError.value = e.message
            }
        }
        scope.launch {
            transcript.collect { t -> _outgoing.update { reconcile(it, t.messages) } }
        }
        scope.launch {
            // After a restart the old streams have ended with an error; follow the new session.
            row.map { it?.running }.distinctUntilChanged().collect { running ->
                if (running == true && streamError.value != null) {
                    try {
                        transcriptSession.value?.let { it.close(); transcriptSession.value = repo.openTranscript(key) }
                        outputSession.value?.let { it.close(); outputSession.value = repo.openOutput(key) }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // The Mac's link went away meanwhile: say so rather than end this follower.
                        openError.value = e.message
                    }
                }
            }
        }
        scope.launch {
            row.map { it?.needs to it?.since }.distinctUntilChanged().collect { (needs, _) ->
                if (needs != "permission") {
                    _pending.value = null
                } else {
                    _pending.value = runCatching { repo.pending(key) }.getOrNull()
                }
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
                    if (draft.value.text.isEmpty()) draft.value = TextFieldValue(text, androidx.compose.ui.text.TextRange(text.length))
                    fail(e, "Couldn't send: ")
                }
            }
            return
        }
        val entry = Outgoing(ids.incrementAndGet(), text, SendState.Sending)
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
        val again = entry.copy(state = SendState.Sending)
        _outgoing.update { list -> list.map { if (it.id == id) again else it } }
        deliver(again)
    }

    fun answer(option: Opt) {
        val ask = _pending.value ?: return
        _pending.value = null
        scope.launch {
            try {
                repo.answer(key, option.n.toString(), ask.summary)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
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

    fun loadImage(id: String) {
        if (id in _images.value) return
        _images.update { it + (id to null) }
        scope.launch {
            val bitmap = runCatching {
                val bytes = Base64.getDecoder().decode(repo.image(key, id).base64)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()
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
