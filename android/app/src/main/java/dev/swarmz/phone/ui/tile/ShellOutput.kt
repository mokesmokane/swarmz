package dev.swarmz.phone.ui.tile

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.swarmz.phone.proto.Line
import dev.swarmz.phone.proto.Palette
import dev.swarmz.phone.proto.TileRow
import dev.swarmz.phone.ui.theme.MonoBody
import dev.swarmz.phone.ui.theme.Sw

/** Turns one screen line's spans into styled text; xterm colours go through [Palette.argb]. */
fun Line.annotated(): AnnotatedString = buildAnnotatedString {
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
}

fun exitLine(code: Int?): String = if (code == null) "[process exited]" else "[process exited with code $code]"

/** The stateless part of [ShellBody]: monospace lines, bottom-aligned, following new output while at the bottom. */
@Composable
internal fun ShellLines(lines: List<Line>, exit: String?, listState: LazyListState, modifier: Modifier = Modifier) {
    // Keep following the newest output while the view is at the bottom.
    LaunchedEffect(lines.size, exit) {
        if (listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0)
    }
    LazyColumn(
        modifier.horizontalScroll(rememberScrollState()),
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        if (exit != null) item(key = "exit") { Text(exit, style = MonoBody.copy(color = Sw.Secondary)) }
        itemsIndexed(lines.reversed()) { _, line -> Text(line.annotated(), style = MonoBody, softWrap = false) }
    }
}

@Composable
fun ShellBody(c: TileController, row: TileRow, modifier: Modifier) {
    val screen by c.screen.collectAsStateWithLifecycle()
    val exit = if (screen.exited || !row.running) exitLine(row.exitCode) else null
    ShellLines(screen.lines, exit, c.listState, modifier)
}

@Composable
fun ShellQuickKeys(enabled: Boolean, onCtrlC: () -> Unit, onUp: () -> Unit, onTab: () -> Unit) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        KeyChip("^C", onCtrlC, enabled)
        KeyChip("↑", onUp, enabled)
        KeyChip("Tab", onTab, enabled)
    }
}
