package dev.swarmz.phone.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.proto.Pending
import dev.swarmz.phone.state.Dot
import dev.swarmz.phone.state.TileKey
import dev.swarmz.phone.state.TileView
import dev.swarmz.phone.state.dotOf
import dev.swarmz.phone.state.folderName
import dev.swarmz.phone.state.parseTime
import dev.swarmz.phone.state.relativeTime
import dev.swarmz.phone.ui.HomeUi
import dev.swarmz.phone.ui.components.Badge
import dev.swarmz.phone.ui.components.LocalMic
import dev.swarmz.phone.ui.components.Pill
import dev.swarmz.phone.ui.components.PrimaryButton
import dev.swarmz.phone.ui.components.QuietButton
import dev.swarmz.phone.ui.components.StatusDot
import dev.swarmz.phone.ui.components.SwCard
import dev.swarmz.phone.ui.theme.Mono
import dev.swarmz.phone.ui.theme.Sw

private fun plural(n: Int, one: String, many: String) = if (n == 1) "1 $one" else "$n $many"

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HomeScreen(
    ui: HomeUi,
    onOpen: (TileKey) -> Unit,
    onAllow: (TileKey) -> Unit,
    onDeny: (TileKey) -> Unit,
    onReply: (TileKey, String) -> Unit,
    onNew: () -> Unit,
    onSettings: () -> Unit,
    showActions: Boolean = true,
    onReplyRestored: (TileKey) -> Unit = {},
    onPairMac: (String) -> Unit = {},
    onDismissHint: (String) -> Unit = {},
    onDismissShare: () -> Unit = {},
) {
    val needs = ui.model.needs
    val quiet = ui.model.quiet
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (needs.isEmpty()) "Nothing needs you" else "${plural(needs.size, "agent needs", "agents need")} you",
                            style = MaterialTheme.typography.headlineSmall,
                        )
                        Text("${plural(quiet.size, "other", "others")} running quietly", style = MaterialTheme.typography.bodySmall)
                    }
                    // Beside the tile list, which has its own Settings and New session actions, they are left out here.
                    if (showActions) {
                        IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Sw.Secondary) }
                    }
                }
            }
            items(ui.banners, key = { "banner-" + it.mac }) { b ->
                SwCard { Text(b.text, style = MaterialTheme.typography.bodyMedium, color = Sw.NeedsYou) }
            }
            if (ui.pendingShare.isNotEmpty()) {
                item(key = "share") {
                    // A share waiting for a tile (phone attachments spec §4.4): the next tile opened takes it.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Choose a tile for ${ui.pendingShare.joinToString(", ")}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = Sw.NeedsYou,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp).wrapContentHeight().testTag("pending-share"),
                        )
                        IconButton(onClick = onDismissShare) {
                            Icon(Icons.Default.Close, contentDescription = "Dismiss the share", tint = Sw.Muted, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
            items(ui.pairHints, key = { "hint-" + it.mac }) { hint ->
                // One quiet line: this Mac has no key of ours, so none of its tiles are here.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${hint.label} isn't paired with this phone yet · Pair",
                        style = MaterialTheme.typography.bodySmall,
                        color = Sw.Secondary,
                        // The line stays small; its touch target does not.
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).clickable { onPairMac(hint.mac) }.wrapContentHeight(),
                    )
                    IconButton(onClick = { onDismissHint(hint.mac) }) {
                        Icon(Icons.Default.Close, contentDescription = "Dismiss", tint = Sw.Muted, modifier = Modifier.size(16.dp))
                    }
                }
            }
            items(needs, key = { "need-" + it.key.mac + "/" + it.key.id }) { view ->
                // homeModel already decided these need you; a row without `needs` is a finished turn.
                when (view.row.needs) {
                    "permission" -> ui.asks[view.key]?.let { PermissionHomeCard(view, it, onOpen, onAllow, onDeny) }
                    else -> ReplyCard(view, ui, onOpen, onReply, onReplyRestored)
                }
            }
            if (quiet.isNotEmpty()) {
                item { Text("RUNNING", style = MaterialTheme.typography.labelSmall) }
                item {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        quiet.forEach { view ->
                            Pill(onClick = { onOpen(view.key) }) {
                                StatusDot(dotOf(view.row, null), size = 6.dp)
                                Text(view.row.shownTitle, style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
            }
        }
        if (showActions) {
            Pill(onClick = onNew, filled = true, modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Text("New session", style = MaterialTheme.typography.titleSmall)
            }
        }
    }
}

@Composable
private fun CardTitle(view: TileView, trailing: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusDot(Dot.NeedsYou)
        Text(view.row.shownTitle, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        trailing()
    }
}

@Composable
private fun PermissionHomeCard(view: TileView, ask: Pending, onOpen: (TileKey) -> Unit, onAllow: (TileKey) -> Unit, onDeny: (TileKey) -> Unit) {
    SwCard(highlighted = true, onClick = { onOpen(view.key) }) {
        CardTitle(view) { Badge("permission", color = Sw.NeedsYou) }
        Text(
            buildAnnotatedString {
                append("Claude wants to run ")
                withStyle(SpanStyle(fontFamily = Mono, color = Sw.Code)) { append(ask.summary) }
                append(" in ${folderName(view.row.cwd)}")
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("Allow once", onClick = { onAllow(view.key) })
            QuietButton("Deny", onClick = { onDeny(view.key) })
        }
    }
}

@Composable
private fun ReplyCard(view: TileView, ui: HomeUi, onOpen: (TileKey) -> Unit, onReply: (TileKey, String) -> Unit, onRestored: (TileKey) -> Unit) {
    val text = rememberSaveable(view.key.mac, view.key.id, stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
    val failed = ui.replyErrors[view.key]
    LaunchedEffect(failed) {
        if (failed != null && !failed.restored) {
            // Put the unsent reply back, unless something new has been typed since.
            if (text.value.text.isBlank()) text.value = TextFieldValue(failed.text, TextRange(failed.text.length))
            onRestored(view.key)
        }
    }
    val send = {
        if (text.value.text.isNotBlank()) {
            onReply(view.key, text.value.text.trim())
            text.value = TextFieldValue("")
        }
    }
    SwCard(highlighted = true, onClick = { onOpen(view.key) }) {
        CardTitle(view) {
            val t = parseTime(view.row.turnEndedAt) ?: parseTime(view.row.since)
            if (t != null) Text(relativeTime(t, ui.now), style = MaterialTheme.typography.bodySmall)
        }
        view.row.lastMessage?.let { Text("\u201C$it\u201D", style = MaterialTheme.typography.bodyMedium, color = Sw.Body2, maxLines = 4) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = text.value,
                onValueChange = { text.value = it },
                placeholder = { Text("Reply to ${view.row.name}…", color = Sw.Muted) },
                modifier = Modifier.weight(1f).testTag("reply-${view.row.name}"),
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Sw.Border3, focusedBorderColor = Sw.Border4),
                trailingIcon = if (text.value.text.isNotBlank()) {
                    {
                        IconButton(onClick = send) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send reply to ${view.row.name}", tint = Sw.Title)
                        }
                    }
                } else null,
            )
            LocalMic.current.Content(text, Modifier.size(44.dp).clip(CircleShape).background(Sw.Primary))
        }
        failed?.let { Text(it.message, style = MaterialTheme.typography.bodySmall, color = Sw.ErrorLine) }
    }
}
