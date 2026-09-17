package dev.swarmz.phone.data

import dev.swarmz.phone.keys.PhoneKey
import dev.swarmz.phone.link.LinkDown
import dev.swarmz.phone.link.LinkState
import dev.swarmz.phone.link.MacLink
import dev.swarmz.phone.proto.AnswerReply
import dev.swarmz.phone.proto.Cmd
import dev.swarmz.phone.proto.Folders
import dev.swarmz.phone.proto.ImageReply
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.MachineList
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.PendingReply
import dev.swarmz.phone.proto.SentReply
import dev.swarmz.phone.proto.TileReply
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.proto.ToolJson
import dev.swarmz.phone.proto.TranscriptPage
import dev.swarmz.phone.ssh.Auth
import dev.swarmz.phone.ssh.SshConnector
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.ScreenState
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TileView
import dev.swarmz.phone.state.TranscriptState
import dev.swarmz.phone.state.apply
import dev.swarmz.phone.state.lastId
import dev.swarmz.phone.state.oldestId
import dev.swarmz.phone.state.withOlder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

data class Banner(val mac: String, val text: String)

private data class LinkSnapshot(val link: MacLink, val state: LinkState, val tiles: Map<String, TileRow>, val lastSeen: Long?)

class TranscriptSession internal constructor(scope: CoroutineScope, private val link: MacLink, private val tile: String) {
    private val _state = MutableStateFlow(TranscriptState())
    val state: StateFlow<TranscriptState> = _state.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val job: Job = scope.launch {
        try {
            link.follow { Cmd.transcript(tile, after = _state.value.lastId, follow = true) }.collect { line ->
                ToolJson.transcriptEvent(line)?.let { ev -> _state.update { it.apply(ev) } }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ToolFailure) {
            _error.value = e.message
        } catch (e: Exception) {
            // Anything else (a malformed line, a stream failure that was not a drop) ends the session, not the app.
            _error.value = e.message ?: "the stream failed"
        }
    }

    suspend fun loadOlder() {
        val s = _state.value
        val before = s.oldestId ?: return
        if (!s.hasMore) return
        val page = link.call<TranscriptPage>(Cmd.transcript(tile, before = before))
        _state.update { it.withOlder(page) }
    }

    fun close() = job.cancel()
}

class OutputSession internal constructor(scope: CoroutineScope, link: MacLink, tile: String) {
    private val _state = MutableStateFlow(ScreenState())
    val state: StateFlow<ScreenState> = _state.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val job: Job = scope.launch {
        try {
            link.follow { Cmd.output(tile, lines = 300, follow = true) }.collect { line ->
                ToolJson.outputEvent(line)?.let { ev -> _state.update { it.apply(ev) } }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ToolFailure) {
            _error.value = e.message
        } catch (e: Exception) {
            // Anything else (a malformed line, a stream failure that was not a drop) ends the session, not the app.
            _error.value = e.message ?: "the stream failed"
        }
    }

    fun close() = job.cancel()
}

@OptIn(ExperimentalCoroutinesApi::class)
class Repository(
    private val settings: SettingsStore,
    private val key: () -> PhoneKey,
    private val connector: SshConnector,
    private val scope: CoroutineScope,
    private val now: () -> Instant = Instant::now,
) {
    private val links = MutableStateFlow<Map<String, MacLink>>(emptyMap())
    private val labels = MutableStateFlow<Map<String, String>>(emptyMap())
    private var discovery: Job? = null

    private val snapshots: StateFlow<List<LinkSnapshot>> = links.flatMapLatest { map ->
        if (map.isEmpty()) flowOf(emptyList())
        else combine(map.values.map { l -> combine(l.state, l.tiles, l.lastSeen) { s, t, seen -> LinkSnapshot(l, s, t, seen) } }) { it.toList() }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    val macs: StateFlow<List<MacInfo>> = combine(snapshots, labels, settings.macs) { snaps, names, known ->
        snaps.map { s ->
            val seen = s.lastSeen ?: known.firstOrNull { it.name == s.link.mac }?.lastSeen
            MacInfo(s.link.mac, names[s.link.mac] ?: s.link.mac, s.state is LinkState.Online, seen?.let(Instant::ofEpochMilli))
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    val tiles: StateFlow<List<TileView>> = combine(snapshots, labels) { snaps, names ->
        snaps.flatMap { s ->
            s.tiles.values.map { row -> TileView(TileKey(s.link.mac, row.id), row, names[s.link.mac] ?: s.link.mac, s.state is LinkState.Online) }
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    val banners: StateFlow<List<Banner>> = combine(snapshots, labels) { snaps, names ->
        snaps.mapNotNull { s ->
            val label = names[s.link.mac] ?: s.link.mac
            when (val st = s.state) {
                is LinkState.TooOld -> Banner(s.link.mac, "Update swarmz on $label")
                is LinkState.Blocked -> Banner(s.link.mac, st.reason)
                else -> null
            }
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    val seen: StateFlow<Map<TileKey, Instant>> = settings.seen

    fun start() {
        scope.launch {
            settings.paired.collect { p ->
                discovery?.cancel()
                links.value.values.forEach { it.stop() }
                links.value = emptyMap()
                labels.value = emptyMap()
                if (p != null) pair(p)
            }
        }
    }

    private fun newLink(p: Paired, host: String): MacLink =
        MacLink(host, host, { Auth.Key(p.user, key()) }, connector, scope) { now().toEpochMilli() }.also { it.start() }

    private fun pair(p: Paired) {
        val primary = newLink(p, p.host)
        links.value = mapOf(p.host to primary)
        discovery = scope.launch {
            while (true) {
                try {
                    val list = primary.call<MachineList>(Cmd.machines()).machines
                    val names = mutableMapOf<String, String>()
                    list.firstOrNull { it.isSelf }?.let { names[p.host] = it.alias ?: it.name }
                    val next = links.value.toMutableMap()
                    for (m in list.filter { !it.isSelf }) {
                        names[m.name] = m.alias ?: m.name
                        if (m.name !in next) next[m.name] = newLink(p, m.name)
                    }
                    links.value = next
                    labels.value = names
                    settings.setMacs(next.keys.map { mac -> KnownMac(mac, names[mac] ?: mac, next[mac]?.lastSeen?.value) })
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Retried on the next round.
                }
                delay(5 * 60_000L)
            }
        }
    }

    fun retry(mac: String) {
        links.value[mac]?.retryNow()
    }

    private fun link(mac: String): MacLink = links.value[mac] ?: throw LinkDown("$mac is not connected")

    suspend fun pending(key: TileKey): Pending? = link(key.mac).call<PendingReply>(Cmd.pending(key.id)).pending

    suspend fun answer(key: TileKey, choice: String, summary: String): AnswerReply =
        link(key.mac).call(Cmd.answer(key.id, choice, summary))

    suspend fun send(key: TileKey, text: String) {
        link(key.mac).call<SentReply>(Cmd.send(key.id, text))
    }

    suspend fun key(key: TileKey, k: Key) {
        link(key.mac).call<SentReply>(Cmd.key(key.id, k))
    }

    suspend fun restart(key: TileKey): TileRow = link(key.mac).call<TileReply>(Cmd.restart(key.id)).tile

    suspend fun newTile(mac: String, folder: String, skipPermissions: Boolean): TileKey =
        TileKey(mac, link(mac).call<TileReply>(Cmd.newTile(folder, skipPermissions)).tile.id)

    suspend fun folders(mac: String, path: String?): Folders = link(mac).call(Cmd.folders(path))

    suspend fun image(key: TileKey, imageId: String): ImageReply = link(key.mac).call(Cmd.image(key.id, imageId))

    fun openTranscript(key: TileKey) = TranscriptSession(scope, link(key.mac), key.id)

    fun openOutput(key: TileKey) = OutputSession(scope, link(key.mac), key.id)

    fun markSeen(key: TileKey) {
        scope.launch { settings.markSeen(key, now()) }
    }
}
