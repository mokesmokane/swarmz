package dev.swarmz.phone.link

import dev.swarmz.phone.proto.APP_PROTOCOL
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.proto.ToolJson
import dev.swarmz.phone.proto.Version
import dev.swarmz.phone.proto.WatchEvent
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.AuthRejected
import dev.swarmz.phone.ssh.HostKeyChanged
import dev.swarmz.phone.ssh.SshConnection
import dev.swarmz.phone.ssh.SshConnector
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.min

sealed interface LinkState {
    data object Idle : LinkState
    data object Connecting : LinkState
    data class Online(val version: Version) : LinkState
    data class Offline(val reason: String, val retryAt: Long) : LinkState
    data class Blocked(val reason: String) : LinkState
    data class TooOld(val version: Version) : LinkState
}

class LinkDown(message: String) : Exception(message)

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

    fun retryNow() {
        kick.trySend(Unit)
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
                _state.value = LinkState.Blocked("$mac refused this phone's key. Pair again from Settings.")
                pause(null)
                continue
            } catch (e: Exception) {
                val wait = backoffMs(attempt++)
                _state.value = LinkState.Offline(e.message ?: "unreachable", now() + wait)
                pause(wait)
                continue
            }
            try {
                val version = ToolJson.decode<Version>(conn.exec(Cmd.version()).stdout)
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
                conn.lines(Cmd.watch()).collect { line ->
                    _lastSeen.value = now()
                    when (val ev = ToolJson.watchEvent(line)) {
                        is WatchEvent.Snapshot -> _tiles.value = ev.tiles.associateBy { it.id }
                        is WatchEvent.Tile -> _tiles.update { it + (ev.tile.id to ev.tile) }
                        is WatchEvent.Gone -> _tiles.update { it - ev.id }
                        WatchEvent.Ping, null -> Unit
                    }
                }
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

    private suspend fun online(waitMs: Long): SshConnection =
        withTimeoutOrNull(waitMs) { current.first { it != null && state.value is LinkState.Online } }
            ?: throw LinkDown("$mac is offline")

    suspend fun exec(command: String, waitMs: Long = 15_000): String = online(waitMs).exec(command).stdout

    suspend inline fun <reified T> call(command: String): T = ToolJson.decode(exec(command))

    fun follow(command: () -> String): Flow<String> = flow {
        while (true) {
            val conn = current.first { it != null && state.value is LinkState.Online }!!
            try {
                conn.lines(command()).collect { emit(it) }
                return@flow
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Wait until this connection is replaced, then run the command again.
                current.first { it !== conn }
            }
        }
    }
}
