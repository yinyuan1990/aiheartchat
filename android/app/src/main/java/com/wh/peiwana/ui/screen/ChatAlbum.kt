package com.wh.peiwana.ui.screen

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import com.wh.peiwana.i18n.t
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.WaveformIcon
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.jsonPrimitive
import com.wh.peiwana.net.WsClient
import kotlin.coroutines.resume
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/*
 * 聊天多图（相册）：一次选多张图时每张仍是一条 image 消息，地址后面带 `#g=相册id&w=宽&h=高`。
 * 同一个人连续发、g 相同的图片合成一组，按 Telegram 的分组规则排版。老版本加载图片时忽略 # 后面的部分。
 * 网页版 web/src/album.ts、iOS ChatAlbum.swift 是同一套算法，改的话三端一起改。
 */

data class ImageMeta(val url: String, val g: String? = null, val w: Int = 0, val h: Int = 0)

const val MAX_ALBUM = 10

fun parseImage(content: String): ImageMeta {
    val i = content.indexOf('#')
    if (i < 0) return ImageMeta(content)
    var g: String? = null
    var w = 0
    var h = 0
    content.substring(i + 1).split('&').forEach { kv ->
        val k = kv.substringBefore('=')
        val v = kv.substringAfter('=', "")
        when (k) {
            "g" -> if (v.isNotEmpty()) g = v
            "w" -> w = v.toIntOrNull() ?: 0
            "h" -> h = v.toIntOrNull() ?: 0
        }
    }
    return ImageMeta(content.substring(0, i), g, w, h)
}

fun imageContent(url: String, g: String?, w: Int, h: Int): String {
    val kv = buildList {
        if (!g.isNullOrEmpty()) add("g=$g")
        if (w > 0 && h > 0) { add("w=$w"); add("h=$h") }
    }
    return if (kv.isEmpty()) url else "$url#${kv.joinToString("&")}"
}

fun imageUrl(content: String) = content.substringBefore('#')

fun newAlbumId(): String = (1..8).map { "abcdefghijklmnopqrstuvwxyz0123456789".random() }.joinToString("")

/** 把消息列表切成行：普通消息一行一条，同一相册的连续图片合成一行 */
fun groupAlbums(list: List<MsgItem>): List<List<MsgItem>> {
    val rows = ArrayList<List<MsgItem>>()
    var cur: ArrayList<MsgItem>? = null
    var curG = ""
    for (m in list) {
        val g = if (m.type == "image") parseImage(m.content).g.orEmpty() else ""
        val c = cur
        if (g.isNotEmpty() && c != null && g == curG && c[0].senderId == m.senderId && c.size < MAX_ALBUM) {
            c.add(m)
            continue
        }
        cur = arrayListOf(m)
        curG = g
        rows.add(cur)
    }
    return rows
}

/** 相册里一格的位置，单位是相册宽度 */
data class AlbumRect(val x: Float, val y: Float, val w: Float, val h: Float)

private const val MAX_H = 1.02f
private const val MIN_W = 0.27f

