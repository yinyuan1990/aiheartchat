package com.wh.peiwana.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 线性麦克风图标（不使用 emoji） */
@Composable
fun MicIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val cx = w / 2
        drawRoundRect(tint, topLeft = Offset(cx - w * 0.14f, w * 0.12f), size = Size(w * 0.28f, w * 0.42f), cornerRadius = CornerRadius(w * 0.14f))
        drawArc(tint, 20f, 140f, false, topLeft = Offset(cx - w * 0.26f, w * 0.26f), size = Size(w * 0.52f, w * 0.44f), style = Stroke(w * 0.06f))
        drawLine(tint, Offset(cx, w * 0.7f), Offset(cx, w * 0.86f), strokeWidth = w * 0.06f)
        drawLine(tint, Offset(cx - w * 0.14f, w * 0.86f), Offset(cx + w * 0.14f, w * 0.86f), strokeWidth = w * 0.06f)
    }
}

/** 声波（语音消息）图标 */
@Composable
fun VoiceIcon(tint: Color, size: Dp = 18.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        // 喇叭口
        drawRoundRect(tint, topLeft = Offset(w * 0.1f, w * 0.36f), size = Size(w * 0.22f, w * 0.28f), cornerRadius = CornerRadius(w * 0.04f))
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.28f, w * 0.5f); lineTo(w * 0.5f, w * 0.25f); lineTo(w * 0.5f, w * 0.75f); close()
        }
        drawPath(path, tint)
        drawArc(tint, -50f, 100f, false, topLeft = Offset(w * 0.5f, w * 0.28f), size = Size(w * 0.28f, w * 0.44f), style = Stroke(w * 0.06f))
        drawArc(tint, -50f, 100f, false, topLeft = Offset(w * 0.6f, w * 0.18f), size = Size(w * 0.4f, w * 0.64f), style = Stroke(w * 0.06f))
    }
}

/** 定位水滴图标 */
@Composable
fun PinIcon(tint: Color, size: Dp = 18.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawArc(tint, 0f, 360f, false, topLeft = Offset(w * 0.22f, w * 0.08f), size = Size(w * 0.56f, w * 0.56f), style = Stroke(w * 0.08f))
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.28f, w * 0.5f); lineTo(w * 0.5f, w * 0.92f); lineTo(w * 0.72f, w * 0.5f)
        }
        drawPath(path, tint, style = Stroke(w * 0.08f))
        drawCircle(tint, w * 0.09f, Offset(w * 0.5f, w * 0.36f))
    }
}

/** 加号图标 */
@Composable
fun PlusIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawLine(tint, Offset(w * 0.5f, w * 0.2f), Offset(w * 0.5f, w * 0.8f), strokeWidth = w * 0.08f)
        drawLine(tint, Offset(w * 0.2f, w * 0.5f), Offset(w * 0.8f, w * 0.5f), strokeWidth = w * 0.08f)
    }
}

/** 视频摄像机图标 */
@Composable
fun VideoIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawRoundRect(tint, topLeft = Offset(w * 0.14f, w * 0.32f), size = Size(w * 0.48f, w * 0.36f), cornerRadius = CornerRadius(w * 0.06f))
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.66f, w * 0.44f); lineTo(w * 0.86f, w * 0.32f); lineTo(w * 0.86f, w * 0.68f); lineTo(w * 0.66f, w * 0.56f); close()
        }
        drawPath(path, tint)
    }
}

/** 礼物盒图标 */
@Composable
fun GiftIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawRoundRect(tint, topLeft = Offset(w * 0.2f, w * 0.4f), size = Size(w * 0.6f, w * 0.42f), cornerRadius = CornerRadius(w * 0.04f), style = Stroke(w * 0.07f))
        drawLine(tint, Offset(w * 0.14f, w * 0.4f), Offset(w * 0.86f, w * 0.4f), strokeWidth = w * 0.07f)
        drawLine(tint, Offset(w * 0.5f, w * 0.4f), Offset(w * 0.5f, w * 0.82f), strokeWidth = w * 0.07f)
        drawCircle(tint, w * 0.08f, Offset(w * 0.4f, w * 0.28f))
        drawCircle(tint, w * 0.08f, Offset(w * 0.6f, w * 0.28f))
    }
}

/** 图片图标 */
@Composable
fun ImageIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawRoundRect(tint, topLeft = Offset(w * 0.15f, w * 0.2f), size = Size(w * 0.7f, w * 0.6f), cornerRadius = CornerRadius(w * 0.08f), style = Stroke(w * 0.07f))
        drawCircle(tint, w * 0.06f, Offset(w * 0.34f, w * 0.38f))
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.2f, w * 0.72f); lineTo(w * 0.42f, w * 0.5f); lineTo(w * 0.6f, w * 0.66f); lineTo(w * 0.72f, w * 0.54f); lineTo(w * 0.8f, w * 0.72f)
        }
        drawPath(path, tint, style = Stroke(w * 0.07f))
    }
}
