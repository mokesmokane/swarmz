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
import dev.swarmz.phone.proto.PHONE_KEY_EXEC_MS
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
import dev.swarmz.phone.state.parseTime
import dev.swarmz.phone.state.withOlder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

private const val DISCOVERY_MS = 5 * 60_000L

data class Banner(val mac: String, val text: String)

/** A Mac that refused this phone's key and has no pairing of its own: Home offers to pair it. */
data class PairHint(val mac: String, val label: String)

/** A revoke that did not reach every Mac. [revoked] and [failed] are labels, in pairing order. */
class RevokeFailure(val revoked: List<String>, val failed: List<String>, message: String) : Exception(message)

/** An address is only ever itself; a name also matches its short MagicDNS form (`studio` is `studio.tail.ts.net`). */
private fun isAddress(name: String) = name.contains(':') || name.isNotEmpty() && name.all { it.isDigit() || it == '.' }

/** Whether two names mean the same Mac. */
internal fun sameMac(a: String, b: String): Boolean {
    if (a.equals(b, ignoreCase = true)) return true
    if (isAddress(a) || isAddress(b)) return false
    val short = a.substringBefore('.')
    return short.isNotEmpty() && short.equals(b.substringBefore('.'), ignoreCase = true)
}

/** The user to log in to [mac] with: its own pairing's, else the first pairing's. */
internal fun userFor(mac: String, pairings: List<Paired>): String? =
    pairings.firstOrNull { sameMac(it.host, mac) }?.user ?: pairings.firstOrNull()?.user

/** Whether [mac] is one of the paired Macs. */
internal fun isPaired(mac: String, pairings: List<Paired>) = pairings.any { sameMac(it.host, mac) }

private data class LinkSnapshot(val link: MacLink, val state: LinkState, val tiles: Map<String, TileRow>, val lastSeen: Long?)

class TranscriptSession internal constructor(scope: CoroutineScope, private val link: MacLink, private val tile: String) {
    private val _state = MutableStateFlow(TranscriptState())
    val state: StateFlow<TranscriptState> = _state.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    internal val job: Job = scope.launch {
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
            _error.value = "Couldn't read this conversation"
        }
    }

    suspend fun loadOlder() {
        val s = _state.value
        val before = s.oldestId ?: return
        if (!s.hasMore) return
        val page = link.call<TranscriptPage>(Cmd.transcript(tile, before = before))
        _state.update { it.withOlder(page) }
    }

    /** Ends the session from outside, e.g. because its Mac's link stopped. */
    internal fun end(message: String) {
        if (job.isActive) _error.value = message
        job.cancel()
    }

    fun close() = job.cancel()
}

