package com.wh.peiwana.ui.sticker

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.rememberLottieComposition
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** 一张贴纸：聊天消息 type=sticker 的 content、评论的 sticker 字段都是这个 JSON */
@Serializable
data class StickerPayload(
    val id: String,
    /** webp=静态图；lottie=Lottie JSON；awebp=动态 WebP */
    val format: String = "webp",
    val url: String,
    val thumb: String = "",
    val w: Int = 512,
    val h: Int = 512,
    val emoji: String = "",
)

@Serializable
data class StickerSetItem(
    val id: Int,
    val title: String = "",
    val kind: String = "static",
    val thumb: String = "",
    val items: List<StickerPayload> = emptyList(),
)

@Serializable
private data class StickerCatalog(val version: Int = 0, val notModified: Boolean = false, val sets: List<StickerSetItem> = emptyList())

/** 表情包目录（进程级缓存 + SharedPreferences 落盘，按 version 增量）与「最近使用」 */
object StickerStore {
    private val json = Json { ignoreUnknownKeys = true }
    private const val PREF = "peiwan_stickers"
    private const val RECENT_MAX = 24

    var sets by mutableStateOf<List<StickerSetItem>>(emptyList())
        private set
    var recent by mutableStateOf<List<StickerPayload>>(emptyList())
        private set
    private var version = 0
    private var loadedFromDisk = false
    private var fetching = false

    fun parse(content: String): StickerPayload? = runCatching { json.decodeFromString<StickerPayload>(content) }.getOrNull()
    fun encode(p: StickerPayload): String = json.encodeToString(p)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    /** 进面板 / 首次渲染贴纸时调用：先用本地缓存，再问后端 version 有没有变 */
    suspend fun ensureLoaded(ctx: Context) {
        if (!loadedFromDisk) {
            loadedFromDisk = true
            val p = prefs(ctx)
            version = p.getInt("version", 0)
            p.getString("sets", null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(StickerSetItem.serializer()), s) }.getOrNull()?.let { sets = it } }
            p.getString("recent", null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(StickerPayload.serializer()), s) }.getOrNull()?.let { recent = it } }
        }
        if (fetching) return
        fetching = true
        try {
            val data = withContext(Dispatchers.IO) { Api.request(if (version > 0) "/stickers?ver=$version" else "/stickers") } ?: return
            val cat = json.decodeFromJsonElement(StickerCatalog.serializer(), data)
            if (!cat.notModified) {
                version = cat.version
                sets = cat.sets
                prefs(ctx).edit().putInt("version", version).putString("sets", json.encodeToString(ListSerializer(StickerSetItem.serializer()), sets)).apply()
            }
        } catch (_: Exception) {
        } finally {
            fetching = false
        }
    }

    fun addRecent(ctx: Context, p: StickerPayload) {
        recent = (listOf(p) + recent.filter { it.id != p.id }).take(RECENT_MAX)
        prefs(ctx).edit().putString("recent", json.encodeToString(ListSerializer(StickerPayload.serializer()), recent)).apply()
    }
}

/**
 * 渲染一张贴纸（消息气泡 / 评论里用）。size 为长边，按 w/h 保比例。
 * 静态 / 动态 WebP 走 Coil（ImageDecoderDecoder 会自动播动态 WebP）；Lottie 走 lottie-compose（按 url 缓存）。
 */
@Composable
fun StickerImage(p: StickerPayload, size: Dp, autoplay: Boolean = true, modifier: Modifier = Modifier) {
    val ratio = if (p.w > 0 && p.h > 0) p.w.toFloat() / p.h else 1f
    val w = if (ratio >= 1f) size else size * ratio
    val h = if (ratio >= 1f) size / ratio else size
    val box = modifier.size(w, h)
    if (p.format == "lottie") {
        val composition by rememberLottieComposition(LottieCompositionSpec.Url(Api.fullUrl(p.url)))
        if (composition == null && p.thumb.isNotEmpty()) {
            AsyncImage(model = Api.fullUrl(p.thumb), contentDescription = p.emoji, contentScale = ContentScale.Fit, modifier = box)
        } else {
            LottieAnimation(composition = composition, iterations = if (autoplay) LottieConstants.IterateForever else 1, isPlaying = autoplay, modifier = box)
        }
    } else {
        AsyncImage(model = Api.fullUrl(p.url), contentDescription = p.emoji, contentScale = ContentScale.Fit, modifier = box)
    }
}

