package com.wh.peiwana.ui.screen

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.EnterResp
import com.wh.peiwana.net.UserProfile
import com.wh.peiwana.ui.theme.Accent
import com.wh.peiwana.ui.theme.Accent2
import com.wh.peiwana.ui.theme.Bg
import com.wh.peiwana.ui.theme.TextDim
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.sin
import kotlin.random.Random

/** 启动进入：设备已注册直接恢复账号，否则去注册（无密码）。启动页至少停留 1.6s 让文字动画走完 */
@Composable
fun BootScreen(onRegistered: (UserProfile) -> Unit, onNeedRegister: () -> Unit) {
    LaunchedEffect(Unit) {
        val minShow = launch { delay(1600) }
        val resp = runCatching {
            val data = Api.request("/auth/enter", "POST", buildJsonObject { put("deviceId", Api.deviceId) })
            Api.json.decodeFromJsonElement(EnterResp.serializer(), data!!)
        }.getOrNull()
        minShow.join()
        if (resp != null && resp.registered && resp.token != null && resp.user != null) {
            Api.token = resp.token
            onRegistered(resp.user)
        } else {
            onNeedRegister()
        }
    }
    SplashContent()
}

private data class Particle(val x: Float, val y: Float, val r: Float, val speed: Float, val alpha: Float, val phase: Float)

/**
 * 启动页：纯黑底 + 玫红/紫两团柔光 + 缓慢上浮的光点，中间呼吸的心形，
 * 右起竖排「爱情和金钱无关 / 与内心相连」逐字浮现，底部品牌与三点加载。
 */
@Composable
private fun SplashContent() {
    val inf = rememberInfiniteTransition(label = "splash")
    val pulse by inf.animateFloat(0.94f, 1.06f, infiniteRepeatable(tween(1800, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "pulse")
    val glow by inf.animateFloat(0.45f, 0.95f, infiniteRepeatable(tween(1800, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "glow")
    val drift by inf.animateFloat(0f, 1f, infiniteRepeatable(tween(14000, easing = LinearEasing)), label = "drift")
    val dots by inf.animateFloat(0f, 3f, infiniteRepeatable(tween(1200, easing = LinearEasing)), label = "dots")
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    val particles = remember {
        val rnd = Random(7)
        List(22) { Particle(rnd.nextFloat(), rnd.nextFloat(), 1f + rnd.nextFloat() * 2.2f, 0.35f + rnd.nextFloat() * 0.9f, 0.15f + rnd.nextFloat() * 0.45f, rnd.nextFloat() * 6.28f) }
    }

    Box(Modifier.fillMaxSize().background(Bg)) {
        // 柔光
        Box(
            Modifier.size(360.dp).offset(x = 120.dp, y = (-140).dp)
                .background(Brush.radialGradient(listOf(Accent.copy(alpha = 0.26f), Color.Transparent))),
        )
        Box(
            Modifier.align(Alignment.BottomStart).size(320.dp).offset(x = (-120).dp, y = 120.dp)
                .background(Brush.radialGradient(listOf(Color(0xFF7850FF).copy(alpha = 0.18f), Color.Transparent))),
        )
        // 上浮光点
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            particles.forEach { p ->
                val y = ((p.y - drift * p.speed) % 1f + 1f) % 1f
                val x = p.x + 0.012f * sin(drift * 6.28f * 2 + p.phase)
                drawCircle(Color(0xFFFFB3C1).copy(alpha = p.alpha), radius = p.r.dp.toPx(), center = Offset(x * w, y * h))
            }
        }

        Column(Modifier.align(Alignment.Center).offset(y = (-24).dp), horizontalAlignment = Alignment.CenterHorizontally) {
            HeartGlyph(pulse, glow)
            Spacer(Modifier.height(44.dp))
            // 右起竖读：右列第一句，左列第二句略下沉，左列底下一枚「心」印
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.padding(top = 56.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    VerticalChars("与内心相连", shown, startIndex = 7, size = 17.sp, color = TextSub, weight = FontWeight.Normal)
                    Spacer(Modifier.height(14.dp))
                    val sealA by animateFloatAsState(if (shown) 1f else 0f, tween(500, delayMillis = 1250), label = "seal")
                    Box(
                        Modifier.alpha(sealA).size(22.dp).clip(RoundedCornerShape(5.dp)).background(Accent),
                        contentAlignment = Alignment.Center,
                    ) { Text("心", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
                }
                Spacer(Modifier.width(26.dp))
                // 浅色主题：主句用正文色（原来写死白色，白底上看不见）
                VerticalChars("爱情和金钱无关", shown, startIndex = 0, size = 24.sp, color = TextMain, weight = FontWeight.Medium)
            }
        }

        // 底部品牌 + 三点加载
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 54.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("心 之 音", color = TextSub, fontSize = 13.sp, letterSpacing = 4.sp)
            Spacer(Modifier.height(4.dp))
            Text("LOVE HAS NOTHING TO DO WITH MONEY", color = TextDim, fontSize = 9.sp, letterSpacing = 2.sp)
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(3) { i ->
                    val on = dots.toInt() % 3 == i
                    Box(Modifier.size(5.dp).clip(RoundedCornerShape(50)).background(if (on) Accent2 else Accent.copy(alpha = 0.25f)))
                }
            }
        }
    }
}

/** 竖排逐字浮现（每字延迟 90ms，从下方 10dp 淡入） */
@Composable
private fun VerticalChars(text: String, shown: Boolean, startIndex: Int, size: androidx.compose.ui.unit.TextUnit, color: Color, weight: FontWeight) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        text.forEachIndexed { i, ch ->
            val a by animateFloatAsState(if (shown) 1f else 0f, tween(520, delayMillis = 200 + (startIndex + i) * 90, easing = FastOutSlowInEasing), label = "ch$i")
            Text(
                ch.toString(), color = color, fontSize = size, fontWeight = weight,
                modifier = Modifier.alpha(a).offset(y = ((1f - a) * 10).dp),
            )
        }
    }
}

/** 心形：外圈多层低透明描边模拟发光 + 渐变主描边，整体随呼吸缩放 */
@Composable
private fun HeartGlyph(pulse: Float, glow: Float) {
    Canvas(Modifier.size(96.dp).scale(pulse)) {
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(w * 0.5f, h * 0.86f)
            cubicTo(w * 0.18f, h * 0.64f, w * 0.02f, h * 0.44f, w * 0.10f, h * 0.26f)
            cubicTo(w * 0.18f, h * 0.08f, w * 0.42f, h * 0.10f, w * 0.5f, h * 0.30f)
            cubicTo(w * 0.58f, h * 0.10f, w * 0.82f, h * 0.08f, w * 0.90f, h * 0.26f)
            cubicTo(w * 0.98f, h * 0.44f, w * 0.82f, h * 0.64f, w * 0.5f, h * 0.86f)
            close()
        }
        // 发光层
        for (i in 4 downTo 1) {
            drawPath(path, Accent.copy(alpha = 0.05f * glow * i), style = Stroke(width = w * 0.07f + i * w * 0.045f, cap = StrokeCap.Round))
        }
        drawPath(
            path,
            Brush.linearGradient(listOf(Accent2, Accent), start = Offset(0f, 0f), end = Offset(w, h)),
            style = Stroke(width = w * 0.075f, cap = StrokeCap.Round),
        )
    }
}