class OutputSession internal constructor(scope: CoroutineScope, link: MacLink, tile: String) {
    private val _state = MutableStateFlow(ScreenState())
    val state: StateFlow<ScreenState> = _state.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    internal val job: Job = scope.launch {
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
            _error.value = "Couldn't read this tile's output"
        }
    }

    /** Ends the session from outside, e.g. because its Mac's link stopped. */
    internal fun end(message: String) {
        if (job.isActive) _error.value = message
        job.cancel()
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
    /** The user each link logs in with, so a pairing change can tell which links need restarting. */
    private val linkUsers = mutableMapOf<String, String>()
    /** One discovery round per paired Mac, with the link it follows. */
    private val discoveries = mutableMapOf<String, Pair<MacLink, Job>>()
    /** Held while the link map is rebuilt, so a discovery round and a pairing change cannot cross. */
    private val linkChanges = kotlinx.coroutines.sync.Mutex()
    private val started = AtomicBoolean(false)
    /** Open sessions: their jobs, and each one's Mac and how to end it. */
    private val sessions = mutableMapOf<Job, Pair<String, (String) -> Unit>>()

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

    /**
     * What Home shows above the cards. A Mac other than the paired one that refuses the key is left out: it was
     * offline when this phone paired, and Settings explains that.
     */
    val banners: StateFlow<List<Banner>> = combine(snapshots, labels, settings.pairings) { snaps, names, pairings ->
        snaps.mapNotNull { s ->
            val label = names[s.link.mac] ?: s.link.mac
            when (val st = s.state) {
                is LinkState.TooOld -> Banner(s.link.mac, "Update swarmz on $label")
                is LinkState.Blocked -> if (st.keyRejected && !isPaired(s.link.mac, pairings)) null else Banner(s.link.mac, st.reason)
                else -> null
            }
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    /** The Macs that refused this phone's key and have no pairing: they can be paired one by one. */
    val pairHints: StateFlow<List<PairHint>> = combine(snapshots, labels, settings.pairings) { snaps, names, pairings ->
        snaps.mapNotNull { s ->
            val st = s.state
            if (st is LinkState.Blocked && st.keyRejected && !isPaired(s.link.mac, pairings)) PairHint(s.link.mac, names[s.link.mac] ?: s.link.mac)
            else null
        }
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    val seen: StateFlow<Map<TileKey, Instant>> = settings.seen

    val macStates: StateFlow<Map<String, LinkState>> = snapshots
        .map { s -> s.associate { it.link.mac to it.state } }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())

    /** The distinct folders of [mac]'s tiles, most recently active first, at most 6. */
    fun recentFolders(mac: String): List<String> =
        tiles.value.filter { it.key.mac == mac }
            .sortedByDescending { parseTime(it.row.turnEndedAt) ?: parseTime(it.row.since) ?: Instant.EPOCH }
            .map { it.row.cwd }
            .distinct()
            .take(6)

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            var previous: List<Paired> = emptyList()
            settings.pairings.collect { pairings ->
                // A new first pairing (or none) starts over; anything else only adds or fixes the links it names.
                if (previous.isNotEmpty() && pairings.firstOrNull() == previous.first()) {
                    previous = pairings
                    applyPairings(pairings)
                    return@collect
                }
                // Joined, so a round that already read the old links cannot write them back after the reset.
                stopEverything()
                if (previous.isNotEmpty() && pairings.isNotEmpty()) settings.setMacs(emptyList())
                previous = pairings
                if (pairings.isNotEmpty()) pair(pairings, settings.loadMacs())
            }
        }
    }

    private suspend fun stopEverything() {
        discoveries.values.forEach { it.second.cancelAndJoin() }
        discoveries.clear()
        links.value.values.forEach { it.stop() }
        endSessions()
        links.value = emptyMap()
        labels.value = emptyMap()
        linkUsers.clear()
    }

    private fun newLink(user: String, host: String): MacLink {
        linkUsers[host] = user
        return MacLink(host, host, { Auth.Key(user, key()) }, connector, scope) { now().toEpochMilli() }.also { it.start() }
    }

    /** The link key for [host], which may be its short or full name. */
    private fun keyOf(host: String): String? = links.value.keys.firstOrNull { sameMac(it, host) }

    /**
     * Links every paired Mac and the Macs saved from earlier rounds ([known]) at once, so they are reachable while a
     * paired Mac is offline. Discovery then adds new Macs; it never removes one, since `machines` leaves out
     * Macs that are merely asleep.
     */
    private suspend fun pair(pairings: List<Paired>, known: List<KnownMac>) {
        val initial = LinkedHashMap<String, MacLink>()
        val names = mutableMapOf<String, String>()
        for (p in pairings) if (initial.keys.none { sameMac(it, p.host) }) initial[p.host] = newLink(p.user, p.host)
        for (m in known) {
            // A saved Mac that is a paired one under its other name keeps the one link, and lends it its label.
            val existing = initial.keys.firstOrNull { sameMac(it, m.name) }
            names[existing ?: m.name] = m.label
            if (existing == null) initial[m.name] = newLink(userFor(m.name, pairings)!!, m.name)
        }
        links.value = initial
        labels.value = names
        for (p in pairings) keyOf(p.host)?.let { ensureDiscovery(it) }
    }

    /**
     * Applies a changed pairing list without disturbing the links it does not touch: a link whose user is now a
     * different one is restarted, a paired Mac with no link gets one, and every other link is only nudged to retry.
     */
    private suspend fun applyPairings(pairings: List<Paired>) {
        linkChanges.withLock {
            val next = LinkedHashMap(links.value)
            for ((mac, link) in links.value) {
                val user = userFor(mac, pairings) ?: continue
                if (linkUsers[mac] == user) {
                    // A Mac that refused the old key can try again now, at once.
                    link.retryNow()
                    continue
                }
                link.stop()
                endSessions(mac)
                next[mac] = newLink(user, mac)
            }
            for (p in pairings) if (next.keys.none { sameMac(it, p.host) }) next[p.host] = newLink(p.user, p.host)
            links.value = next
        }
        for (p in pairings) keyOf(p.host)?.let { ensureDiscovery(it) }
    }

    /** Runs a discovery round on [mac]'s link each time it comes online, then every 5 minutes while it stays online. */
    private suspend fun ensureDiscovery(mac: String) {
        val link = links.value[mac] ?: return
        val current = discoveries[mac]
        if (current != null && current.first === link) return
        current?.second?.cancelAndJoin()
        discoveries[mac] = link to scope.launch {
            link.state.map { it is LinkState.Online }.distinctUntilChanged().collectLatest { online ->
                if (!online) return@collectLatest
                while (true) {
                    link.state.first { it is LinkState.Online }
                    discover(link)
                    delay(DISCOVERY_MS)
                }
            }
        }
    }

    private suspend fun discover(primary: MacLink) {
        val list = try {
            primary.call<MachineList>(Cmd.machines()).machines
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Retried on the next round.
            return
        }
        linkChanges.withLock {
            val pairings = settings.pairings.value
            val names = mutableMapOf<String, String>()
            // This Mac names itself, alias or not; another Mac without an alias does not rename one we know.
            list.firstOrNull { it.isSelf }?.let { names[primary.mac] = it.alias ?: it.name }
            // Only adds: `machines` leaves out Macs that are asleep, and those stay (dimmed, with "last seen").
            val next = LinkedHashMap(links.value)
            for (m in list.filter { !it.isSelf }) {
                val existing = next.keys.firstOrNull { sameMac(it, m.name) }
                val mac = existing ?: m.name
                names[mac] = m.alias ?: labels.value[mac] ?: m.name
                if (existing == null) next[mac] = newLink(userFor(mac, pairings) ?: return@withLock, mac)
            }
            links.value = next
            // A Mac this round did not list keeps the label it had.
            val merged = labels.value + names
            labels.value = merged
            val saved = settings.macs.value.associateBy { it.name }
            settings.setMacs(next.keys.map { mac -> KnownMac(mac, merged[mac] ?: mac, next[mac]?.lastSeen?.value ?: saved[mac]?.lastSeen) })
        }
    }

    private fun register(job: Job, mac: String, end: (String) -> Unit) {
        synchronized(sessions) { sessions[job] = mac to end }
        job.invokeOnCompletion { synchronized(sessions) { sessions.remove(job) } }
    }

    /** Ends the open sessions of [mac] (or every one), whose link is being stopped, where `follow` would wait for ever. */
    private fun endSessions(mac: String? = null) {
        val open = synchronized(sessions) {
            val ending = sessions.filterValues { mac == null || it.first == mac }
            ending.keys.forEach(sessions::remove)
            ending.values.map { it.second }
        }
        open.forEach { it("Disconnected") }
    }

    fun retry(mac: String) {
        keyOf(mac)?.let { links.value[it]?.retryNow() }
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

    fun openTranscript(key: TileKey): TranscriptSession =
        TranscriptSession(scope, link(key.mac), key.id).also { register(it.job, key.mac, it::end) }

    fun openOutput(key: TileKey): OutputSession =
        OutputSession(scope, link(key.mac), key.id).also { register(it.job, key.mac, it::end) }

    /**
     * Removes this phone's key from every paired Mac, in parallel, then forgets the pairing. Throws [RevokeFailure]
     * when some Macs answered and others did not (a single pairing throws its own error), keeping the pairings.
     */
    suspend fun revokeThisPhone() {
        val pairings = settings.pairings.value
        if (pairings.isEmpty()) return
        val results = coroutineScope {
            pairings.map { p ->
                async {
                    p to try {
                        withTimeout(PHONE_KEY_EXEC_MS) { ToolJson.obj(link(keyOf(p.host) ?: p.host).exec(Cmd.phoneRevoke(p.device), timeoutMs = PHONE_KEY_EXEC_MS)) }
                        null
                    } catch (e: TimeoutCancellationException) {
                        LinkDown("${p.host} did not answer in time")
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        e
                    }
                }
            }.awaitAll()
        }
        if (results.all { it.second == null }) {
            settings.forgetPairing()
            return
        }
        if (pairings.size == 1) throw results.first().second!!
        val labelOf = { p: Paired -> labels.value[keyOf(p.host) ?: p.host] ?: p.host }
        val revoked = results.filter { it.second == null }.map { labelOf(it.first) }
        val failed = results.filter { it.second != null }
        val parts = mutableListOf<String>()
        if (revoked.isNotEmpty()) parts += "Revoked on " + revoked.joinToString(", ")
        for ((p, e) in failed) parts += if (e is LinkDown) "couldn't reach ${labelOf(p)}" else "${labelOf(p)}: ${e?.message ?: "unknown error"}"
        throw RevokeFailure(revoked, failed.map { labelOf(it.first) }, parts.joinToString("; ").replaceFirstChar { it.uppercase() })
    }

    /** Forgets the pairing on this phone only; the Macs keep the key. */
    suspend fun forgetLocally() {
        settings.forgetPairing()
    }

    /** Records that the user has looked at [key], at [at] or else now. */
    fun markSeen(key: TileKey, at: Instant? = null) {
        scope.launch { settings.markSeen(key, at ?: now()) }
    }
}
