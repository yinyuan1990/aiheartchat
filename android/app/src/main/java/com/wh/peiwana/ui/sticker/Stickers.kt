package com.wh.peiwana.ui.sticker

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.rememberLottieComposition
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.theme.Bg3
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** 一张贴纸 / 一条 GIF：聊天消息 type=sticker 的 content、评论的 sticker 字段都是这个 JSON */
@Serializable
data class StickerPayload(
    val id: String,
    /** webp=静态图；lottie=Lottie JSON；awebp=动态 WebP；mp4=GIF（无声视频，thumb 是动态 WebP 预览） */
    val format: String = "webp",
    val url: String,
    val thumb: String = "",
    val w: Int = 512,
    val h: Int = 512,
    val emoji: String = "",
) {
    val isGif get() = format == "mp4"
}

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

@Serializable
private data class GifPage(val items: List<StickerPayload> = emptyList(), val next: String = "")

/** 表情包目录（进程级缓存 + SharedPreferences 落盘，按 version 增量）、「最近使用」、我的包、GIF */
object StickerStore {
    private val json = Json { ignoreUnknownKeys = true }
    private const val PREF = "peiwan_stickers"
    private const val RECENT_MAX = 24

    var sets by mutableStateOf<List<StickerSetItem>>(emptyList())
        private set
    var recent by mutableStateOf<List<StickerPayload>>(emptyList())
        private set
    var recentGifs by mutableStateOf<List<StickerPayload>>(emptyList())
        private set
    private var version = 0
    private var loadedFromDisk = false
    private var fetching = false

    fun parse(content: String): StickerPayload? = runCatching { json.decodeFromString<StickerPayload>(content) }.getOrNull()
    fun encode(p: StickerPayload): String = json.encodeToString(p)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
    private fun saveList(ctx: Context, key: String, list: List<StickerPayload>) =
        prefs(ctx).edit().putString(key, json.encodeToString(ListSerializer(StickerPayload.serializer()), list)).apply()
    private fun readList(ctx: Context, key: String): List<StickerPayload>? =
        prefs(ctx).getString(key, null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(StickerPayload.serializer()), s) }.getOrNull() }

    /** 进面板 / 首次渲染贴纸时调用：先用本地缓存，再问后端 version 有没有变 */
    suspend fun ensureLoaded(ctx: Context) {
        if (!loadedFromDisk) {
            loadedFromDisk = true
            val p = prefs(ctx)
            version = p.getInt("version", 0)
            p.getString("sets", null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(StickerSetItem.serializer()), s) }.getOrNull()?.let { sets = it } }
            readList(ctx, "recent")?.let { recent = it }
            readList(ctx, "recent_gif")?.let { recentGifs = it }
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
                // 后台下架的包：把「最近使用」里已经不在目录中的贴纸清掉
                val alive = sets.flatMap { s -> s.items.map { it.id } }.toHashSet()
                val pruned = recent.filter { it.id in alive }
                if (pruned.size != recent.size) { recent = pruned; saveList(ctx, "recent", recent) }
            }
        } catch (_: Exception) {
        } finally {
            fetching = false
        }
    }

    /** 记一次使用：贴纸进贴纸「最近」，GIF 进 GIF「最近」 */
    fun addRecent(ctx: Context, p: StickerPayload) {
        if (p.isGif) {
            recentGifs = (listOf(p) + recentGifs.filter { it.id != p.id }).take(RECENT_MAX)
            saveList(ctx, "recent_gif", recentGifs)
        } else {
            recent = (listOf(p) + recent.filter { it.id != p.id }).take(RECENT_MAX)
            saveList(ctx, "recent", recent)
        }
    }

    // ---------- 我的表情包（表情商店） ----------

    /** 我面板里的集合 id（有序）；先用本地缓存，进面板时向后端刷一次 */
    var mineIds by mutableStateOf<List<Int>>(emptyList())
        private set
    private var mineLoadedFromDisk = false

    val mineSets: List<StickerSetItem> get() = mineIds.mapNotNull { id -> sets.find { it.id == id } }
    val otherSets: List<StickerSetItem> get() = sets.filter { it.id !in mineIds }

    suspend fun loadMine(ctx: Context) {
        if (!mineLoadedFromDisk) {
            mineLoadedFromDisk = true
            prefs(ctx).getString("mine", null)?.let { s -> runCatching { json.decodeFromString<List<Int>>(s) }.getOrNull()?.let { mineIds = it } }
        }
        runCatching { Api.request("/stickers/mine") }.getOrNull()?.let { applyMine(ctx, it) }
    }

    private fun applyMine(ctx: Context, data: kotlinx.serialization.json.JsonElement) {
        val ids = runCatching { json.decodeFromJsonElement(MineResp.serializer(), data).ids }.getOrNull() ?: return
        mineIds = ids
        prefs(ctx).edit().putString("mine", json.encodeToString(ids)).apply()
    }

    suspend fun addMine(ctx: Context, setId: Int) {
        Api.request("/stickers/mine/$setId", "POST")?.let { applyMine(ctx, it) }
    }

    suspend fun removeMine(ctx: Context, setId: Int) {
        Api.request("/stickers/mine/$setId", "DELETE")?.let { applyMine(ctx, it) }
    }

    suspend fun reorderMine(ctx: Context, ids: List<Int>) {
        mineIds = ids
        Api.request("/stickers/mine", "PUT", buildJsonObject { put("ids", JsonArray(ids.map { JsonPrimitive(it) })) })?.let { applyMine(ctx, it) }
    }

    @Serializable
    private data class MineResp(val ids: List<Int> = emptyList())

    // ---------- GIF（后端 /gifs：Telegram @gif 中转） ----------

    private val gifPages = HashMap<String, Pair<Long, GifPage>>()

    /** 搜 GIF（q 空 = 热门）；同一页 5 分钟内复用。返回 items + 下一页 offset（空 = 没了） */
    suspend fun searchGifs(q: String, offset: String = ""): Pair<List<StickerPayload>, String> {
        val key = "$q|$offset"
        gifPages[key]?.let { (at, page) -> if (System.currentTimeMillis() - at < 5 * 60 * 1000) return page.items to page.next }
        val data = Api.request("/gifs?q=${java.net.URLEncoder.encode(q, "UTF-8")}&offset=${java.net.URLEncoder.encode(offset, "UTF-8")}") ?: return emptyList<StickerPayload>() to ""
        val page = json.decodeFromJsonElement(GifPage.serializer(), data)
        // 首次搜索后端可能还在后台补齐，结果少时只短缓存
        gifPages[key] = (System.currentTimeMillis() - if (page.items.size < 10) 4 * 60 * 1000 else 0) to page
        return page.items to page.next
    }
}

