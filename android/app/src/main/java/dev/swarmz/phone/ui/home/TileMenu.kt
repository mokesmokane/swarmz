package dev.swarmz.phone.ui.home

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.swarmz.phone.state.TileView

/**
 * The long-press menu of a tile row or chip (phone spec §6.5, amended 2026-09-23): **Open**, and
 * **Stop** for a running tile (ends its session on the Mac, after a confirm: the shell and any
 * Claude in it end; Start brings the conversation back) or **Start** for a stopped one (`restart`).
 */
@Composable
fun TileMenu(view: TileView, expanded: Boolean, onDismiss: () -> Unit, onOpen: () -> Unit, onStop: () -> Unit, onStart: () -> Unit) {
    var confirmStop by remember { mutableStateOf(false) }
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.testTag("tile-menu")) {
        DropdownMenuItem(text = { Text("Open") }, onClick = { onDismiss(); onOpen() })
        if (view.row.running) {
            DropdownMenuItem(text = { Text("Stop") }, onClick = { onDismiss(); confirmStop = true }, enabled = view.macOnline)
        } else {
            DropdownMenuItem(text = { Text("Start") }, onClick = { onDismiss(); onStart() }, enabled = view.macOnline)
        }
    }
    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text("Stop ${view.row.shownTitle}?") },
            text = { Text("The shell on ${view.macLabel} ends, and Claude with it. Start brings the conversation back.") },
            confirmButton = { TextButton(onClick = { confirmStop = false; onStop() }) { Text("Stop") } },
            dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Cancel") } },
        )
    }
}