/** 面板网格里的小图：动态的用静态缩略图，省资源 */
@Composable
fun StickerThumb(p: StickerPayload, size: Dp, modifier: Modifier = Modifier) {
    val src = if (p.format == "webp") p.url else p.thumb
    if (src.isNotEmpty()) {
        AsyncImage(model = Api.fullUrl(src), contentDescription = p.emoji, contentScale = ContentScale.Fit, modifier = modifier.size(size))
    } else {
        StickerImage(p, size, autoplay = false, modifier = modifier)
    }
}

val EMOJIS = listOf(
    "😀", "😂", "🥰", "😍", "😘", "😊", "🤔", "😎", "🥺", "😭", "😅", "🙃", "😏", "😴", "🤗", "😡",
    "❤️", "💕", "💔", "👍", "👏", "🙏", "🌹", "🎉", "🔥", "✨", "🙌", "🤝", "💪", "🍻", "🎂", "🌙",
)

/**
 * 表情面板（三端同一套交互）：顶部横向 tab（emoji / 最近 / 各表情包封面），下面 5 列网格。
 * onEmoji 传了才有 emoji tab（插入文字）；onPick 点贴纸——聊天里即发送，评论里挂到待发评论上。
 */
@Composable
fun StickerPanel(onPick: (StickerPayload) -> Unit, onEmoji: ((String) -> Unit)? = null, height: Dp = 260.dp) {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { StickerStore.ensureLoaded(ctx) }
    val sets = StickerStore.sets
    val recent = StickerStore.recent
    // tab：-2 emoji，-1 最近，>=0 表情包 id
    var tab by remember { mutableIntStateOf(if (onEmoji != null) -2 else if (recent.isNotEmpty()) -1 else sets.firstOrNull()?.id ?: -1) }
    LaunchedEffect(sets.size) {
        if (tab == -1 && recent.isEmpty() && sets.isNotEmpty() && onEmoji == null) tab = sets.first().id
    }

    Column(Modifier.fillMaxWidth().height(height).background(Bg2)) {
        LazyRow(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (onEmoji != null) item { TabCell(tab == -2, { tab = -2 }) { SmileIcon(TextMain, 22.dp) } }
            item { TabCell(tab == -1, { tab = -1 }) { ClockIcon(TextSub, 20.dp) } }
            items(sets, key = { it.id }) { s ->
                TabCell(tab == s.id, { tab = s.id }) {
                    if (s.thumb.isNotEmpty()) AsyncImage(model = Api.fullUrl(s.thumb), contentDescription = s.title, contentScale = ContentScale.Fit, modifier = Modifier.size(28.dp))
                    else Text(s.title.take(2), color = TextSub, fontSize = 11.sp)
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        when {
            tab == -2 && onEmoji != null -> LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp)) {
                items(EMOJIS) { e ->
                    Text(e, fontSize = 24.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 6.dp).noRippleClick { onEmoji(e) })
                }
            }
            tab == -1 -> if (recent.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(if (sets.isEmpty()) "表情包还在路上…" else "还没用过表情，先从右边的表情包里挑一个", color = TextSub, fontSize = 13.sp)
                }
            } else StickerGrid(recent, onPick)
            else -> {
                val cur = sets.find { it.id == tab }
                if (cur == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("加载中…", color = TextSub, fontSize = 13.sp) }
                else Column(Modifier.fillMaxSize()) {
                    Text(cur.title, color = TextSub, fontSize = 11.sp, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 2.dp))
                    StickerGrid(cur.items, onPick)
                }
            }
        }
    }
}

@Composable
private fun StickerGrid(items: List<StickerPayload>, onPick: (StickerPayload) -> Unit) {
    LazyVerticalGrid(columns = GridCells.Fixed(5), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(items, key = { it.id }) { p ->
            Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).noRippleClick { onPick(p) }, contentAlignment = Alignment.Center) {
                StickerThumb(p, 60.dp)
            }
        }
    }
}

@Composable
private fun TabCell(active: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(if (active) Bg3 else Color.Transparent).noRippleClick(onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** 笑脸（表情按钮） */
@Composable
fun SmileIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.075f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.36f, w * 0.4f))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.64f, w * 0.4f))
        drawArc(tint, startAngle = 20f, sweepAngle = 140f, useCenter = false, topLeft = Offset(w * 0.27f, w * 0.3f), size = Size(w * 0.46f, w * 0.42f), style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
    }
}

/** 时钟（最近使用 tab） */
@Composable
fun ClockIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.08f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.5f, w * 0.26f), Offset(w * 0.5f, w * 0.52f), strokeWidth = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(tint, Offset(w * 0.5f, w * 0.52f), Offset(w * 0.68f, w * 0.62f), strokeWidth = stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}
