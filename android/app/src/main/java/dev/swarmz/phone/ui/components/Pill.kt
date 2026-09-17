package dev.swarmz.phone.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.swarmz.phone.ui.theme.Sw

@Composable
fun Pill(onClick: () -> Unit, modifier: Modifier = Modifier, filled: Boolean = false, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier
            .clip(CircleShape)
            .background(if (filled) Sw.Primary else Sw.Card)
            .border(1.dp, if (filled) Sw.Primary else Sw.Border2, CircleShape)
            .clickable(onClick = onClick)
            .heightIn(min = 36.dp)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        content = content,
    )
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        shape = RoundedCornerShape(4.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Sw.Primary, contentColor = Sw.Title),
    ) { Text(text, style = MaterialTheme.typography.labelMedium, color = Sw.Title) }
}

@Composable
fun QuietButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, color: Color = Sw.Body) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.border(1.dp, Sw.Border3, RoundedCornerShape(4.dp)),
        shape = RoundedCornerShape(4.dp),
    ) { Text(text, style = MaterialTheme.typography.labelMedium, color = color) }
}
