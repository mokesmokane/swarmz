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
import dev.swarmz.phone.state.HomeModel
import dev.swarmz.phone.state.ListSection
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.Need
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TileView
import dev.swarmz.phone.state.homeModel
import dev.swarmz.phone.state.needOf
import dev.swarmz.phone.state.tileListSections
import dev.swarmz.phone.ui.tile.TileController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

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
)

data class PairingUi(val busy: Boolean = false, val error: String? = null)

class AppViewModel(
    val repo: Repository,
    val settings: SettingsStore,
    private val pairing: Pairing?,
    private val forgetKey: () -> Unit = {},
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    val now: () -> Instant = Instant::now,
) : ViewModel(scope) {
    val paired: StateFlow<Paired?> = settings.paired

    private val _route = MutableStateFlow<Route>(Route.Home)
    val route: StateFlow<Route> = _route.asStateFlow()

    private val _tile = MutableStateFlow<TileController?>(null)
    val tile: StateFlow<TileController?> = _tile.asStateFlow()

    private val _pairingUi = MutableStateFlow(PairingUi())
    val pairingUi: StateFlow<PairingUi> = _pairingUi.asStateFlow()

    private val asks = MutableStateFlow<Map<TileKey, Pending>>(emptyMap())
    private val asked = mutableSetOf<Pair<TileKey, String?>>()

    val home: StateFlow<HomeUi> = combine(repo.tiles, repo.seen, repo.macs, repo.banners, asks) { tiles, seen, macs, banners, a ->
        HomeUi(homeModel(tiles, seen), tileListSections(tiles, seen, macs), a, banners, macs, now())
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HomeUi(HomeModel(emptyList(), emptyList()), emptyList(), emptyMap(), emptyList(), emptyList(), now()))

    init {
        viewModelScope.launch {
            repo.tiles.collect { tiles ->
                val seen = repo.seen.value
                val permission = tiles.filter { needOf(it.row, seen[it.key]) == Need.Permission }
                val live = permission.map { it.key }.toSet()
                asks.update { current -> current.filterKeys { it in live } }
                for (view in permission) fetchAsk(view)
            }
        }
        viewModelScope.launch {
            // Keep the open tile seen while new turns end in front of the user.
            combine(route, repo.tiles) { r, tiles -> (r as? Route.Tile)?.let { t -> tiles.firstOrNull { it.key == t.key } } }
                .map { it?.key to it?.row?.turnEndedAt }
                .distinctUntilChanged()
                .collect { (key, _) -> if (key != null) repo.markSeen(key) }
        }
    }

    private fun fetchAsk(view: TileView) {
        if (!asked.add(view.key to view.row.since)) return
        viewModelScope.launch {
            try {
                val p = repo.pending(view.key)
                asks.update { if (p == null) it - view.key else it + (view.key to p) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                asked.remove(view.key to view.row.since)
            }
        }
    }

    fun open(key: TileKey) {
        if (_tile.value?.key != key) {
            _tile.value?.close()
            _tile.value = TileController(key, repo, viewModelScope, now)
        }
        _route.value = Route.Tile(key)
        repo.markSeen(key)
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
            try {
                repo.answer(key, choice, ask.summary)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The row's next change fetches the question again.
            }
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
