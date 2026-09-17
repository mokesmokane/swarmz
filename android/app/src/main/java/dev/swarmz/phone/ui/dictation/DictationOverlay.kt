package dev.swarmz.phone.ui.dictation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.Sw
import kotlin.math.abs
import kotlin.math.sin

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
