package dev.swarmz.phone.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.dotOf
import dev.swarmz.phone.state.needOf
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.state.subLine
import dev.swarmz.phone.ui.HomeUi
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw

@Composable
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
fun TileListPane(
    ui: HomeUi,
    selected: TileKey?,
    onOpen: (TileKey) -> Unit,
    onNew: () -> Unit,
    onSettings: () -> Unit,
    onCollapse: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    onStop: (TileKey) -> Unit = {},
    onStart: (TileKey) -> Unit = {},
    notice: String? = null,
    onDismissNotice: () -> Unit = {},
) {
    // The row whose long-press menu is open.
    var menuFor by remember { mutableStateOf<TileKey?>(null) }
    Column(modifier.fillMaxHeight().background(Sw.Background)) {
        notice?.let {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, style = MaterialTheme.typography.bodySmall, color = Sw.ErrorLine, modifier = Modifier.weight(1f).testTag("tile-notice"))
                IconButton(onClick = onDismissNotice) { Icon(Icons.Default.Close, contentDescription = "Dismiss", tint = Sw.Muted) }
            }
        }
        Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Tiles", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Sw.Secondary) }
            IconButton(onClick = onNew) { Icon(Icons.Default.Add, contentDescription = "New session", tint = Sw.Title) }
            // Slides the list away to the left, leaving the open tile the whole width.
            if (onCollapse != null) {
                IconButton(onClick = onCollapse) { Icon(Icons.Default.ChevronLeft, contentDescription = "Hide the list", tint = Sw.Secondary) }
            }
        }
        ui.banners.forEach { b -> Text(b.text, color = Sw.NeedsYou, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            ui.sections.forEach { section ->
                item(key = "section-" + section.key) {
                    Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp).alpha(if (section.dimmed) 0.5f else 1f)) {
                        Text(section.title, style = MaterialTheme.typography.labelSmall, color = if (section.needsYou) Sw.NeedsYou else Sw.Secondary)
                        if (section.dimmed && section.lastSeen != null) {
                            val ago = relativeTime(section.lastSeen, ui.now).let { if (it == "now") "just now" else "$it ago" }
                            Text(" · last seen $ago", style = MaterialTheme.typography.labelSmall, color = Sw.Muted)
                        }
                    }
                }
                items(section.rows, key = { (if (section.needsYou) "n-" else "m-") + it.key.mac + "/" + it.key.id }) { view ->
                    val need = needOf(view.row, ui.seen[view.key])
                    val isSelected = view.key == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (isSelected) Sw.Card else Sw.Background)
                            .testTag("tile-row-${view.key.mac}/${view.key.id}")
                            .combinedClickable(onClick = { onOpen(view.key) }, onLongClick = { menuFor = view.key })
                            .padding(horizontal = 8.dp, vertical = 8.dp)
                            .alpha(if (section.dimmed) 0.5f else 1f),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatusDot(dotOf(view.row, need))
                        Column(Modifier.weight(1f)) {
                            Text(view.row.badgedTitle, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                            Text(subLine(view, need), style = MonoSmall, maxLines = 1)
                        }
                        TileMenu(
                            view,
                            expanded = menuFor == view.key,
                            onDismiss = { menuFor = null },
                            onOpen = { onOpen(view.key) },
                            onStop = { onStop(view.key) },
                            onStart = { onStart(view.key) },
                        )
                    }
                }
            }
        }
    }
}
