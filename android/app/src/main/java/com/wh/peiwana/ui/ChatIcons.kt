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

/**
 * 扬声器（通话页「免提」）图标：SF Symbols `speaker.wave.2` 的样子——
 * 喇叭主体一笔画成（矩形 + 梯形口），右边两道圆头声波弧。
 */
@Composable
fun VoiceIcon(tint: Color, size: Dp = 18.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.085f
        val body = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.12f, w * 0.38f); lineTo(w * 0.26f, w * 0.38f); lineTo(w * 0.46f, w * 0.2f)
            lineTo(w * 0.46f, w * 0.8f); lineTo(w * 0.26f, w * 0.62f); lineTo(w * 0.12f, w * 0.62f); close()
        }
        drawPath(body, tint, style = Stroke(sw, join = androidx.compose.ui.graphics.StrokeJoin.Round, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        drawArc(tint, -42f, 84f, false, topLeft = Offset(w * 0.42f, w * 0.34f), size = Size(w * 0.3f, w * 0.32f), style = Stroke(sw, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        drawArc(tint, -46f, 92f, false, topLeft = Offset(w * 0.42f, w * 0.2f), size = Size(w * 0.5f, w * 0.6f), style = Stroke(sw, cap = androidx.compose.ui.graphics.StrokeCap.Round))
    }
}

/**
 * 声纹（语音消息 / 输入栏切语音）图标：和 iOS 的 SF Symbols `waveform` 一致——
 * 7 根圆头竖条，中间高两边低，左右不对称。
 */
@Composable
fun WaveformIcon(tint: Color, size: Dp = 18.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val heights = floatArrayOf(0.30f, 0.62f, 0.92f, 0.46f, 0.74f, 0.38f, 0.22f)
        val sw = w * 0.1f
        val gap = (w - sw) / (heights.size - 1)
        heights.forEachIndexed { i, f ->
            val x = sw / 2 + gap * i
            val half = h * f / 2
            drawLine(tint, Offset(x, h / 2 - half), Offset(x, h / 2 + half), strokeWidth = sw, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        }
    }
}

/** 键盘图标（语音模式下切回文字输入）：SF Symbols `keyboard` 的样子——圆角矩形 + 两行键 + 空格条 */
@Composable
fun KeyboardIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.075f
        drawRoundRect(tint, topLeft = Offset(sw / 2, w * 0.22f), size = Size(w - sw, w * 0.56f), cornerRadius = CornerRadius(w * 0.1f), style = Stroke(sw))
        val key = w * 0.07f
        for (row in 0..1) {
            val y = w * (0.36f + row * 0.13f)
            for (i in 0..4) {
                val x = w * (0.2f + i * 0.15f)
                drawRoundRect(tint, topLeft = Offset(x - key / 2, y - key / 2), size = Size(key, key), cornerRadius = CornerRadius(key * 0.3f))
            }
        }
        drawLine(tint, Offset(w * 0.3f, w * 0.65f), Offset(w * 0.7f, w * 0.65f), strokeWidth = sw, cap = androidx.compose.ui.graphics.StrokeCap.Round)
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

/** 实心路径 + 同色圆角描边（把尖角磨圆，接近 SF Symbols 的 .fill 款） */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.filledRound(path: androidx.compose.ui.graphics.Path, tint: Color) {
    drawPath(path, tint)
    drawPath(path, tint, style = Stroke(size.width * 0.06f, join = androidx.compose.ui.graphics.StrokeJoin.Round))
}

/** 位置（「+」面板）：实心导航箭头，同 iOS `location.fill` */
@Composable
fun LocationArrowIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        filledRound(androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.88f, w * 0.12f); lineTo(w * 0.12f, w * 0.45f); lineTo(w * 0.49f, w * 0.51f); lineTo(w * 0.55f, w * 0.88f); close()
        }, tint)
    }
}

/** 电话听筒（「+」面板的语音通话）：实心，同 iOS `phone.fill` */
@Composable
fun PhoneIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        fun x(v: Float) = w * v / 100f
        filledRound(androidx.compose.ui.graphics.Path().apply {
            moveTo(x(30f), x(12f))
            cubicTo(x(24f), x(10f), x(12f), x(16f), x(12f), x(26f))
            cubicTo(x(12f), x(58f), x(42f), x(88f), x(74f), x(88f))
            cubicTo(x(84f), x(88f), x(90f), x(78f), x(88f), x(70f))
            lineTo(x(86f), x(64f))
            cubicTo(x(85f), x(60f), x(82f), x(58f), x(78f), x(58f))
            lineTo(x(66f), x(60f))
            cubicTo(x(62f), x(61f), x(60f), x(62f), x(57f), x(65f))
            cubicTo(x(47f), x(60f), x(40f), x(53f), x(35f), x(43f))
            cubicTo(x(38f), x(40f), x(39f), x(38f), x(40f), x(34f))
            lineTo(x(42f), x(22f))
            cubicTo(x(42f), x(18f), x(40f), x(15f), x(36f), x(14f))
            close()
        }, tint)
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

