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

/**
 * An agent tile's key row (Claude or Codex). `↑`, `↓` and `Enter` move through and confirm whatever
 * prompt is on the tile's screen, which is how a question the permission card does not recognise
 * (the agent's own multiple-choice questions, the `/resume` picker) is answered from the phone.
 * `⇧Tab` (Claude's mode cycle) shows only when [onShiftTab] is given, with [mode] when it is known.
 */
@Composable
fun AgentQuickKeys(
    mode: String?,
    enabled: Boolean,
    slashCommands: List<String>,
    onEsc: () -> Unit,
    onCtrlC: () -> Unit,
    onUp: () -> Unit,
    onDown: () -> Unit,
    onEnter: () -> Unit,
    onShiftTab: (() -> Unit)?,
    onSlash: (String) -> Unit,
) {
    var picking by remember { mutableStateOf(false) }
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KeyChip("Esc", onEsc, enabled)
        KeyChip("^C", onCtrlC, enabled)
        KeyChip("↑", onUp, enabled)
        KeyChip("↓", onDown, enabled)
        KeyChip("Enter", onEnter, enabled)
        if (onShiftTab != null) KeyChip(if (mode != null) "⇧Tab $mode" else "⇧Tab", onShiftTab, enabled)
        Box {
            KeyChip("/", { picking = true }, enabled)
            DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                slashCommands.forEach { cmd ->
                    DropdownMenuItem(text = { Text(cmd, fontFamily = Mono) }, onClick = {
                        picking = false
                        onSlash(cmd)
                    })
                }
            }
        }
    }
}
