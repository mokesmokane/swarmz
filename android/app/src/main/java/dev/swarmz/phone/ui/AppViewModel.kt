package dev.swarmz.phone.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.swarmz.phone.data.Banner
import dev.swarmz.phone.data.PairHint
import dev.swarmz.phone.data.userFor
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.data.RevokeFailure
import dev.swarmz.phone.data.SettingsStore
import dev.swarmz.phone.pairing.Pairing
import dev.swarmz.phone.pairing.PairingError
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.proto.ToolFailure
import dev.swarmz.phone.state.HomeModel
import dev.swarmz.phone.state.ListSection
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.Need
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TileView
import dev.swarmz.phone.state.homeModel
import dev.swarmz.phone.state.needOf
import dev.swarmz.phone.state.parseTime
import dev.swarmz.phone.state.tileListSections
import dev.swarmz.phone.ui.newsession.NewSessionModel
import dev.swarmz.phone.ui.tile.TileController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import kotlin.math.min

sealed interface Route {
    data object Home : Route
    data class Tile(val key: TileKey) : Route
    data object NewSession : Route
    data object Settings : Route
    /** Pairing another Mac: [host] and [user] are what its fields start with. */
    data class AddMac(val host: String?, val user: String?) : Route
}

data class HomeUi(
    val model: HomeModel,
    val sections: List<ListSection>,
    val asks: Map<TileKey, Pending>,
    val banners: List<Banner>,
    val macs: List<MacInfo>,
    val now: Instant,
    val seen: Map<TileKey, Instant> = emptyMap(),
    val replyErrors: Map<TileKey, ReplyError> = emptyMap(),
    /** Macs that refused this phone's key and have no pairing yet. */
    val pairHints: List<PairHint> = emptyList(),
)

/** A Home reply that did not send: its [text] goes back into the card's field once ([restored] after that). */
data class ReplyError(val text: String, val message: String, val restored: Boolean = false)

data class PairingUi(val busy: Boolean = false, val error: String? = null)

/** Emits at once, then every [periodMs], so relative times on the home screen stay current. */
fun ticker(periodMs: Long): Flow<Unit> = flow {
    while (true) {
        emit(Unit)
        delay(periodMs)
    }
}

private const val TICK_MS = 30_000L
private const val ASK_RETRY_MS = 2_000L
private const val ASK_RETRY_MAX_MS = 30_000L

/** Tool error codes that do not clear by themselves; any other code (e.g. `failed`, a timeout) is retried. */
private val FINAL_ASK_CODES = setOf("old_session", "not_running", "invalid")

/** 2 s, 4 s, 8 s, 16 s, then 30 s. */
internal fun askBackoffMs(attempt: Int): Long = min(ASK_RETRY_MAX_MS, ASK_RETRY_MS shl min(attempt, 5))