/**
 * 渲染一张贴纸 / GIF（消息气泡 / 评论里用）。size 为长边，按 w/h 保比例。
 * 静态 / 动态 WebP 走 Coil（ImageDecoderDecoder 会自动播动态 WebP）；Lottie 走 lottie-compose；
 * GIF（mp4）用 ExoPlayer 静音循环，autoplay=false 时只放动态 WebP 预览（面板网格 / 待发小图）。
 */
@Composable
fun StickerImage(p: StickerPayload, size: Dp, autoplay: Boolean = true, modifier: Modifier = Modifier) {
    val ratio = if (p.w > 0 && p.h > 0) p.w.toFloat() / p.h else 1f
    val w = if (ratio >= 1f) size else size * ratio
    val h = if (ratio >= 1f) size / ratio else size
    val box = modifier.size(w, h)
    when {
        p.format == "lottie" -> {
            val composition by rememberLottieComposition(LottieCompositionSpec.Url(Api.fullUrl(p.url)))
            if (composition == null && p.thumb.isNotEmpty()) {
                AsyncImage(model = Api.fullUrl(p.thumb), contentDescription = p.emoji, contentScale = ContentScale.Fit, modifier = box)
            } else {
                LottieAnimation(composition = composition, iterations = if (autoplay) LottieConstants.IterateForever else 1, isPlaying = autoplay, modifier = box)
            }
        }
        p.isGif && autoplay -> GifPlayer(p, box.clip(RoundedCornerShape(10.dp)))
        p.isGif -> AsyncImage(model = Api.fullUrl(p.thumb.ifEmpty { p.url }), contentDescription = null, contentScale = ContentScale.Crop, modifier = box.clip(RoundedCornerShape(8.dp)).background(Bg3))
        else -> AsyncImage(model = Api.fullUrl(p.url), contentDescription = p.emoji, contentScale = ContentScale.Fit, modifier = box)
    }
}

