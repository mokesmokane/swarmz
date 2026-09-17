package dev.swarmz.phone.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.state.Dot
import dev.swarmz.phone.ui.theme.color

@Composable
fun StatusDot(dot: Dot, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    val colour = dot.color()
    val halo = dot == Dot.NeedsYou
    Canvas(
        modifier
            .size(size * 2)
            .semantics { contentDescription = dot.name.lowercase() },
    ) {
        val r = size.toPx() / 2
        if (halo) {
            drawCircle(colour.copy(alpha = 0.18f), radius = r * 2)
            drawCircle(colour.copy(alpha = 0.30f), radius = r * 1.5f)
        }
        drawCircle(colour, radius = r)
    }
}
