package dev.swarmz.phone.link

import dev.swarmz.phone.proto.APP_PROTOCOL
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.proto.ToolJson
import dev.swarmz.phone.proto.Version
import dev.swarmz.phone.proto.WatchEvent
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.AuthRejected
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.Progress
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.uploadTimeoutMs
import dev.swarmz.phone.ssh.SshConnector
import android.os.Looper
import java.io.IOException
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

sealed interface LinkState {
    data object Idle : LinkState
    data object Connecting : LinkState
    data class Online(val version: Version) : LinkState
    data class Offline(val reason: String, val retryAt: Long) : LinkState
    data class Blocked(val reason: String, val keyRejected: Boolean = false) : LinkState
    data class TooOld(val version: Version) : LinkState
}

class LinkDown(message: String) : Exception(message)

/** `swarmz watch` pings every 25 s; this much silence means the connection is gone. */
private const val WATCH_SILENCE_MS = 75_000L

/** How long `follow` waits for a failed stream's connection to be declared down before calling the failure its own. */
private const val DROP_GRACE_MS = 2_000L

/**
 * Channel limits per connection. macOS sshd allows 10 sessions on one connection (`MaxSessions`), so a link
 * uses at most 6 for `exec` and 4 for streams: the watch, which needs no slot as there is one per connection,
 * plus [FOLLOW_SLOTS] follows. Separate limits mean open streams can never starve `exec`.
 */
const val EXEC_SLOTS = 6
const val FOLLOW_SLOTS = 3

/** True on Android's main thread; false off it, and in plain JVM tests, which have no main looper. */
@PublishedApi internal fun onMainThread(): Boolean = Looper.getMainLooper()?.isCurrentThread == true

fun backoffMs(attempt: Int): Long = min(30_000L, 1_000L shl min(attempt, 5))

