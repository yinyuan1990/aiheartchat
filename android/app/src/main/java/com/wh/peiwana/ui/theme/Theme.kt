package com.wh.peiwana.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Dark = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    secondary = Accent2,
    onSecondary = Color.White,
    background = Bg,
    onBackground = TextMain,
    surface = Bg2,
    onSurface = TextMain,
    surfaceVariant = Bg3,
    onSurfaceVariant = TextSub,
    outline = Line,
    error = Danger,
)

@Composable
fun PeiwanATheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Dark, typography = Typography, content = content)
}
