package com.wh.peiwana.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** 从左扫到右用时、每颗粒子最长存活（秒） */
private const val SWEEP = 0.45f
private const val LIFE = 0.9f
private const val MAX_PARTICLES = 5000

private class DustCloud(
    val n: Int,
    val x: FloatArray,
    val y: FloatArray,
    val vx: FloatArray,
    val vy: FloatArray,
    val delay: FloatArray,
    val life: FloatArray,
    val argb: IntArray,
    val size: Float,
    val px: Float,
)

/**
 * Telegram 式删除动画（灰飞烟灭）：dying 变 true 时把这块内容截成位图、按像素拆成粒子，
 * 从左到右依次化成灰往右上飘散，播完调用 onGone（这时再把它从列表里移掉）。
 */
@Composable
fun Modifier.dustOut(dying: Boolean, onGone: () -> Unit): Modifier {
    val layer = rememberGraphicsLayer()
    val density = LocalDensity.current.density
    var cloud by remember { mutableStateOf<DustCloud?>(null) }
    var t by remember { mutableFloatStateOf(0f) }
    val gone by rememberUpdatedState(onGone)

    LaunchedEffect(dying) {
        if (!dying) return@LaunchedEffect
        val bmp = runCatching { layer.toImageBitmap() }.getOrNull()
        val c = bmp?.let { withContext(Dispatchers.Default) { runCatching { build(it, density) }.getOrNull() } }
        if (c == null || c.n == 0) {
            gone()
            return@LaunchedEffect
        }
        cloud = c
        val start = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            t = (now - start) / 1_000_000_000f
            if (t > SWEEP + LIFE + 0.1f) break
        }
        gone()
    }

    return drawWithContent {
        val c = cloud
        if (c == null) {
            layer.record { this@drawWithContent.drawContent() }
            drawLayer(layer)
        } else {
            drawCloud(c, t)
        }
    }
}

private fun build(img: ImageBitmap, density: Float): DustCloud {
    val src = img.asAndroidBitmap().let { if (it.config == android.graphics.Bitmap.Config.HARDWARE) it.copy(android.graphics.Bitmap.Config.ARGB_8888, false) else it }
    val w = src.width
    val h = src.height
    val pixels = IntArray(w * h)
    src.getPixels(pixels, 0, w, 0, 0, w, h)
    var step = maxOf(2, (density * 1.4f).toInt())
    while ((w / step) * (h / step) > MAX_PARTICLES) step++
    val cap = (w / step + 1) * (h / step + 1)
    val x = FloatArray(cap); val y = FloatArray(cap)
    val vx = FloatArray(cap); val vy = FloatArray(cap)
    val delay = FloatArray(cap); val life = FloatArray(cap)
    val argb = IntArray(cap)
    var n = 0
    val rnd = Random(w * 31 + h)
    var yy = 0
    while (yy < h) {
        var xx = 0
        while (xx < w) {
            val p = pixels[yy * w + xx]
            if ((p ushr 24) >= 24) {
                val ang = (-Math.PI / 2 + (rnd.nextFloat() - 0.15f) * 1.6f).toFloat()
                val speed = (30f + rnd.nextFloat() * 90f) * density
                x[n] = xx.toFloat(); y[n] = yy.toFloat()
                vx[n] = cos(ang) * speed + 25f * density
                vy[n] = sin(ang) * speed
                delay[n] = xx.toFloat() / w * SWEEP + rnd.nextFloat() * 0.08f
                life[n] = LIFE * (0.6f + rnd.nextFloat() * 0.6f)
                argb[n] = p
                n++
            }
            xx += step
        }
        yy += step
    }
    return DustCloud(n, x, y, vx, vy, delay, life, argb, step.toFloat(), density)
}

private fun DrawScope.drawCloud(c: DustCloud, t: Float) {
    for (i in 0 until c.n) {
        val age = t - c.delay[i]
        if (age > c.life[i]) continue
        var px = c.x[i]
        var py = c.y[i]
        var k = 1f
        if (age > 0f) {
            val f = age / c.life[i]
            px += c.vx[i] * age + sin((c.y[i] + age * 60f) * 0.08f) * 6f * c.px * f
            py += c.vy[i] * age - 18f * c.px * age * age
            k = 1f - f
        }
        val s = if (age > 0f) c.size * (0.5f + 0.5f * k) else c.size
        val a = ((c.argb[i] ushr 24) / 255f) * (if (age > 0f) k * k else 1f)
        drawRect(Color(c.argb[i] or (0xFF shl 24)).copy(alpha = a), Offset(px, py), Size(s, s))
    }
}