class MacLink(
    val mac: String,
    private val host: String,
    private val auth: suspend () -> Auth,
    private val connector: SshConnector,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow<LinkState>(LinkState.Idle)
    val state: StateFlow<LinkState> = _state.asStateFlow()
    private val _tiles = MutableStateFlow<Map<String, TileRow>>(emptyMap())
    val tiles: StateFlow<Map<String, TileRow>> = _tiles.asStateFlow()
    private val _lastSeen = MutableStateFlow<Long?>(null)
    val lastSeen: StateFlow<Long?> = _lastSeen.asStateFlow()

    private val current = MutableStateFlow<SshConnection?>(null)
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private var job: Job? = null
    private val execSlots = Semaphore(EXEC_SLOTS)
    private val followSlots = Semaphore(FOLLOW_SLOTS)

    fun start() {
        if (job == null) job = scope.launch { loop() }
    }

    fun stop() {
        job?.cancel()
        job = null
        current.value?.close()
        current.value = null
        _state.value = LinkState.Idle
    }

    /** Skips the current wait. Does nothing unless the link is waiting (offline, blocked or on an old tool). */
    fun retryNow() {
        when (_state.value) {
            is LinkState.Offline, is LinkState.Blocked, is LinkState.TooOld -> kick.trySend(Unit)
            else -> Unit
        }
    }

    private suspend fun pause(ms: Long?) {
        if (ms == null) kick.receive() else withTimeoutOrNull(ms) { kick.receive() }
    }

    private suspend fun loop() {
        var attempt = 0
        while (currentCoroutineContext().isActive) {
            _state.value = LinkState.Connecting
            val conn = try {
                connector.connect(host, 22, auth())
            } catch (e: CancellationException) {
                throw e
            } catch (e: HostKeyChanged) {
                _state.value = LinkState.Blocked("$mac presented a different host key. If you reinstalled macOS, remove and pair it again.")
                pause(null)
                continue
            } catch (e: AuthRejected) {
                _state.value = LinkState.Blocked("$mac refused this phone's key. Pair it again below.", keyRejected = true)
                pause(null)
                continue
            } catch (e: Exception) {
                val wait = backoffMs(attempt++)
                _state.value = LinkState.Offline(e.message ?: "unreachable", now() + wait)
                pause(wait)
                continue
            }
            try {
                val version = try {
                    ToolJson.decode<Version>(conn.exec(Cmd.version()).stdout)
                } catch (_: IllegalArgumentException) {
                    // Not JSON at all (SerializationException is one): a missing or broken tool, or a cut-off answer.
                    throw LinkDown("swarmz isn't answering on $mac")
                }
                if (version.protocol < APP_PROTOCOL) {
                    conn.close()
                    _state.value = LinkState.TooOld(version)
                    pause(30_000)
                    continue
                }
                attempt = 0
                // A retry asked for while connecting must not cut the next backoff or block short.
                kick.tryReceive()
                _lastSeen.value = now()
                // State first: waiters check `state` when `current` changes.
                _state.value = LinkState.Online(version)
                current.value = conn
                watch(conn)
                throw LinkDown("$mac stopped answering")
            } catch (e: CancellationException) {
                if (current.value === conn) current.value = null
                conn.close()
                throw e
            } catch (e: Exception) {
                current.value = null
                conn.close()
                val wait = backoffMs(attempt++)
                _state.value = LinkState.Offline(e.message ?: "connection lost", now() + wait)
                pause(wait)
            }
        }
    }

    /** Follows `swarmz watch` until it ends, fails, or stays silent for [WATCH_SILENCE_MS]. */
    private suspend fun watch(conn: SshConnection) = coroutineScope {
        val lines = conn.lines(Cmd.watch()).produceIn(this)
        try {
            while (true) {
                val next = withTimeoutOrNull(WATCH_SILENCE_MS) { lines.receiveCatching() }
                    ?: throw LinkDown("$mac stopped answering")
                if (next.isClosed) {
                    next.exceptionOrNull()?.let { throw it }
                    return@coroutineScope
                }
                _lastSeen.value = now()
                when (val ev = ToolJson.watchEvent(next.getOrThrow())) {
                    is WatchEvent.Snapshot -> _tiles.value = ev.tiles.associateBy { it.id }
                    is WatchEvent.Tile -> _tiles.update { it + (ev.tile.id to ev.tile) }
                    is WatchEvent.Gone -> _tiles.update { it - ev.id }
                    WatchEvent.Ping, null -> Unit
                }
            }
        } finally {
            lines.cancel()
        }
    }

    private suspend fun online(waitMs: Long): SshConnection =
        withTimeoutOrNull(waitMs) { current.first { it != null && state.value is LinkState.Online } }
            ?: throw LinkDown("$mac is offline")

    /** Runs [command] once the link is online (waiting up to [waitMs]); [timeoutMs] bounds the command itself. */
    suspend fun exec(command: String, waitMs: Long = 15_000, timeoutMs: Long = 20_000): String {
        // Wait for the link first, so commands waiting for it do not hold slots.
        val conn = online(waitMs)
        return execSlots.withPermit { run(conn, command, timeoutMs) }
    }

    /** [exec] with [input] on the command's stdin (an upload), taking a slot for as long as the bytes take. */
    suspend fun execInput(command: String, input: ByteArray, onProgress: Progress, waitMs: Long = 15_000): String {
        val conn = online(waitMs)
        return execSlots.withPermit { run(conn, command, uploadTimeoutMs(input.size.toLong()), input, onProgress) }
    }

    private suspend fun run(conn: SshConnection, command: String, timeoutMs: Long, input: ByteArray? = null, onProgress: Progress = {}): String {
        val result = try {
            if (input == null) conn.exec(command, timeoutMs) else conn.exec(command, input, onProgress, timeoutMs)
        } catch (e: IOException) {
            throw LinkDown(e.message ?: "lost the connection to $mac")
        }
        val exit = result.exit ?: throw LinkDown("$mac did not answer in time")
        // Tool errors come back as JSON with a non-zero exit; no output at all means the tool itself did not run.
        if (exit != 0 && result.stdout.isBlank()) {
            val detail = result.stderr.lineSequence().firstOrNull { it.isNotBlank() }?.let { ": $it" } ?: ""
            throw LinkDown("swarmz failed on $mac (exit $exit)$detail")
        }
        return result.stdout
    }

    /** Runs [command] and decodes its reply, off the main thread: replies such as transcript pages and images are large. */
    suspend inline fun <reified T> call(command: String): T {
        val text = exec(command)
        return if (onMainThread()) withContext(Dispatchers.Default) { ToolJson.decode<T>(text) } else ToolJson.decode(text)
    }

    fun follow(command: () -> String): Flow<String> = flow {
        while (true) {
            val conn = current.first { it != null && state.value is LinkState.Online }!!
            val line = command()
            // Only the remote stream's own failure is caught here; the collector's exceptions pass straight through.
            var failure: Throwable? = null
            followSlots.withPermit { conn.lines(line).catch { failure = it }.collect { emit(it) } }
            val dropped = current.value !== conn || !conn.isOpen
            val error = failure
            if (error == null && !dropped) return@flow
            if (error is ToolFailure) throw error
            if (error != null && !dropped) {
                // The connection may be dropping and the watch not have noticed yet; give it a moment.
                withTimeoutOrNull(DROP_GRACE_MS) {
                    current.first { it !== conn }
                    true
                } ?: throw error
            }
            // Wait until this connection is replaced, then run the command again.
            current.first { it !== conn }
        }
    }
}
