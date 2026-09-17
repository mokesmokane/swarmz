package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.Need
import dev.swarmz.phone.state.dotOf
import dev.swarmz.phone.state.folderName
import dev.swarmz.phone.state.modeLabel
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.ui.components.Badge
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.delay
import java.time.Instant

@Composable
fun TileScreen(c: TileController, unfolded: Boolean, onBack: (() -> Unit)?, now: () -> Instant = Instant::now) {
    val row by c.row.collectAsStateWithLifecycle()
    val online by c.macOnline.collectAsStateWithLifecycle()
    val macLabel by c.macLabel.collectAsStateWithLifecycle()
    val lastSeen by c.lastSeen.collectAsStateWithLifecycle()
    val pending by c.pending.collectAsStateWithLifecycle()
    val notice by c.notice.collectAsStateWithLifecycle()
    val noticeRound by c.noticeRound.collectAsStateWithLifecycle()
    val streamError by c.streamError.collectAsStateWithLifecycle()
    var clock by remember { mutableStateOf(now()) }
    val r = row
    val screenMode = c.screenMode.value
    // Times only move on screen for a working tile ("working · 12s") or an offline Mac ("last seen 3m ago").
    val ticking = (r?.running == true && r.status == "working") || !online
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(lifecycle, ticking) {
        clock = now()
        if (!ticking) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                clock = now()
                delay(1_000)
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Sw.Title) }
            }
            if (r != null) StatusDot(dotOf(r, if (r.needs == "permission") Need.Permission else null), Modifier.padding(horizontal = 6.dp))
            Column(Modifier.weight(1f).padding(start = 6.dp)) {
                Text(r?.name ?: c.key.id, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                Text("$macLabel · ${r?.let { folderName(it.cwd) } ?: ""}", style = MonoSmall, maxLines = 1)
            }
            if (r != null && r.kind != "shell") {
                // Anything Claude draws but never writes to the transcript (`/login`, `/model`, `/cost`) is only
                // reachable on the live screen.
                IconButton(onClick = c::toggleScreen, modifier = Modifier.size(36.dp)) {
                    val icon = if (screenMode) Icons.AutoMirrored.Filled.Chat else Icons.Filled.Terminal
                    Icon(icon, contentDescription = if (screenMode) "Conversation" else "Screen", tint = Sw.Title, modifier = Modifier.size(20.dp))
                }
            }
            if (r != null) Badge(modeLabel(r), modifier = Modifier.padding(end = 12.dp))
        }
        HorizontalDivider(color = Sw.Border)
        if (!online) {
            val seen = lastSeen?.let { relativeTime(it, clock) }?.let { if (it == "now") "just now" else "$it ago" }
            Text("$macLabel is offline${seen?.let { " · last seen $it" } ?: ""}", color = Sw.Secondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp))
        }
        streamError?.let { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) }
        val body = Modifier.weight(1f).fillMaxWidth()
        if (r != null && (r.kind == "shell" || screenMode)) {
            ShellBody(c, r, body)
        } else {
            val t by c.transcript.collectAsStateWithLifecycle()
            val outgoing by c.outgoing.collectAsStateWithLifecycle()
            ClaudeConversation(c, t.messages, outgoing, t.hasMore, unfolded, r?.let { statusLine(it, clock) } ?: "", c.listState, body)
        }
        notice?.let {
            Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp).fillMaxWidth())
            // Keyed on the round, not the text: the same notice twice in a row must restart the 5 s timer.
            LaunchedEffect(noticeRound) {
                delay(5_000)
                c.dismissNotice()
            }
        }
        if (r != null && !r.running) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(statusLine(r, clock), style = MonoSmall, modifier = Modifier.weight(1f))
                PrimaryButton(if (r.kind == "shell") "Restart shell" else "Restart", onClick = c::restart, enabled = online)
            }
            return@Column
        }
        pending?.let { p -> if (online) PermissionCard(p, horizontal = unfolded, onAnswer = c::answer) }
        val canType = online && r != null
        if (r?.kind == "shell") {
            ShellQuickKeys(canType, onCtrlC = { c.key(Key.CtrlC) }, onUp = { c.key(Key.Up) }, onTab = { c.key(Key.Tab) })
            Composer(c.draft, "Type a command…", canType, c::send)
        } else {
            ClaudeQuickKeys(
                mode = r?.let { modeLabel(it) } ?: "default",
                enabled = canType,
                onEsc = { c.key(Key.Esc) },
                onCtrlC = { c.key(Key.CtrlC) },
                onShiftTab = { c.key(Key.ShiftTab) },
                onSlash = { cmd -> c.draft.value = TextFieldValue("$cmd ", TextRange(cmd.length + 1)) },
            )
            Composer(c.draft, "Message ${r?.name ?: ""}…", canType, c::send)
        }
    }
}
