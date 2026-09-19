package com.wh.peiwana.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Light = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    secondary = Accent2,
    onSecondary = Color.White,
    background = Bg,
    onBackground = TextMain,
    surface = Bg,
    onSurface = TextMain,
    surfaceVariant = Bg3,
    onSurfaceVariant = TextSub,
    surfaceContainer = Bg2,
    surfaceContainerHigh = Bg2,
    surfaceContainerHighest = Bg3,
    outline = Line,
    outlineVariant = Line,
    error = Danger,
)

@Composable
fun PeiwanATheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Light, typography = Typography, content = content)
}
