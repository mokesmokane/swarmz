package dev.swarmz.phone.ui.tile

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.swarmz.phone.proto.Agent
import dev.swarmz.phone.proto.Key
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.state.Need
import dev.swarmz.phone.state.dotOf
import dev.swarmz.phone.state.folderName
import dev.swarmz.phone.state.modeLabel
import dev.swarmz.phone.state.parseTime
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.ui.components.Badge
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.runtime.rememberCoroutineScope
import java.time.Instant

@Composable
fun TileScreen(
    c: TileController,
    unfolded: Boolean,
    onBack: (() -> Unit)?,
    now: () -> Instant = Instant::now,
    onShowList: (() -> Unit)? = null,
) {
    val row by c.row.collectAsStateWithLifecycle()
    val online by c.macOnline.collectAsStateWithLifecycle()
    val macLabel by c.macLabel.collectAsStateWithLifecycle()
    val lastSeen by c.lastSeen.collectAsStateWithLifecycle()
    val pending by c.pending.collectAsStateWithLifecycle()
    val notice by c.notice.collectAsStateWithLifecycle()
    val noticeRound by c.noticeRound.collectAsStateWithLifecycle()
    val streamError by c.streamError.collectAsStateWithLifecycle()
    var clock by remember { mutableStateOf(now()) }
    var recapOpen by remember { mutableStateOf(false) }
    // Editing the title happens inline under the header, not inside the dialog.
    var titleDraft by remember { mutableStateOf<String?>(null) }
    val r = row
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
            } else if (onShowList != null) {
                // Unfolded with the list hidden: the same spot brings it back.
                IconButton(onClick = onShowList) { Icon(Icons.Filled.ChevronRight, contentDescription = "Show the list", tint = Sw.Title) }
            }
            if (r != null) StatusDot(dotOf(r, when (r.needs) { "permission" -> Need.Permission; "question" -> Need.Question; else -> null }), Modifier.padding(horizontal = 6.dp))
            // The title opens the tile's card: its recap, and a way to retitle it (conversation cards spec §6).
            val titleTap = if (r != null && !r.isShell) Modifier.clickable { recapOpen = true } else Modifier
            Column(Modifier.weight(1f).padding(start = 6.dp).then(titleTap).testTag("tile-title")) {
                Text(r?.badgedTitle ?: c.key.id, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                val where = "$macLabel · ${r?.let { folderName(it.cwd) } ?: ""}"
                Text(if (r?.hasTitle == true) "${r.name} · $where" else where, style = MonoSmall, maxLines = 1)
            }
            r?.let { modeLabel(it) }?.let { Badge(it, modifier = Modifier.padding(end = 12.dp)) }
        }
        HorizontalDivider(color = Sw.Border)
        if (recapOpen && r != null) {
            RecapDialog(r, clock, onEditTitle = { titleDraft = if (r.cardBy == "user") (r.title ?: "") else ""; recapOpen = false }, onDismiss = { recapOpen = false })
        }
        titleDraft?.let { draft ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { titleDraft = it },
                    singleLine = true,
                    label = { Text("Title") },
                    placeholder = { Text("Empty: back to the agent's") },
                    modifier = Modifier.weight(1f).testTag("title-edit"),
                )
                TextButton(onClick = { c.setTitle(draft); titleDraft = null }) { Text("Save") }
                TextButton(onClick = { titleDraft = null }) { Text("Cancel") }
            }
        }
        if (!online) {
            val seen = lastSeen?.let { relativeTime(it, clock) }?.let { if (it == "now") "just now" else "$it ago" }
            Text("$macLabel is offline${seen?.let { " · last seen $it" } ?: ""}", color = Sw.Secondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp))
        }
        streamError?.let { Text(it, color = Sw.ErrorLine, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) }
        val body = Modifier.weight(1f).fillMaxWidth()
        // The terminal is the tile, for agents and shell alike (phone terminal-only spec §1).
        if (r != null) ShellBody(c, r, body) else Box(body)
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
                PrimaryButton(if (r.isShell) "Restart shell" else "Restart", onClick = c::restart, enabled = online)
            }
            return@Column
        }
        pending?.let { p -> if (online) PermissionCard(p, horizontal = unfolded, onAnswer = c::answer, onSubmit = c::submit) }
        val canType = online && r != null
        if (r?.isShell == true) {
            ShellQuickKeys(canType, onCtrlC = { c.key(Key.CtrlC) }, onUp = { c.key(Key.Up) }, onTab = { c.key(Key.Tab) })
            Composer(c.draft, "Type a command…", canType, c::send)
        } else {
            val codex = r?.kind == Agent.Codex.arg
            AgentQuickKeys(
                mode = r?.let { modeLabel(it) },
                enabled = canType,
                slashCommands = slashCommandsFor(r?.kind ?: ""),
                onEsc = { c.key(Key.Esc) },
                onCtrlC = { c.key(Key.CtrlC) },
                onUp = { c.key(Key.Up) },
                onDown = { c.key(Key.Down) },
                onEnter = { c.key(Key.Enter) },
                // Shift+Tab is Claude's mode cycle; Codex has none.
                onShiftTab = if (codex) null else ({ c.key(Key.ShiftTab) }),
                onSlash = { cmd -> c.draft.value = TextFieldValue("$cmd ", TextRange(cmd.length + 1)) },
            )
            // Attach: the system picker (any type); each item is read off the main thread and sent.
            val context = LocalContext.current
            val readScope = rememberCoroutineScope()
            val attachments by c.attachments.collectAsStateWithLifecycle()
            val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
                uris.forEach { uri ->
                    readScope.launch {
                        withContext(Dispatchers.IO) { readPicked(context, uri) }
                            .onSuccess { c.attach(it.name, it.bytes) }
                            .onFailure { c.notify(it.message ?: "could not read the file") }
                    }
                }
            }
            AttachmentChips(attachments, onRetry = c::retryAttachment, onRemove = c::removeAttachment)
            Composer(c.draft, "Message ${r?.name ?: ""}…", canType, c::send, onAttach = { picker.launch(arrayOf("*/*")) })
        }
    }
}


/**
 * A tile's card (conversation cards spec §6): the recap, or the last message when there is none,
 * when it was set and by whom, and a way to retitle it (the field opens under the header).
 */
@Composable
private fun RecapDialog(r: TileRow, clock: Instant, onEditTitle: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(r.shownTitle, maxLines = 3) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val body = r.recap?.takeIf { it.isNotBlank() } ?: r.lastMessage?.takeIf { it.isNotBlank() }?.let { "\u201C$it\u201D" } ?: "No recap yet"
                Text(body, style = MaterialTheme.typography.bodyMedium)
                parseTime(r.cardAt)?.let { at ->
                    val ago = relativeTime(at, clock).let { if (it == "now") "just now" else "$it ago" }
                    Text("updated $ago by ${if (r.cardBy == "user") "you" else r.agentName}", style = MaterialTheme.typography.bodySmall, color = Sw.Secondary)
                }
            }
        },
        confirmButton = { TextButton(onClick = onEditTitle) { Text("Edit title") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
