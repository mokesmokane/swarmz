package dev.swarmz.phone.ui.dictation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.Sw
import kotlin.math.abs
import kotlin.math.sin

const val PARTIAL_TAG = "dictation-partial"
private const val PARTIAL_LINES = 2

/**
 * The longest tail of [text] that fits in [maxLines] at [maxWidth] px, with a leading "…" when cut,
 * so the newest words stay visible (Compose's start ellipsis only handles one line).
 */
internal fun tailThatFits(text: String, measurer: TextMeasurer, style: TextStyle, maxWidth: Int, maxLines: Int): String {
    fun fits(s: String) = measurer.measure(s, style, constraints = Constraints(maxWidth = maxWidth)).lineCount <= maxLines
    if (fits(text)) return text
    var lo = 1
    var hi = text.length
    while (lo < hi) {
        val mid = (lo + hi) / 2
        if (fits("…" + text.substring(mid))) hi = mid else lo = mid + 1
    }
    return "…" + text.substring(lo).trimStart()
}

@Composable
private fun PartialText(partial: String) {
    val style = MaterialTheme.typography.bodyMedium.copy(color = Sw.Title, textAlign = TextAlign.Center)
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        val width = constraints.maxWidth
        val shown = remember(partial, width, style) { tailThatFits(partial, measurer, style, width, PARTIAL_LINES) }
        Text(
            shown,
            style = style,
            maxLines = PARTIAL_LINES,
            overflow = TextOverflow.Clip,
            modifier = Modifier.fillMaxWidth().testTag(PARTIAL_TAG),
        )
    }
}

/** The panel that slides up from the bottom while dictating, with waveform bars. */
@Composable
fun DictationOverlay(talk: Talk, level: Float, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = talk != Talk.Idle,
        enter = slideInVertically { it },
        exit = slideOutVertically { it },
        modifier = modifier,
    ) {
        val cancelling = (talk as? Talk.Listening)?.cancelling == true
        val loud by animateFloatAsState(((level + 2f) / 12f).coerceIn(0.1f, 1f), label = "level")
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 8.dp, topEnd = 8.dp))
                .background(if (cancelling) Sw.Card else Sw.Primary)
                .padding(vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                repeat(24) { i ->
                    val h = 6f + 30f * loud * abs(sin(i * 0.7f + loud * 3f))
                    Box(Modifier.width(3.dp).height(h.dp).clip(RoundedCornerShape(2.dp)).background(Sw.Title.copy(alpha = 0.85f)))
                }
            }
            val partial = (talk as? Talk.Listening)?.partial.orEmpty()
            if (partial.isNotBlank()) PartialText(partial)
            Text(
                when {
                    talk == Talk.Finishing -> "Inserting…"
                    cancelling -> "Release to cancel"
                    else -> "Release to insert · slide up to cancel"
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (cancelling) Sw.ErrorLine else Sw.Title,
            )
        }
    }
}