/** 相机图标（实心，叠在取景画面上用） */
@Composable
fun CameraIcon(tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val body = androidx.compose.ui.graphics.Path().apply {
            addRoundRect(androidx.compose.ui.geometry.RoundRect(w * 0.08f, w * 0.28f, w * 0.92f, w * 0.84f, CornerRadius(w * 0.12f)))
            moveTo(w * 0.34f, w * 0.3f); lineTo(w * 0.4f, w * 0.16f); lineTo(w * 0.6f, w * 0.16f); lineTo(w * 0.66f, w * 0.3f); close()
        }
        drawPath(body, tint)
        drawCircle(Color.Black.copy(alpha = 0.35f), w * 0.17f, Offset(w * 0.5f, w * 0.56f))
        drawCircle(tint, w * 0.11f, Offset(w * 0.5f, w * 0.56f))
    }
}

/** 关闭 × 图标 */
@Composable
fun XMarkIcon(tint: Color, size: Dp = 16.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.12f
        drawLine(tint, Offset(w * 0.2f, w * 0.2f), Offset(w * 0.8f, w * 0.8f), strokeWidth = sw, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(tint, Offset(w * 0.8f, w * 0.2f), Offset(w * 0.2f, w * 0.8f), strokeWidth = sw, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

/** 向下箭头（下拉菜单提示） */
@Composable
fun ChevronDownIcon(tint: Color, size: Dp = 12.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.18f, w * 0.36f); lineTo(w * 0.5f, w * 0.68f); lineTo(w * 0.82f, w * 0.36f)
        }
        drawPath(path, tint, style = Stroke(w * 0.16f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
    }
}

/** 向上箭头（发送） */
@Composable
fun ArrowUpIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.12f
        val cap = androidx.compose.ui.graphics.StrokeCap.Round
        drawLine(tint, Offset(w * 0.5f, w * 0.18f), Offset(w * 0.5f, w * 0.84f), strokeWidth = sw, cap = cap)
        val head = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.22f, w * 0.44f); lineTo(w * 0.5f, w * 0.16f); lineTo(w * 0.78f, w * 0.44f)
        }
        drawPath(head, tint, style = Stroke(sw, cap = cap, join = androidx.compose.ui.graphics.StrokeJoin.Round))
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

/** 实心对话气泡（消息页「评论通知」） */
@Composable
fun BubbleIcon(tint: Color, size: Dp = 26.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawOval(tint, topLeft = Offset(w * 0.08f, w * 0.14f), size = Size(w * 0.84f, w * 0.64f))
        val tail = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.26f, w * 0.62f); lineTo(w * 0.18f, w * 0.9f); lineTo(w * 0.46f, w * 0.74f); close()
        }
        drawPath(tail, tint)
    }
}

/** 线性单人 + 加号（消息页「+」菜单「创建群聊」） */
@Composable
fun PersonPlusIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = Stroke(w * 0.085f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawCircle(tint, radius = w * 0.16f, center = Offset(w * 0.38f, w * 0.32f), style = s)
        drawArc(tint, 180f, 180f, false, topLeft = Offset(w * 0.1f, w * 0.6f), size = Size(w * 0.56f, w * 0.5f), style = s)
        drawLine(tint, Offset(w * 0.8f, w * 0.28f), Offset(w * 0.8f, w * 0.56f), strokeWidth = s.width, cap = s.cap)
        drawLine(tint, Offset(w * 0.66f, w * 0.42f), Offset(w * 0.94f, w * 0.42f), strokeWidth = s.width, cap = s.cap)
    }
}

/** 线性双人（消息页「+」菜单「加入群聊」） */
@Composable
fun PeopleIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = Stroke(w * 0.085f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawCircle(tint, radius = w * 0.15f, center = Offset(w * 0.36f, w * 0.34f), style = s)
        drawArc(tint, 180f, 180f, false, topLeft = Offset(w * 0.08f, w * 0.62f), size = Size(w * 0.56f, w * 0.48f), style = s)
        drawArc(tint, 120f, 270f, false, topLeft = Offset(w * 0.56f, w * 0.2f), size = Size(w * 0.26f, w * 0.26f), style = s)
        drawArc(tint, 270f, 90f, false, topLeft = Offset(w * 0.5f, w * 0.58f), size = Size(w * 0.42f, w * 0.44f), style = s)
    }
}

/** 线性喇叭（消息页「+」菜单「创建频道」） */
@Composable
fun BroadcastIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = Stroke(w * 0.085f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
        val p = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.14f, w * 0.4f); lineTo(w * 0.34f, w * 0.4f); lineTo(w * 0.72f, w * 0.18f)
            lineTo(w * 0.72f, w * 0.82f); lineTo(w * 0.34f, w * 0.6f); lineTo(w * 0.14f, w * 0.6f); close()
        }
        drawPath(p, tint, style = s)
        drawLine(tint, Offset(w * 0.36f, w * 0.62f), Offset(w * 0.42f, w * 0.86f), strokeWidth = w * 0.085f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawArc(tint, -40f, 80f, false, topLeft = Offset(w * 0.7f, w * 0.34f), size = Size(w * 0.2f, w * 0.32f), style = s)
    }
}

/** 实心公文包（消息页「接单通知」） */
@Composable
fun BriefcaseIcon(tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawRoundRect(tint, topLeft = Offset(w * 0.36f, w * 0.14f), size = Size(w * 0.28f, w * 0.2f), cornerRadius = CornerRadius(w * 0.05f), style = Stroke(w * 0.08f))
        drawRoundRect(tint, topLeft = Offset(w * 0.08f, w * 0.3f), size = Size(w * 0.84f, w * 0.56f), cornerRadius = CornerRadius(w * 0.1f))
    }
}
