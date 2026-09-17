package dev.swarmz.phone.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.state.Need
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.dotOf
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.state.subLine
import dev.swarmz.phone.ui.HomeUi
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw

@Composable
fun TileListPane(ui: HomeUi, selected: TileKey?, onOpen: (TileKey) -> Unit, onNew: () -> Unit, onSettings: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxHeight().background(Sw.Background)) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Tiles", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Sw.Secondary) }
            IconButton(onClick = onNew) { Icon(Icons.Default.Add, contentDescription = "New session", tint = Sw.Title) }
        }
        ui.banners.forEach { b -> Text(b.text, color = Sw.NeedsYou, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            ui.sections.forEach { section ->
                item(key = "section-" + section.title) {
                    Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp).alpha(if (section.dimmed) 0.5f else 1f)) {
                        Text(section.title, style = MaterialTheme.typography.labelSmall, color = if (section.needsYou) Sw.NeedsYou else Sw.Secondary)
                        if (section.dimmed && section.lastSeen != null) {
                            val ago = relativeTime(section.lastSeen, ui.now).let { if (it == "now") "just now" else "$it ago" }
                            Text(" · last seen $ago", style = MaterialTheme.typography.labelSmall, color = Sw.Muted)
                        }
                    }
                }
                items(section.rows, key = { (if (section.needsYou) "n-" else "m-") + it.key.mac + "/" + it.key.id }) { view ->
                    val need = if (section.needsYou) (if (view.row.needs == "permission") Need.Permission else if (view.row.needs == "question") Need.Question else Need.Finished) else null
                    val isSelected = view.key == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (isSelected) Sw.Card else Sw.Background)
                            .clickable { onOpen(view.key) }
                            .padding(horizontal = 8.dp, vertical = 8.dp)
                            .alpha(if (section.dimmed) 0.5f else 1f),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatusDot(dotOf(view.row, need))
                        Column(Modifier.weight(1f)) {
                            Text(view.row.name, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                            Text(subLine(view, need), style = MonoSmall, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}