/** ratios：每张图的宽 / 高。返回每格的位置和相册总高度（相对宽度） */
fun albumLayout(raw: List<Float>): Pair<List<AlbumRect>, Float> {
    val n = raw.size
    val r = raw.map { if (it.isFinite() && it > 0f) it.coerceIn(0.2f, 5f) else 1f }
    if (n == 1) {
        val h = min(1f / r[0], MAX_H * 1.2f)
        return listOf(AlbumRect(0f, 0f, 1f, h)) to h
    }
    val prop = r.joinToString("") { if (it > 1.2f) "w" else if (it < 0.8f) "n" else "q" }
    val avg = r.sum() / n
    val force = r.any { it > 2f }

    if (!force && n == 2) {
        if (prop == "ww" && avg > 1.4f / MAX_H && abs(r[1] - r[0]) < 0.2f) {
            val h = minOf(1f / r[0], 1f / r[1], MAX_H / 2)
            return listOf(AlbumRect(0f, 0f, 1f, h), AlbumRect(0f, h, 1f, h)) to h * 2
        }
        if (prop == "ww" || prop == "qq") {
            val h = minOf(0.5f / r[0], 0.5f / r[1], MAX_H)
            return listOf(AlbumRect(0f, 0f, 0.5f, h), AlbumRect(0.5f, 0f, 0.5f, h)) to h
        }
        val w1 = max(0.4f, r[1] / (r[0] + r[1]))
        val w0 = 1f - w1
        val h = minOf(MAX_H, w0 / r[0], w1 / r[1])
        return listOf(AlbumRect(0f, 0f, w0, h), AlbumRect(w0, 0f, w1, h)) to h
    }

    if (!force && n == 3) {
        if (prop[0] == 'n') {
            // 左边一张大图占满高度，右边上下两张
            val h2 = min(MAX_H * 0.5f, r[1] / (r[2] + r[1]))
            val h1 = MAX_H - h2
            val rw = max(MIN_W, min(0.5f, min(h2 * r[2], h1 * r[1])))
            val lw = 1f - rw
            return listOf(AlbumRect(0f, 0f, lw, MAX_H), AlbumRect(lw, 0f, rw, h1), AlbumRect(lw, h1, rw, h2)) to MAX_H
        }
        // 上面一张通栏，下面两张并排
        val h0 = min(1f / r[0], MAX_H * 0.66f)
        val h1 = minOf(MAX_H - h0, 0.5f / r[1], 0.5f / r[2])
        return listOf(AlbumRect(0f, 0f, 1f, h0), AlbumRect(0f, h0, 0.5f, h1), AlbumRect(0.5f, h0, 0.5f, h1)) to h0 + h1
    }

    if (!force && n == 4) {
        if (prop[0] == 'w') {
            // 上面一张通栏，下面三张并排
            val h0 = min(1f / r[0], MAX_H * 0.66f)
            var h = 1f / (r[1] + r[2] + r[3])
            val w0 = max(MIN_W, h * r[1])
            val w2 = max(MIN_W, h * r[3])
            val w1 = max(0.1f, 1f - w0 - w2)
            h = min(MAX_H - h0, h)
            return listOf(
                AlbumRect(0f, 0f, 1f, h0), AlbumRect(0f, h0, w0, h), AlbumRect(w0, h0, w1, h), AlbumRect(w0 + w1, h0, 1f - w0 - w1, h),
            ) to h0 + h
        }
        // 左边一张大图，右边三张竖排
        val rw = min(0.5f, max(MIN_W, MAX_H / (1f / r[1] + 1f / r[2] + 1f / r[3])))
        val h0 = min(0.33f * MAX_H, rw / r[1])
        val h1 = min(0.33f * MAX_H, rw / r[2])
        val h2 = MAX_H - h0 - h1
        val lw = 1f - rw
        return listOf(
            AlbumRect(0f, 0f, lw, MAX_H), AlbumRect(lw, 0f, rw, h0), AlbumRect(lw, h0, rw, h1), AlbumRect(lw, h0 + h1, rw, h2),
        ) to MAX_H
    }

    // 5 张以上（或有特别宽的图）：枚举 2～4 行的切法，选总高度最接近 4:3 的
    val cr = r.map { if (avg > 1.1f) max(1f, it) else min(1f, it) }
    fun rowH(start: Int, count: Int): Float = 1f / (start until start + count).sumOf { cr[it].toDouble() }.toFloat()
    val attempts = ArrayList<List<Int>>()
    for (a in 1 until n) {
        val b = n - a
        if (a <= 3 && b <= 3) attempts.add(listOf(a, b))
    }
    for (a in 1 until n - 1) for (b in 1 until n - a) {
        val c = n - a - b
        if (a <= 3 && b <= (if (avg < 0.85f) 4 else 3) && c <= 3) attempts.add(listOf(a, b, c))
    }
    for (a in 1 until n - 2) for (b in 1 until n - a - 1) for (c in 1 until n - a - b) {
        val d = n - a - b - c
        if (a <= 3 && b <= 3 && c <= 3 && d <= 3) attempts.add(listOf(a, b, c, d))
    }
    val target = 4f / 3f
    var best = attempts.firstOrNull() ?: listOf(n)
    var bestDiff = Float.MAX_VALUE
    for (counts in attempts) {
        var start = 0
        var total = 0f
        var minH = Float.MAX_VALUE
        for (c in counts) {
            val h = rowH(start, c)
            total += h
            minH = min(minH, h)
            start += c
        }
        var diff = abs(total - target)
        if (counts.size > 1 && (counts[0] > counts[1] || (counts.size > 2 && counts[1] > counts[2]) || (counts.size > 3 && counts[2] > counts[3]))) diff *= 1.2f
        if (minH < MIN_W) diff *= 1.5f
        if (diff < bestDiff) { bestDiff = diff; best = counts }
    }
    val rects = ArrayList<AlbumRect>()
    var start = 0
    var y = 0f
    for (c in best) {
        val h = rowH(start, c)
        var x = 0f
        for (i in start until start + c) {
            val w = if (i == start + c - 1) 1f - x else cr[i] * h
            rects.add(AlbumRect(x, y, w, h))
            x += w
        }
        y += h
        start += c
    }
    return rects to y
}

// ---------- 上传 ----------

/** 本地图片的上传状态：progress 0～1；失败等重试 */
data class UploadState(val progress: Float = 0f, val failed: Boolean = false)