class AppViewModel(
    val repo: Repository,
    val settings: SettingsStore,
    private val pairing: Pairing?,
    private val forgetKey: () -> Unit = {},
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    val now: () -> Instant = Instant::now,
    ticks: Flow<Any?> = ticker(TICK_MS),
) : ViewModel(scope) {
    val paired: StateFlow<Paired?> = settings.paired

    private val _route = MutableStateFlow<Route>(Route.Home)
    val route: StateFlow<Route> = _route.asStateFlow()

    private val _tile = MutableStateFlow<TileController?>(null)
    val tile: StateFlow<TileController?> = _tile.asStateFlow()

    private val _pairingUi = MutableStateFlow(PairingUi())
    val pairingUi: StateFlow<PairingUi> = _pairingUi.asStateFlow()

    /** Add mode's own busy and error state, so the first pairing screen's is untouched. */
    private val _addMacUi = MutableStateFlow(PairingUi())
    val addMacUi: StateFlow<PairingUi> = _addMacUi.asStateFlow()

    /** Where add mode came from, and where cancelling or a successful add returns to. */
    private var addReturn: Route = Route.Home

    /** The Macs whose Home hint the user has dismissed; they come back next launch. */
    private val dismissedHints = MutableStateFlow<Set<String>>(emptySet())

    /** Whether the app is on screen (resumed). Tiles are only marked seen while it is. */
    val visible = MutableStateFlow(false)

    fun setVisible(on: Boolean) {
        visible.value = on
    }

    private val asks = MutableStateFlow<Map<TileKey, Pending>>(emptyMap())
    private val replyErrors = MutableStateFlow<Map<TileKey, ReplyError>>(emptyMap())

    /*
     * Plain maps: every reader and writer runs on the view model's scope, whose dispatcher is single-threaded (Main).
     *
     * `asked` holds, per tile, the `since` whose question is fetched, being fetched (with retries) or given up on.
     * While it matches the row, tiles emissions start nothing. `fetches` holds each tile's one fetch-or-retry job.
     */
    private val asked = mutableMapOf<TileKey, String?>()
    private val fetches = mutableMapOf<TileKey, Job>()

    /**
     * Per tile, a job that completes when fetching may resume after an answer: at once after an ignored or failed
     * answer, [ASK_RETRY_MS] after a real one (Claude closes its dialog a moment after `answer` returns). A job
     * rather than a time, so it runs on the same clock as `delay`.
     */
    private val holds = mutableMapOf<TileKey, CompletableJob>()

    /** Per failed reply, the tile's turn (`since`, `turnEndedAt`) when it failed. */
    private val replyTurns = mutableMapOf<TileKey, Pair<String?, String?>>()

    private fun turnOf(view: TileView?): Pair<String?, String?> = view?.row?.since to view?.row?.turnEndedAt

    val home: StateFlow<HomeUi> = combine(
        combine(repo.tiles, repo.seen, repo.macs, repo.banners, repo.pairHints) { tiles, seen, macs, banners, hints ->
            Inputs(tiles, seen, macs, banners, hints)
        },
        asks,
        replyErrors,
        ticks,
        dismissedHints,
    ) { i, a, r, _, dismissed ->
        HomeUi(
            homeModel(i.tiles, i.seen),
            tileListSections(i.tiles, i.seen, i.macs),
            a,
            i.banners,
            i.macs,
            now(),
            i.seen,
            r,
            i.hints.filter { it.mac !in dismissed },
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HomeUi(HomeModel(emptyList(), emptyList()), emptyList(), emptyMap(), emptyList(), emptyList(), now()))

    private data class Inputs(
        val tiles: List<TileView>,
        val seen: Map<TileKey, Instant>,
        val macs: List<MacInfo>,
        val banners: List<Banner>,
        val hints: List<PairHint>,
    )

    init {
        viewModelScope.launch {
            repo.tiles.collect { tiles ->
                val permission = permissionViews(tiles)
                val live = permission.map { it.key }.toSet()
                asks.update { a -> a.filterKeys { it in live } }
                // A failed reply belongs to the turn it answered: it goes when the tile goes or moves on.
                val turns = tiles.associate { it.key to turnOf(it) }
                replyErrors.update { r -> r.filterKeys { k -> k in turns && turns[k] == replyTurns[k] } }
                replyTurns.keys.retainAll(replyErrors.value.keys)
                for (key in (asked.keys + fetches.keys).filter { it !in live }) forget(key)
                for (view in permission) fetchAsk(view)
            }
        }
        viewModelScope.launch {
            // Keep the open tile seen while new turns end in front of the user, and once more when the app comes back.
            combine(route, repo.tiles, visible) { r, tiles, shown ->
                val view = (r as? Route.Tile)?.let { t -> tiles.firstOrNull { it.key == t.key } }
                Triple(view?.key, view?.row?.turnEndedAt, shown)
            }
                .distinctUntilChanged()
                .collect { (key, ended, shown) -> if (key != null && shown) markSeen(key, ended) }
        }
    }

    private fun permissionViews(tiles: List<TileView>): List<TileView> {
        val seen = repo.seen.value
        return tiles.filter { needOf(it.row, seen[it.key]) == Need.Permission }
    }

    /** Stores the later of the phone's clock and the Mac's turn end, so a Mac clock ahead of the phone cannot resurface the turn. */
    private fun markSeen(key: TileKey, turnEndedAt: String?) {
        val phone = now()
        val mac = parseTime(turnEndedAt)
        repo.markSeen(key, if (mac != null && mac.isAfter(phone)) mac else phone)
    }

    /** The tile no longer needs a permission: drop its fetch state, and any answer's hold, which belonged to the old question. */
    private fun forget(key: TileKey) {
        asked.remove(key)
        fetches.remove(key)?.cancel()
        holds.remove(key)?.complete()
    }

    /**
     * Fetches [view]'s question unless its `since` is already handled; [force] fetches again anyway. Replaces any
     * earlier job for the tile. Retries an empty or failed fetch with backoff; a tool error (e.g. `old_session`)
     * is not retried, and the card stays hidden until `since` changes.
     */
    private fun fetchAsk(view: TileView, force: Boolean = false, delayMs: Long = 0) {
        val key = view.key
        val since = view.row.since
        if (!force && key in asked && asked[key] == since) return
        fetches.remove(key)?.cancel()
        asked[key] = since
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            val self = coroutineContext.job
            fun current() = fetches[key] === self
            try {
                // The longer of the requested delay and what is left of an answer's hold.
                coroutineScope {
                    if (delayMs > 0) launch { delay(delayMs) }
                    holds[key]?.join()
                }
                var attempt = 0
                while (true) {
                    val p = try {
                        repo.pending(key)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: ToolFailure) {
                        // A tile that needs a restart (or cannot be asked) stays without a card until its row changes.
                        if (e.code in FINAL_ASK_CODES) {
                            if (current()) asks.update { it - key }
                            return@launch
                        }
                        null
                    } catch (_: Exception) {
                        null
                    }
                    if (!current()) return@launch
                    if (p != null) {
                        asks.update { it + (key to p) }
                        return@launch
                    }
                    // Nothing to show (yet): the hook log can run ahead of the screen, or the link is down.
                    asks.update { it - key }
                    delay(askBackoffMs(attempt++))
                }
            } finally {
                if (current()) fetches.remove(key)
            }
        }
        fetches[key] = job
        job.start()
    }

    /** Fetches the question again if the tile still needs a permission. */
    private fun refetch(key: TileKey, delayMs: Long) {
        val view = permissionViews(repo.tiles.value).firstOrNull { it.key == key } ?: return
        fetchAsk(view, force = true, delayMs = delayMs)
    }

    fun open(key: TileKey) {
        if (_tile.value?.key != key) {
            _tile.value?.close()
            _tile.value = TileController(key, repo, viewModelScope, now)
        }
        _route.value = Route.Tile(key)
        if (visible.value) markSeen(key, repo.tiles.value.firstOrNull { it.key == key }?.row?.turnEndedAt)
    }

    private var newSession: NewSessionModel? = null

    /** The new-session flow's model: kept while the screen is shown, fresh on each visit. */
    fun newSessionModel(): NewSessionModel = newSession ?: NewSessionModel(repo, viewModelScope).also { newSession = it }

    fun openNewSession() {
        if (_route.value != Route.NewSession) newSession = null
        _route.value = Route.NewSession
    }

    fun openSettings() {
        _route.value = Route.Settings
    }

    /** Opens add mode for [host] (or with no Mac chosen yet), coming back here when it ends. */
    fun openAddMac(host: String?) {
        val pairings = settings.pairings.value
        val user = if (host == null) pairings.firstOrNull()?.user else userFor(host, pairings)
        if (_route.value !is Route.AddMac) addReturn = _route.value
        _addMacUi.value = PairingUi()
        _route.value = Route.AddMac(host, user)
    }

    /** Hides this Mac's Home hint for the rest of this run. */
    fun dismissPairHint(mac: String) {
        dismissedHints.update { it + mac }
    }

    fun back(): Boolean {
        // Add mode returns to the screen it was opened from, which keeps whatever it had open.
        if (_route.value is Route.AddMac) {
            _route.value = addReturn
            return true
        }
        if (_route.value == Route.Home) return false
        _tile.value?.close()
        _tile.value = null
        newSession = null
        _route.value = Route.Home
        return true
    }

    /**
     * Revokes this phone's key on the Macs, then forgets the pairings and the key. Null on success, else what to
     * show: a partial revoke says where it worked. The work runs on the view model's scope: forgetting the pairing
     * removes the screen that asked for it.
     */
    suspend fun revoke(): String? = viewModelScope.async {
        try {
            repo.revokeThisPhone()
            forgetKey()
            back()
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: RevokeFailure) {
            e.message ?: "Couldn't revoke on some Macs"
        } catch (e: Exception) {
            "Couldn't revoke: ${e.message ?: "unknown error"}"
        }
    }.await()

    /** Forgets the pairing and the key on this phone only, e.g. after a revoke that could not finish. */
    fun forgetLocally() {
        viewModelScope.launch {
            repo.forgetLocally()
            forgetKey()
            back()
        }
    }

    fun setBackgroundWatch(on: Boolean) {
        viewModelScope.launch { settings.setBackgroundWatch(on) }
    }

    fun setNotify(kind: String, on: Boolean) {
        viewModelScope.launch {
            val kinds = settings.notifyKinds.value
            settings.setNotifyKinds(if (on) kinds + kind else kinds - kind)
        }
    }

    fun setLanguage(tag: String?) {
        viewModelScope.launch { settings.setDictationLanguage(tag) }
    }

    /** The unfolded tile list's width in dp, and whether it is hidden; both are stored, so they outlive a fold. */
    val listWidth: StateFlow<Int> = settings.listWidth
    val listCollapsed: StateFlow<Boolean> = settings.listCollapsed

    fun setListWidth(dp: Int) {
        viewModelScope.launch { settings.setListWidth(dp) }
    }

    fun setListCollapsed(on: Boolean) {
        viewModelScope.launch { settings.setListCollapsed(on) }
    }

    private fun answer(key: TileKey, choice: String) {
        val ask = asks.value[key] ?: return
        asks.update { it - key }
        val hold = Job()
        holds.put(key, hold)?.complete()
        viewModelScope.launch {
            val answered = try {
                repo.answer(key, choice, ask.summary).answered
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            // If the tile still needs a permission, ask the screen again: once the hold ends, which is at once after
            // an ignored or failed answer. A fetch started meanwhile (e.g. by a new `since`) waits for the same hold.
            refetch(key, 0)
            if (answered) delay(ASK_RETRY_MS)
            hold.complete()
            if (holds[key] === hold) holds.remove(key)
        }
    }

    fun allowOnce(key: TileKey) = answer(key, "yes")

    fun deny(key: TileKey) = answer(key, "deny")

    /** Sends a Home reply. A failure comes back on [home] as the card's [ReplyError], with the text to put back. */
    fun reply(key: TileKey, text: String) {
        if (text.isBlank()) return
        replyErrors.update { it - key }
        viewModelScope.launch {
            try {
                repo.send(key, text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                replyTurns[key] = turnOf(repo.tiles.value.firstOrNull { it.key == key })
                replyErrors.update { it + (key to ReplyError(text, "Couldn't send: ${e.message ?: "unknown error"}")) }
            }
        }
    }

    /** The card has put the failed reply's text back; its error stays shown until the next send. */
    fun replyRestored(key: TileKey) {
        replyErrors.update { r -> r[key]?.let { r + (key to it.copy(restored = true)) } ?: r }
    }

    fun pair(host: String, user: String, password: CharArray, device: String) {
        val p = pairing ?: return
        _pairingUi.value = PairingUi(busy = true)
        viewModelScope.launch {
            val error = try {
                withContext(Dispatchers.IO) { p.pair(host.trim(), user.trim(), password, device.trim()) }
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairingError) {
                e.message
            } catch (e: Exception) {
                "Pairing failed: ${e.message}"
            }
            _pairingUi.value = PairingUi(busy = false, error = error)
        }
    }

    /** Adds another Mac with the saved device name; on success the link starts and the flow returns where it began. */
    fun addMac(host: String, user: String, password: CharArray) {
        val p = pairing ?: return
        _addMacUi.value = PairingUi(busy = true)
        viewModelScope.launch {
            val error = try {
                withContext(Dispatchers.IO) { p.pair(host.trim(), user.trim(), password, "") }
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairingError) {
                e.message
            } catch (e: Exception) {
                "Pairing failed: ${e.message}"
            }
            _addMacUi.value = PairingUi(busy = false, error = error)
            if (error == null) {
                repo.retry(host.trim())
                if (_route.value is Route.AddMac) _route.value = addReturn
            }
        }
    }

    override fun onCleared() {
        _tile.value?.close()
    }
}
