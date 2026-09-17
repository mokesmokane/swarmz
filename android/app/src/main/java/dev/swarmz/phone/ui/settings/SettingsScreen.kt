package dev.swarmz.phone.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.link.LinkState
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.ui.AppViewModel
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.components.SwCard
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.launch

val LANGUAGES = listOf(null to "Phone default", "en-US" to "English (US)", "en-GB" to "English (UK)", "de-DE" to "Deutsch", "fr-FR" to "Français", "es-ES" to "Español")
val NOTIFY_KINDS = listOf("permission" to "Permission requests", "question" to "Questions", "finished" to "Finished turns")

@Composable
fun SettingsScreen(vm: AppViewModel, onBack: (() -> Unit)?) {
    val home by vm.home.collectAsStateWithLifecycle()
    val states by vm.repo.macStates.collectAsStateWithLifecycle()
    val paired by vm.settings.paired.collectAsStateWithLifecycle()
    val background by vm.settings.backgroundWatch.collectAsStateWithLifecycle()
    val kinds by vm.settings.notifyKinds.collectAsStateWithLifecycle()
    val language by vm.settings.dictationLanguage.collectAsStateWithLifecycle()
    var confirming by remember { mutableStateOf(false) }
    var revokeError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Sw.Title) }
            Text("Settings", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
        }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("MACS", style = MaterialTheme.typography.labelSmall)
            home.macs.forEach { m ->
                val st = states[m.name]
                SwCard {
                    Text(m.label, style = MaterialTheme.typography.titleSmall)
                    Text(m.name + if (m.name == paired?.host) " · paired" else "", style = MonoSmall)
                    val line = when (st) {
                        is LinkState.Online -> "online"
                        is LinkState.TooOld -> "Update swarmz on ${m.label}"
                        // A Mac that was offline at pairing never got the key; only the paired Mac's refusal means pairing again.
                        is LinkState.Blocked ->
                            if (st.keyRejected && m.name != paired?.host) "${m.label} doesn't have this phone's key yet (it was offline when you paired)"
                            else st.reason
                        else -> "offline" + (m.lastSeen?.let { " · last seen ${relativeTime(it, home.now)}" } ?: "")
                    }
                    Text(line, style = MaterialTheme.typography.bodySmall, color = if (st is LinkState.Blocked || st is LinkState.TooOld) Sw.NeedsYou else Sw.Secondary)
                    if (st is LinkState.Blocked) QuietButton("Try again", onClick = { vm.repo.retry(m.name) })
                }
            }
            Text("ALERTS", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 12.dp))
            Row(Modifier.fillMaxWidth().clickable { vm.setBackgroundWatch(!background) }, verticalAlignment = Alignment.CenterVertically) {
                Text("Watch in the background", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(checked = background, onCheckedChange = vm::setBackgroundWatch)
            }
            NOTIFY_KINDS.forEach { (kind, label) ->
                Row(Modifier.fillMaxWidth().clickable { vm.setNotify(kind, kind !in kinds) }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = kind in kinds, onCheckedChange = { vm.setNotify(kind, it) })
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                }
            }
            Text("Alerts arrive in a later update.", style = MaterialTheme.typography.bodySmall)
            Text("DICTATION", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 12.dp))
            LANGUAGES.forEach { (tag, label) ->
                Row(Modifier.fillMaxWidth().clickable { vm.setLanguage(tag) }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = language == tag, onClick = { vm.setLanguage(tag) })
                    Text(label, style = MaterialTheme.typography.bodyLarge)
                }
            }
            Text("THIS PHONE", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 12.dp))
            paired?.let { Text(it.device, style = MaterialTheme.typography.bodyLarge) }
            QuietButton("Revoke this phone", onClick = { confirming = true; revokeError = null }, color = Sw.ErrorLine)
        }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { if (!busy) confirming = false },
            title = { Text("Revoke this phone?") },
            text = {
                Text(
                    revokeError?.let { "Couldn't revoke: $it" }
                        ?: "This removes this phone's key from your Macs and forgets them here. You'll need your Mac password to pair again.",
                )
            },
            confirmButton = {
                if (revokeError == null) {
                    TextButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            try {
                                revokeError = vm.revoke()
                            } finally {
                                busy = false
                            }
                            if (revokeError == null) confirming = false
                        }
                    }) { Text("Revoke", color = Sw.ErrorLine) }
                } else {
                    TextButton(onClick = { vm.forgetLocally(); confirming = false }) { Text("Forget on this phone only", color = Sw.ErrorLine) }
                }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
}
