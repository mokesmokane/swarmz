package dev.swarmz.phone.ui.newsession

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.data.Repository
import dev.swarmz.phone.proto.Folders
import dev.swarmz.phone.state.MacInfo
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.folderName
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.SwCard
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class NewSessionState(
    val mac: String? = null,
    val folders: Folders? = null,
    val recent: List<String> = emptyList(),
    val skip: Boolean = false,
    val loading: Boolean = false,
    val starting: Boolean = false,
    val error: String? = null,
)

class NewSessionModel(private val repo: Repository, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(NewSessionState())
    val state: StateFlow<NewSessionState> = _state.asStateFlow()
    private var startPath: String? = null
    private var browsing: Job? = null

    fun pickMac(mac: String) {
        browsing?.cancel()
        _state.value = NewSessionState(mac = mac, recent = repo.recentFolders(mac))
        startPath = null
        browse(null)
    }

    /** Lists [path] (the Mac's starting folder when null); a newer browse replaces one still loading. */
    fun browse(path: String?) {
        val mac = _state.value.mac ?: return
        browsing?.cancel()
        _state.update { it.copy(loading = true, error = null) }
        browsing = scope.launch {
            try {
                val f = repo.folders(mac, path)
                if (startPath == null) startPath = f.path
                _state.update { it.copy(folders = f, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message) }
            }
        }
    }

    fun setSkip(on: Boolean) = _state.update { it.copy(skip = on) }

    val atStart: Boolean get() = _state.value.folders?.path == startPath

    suspend fun start(): TileKey? {
        val s = _state.value
        val mac = s.mac ?: return null
        val folder = s.folders?.path ?: return null
        _state.update { it.copy(starting = true, error = null) }
        return try {
            repo.newTile(mac, folder, s.skip).also { _state.update { it.copy(starting = false) } }
        } catch (e: CancellationException) {
            _state.update { it.copy(starting = false) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(starting = false, error = e.message) }
            null
        }
    }
}

private fun child(parent: String, name: String) = if (parent.endsWith("/")) parent + name else "$parent/$name"

@Composable
fun NewSessionScreen(model: NewSessionModel, macs: List<MacInfo>, onStarted: (TileKey) -> Unit, onBack: (() -> Unit)?) {
    val s by model.state.collectAsStateWithLifecycle()
    val online = macs.filter { it.online }
    val scope = rememberCoroutineScope()
    LaunchedEffect(online.map { it.name }) {
        if (s.mac == null && online.size == 1) model.pickMac(online.single().name)
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Sw.Title) }
            Text("New session", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
        }
        if (online.isEmpty()) {
            Text("No Mac is online. Check Tailscale on this phone.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
            return@Column
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("MAC", style = MaterialTheme.typography.labelSmall) }
            items(online, key = { "mac-" + it.name }) { m ->
                SwCard(highlighted = m.name == s.mac, onClick = { model.pickMac(m.name) }) {
                    Text(m.label, style = MaterialTheme.typography.titleSmall)
                }
            }
            val f = s.folders
            if (s.mac != null && f != null) {
                item { Text(f.path, style = MonoSmall, modifier = Modifier.padding(top = 12.dp)) }
                f.parent?.let { parent ->
                    item(key = "up") { FolderRow("Up", onClick = { model.browse(parent) }) }
                }
                if (model.atStart && s.recent.isNotEmpty()) {
                    item { Text("RECENT", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 8.dp)) }
                    items(s.recent, key = { "recent-$it" }) { path -> FolderRow(path, mono = true, onClick = { model.browse(path) }) }
                }
                item { Text("FOLDERS", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 8.dp)) }
                items(f.dirs, key = { "dir-$it" }) { name -> FolderRow(name, onClick = { model.browse(child(f.path, name)) }) }
            }
            s.error?.let { item { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodyMedium) } }
        }
        val f = s.folders
        if (s.mac != null && f != null) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    Modifier.fillMaxWidth().clickable { model.setSkip(!s.skip) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Skip permissions", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Switch(checked = s.skip, onCheckedChange = model::setSkip, colors = SwitchDefaults.colors(checkedTrackColor = Sw.ErrorLine))
                }
                if (s.skip) Text("Claude will run commands and edit files without asking.", color = Sw.ErrorLine, style = MaterialTheme.typography.bodySmall)
                PrimaryButton(
                    "Start in ${folderName(f.path)}",
                    enabled = !s.starting && !s.loading,
                    onClick = { scope.launch { model.start()?.let(onStarted) } },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun FolderRow(label: String, mono: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Default.Folder, contentDescription = null, tint = Sw.Secondary)
        Text(label, style = if (mono) MonoSmall else MaterialTheme.typography.bodyLarge)
    }
}
