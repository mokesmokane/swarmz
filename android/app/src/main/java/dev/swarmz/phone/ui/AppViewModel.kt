package dev.swarmz.phone.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.swarmz.phone.data.Banner
import dev.swarmz.phone.data.Paired
import dev.swarmz.phone.data.Repository
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
import dev.swarmz.phone.ui.tile.TileController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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
}

data class HomeUi(
    val model: HomeModel,
    val sections: List<ListSection>,
    val asks: Map<TileKey, Pending>,
    val banners: List<Banner>,
    val macs: List<MacInfo>,
    val now: Instant,
    val seen: Map<TileKey, Instant> = emptyMap(),
)

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

    /** Whether the app is on screen (resumed). Tiles are only marked seen while it is. */
    val visible = MutableStateFlow(false)

    fun setVisible(on: Boolean) {
        visible.value = on
    }

    private val asks = MutableStateFlow<Map<TileKey, Pending>>(emptyMap())

    /*
     * Plain maps: every reader and writer runs on the view model's scope, whose dispatcher is single-threaded (Main).
     *
     * `asked` holds, per tile, the `since` whose question is fetched, being fetched (with retries) or given up on.
     * While it matches the row, tiles emissions start nothing. `fetches` holds each tile's one fetch-or-retry job.
     */
    private val asked = mutableMapOf<TileKey, String?>()
    private val fetches = mutableMapOf<TileKey, Job>()

    val home: StateFlow<HomeUi> = combine(
        combine(repo.tiles, repo.seen, repo.macs, repo.banners) { tiles, seen, macs, banners -> Inputs(tiles, seen, macs, banners) },
        asks,
        ticks,
    ) { i, a, _ ->
        HomeUi(homeModel(i.tiles, i.seen), tileListSections(i.tiles, i.seen, i.macs), a, i.banners, i.macs, now(), i.seen)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HomeUi(HomeModel(emptyList(), emptyList()), emptyList(), emptyMap(), emptyList(), emptyList(), now()))

    private data class Inputs(val tiles: List<TileView>, val seen: Map<TileKey, Instant>, val macs: List<MacInfo>, val banners: List<Banner>)

    init {
        viewModelScope.launch {
            repo.tiles.collect { tiles ->
                val permission = permissionViews(tiles)
                val live = permission.map { it.key }.toSet()
                asks.update { a -> a.filterKeys { it in live } }
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

    private fun forget(key: TileKey) {
        asked.remove(key)
        fetches.remove(key)?.cancel()
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
                if (delayMs > 0) delay(delayMs)
                var attempt = 0
                while (true) {
                    val p = try {
                        repo.pending(key)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: ToolFailure) {
                        if (current()) asks.update { it - key }
                        return@launch
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

    fun openNewSession() {
        _route.value = Route.NewSession
    }

    fun openSettings() {
        _route.value = Route.Settings
    }

    fun back(): Boolean {
        if (_route.value == Route.Home) return false
        _tile.value?.close()
        _tile.value = null
        _route.value = Route.Home
        return true
    }

    private fun answer(key: TileKey, choice: String) {
        val ask = asks.value[key] ?: return
        asks.update { it - key }
        viewModelScope.launch {
            val answered = try {
                repo.answer(key, choice, ask.summary).answered
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            // If the tile still needs a permission, ask the screen again. `answer` returns before Claude closes the
            // dialog, so after a real answer wait a moment; after an ignored or failed one, ask at once.
            refetch(key, if (answered) ASK_RETRY_MS else 0)
        }
    }

    fun allowOnce(key: TileKey) = answer(key, "yes")

    fun deny(key: TileKey) = answer(key, "deny")

    fun reply(key: TileKey, text: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            runCatching { repo.send(key, text) }
        }
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

    override fun onCleared() {
        _tile.value?.close()
    }
}
