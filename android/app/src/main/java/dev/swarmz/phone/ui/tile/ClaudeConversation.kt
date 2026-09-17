package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import android.content.ClipData
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import dev.swarmz.phone.proto.Message
import dev.swarmz.phone.ui.theme.MonoBody
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

private val Bubble = RoundedCornerShape(8.dp)
private const val OLDER_KEY = "older"

/** Messages oldest first; the list is reversed so it sits at the bottom and follows new messages. */
@Composable
fun ClaudeConversation(
    c: TileController,
    messages: List<Message>,
    outgoing: List<Outgoing>,
    hasMore: Boolean,
    unfolded: Boolean,
    status: String,
    listState: LazyListState,
    modifier: Modifier = Modifier,
) {
    // Load older pages when the "older" row scrolls into view; the message count restarts this after each page.
    LaunchedEffect(listState, hasMore, messages.size) {
        if (!hasMore) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.any { it.key == OLDER_KEY } }
            .distinctUntilChanged()
            .filter { it }
            .collect { c.loadOlder() }
    }
    BoxWithConstraints(modifier) {
        val mine = maxWidth * (if (unfolded) 0.62f else 0.80f)
        val theirs = if (unfolded) maxWidth * 0.72f else maxWidth
        LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item(key = "status") { StatusLine(status) }
            items(outgoing.reversed(), key = { "out-${it.id}" }) { o -> OutgoingBubble(o, mine) { c.retry(o.id) } }
            items(messages.reversed(), key = { it.id }) { m ->
                if (m.role == "user") UserBubble(m.text, mine) else AssistantMessage(c, m, theirs)
            }
            if (hasMore) item(key = OLDER_KEY) { Text("Loading older messages…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp)) }
        }
    }
}

@Composable
internal fun StatusLine(text: String) {
    var on by remember { mutableStateOf(true) }
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(lifecycle) {
        // Blinks only while the app is on screen.
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                delay(530)
                on = !on
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MonoSmall)
        // The cursor's text never changes, only its alpha: swapping it for "  " measured taller in the fallback
        // font that draws the block character, so the line's height (and every message above it) jumped on blink.
        Text(" ▍", style = MonoSmall, modifier = Modifier.alpha(if (on) 1f else 0f).testTag("statusCursor"))
    }
}

@Composable
private fun UserBubble(text: String, max: androidx.compose.ui.unit.Dp, footer: String? = null, onClick: (() -> Unit)? = null) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Column(
            Modifier.widthIn(max = max).clip(Bubble).background(Sw.Primary)
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodyLarge, color = Sw.Title)
            footer?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (it.startsWith("Failed")) Sw.ErrorLine else Sw.Body2) }
        }
    }
}

@Composable
private fun OutgoingBubble(o: Outgoing, max: androidx.compose.ui.unit.Dp, onRetry: () -> Unit) {
    val footer = when (o.state) {
        SendState.Sending -> "sending…"
        SendState.Sent -> "sent"
        SendState.Failed -> "Failed · tap to retry"
    }
    UserBubble(o.text, max, footer, if (o.state == SendState.Failed) onRetry else null)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AssistantMessage(c: TileController, m: Message, max: androidx.compose.ui.unit.Dp) {
    val images by c.images.collectAsStateWithLifecycle()
    Column(Modifier.widthIn(max = max), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        splitCode(m.text).forEach { seg ->
            when (seg) {
                is Segment.Prose -> Prose(seg.text)
                is Segment.Code -> CodeBlock(seg.text)
            }
        }
        m.images.forEach { ref ->
            LaunchedEffect(ref.id) { c.loadImage(ref.id) }
            images[ref.id]?.let { InlineImage(it) }
        }
        if (m.tools.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                m.tools.forEach { t ->
                    Text(
                        "${t.name} · ${t.summary}",
                        style = MonoSmall,
                        color = if (t.ok == false) Sw.ErrorLine else Sw.Secondary,
                        maxLines = 1,
                        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Sw.Card).padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Prose(text: String) {
    val body = MaterialTheme.typography.bodyLarge
    val inline = MonoBody.copy(color = Sw.Code)
    Markdown(
        text,
        colors = markdownColor(text = Sw.Body, codeBackground = Sw.Card, inlineCodeBackground = Sw.Card, dividerColor = Sw.Border2, tableBackground = Sw.Card),
        typography = markdownTypography(
            text = body,
            paragraph = body,
            ordered = body,
            bullet = body,
            list = body,
            quote = body.copy(color = Sw.Secondary),
            code = inline,
            inlineCode = inline,
        ),
    )
}

@Composable
private fun CodeBlock(text: String) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Sw.Card)) {
        Text(
            text,
            style = MonoBody.copy(color = Sw.Code),
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 10.dp, top = 10.dp, bottom = 10.dp, end = 44.dp),
        )
        IconButton(onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("code", text))) } }, modifier = Modifier.align(Alignment.TopEnd)) {
            Icon(Icons.Default.ContentCopy, contentDescription = "Copy code", tint = Sw.Secondary)
        }
    }
}

@Composable
private fun InlineImage(bitmap: androidx.compose.ui.graphics.ImageBitmap) {
    var big by remember { mutableStateOf(false) }
    Image(bitmap, contentDescription = "Image", modifier = Modifier.heightIn(max = 240.dp).clip(RoundedCornerShape(8.dp)).clickable { big = true })
    if (big) {
        Dialog(onDismissRequest = { big = false }) {
            Image(bitmap, contentDescription = "Image, enlarged", modifier = Modifier.fillMaxWidth().clickable { big = false })
        }
    }
}
