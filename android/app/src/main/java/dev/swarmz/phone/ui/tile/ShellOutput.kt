package dev.swarmz.phone.ui.tile

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.proto.Line
import dev.swarmz.phone.proto.Palette
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.ui.theme.MonoBody
import dev.swarmz.phone.ui.theme.MonoSmall
import dev.swarmz.phone.ui.theme.Sw
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Punctuation that ends a sentence far more often than it ends a URL, so a trailing run of it is not part of one. */
private const val LINK_TRAILING = ".,)]\"';>"

/** One screen line as plain text. */
fun Line.plain(): String = joinToString("") { it.text }

/**
 * The `http://` and `https://` URLs in [text]: each runs to the first whitespace, with trailing punctuation
 * trimmed, and needs at least one character after the scheme. A URL the terminal wrapped onto the next line is
 * two halves on two lines, and the halves are never joined.
 */
fun links(text: String): List<IntRange> {
    val out = mutableListOf<IntRange>()
    var i = 0
    while (i < text.length) {
        val at = text.indexOf("http", i)
        if (at < 0) break
        val scheme = when {
            text.startsWith("https://", at) -> 8
            text.startsWith("http://", at) -> 7
            else -> 0
        }
        if (scheme == 0) {
            i = at + 4
            continue
        }
        var end = at + scheme
        while (end < text.length && !text[end].isWhitespace()) end++
        while (end > at + scheme && text[end - 1] in LINK_TRAILING) end--
        if (end > at + scheme) out += at until end
        i = maxOf(end, at + scheme)
    }
    return out
}

/**
 * Turns one screen line's spans into styled text; xterm colours go through [Palette.argb]. With [onLink] set,
 * every URL on the line also becomes a tappable link, keeping the rest of the line's colours.
 */
fun Line.annotated(onLink: ((String) -> Unit)? = null): AnnotatedString {
    val text = plain()
    return buildAnnotatedString {
        for (span in this@annotated) {
            var fg = Palette.argb(span.fg)?.let { Color(it) }
            var bg = Palette.argb(span.bg)?.let { Color(it) }
            if (span.inverse) {
                val f = fg
                fg = bg ?: Sw.Background
                bg = f ?: Sw.Body
            }
            withStyle(
                SpanStyle(
                    color = fg ?: Sw.Body,
                    background = bg ?: Color.Unspecified,
                    fontWeight = if (span.bold) FontWeight.Bold else null,
                ),
            ) { append(span.text) }
        }
        if (onLink == null) return@buildAnnotatedString
        for (range in links(text)) {
            val url = text.substring(range)
            addStyle(SpanStyle(color = Sw.Code, textDecoration = TextDecoration.Underline), range.first, range.last + 1)
            addLink(LinkAnnotation.Clickable(url, styles = null) { onLink(url) }, range.first, range.last + 1)
        }
    }
}

/** Opens [url] in a browser. Only `http` and `https` are ever opened; false means show a notice instead. */
internal fun openLink(context: Context, url: String): Boolean {
    val uri = Uri.parse(url)
    if (uri.scheme?.lowercase() !in setOf("http", "https")) return false
    return try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    } catch (_: Exception) {
        false
    }
}

fun exitLine(code: Int?): String = if (code == null) "[process exited]" else "[process exited with code $code]"

/**
 * The stateless part of [ShellBody]: monospace lines, bottom-aligned, following new output while at the bottom.
 *
 * [dropped] is the running count of lines dropped from the top (see [dev.swarmz.phone.state.ScreenState.dropped]).
 * Combined with `lines.size` it both gives each row a stable absolute-line-number key (so a full window's rows
 * don't all recompose and lose scroll position on every update) and signals the follow effect: once the window is
 * full, `output --follow` drops and appends the same number of lines each update, so `lines.size` alone never
 * changes and following would silently stop without it.
 */
@Composable
internal fun ShellLines(
    lines: List<Line>,
    dropped: Long,
    exit: String?,
    listState: LazyListState,
    modifier: Modifier = Modifier,
    onNotice: (String) -> Unit = {},
) {
    // Keep following the newest output while the view is at the bottom.
    LaunchedEffect(lines.size, dropped, exit) {
        if (listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0)
    }
    var tapped by remember { mutableStateOf<String?>(null) }
    // Held here, not in LinkMenu: dismissing the menu takes its composable, and with it any scope of its own,
    // out of the composition before a Copy launched from it could run.
    val scope = rememberCoroutineScope()
    LazyColumn(
        modifier.horizontalScroll(rememberScrollState()),
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        if (exit != null) item(key = "exit") { Text(exit, style = MonoBody.copy(color = Sw.Secondary)) }
        itemsIndexed(lines.reversed(), key = { j, _ -> dropped + (lines.size - 1 - j) }) { _, line ->
            Text(line.annotated { tapped = it }, style = MonoBody, softWrap = false)
        }
    }
    tapped?.let { url -> LinkMenu(url, scope, onNotice) { tapped = null } }
}

/**
 * What a tapped URL offers. Claude's `/login` prints a long URL and waits for the code to be pasted back, which is
 * the flow this exists for: open it in a browser, or copy it somewhere else.
 */
@Composable
private fun LinkMenu(url: String, scope: CoroutineScope, onNotice: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(url, style = MonoSmall, maxLines = 4) },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                if (!openLink(context, url)) onNotice("Couldn't open this link")
            }) { Text("Open") }
        },
        dismissButton = {
            TextButton(onClick = {
                onDismiss()
                scope.launch {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("link", url)))
                    onNotice("Link copied")
                }
            }) { Text("Copy") }
        },
    )
}

@Composable
fun ShellBody(c: TileController, row: TileRow, modifier: Modifier) {
    val screen by c.screen.collectAsStateWithLifecycle()
    val exit = if (screen.exited || !row.running) exitLine(row.exitCode) else null
    ShellLines(screen.lines, screen.dropped, exit, c.screenListState, modifier, c::notify)
}

@Composable
fun ShellQuickKeys(enabled: Boolean, onCtrlC: () -> Unit, onUp: () -> Unit, onTab: () -> Unit) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        KeyChip("^C", onCtrlC, enabled)
        KeyChip("↑", onUp, enabled)
        KeyChip("Tab", onTab, enabled)
    }
}