/** 图片上传和发送不跟聊天页走：离开页面也会传完发出 */
val ChatUploadScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

/** 最多 limit 个同时上传，传完按 keys 的顺序发出（send 等到服务端确认再发下一张；失败的跳过，留给重试） */
suspend fun uploadInOrder(keys: List<String>, upload: suspend (String) -> String?, send: suspend (String, String) -> Unit, limit: Int = 3) = coroutineScope {
    val sem = Semaphore(limit)
    val jobs = keys.map { k -> async { sem.withPermit { upload(k) } } }
    keys.forEachIndexed { i, k -> jobs[i].await()?.let { send(k, it) } }
}

/**
 * 等服务端确认这条消息（ack / error），最多 timeoutMs。
 * 连发几条时要一条一条等：服务端并发处理同一连接的帧，连着发入库顺序不固定。
 */
suspend fun awaitAck(tempId: String, timeoutMs: Long = 8000): Boolean = withTimeoutOrNull(timeoutMs) {
    suspendCancellableCoroutine { cont ->
        var remove: (() -> Unit)? = null
        remove = WsClient.addListener { frame ->
            if (frame["tempId"]?.jsonPrimitive?.content != tempId) return@addListener
            val op = frame["op"]?.jsonPrimitive?.content
            if (op == "ack" || op == "error") {
                remove?.invoke()
                if (cont.isActive) cont.resume(op == "ack")
            }
        }
        cont.invokeOnCancellation { remove?.invoke() }
    }
} ?: false

private fun exifRotation(ctx: Context, uri: Uri): Int = runCatching {
    ctx.contentResolver.openInputStream(uri)?.use {
        when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
            else -> 0
        }
    } ?: 0
}.getOrDefault(0)

/** 读本地图片的显示宽高（EXIF 转了 90° 的宽高互换） */
fun readImageSize(ctx: Context, uri: Uri): Pair<Int, Int> = runCatching {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, o) }
    val rot = exifRotation(ctx, uri)
    if (rot == 90 || rot == 270) o.outHeight to o.outWidth else o.outWidth to o.outHeight
}.getOrDefault(0 to 0)

/** 长边压到 1600、按 EXIF 转正后出 JPEG；GIF 原样传。返回 (数据, mime) */
fun compressImage(ctx: Context, uri: Uri, maxSide: Int = 1600): Pair<ByteArray, String> {
    val raw = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
    val mime = ctx.contentResolver.getType(uri).orEmpty()
    if (mime == "image/gif") return raw to mime
    return runCatching {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, o)
        val long = max(o.outWidth, o.outHeight)
        val rot = exifRotation(ctx, uri)
        if (long <= maxSide && rot == 0 && raw.size < 1_500_000 && (mime == "image/jpeg" || mime == "image/png" || mime == "image/webp")) return raw to mime
        var sample = 1
        while (long / (sample * 2) >= maxSide) sample *= 2
        var bmp = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })!!
        val scale = min(1f, maxSide.toFloat() / max(bmp.width, bmp.height))
        if (scale < 1f || rot != 0) {
            val m = Matrix().apply { if (scale < 1f) postScale(scale, scale); if (rot != 0) postRotate(rot.toFloat()) }
            val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (out !== bmp) bmp.recycle()
            bmp = out
        }
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, bos)
        bmp.recycle()
        bos.toByteArray() to "image/jpeg"
    }.getOrElse { raw to (mime.ifEmpty { "image/jpeg" }) }
}

// ---------- 界面 ----------

/** 图片上盖的一层：上传中是进度圈，传完等服务端确认时转圈，失败点一下重试 */
@Composable
fun UploadOverlay(state: UploadState?, sending: Boolean, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    if (state == null && !sending) return
    Box(modifier.background(Color.Black.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
        if (state?.failed == true) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.pointerInput(Unit) { detectTapGestures { onRetry() } }) {
                Box(Modifier.size(34.dp).clip(CircleShape).background(Danger), contentAlignment = Alignment.Center) {
                    Text("!", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                }
                Text(t("chat.upload.retry"), color = Color.White, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
            }
            return@Box
        }
        val spin = rememberInfiniteTransition(label = "upSpin")
        val angle by spin.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "upAngle")
        val p = state?.progress
        Canvas(Modifier.size(44.dp).rotate(if (p == null) angle else 0f)) {
            drawCircle(Color.Black.copy(alpha = 0.45f))
            val stroke = 2.6.dp.toPx()
            val inset = 5.dp.toPx()
            drawArc(
                Color.White, startAngle = -90f, sweepAngle = if (p == null) 100f else 360f * p.coerceAtLeast(0.04f), useCenter = false,
                topLeft = Offset(inset, inset), size = Size(size.width - inset * 2, size.height - inset * 2),
                style = Stroke(stroke, cap = StrokeCap.Round),
            )
        }
    }
}

