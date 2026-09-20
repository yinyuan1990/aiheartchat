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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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
                // 后台下架的包：把「最近使用」里已经不在目录中的贴纸清掉
                val alive = sets.flatMap { s -> s.items.map { it.id } }.toHashSet()
                val pruned = recent.filter { it.id in alive }
                if (pruned.size != recent.size) {
                    recent = pruned
                    prefs(ctx).edit().putString("recent", json.encodeToString(ListSerializer(StickerPayload.serializer()), recent)).apply()
                }
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

    // ---------- 我的表情包（表情商店） ----------

    /** 我面板里的集合 id（有序）；先用本地缓存，进面板时向后端刷一次 */
    var mineIds by mutableStateOf<List<Int>>(emptyList())
        private set
    private var mineLoadedFromDisk = false

    val mineSets: List<StickerSetItem> get() = mineIds.mapNotNull { id -> sets.find { it.id == id } }

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

/** 面板网格里的小图：和 Telegram 一样动态的也直接播（LazyVerticalGrid 只组合可见的那几行） */
@Composable
fun StickerThumb(p: StickerPayload, size: Dp, modifier: Modifier = Modifier) {
    StickerImage(p, size, modifier = modifier)
}

val EMOJIS = listOf(
    "😀", "😂", "🥰", "😍", "😘", "😊", "🤔", "😎", "🥺", "😭", "😅", "🙃", "😏", "😴", "🤗", "😡",
    "❤️", "💕", "💔", "👍", "👏", "🙏", "🌹", "🎉", "🔥", "✨", "🙌", "🤝", "💪", "🍻", "🎂", "🌙",
)

/**
 * 表情面板（三端同一套交互）：顶部横向 tab（emoji / 最近 / 我加的表情包），右侧固定「+」进表情商店，下面 5 列网格。
 * onEmoji 传了才有 emoji tab（插入文字）；onPick 点贴纸——聊天里即发送，评论里挂到待发评论上。
 */
@Composable
fun StickerPanel(onPick: (StickerPayload) -> Unit, onEmoji: ((String) -> Unit)? = null, height: Dp = 260.dp) {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { StickerStore.ensureLoaded(ctx); StickerStore.loadMine(ctx) }
    val sets = StickerStore.mineSets
    val recent = StickerStore.recent
    var showStore by remember { mutableStateOf(false) }
    // tab：-2 emoji，-1 最近，>=0 表情包 id
    var tab by remember { mutableIntStateOf(if (onEmoji != null) -2 else if (recent.isNotEmpty()) -1 else sets.firstOrNull()?.id ?: -1) }
    LaunchedEffect(sets.map { it.id }) {
        if (tab == -1 && recent.isEmpty() && sets.isNotEmpty() && onEmoji == null) tab = sets.first().id
        if (tab >= 0 && sets.isNotEmpty() && sets.none { it.id == tab }) tab = sets.first().id
    }

    Column(Modifier.fillMaxWidth().height(height).background(Bg2)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            LazyRow(Modifier.weight(1f).padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (onEmoji != null) item { TabCell(tab == -2, { tab = -2 }) { SmileIcon(TextMain, 22.dp) } }
                item { TabCell(tab == -1, { tab = -1 }) { ClockIcon(TextSub, 20.dp) } }
                items(sets, key = { it.id }) { s ->
                    TabCell(tab == s.id, { tab = s.id }) {
                        if (s.thumb.isNotEmpty()) AsyncImage(model = Api.fullUrl(s.thumb), contentDescription = s.title, contentScale = ContentScale.Fit, modifier = Modifier.size(28.dp))
                        else Text(s.title.take(2), color = TextSub, fontSize = 11.sp)
                    }
                }
            }
            Box(Modifier.width(1.dp).height(28.dp).background(Line))
            Box(Modifier.size(44.dp, 40.dp).noRippleClick { showStore = true }, contentAlignment = Alignment.Center) { PlusIconS(TextSub, 22.dp) }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))

        when {
            tab == -2 && onEmoji != null -> LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp)) {
                items(EMOJIS) { e ->
                    Text(e, fontSize = 24.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 6.dp).noRippleClick { onEmoji(e) })
                }
            }
            tab == -1 -> if (recent.isEmpty()) EmptyHint(sets.isNotEmpty()) { showStore = true } else StickerGrid(recent, onPick)
            else -> {
                val cur = sets.find { it.id == tab }
                if (cur == null) EmptyHint(sets.isNotEmpty()) { showStore = true }
                else Column(Modifier.fillMaxSize()) {
                    Text(cur.title, color = TextSub, fontSize = 11.sp, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 2.dp))
                    StickerGrid(cur.items, onPick)
                }
            }
        }
    }

    if (showStore) {
        androidx.compose.ui.window.Dialog(onDismissRequest = { showStore = false }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            StickerStoreScreen { showStore = false }
        }
    }
}

