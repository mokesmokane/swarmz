package dev.swarmz.phone.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.Sw

private val CardShape = RoundedCornerShape(8.dp)

@Composable
fun SwCard(
    modifier: Modifier = Modifier,
    highlighted: Boolean = false,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val fill = if (highlighted) Brush.verticalGradient(listOf(Sw.CardHighTop, Sw.Card)) else Brush.linearGradient(listOf(Sw.Card, Sw.Card))
    Column(
        modifier
            .clip(CardShape)
            .background(fill)
            .border(1.dp, if (highlighted) Sw.Border3 else Sw.Border, CardShape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}