/** 相册里的一格 */
data class AlbumCell(val key: String, val model: Any, val w: Int, val h: Int, val state: UploadState?, val sending: Boolean)

/** Telegram 式多图拼版：整块圆角，格子之间留 2dp 缝 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ImageAlbum(cells: List<AlbumCell>, width: Dp, onTap: (Int) -> Unit, onLongPress: (Int) -> Unit, onRetry: (Int) -> Unit) {
    val (rects, height) = remember(cells.map { it.w to it.h }) {
        albumLayout(cells.map { if (it.w > 0 && it.h > 0) it.w.toFloat() / it.h else 1f })
    }
    val gap = 2.dp
    Box(Modifier.size(width, width * height).clip(RoundedCornerShape(12.dp)).background(Bg3)) {
        cells.forEachIndexed { i, c ->
            val r = rects[i]
            val left = width * r.x + if (r.x > 0.001f) gap / 2 else 0.dp
            val right = width * (r.x + r.w) - if (r.x + r.w < 0.999f) gap / 2 else 0.dp
            val top = width * r.y + if (r.y > 0.001f) gap / 2 else 0.dp
            val bottom = width * (r.y + r.h) - if (r.y + r.h < height - 0.001f) gap / 2 else 0.dp
            key(c.key) {
                Box(Modifier.offset(left, top).size((right - left).coerceAtLeast(1.dp), (bottom - top).coerceAtLeast(1.dp))) {
                    AsyncImage(
                        model = c.model, contentDescription = null, contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize().background(Bg3).combinedClickable(
                            interactionSource = remember { MutableInteractionSource() }, indication = null,
                            onLongClick = { onLongPress(i) },
                        ) { onTap(i) },
                    )
                    UploadOverlay(c.state, c.sending, { onRetry(i) }, Modifier.matchParentSize())
                }
            }
        }
    }
}

/** 单张图：有宽高就按比例预留尺寸（加载前不跳动），最宽 maxW、最高 maxH */
fun singleImageSize(w: Int, h: Int, maxW: Dp, maxH: Dp): Pair<Dp, Dp>? {
    if (w <= 0 || h <= 0) return null
    val s = min(maxW.value / w, maxH.value / h)
    return max(60f, w * s).dp to max(60f, h * s).dp
}

// ---------- 语音 ----------

/** 按住说话条（频道用；聊天页自己有一套）：松手发出，录到的 m4a 和秒数交给 onSend */
@Composable
fun VoiceHoldBar(modifier: Modifier, onSend: (ByteArray, Int) -> Unit) {
    val ctx = LocalContext.current
    var recording by remember { mutableStateOf(false) }
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var file by remember { mutableStateOf<File?>(null) }
    var started by remember { mutableLongStateOf(0L) }
    val perm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    fun start() {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            perm.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        runCatching {
            val f = File(ctx.cacheDir, "rec_${System.currentTimeMillis()}.m4a")
            val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setOutputFile(f.absolutePath)
            r.prepare(); r.start()
            recorder = r; file = f; started = System.currentTimeMillis(); recording = true
        }
    }
    fun stop() {
        if (!recording) return
        recording = false
        val ok = runCatching { recorder?.stop() }.isSuccess
        runCatching { recorder?.release() }
        recorder = null
        val f = file ?: return
        val dur = ((System.currentTimeMillis() - started) / 1000).toInt()
        if (!ok || dur < 1) { android.widget.Toast.makeText(ctx, t("chat.voice.tooShort"), android.widget.Toast.LENGTH_SHORT).show(); return }
        onSend(f.readBytes(), dur.coerceAtMost(60))
        f.delete()
    }
    DisposableEffect(Unit) { onDispose { runCatching { recorder?.stop(); recorder?.release() } } }
    Box(
        modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(if (recording) Accent else Bg3)
            .pointerInput(Unit) { detectTapGestures(onPress = { start(); tryAwaitRelease(); stop() }) },
        contentAlignment = Alignment.Center,
    ) {
        if (recording) {
            val trans = rememberInfiniteTransition(label = "rec")
            val a by trans.animateFloat(0.35f, 1f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "a")
            Row(verticalAlignment = Alignment.CenterVertically) {
                WaveformIcon(Color.White.copy(alpha = a), 16.dp); Spacer(Modifier.width(8.dp)); Text(t("chat.releaseToSend"), color = Color.White, fontSize = 14.sp)
            }
        } else Text(t("chat.holdToTalk"), color = TextMain, fontSize = 14.sp)
    }
}

/** 本地选的图（content:// / file://）直接给 Coil；服务器上的补全地址 */
fun imageModel(local: String?, content: String): Any = local ?: Api.fullUrl(imageUrl(content))
