package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.components.Pill
import dev.swarmz.phone.ui.theme.Mono

@Composable
fun KeyChip(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    Pill(onClick = { if (enabled) onClick() }) {
        Text(label, style = MaterialTheme.typography.labelMedium.copy(fontFamily = Mono))
    }
}

@Composable
fun ClaudeQuickKeys(mode: String, enabled: Boolean, onEsc: () -> Unit, onCtrlC: () -> Unit, onShiftTab: () -> Unit, onSlash: (String) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KeyChip("Esc", onEsc, enabled)
        KeyChip("^C", onCtrlC, enabled)
        KeyChip("⇧Tab $mode", onShiftTab, enabled)
        Box {
            KeyChip("/", { picking = true }, enabled)
            DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                SLASH_COMMANDS.forEach { cmd ->
                    DropdownMenuItem(text = { Text(cmd, fontFamily = Mono) }, onClick = {
                        picking = false
                        onSlash(cmd)
                    })
                }
            }
        }
    }
}