@Composable
private fun EmptyHint(hasSets: Boolean, onStore: () -> Unit) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(if (hasSets) "还没用过表情，先从右边的表情包里挑一个" else "还没有表情包", color = TextSub, fontSize = 13.sp)
        Spacer(Modifier.height(10.dp))
        Box(Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).noRippleClick(onStore).padding(horizontal = 16.dp, vertical = 7.dp)) {
            Text("去表情商店添加", color = Color.White, fontSize = 13.sp)
        }
    }
}

/**
 * 表情商店（全屏 Dialog，从面板「+」进来）：上半「我的表情」可置顶 / 移除，下半「全部」可添加。
 * 库里的包由后台维护；用户只决定自己面板里有哪些、什么顺序。
 */
@Composable
fun StickerStoreScreen(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { StickerStore.ensureLoaded(ctx); StickerStore.loadMine(ctx) }
    val all = StickerStore.sets
    val mineIds = StickerStore.mineIds
    val mine = StickerStore.mineSets
    val others = all.filter { it.id !in mineIds }
    var busy by remember { mutableStateOf<Int?>(null) }
    var toast by remember { mutableStateOf("") }
    LaunchedEffect(toast) { if (toast.isNotEmpty()) { kotlinx.coroutines.delay(1600); toast = "" } }
    fun run(id: Int, block: suspend () -> Unit) {
        busy = id
        scope.launch { runCatching { block() }.onFailure { toast = it.message ?: "操作失败" }; busy = null }
    }
    val kindName = mapOf("static" to "静态", "animated" to "动态", "video" to "动态")

    Box(Modifier.fillMaxSize().background(Bg)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).noRippleClick(onClose), contentAlignment = Alignment.Center) { com.wh.peiwana.ui.BackIcon(TextMain, 24.dp) }
                Text("表情商店", color = TextMain, fontSize = 17.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f), textAlign = TextAlign.Center)
                Spacer(Modifier.size(40.dp))
            }
            androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize()) {
                item { Text("我的表情（${mine.size}）", color = TextSub, fontSize = 12.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.padding(16.dp, 12.dp, 16.dp, 4.dp)) }
                if (mine.isEmpty()) item { Text("还没有添加表情包，从下面挑几个", color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 14.dp)) }
                items(mine, key = { "m${it.id}" }) { s ->
                    val idx = mineIds.indexOf(s.id)
                    StoreRow(s, kindName[s.kind] ?: "") {
                        if (idx > 0) StoreBtn("置顶", busy == s.id, false) { run(s.id) { StickerStore.reorderMine(ctx, listOf(s.id) + mineIds.filter { it != s.id }) } }
                        StoreBtn("移除", busy == s.id, false) { run(s.id) { StickerStore.removeMine(ctx, s.id) } }
                    }
                }
                item { Text("全部表情包（${all.size}）", color = TextSub, fontSize = 12.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.padding(16.dp, 18.dp, 16.dp, 4.dp)) }
                if (all.isEmpty()) item { Text("表情包还在路上…", color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 14.dp)) }
                else if (others.isEmpty()) item { Text("都已经添加了", color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 14.dp)) }
                items(others, key = { "a${it.id}" }) { s ->
                    StoreRow(s, kindName[s.kind] ?: "") {
                        StoreBtn("添加", busy == s.id, true) { run(s.id) { StickerStore.addMine(ctx, s.id) } }
                    }
                }
                item { Spacer(Modifier.height(30.dp)) }
            }
        }
        if (toast.isNotEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(toast, color = Color.White, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.85f)).padding(horizontal = 22.dp, vertical = 10.dp))
            }
        }
    }
}

@Composable
private fun StoreRow(s: StickerSetItem, kind: String, actions: @Composable RowScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (s.thumb.isNotEmpty()) AsyncImage(model = Api.fullUrl(s.thumb), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(44.dp))
            else Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(Bg3))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(s.title, color = TextMain, fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium, maxLines = 1)
                Text("${s.items.size} 张 · $kind", color = TextSub, fontSize = 12.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { actions() }
        }
        LazyRow(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(s.items.take(8), key = { it.id }) { p -> StickerImage(p, 52.dp, autoplay = false) }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
}

@Composable
private fun StoreBtn(label: String, busy: Boolean, primary: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(14.dp)).background(if (primary) Accent else Bg3).noRippleClick { if (!busy) onClick() }.padding(horizontal = 14.dp, vertical = 6.dp),
    ) { Text(label, color = if (primary) Color.White else TextMain, fontSize = 13.sp) }
}

/** 加号（面板右侧进商店） */
@Composable
private fun PlusIconS(tint: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawLine(tint, Offset(w * 0.5f, w * 0.2f), Offset(w * 0.5f, w * 0.8f), strokeWidth = w * 0.08f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(tint, Offset(w * 0.2f, w * 0.5f), Offset(w * 0.8f, w * 0.5f), strokeWidth = w * 0.08f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
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
