package dev.swarmz.phone.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val scheme = darkColorScheme(
    primary = Sw.Primary,
    onPrimary = Sw.Title,
    background = Sw.Background,
    onBackground = Sw.Body,
    surface = Sw.Background,
    onSurface = Sw.Body,
    surfaceVariant = Sw.Card,
    onSurfaceVariant = Sw.Secondary,
    surfaceContainer = Sw.Card,
    surfaceContainerHigh = Sw.Card,
    outline = Sw.Border3,
    outlineVariant = Sw.Border2,
    error = Sw.ErrorLine,
)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(4.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(8.dp),
)

@Composable
fun SwarmzTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = SwTypography, shapes = shapes, content = content)
}