/** GIF 气泡：mp4 静音循环；ExoPlayer 起播前先垫动态 WebP 预览 */
@Composable
private fun GifPlayer(p: StickerPayload, modifier: Modifier) {
    val ctx = LocalContext.current
    val url = Api.fullUrl(p.url)
    var ready by remember(url) { mutableStateOf(false) }
    val player = remember(url) {
        ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            repeatMode = Player.REPEAT_MODE_ONE
            volume = 0f
            playWhenReady = true
            addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() { ready = true }
            })
            prepare()
        }
    }
    DisposableEffect(url) { onDispose { player.release() } }
    Box(modifier.background(Bg3)) {
        AndroidView(
            modifier = Modifier.matchParentSize(),
            factory = {
                PlayerView(it).apply {
                    this.player = player
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                }
            },
        )
        if (!ready && p.thumb.isNotEmpty()) {
            AsyncImage(model = Api.fullUrl(p.thumb), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
        }
    }
}

/** 面板网格里的小图：和 Telegram 一样动态的也直接播（LazyVerticalGrid 只组合可见的那几行）；GIF 只放预览 */
@Composable
fun StickerThumb(p: StickerPayload, size: Dp, modifier: Modifier = Modifier) {
    StickerImage(p, size, autoplay = !p.isGif, modifier = modifier)
}

// ---------- 图标 ----------

/** 笑脸（表情按钮） */
@Composable
fun SmileIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.075f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.36f, w * 0.4f))
        drawCircle(tint, radius = w * 0.055f, center = Offset(w * 0.64f, w * 0.4f))
        drawArc(tint, startAngle = 20f, sweepAngle = 140f, useCenter = false, topLeft = Offset(w * 0.27f, w * 0.3f), size = Size(w * 0.46f, w * 0.42f), style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

/** 时钟（最近使用 tab） */
@Composable
fun ClockIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.08f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.5f, w * 0.26f), Offset(w * 0.5f, w * 0.52f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.5f, w * 0.52f), Offset(w * 0.68f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 圆圈加号（顶部条最左，进表情商店，图 6） */
@Composable
fun PlusCircleIcon(tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.07f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.5f, w * 0.3f), Offset(w * 0.5f, w * 0.7f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.3f, w * 0.5f), Offset(w * 0.7f, w * 0.5f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 放大镜（搜索行） */
@Composable
fun SearchIcon(tint: Color, size: Dp = 16.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.1f
        drawCircle(tint, radius = w * 0.3f, center = Offset(w * 0.42f, w * 0.42f), style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.64f, w * 0.64f), Offset(w * 0.88f, w * 0.88f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 地球（切回键盘） */
@Composable
fun GlobeIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.07f
        drawCircle(tint, radius = w * 0.42f, style = Stroke(stroke))
        drawOval(tint, topLeft = Offset(w * 0.3f, w * 0.08f), size = Size(w * 0.4f, w * 0.84f), style = Stroke(stroke))
        drawLine(tint, Offset(w * 0.08f, w * 0.5f), Offset(w * 0.92f, w * 0.5f), strokeWidth = stroke)
        drawLine(tint, Offset(w * 0.5f, w * 0.08f), Offset(w * 0.5f, w * 0.92f), strokeWidth = stroke)
    }
}

/** 退格（删一个字） */
@Composable
fun BackspaceIcon(tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.07f
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.34f, w * 0.22f); lineTo(w * 0.88f, w * 0.22f); lineTo(w * 0.88f, w * 0.78f); lineTo(w * 0.34f, w * 0.78f); lineTo(w * 0.1f, w * 0.5f); close()
        }
        drawPath(path, tint, style = Stroke(stroke, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        drawLine(tint, Offset(w * 0.5f, w * 0.38f), Offset(w * 0.72f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.72f, w * 0.38f), Offset(w * 0.5f, w * 0.62f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

/** 齿轮（管理我的贴纸） */
@Composable
fun GearIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.08f
        drawCircle(tint, radius = w * 0.14f, style = Stroke(stroke))
        for (i in 0 until 8) {
            val a = Math.toRadians(i * 45.0)
            val c = Offset(w * 0.5f, w * 0.5f)
            drawLine(tint, c + Offset(Math.cos(a).toFloat() * w * 0.26f, Math.sin(a).toFloat() * w * 0.26f), c + Offset(Math.cos(a).toFloat() * w * 0.42f, Math.sin(a).toFloat() * w * 0.42f), strokeWidth = stroke, cap = StrokeCap.Round)
        }
        drawCircle(tint, radius = w * 0.28f, style = Stroke(stroke))
    }
}
