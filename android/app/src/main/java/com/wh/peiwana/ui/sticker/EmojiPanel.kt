package com.wh.peiwana.ui.sticker

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 面板三个模式 */
enum class PanelMode { GIF, STICKER, EMOJI }

/** 搜索行右侧的快捷 emoji（Telegram 同款）：贴纸按 emoji 过滤，GIF 当搜索词 */
private val QUICK_EMOJIS = listOf("❤️", "👍", "👎", "🎉", "👋", "😀", "😢", "😠")
private const val BOTTOM_PAD = 64

/**
 * 表情面板（Telegram 式，三端同一套）：底部悬浮胶囊切 GIF / 贴纸 / 表情，内容往下滚时胶囊和顶部条一起收起。
 * - 表情：点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 * - 贴纸 / GIF：点了回调 onPick（聊天里即发送，评论里挂到待发区），右 ⚙ 管理我的贴纸
 */
@Composable
fun EmojiPanel(
    onPick: (StickerPayload) -> Unit,
    onEmoji: ((String) -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
    onKeyboard: (() -> Unit)? = null,
) {
    val ctx = LocalContext.current
    val cfg = LocalConfiguration.current
    // 跟键盘差不多高，且收起顶部后能完整放 5 行贴纸
    val height = (cfg.screenWidthDp * 0.92f).dp.coerceIn(320.dp, 420.dp)
    var mode by remember { mutableStateOf(PanelPrefs.lastMode(ctx)) }
    val chrome = remember { PanelChrome() }
    // 底部 sheet：商店 / 管理 / GIF 搜索 / 表情搜索。query 非 null = 从搜索行进来（"" 只聚焦搜索框，emoji 直接带着搜）
    var sheet by remember { mutableStateOf<SheetReq?>(null) }
    LaunchedEffect(mode) { chrome.show(); PanelPrefs.saveMode(ctx, mode) }
    val pickGif: (StickerPayload) -> Unit = { onPick(it); StickerStore.addRecent(ctx, it) }
    val pickEmoji: (String) -> Unit = { onEmoji?.invoke(it); EmojiStore.addRecent(ctx, it) }

    // 面板本身挂个空 pointerInput：空白处的点击到此为止，不穿到下层页面（主页底栏「+」）
    Box(Modifier.fillMaxWidth().height(height).background(Bg2).pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
        when (mode) {
            PanelMode.STICKER -> StickerPane(chrome, onPick = pickGif, onStore = { q -> sheet = SheetReq(SheetKind.STORE, q) })
            PanelMode.GIF -> GifPane(chrome, onPick = pickGif, onSearch = { q -> sheet = SheetReq(SheetKind.GIF, q) })
            PanelMode.EMOJI -> EmojiPane(chrome, onEmoji = pickEmoji, onSearch = { q -> sheet = SheetReq(SheetKind.EMOJI, q) })
        }

        // 底部悬浮：左 🌐（表情）/ 胶囊 / 右 ⌫（表情）或 ⚙（贴纸）
        AnimatedVisibility(
            visible = !chrome.hidden,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = fadeIn() + slideInVertically { it },
            exit = fadeOut() + slideOutVertically { it },
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (mode == PanelMode.EMOJI && onKeyboard != null) SideBtn(Modifier.align(Alignment.CenterStart), onKeyboard) { GlobeIcon(TextMain, 22.dp) }
                Row(
                    Modifier.align(Alignment.Center).shadow(6.dp, RoundedCornerShape(20.dp)).clip(RoundedCornerShape(20.dp)).background(Bg).padding(3.dp),
                ) {
                    listOf(PanelMode.GIF to "GIF", PanelMode.STICKER to "贴纸", PanelMode.EMOJI to "表情").forEach { (m, label) ->
                        val on = mode == m
                        Text(
                            label, color = if (on) TextMain else TextSub, fontSize = 14.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (on) Bg3 else Color.Transparent).noRippleClick { mode = m }.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
                if (mode == PanelMode.EMOJI && onDelete != null) SideBtn(Modifier.align(Alignment.CenterEnd), onDelete) { BackspaceIcon(TextMain, 22.dp) }
                if (mode == PanelMode.STICKER) SideBtn(Modifier.align(Alignment.CenterEnd), { sheet = SheetReq(SheetKind.MANAGE) }) { GearIcon(TextMain, 20.dp) }
            }
        }
    }

    sheet?.let { r ->
        when (r.kind) {
            SheetKind.STORE, SheetKind.MANAGE -> StickerStoreSheet(manage = r.kind == SheetKind.MANAGE, initialQuery = r.query ?: "", focusSearch = r.query != null) { sheet = null }
            SheetKind.GIF -> GifSearchSheet(initialQuery = r.query ?: "", onPick = pickGif) { sheet = null }
            SheetKind.EMOJI -> EmojiSearchSheet(initialQuery = r.query ?: "", onEmoji = pickEmoji) { sheet = null }
        }
    }
}

private enum class SheetKind { STORE, MANAGE, GIF, EMOJI }
private data class SheetReq(val kind: SheetKind, val query: String? = null)

@Composable
private fun SideBtn(modifier: Modifier, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(modifier.size(40.dp).shadow(6.dp, CircleShape).clip(CircleShape).background(Bg).noRippleClick(onClick), contentAlignment = Alignment.Center) { content() }
}

private object PanelPrefs {
    fun lastMode(ctx: Context): PanelMode =
        runCatching { PanelMode.valueOf(ctx.getSharedPreferences("peiwan_stickers", Context.MODE_PRIVATE).getString("panel_mode", "STICKER")!!) }.getOrDefault(PanelMode.STICKER)
    fun saveMode(ctx: Context, m: PanelMode) = ctx.getSharedPreferences("peiwan_stickers", Context.MODE_PRIVATE).edit().putString("panel_mode", m.name).apply()
}

/** 内容区滚动方向 → 顶部条 / 底部胶囊收起或展开（往下滚收起，往上滚或回到顶部展开） */
class PanelChrome {
    var hidden by mutableStateOf(false)
        private set
    fun show() { hidden = false }
    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (available.y < -6f) hidden = true else if (available.y > 6f) hidden = false
            return Offset.Zero
        }
    }
}

/** 网格滚回顶部时把顶部条放出来 */
@Composable
private fun ShowAtTop(chrome: PanelChrome, grid: LazyGridState) {
    val atTop by remember { derivedStateOf { grid.firstVisibleItemIndex == 0 && grid.firstVisibleItemScrollOffset < 24 } }
    LaunchedEffect(atTop) { if (atTop) chrome.show() }
}

/** 顶部横向条被用户拖动时展开成两行（图 5），松手 1.5 秒后收回 */
@Composable
private fun rememberBarExpanded(row: LazyListState): Boolean {
    val dragged by row.interactionSource.collectIsDraggedAsState()
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(dragged) {
        if (dragged) expanded = true else { delay(1500); expanded = false }
    }
    return expanded
}

/** 顶部条上的一个格子（图标 / 封面），expanded 时下面带名字 */
@Composable
private fun BarCell(active: Boolean, expanded: Boolean, title: String, badge: Boolean = false, onClick: () -> Unit, content: @Composable () -> Unit) {
    Column(
        Modifier.width(if (expanded) 56.dp else 40.dp).height(if (expanded) 64.dp else 40.dp).clip(RoundedCornerShape(10.dp)).background(if (active) Bg3 else Color.Transparent).noRippleClick(onClick),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
            content()
            if (badge) Box(Modifier.align(Alignment.TopEnd).offset(4.dp, (-3).dp).size(14.dp).clip(CircleShape).background(Accent), contentAlignment = Alignment.Center) {
                Text("+", color = Color.White, fontSize = 10.sp, lineHeight = 10.sp)
            }
        }
        if (expanded) Text(title, color = TextSub, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp, start = 2.dp, end = 2.dp))
    }
}

/** 快捷 emoji 虚化：灰度 + 半透明，被选中的那个恢复彩色 */
private val GRAYSCALE = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

/**
 * 搜索行（Telegram 图）：一整条圆角胶囊，左边 🔍「搜索」，右边一排**虚化**的快捷 emoji。
 * - 贴纸页传 onTap：整条胶囊是个按钮（和「+」一样弹表情商店 sheet 并聚焦搜索框），点快捷 emoji 直接带着它去搜；
 * - 表情 / GIF 页不传：点胶囊变成输入框就地搜，快捷 emoji 点亮一个当过滤词。
 */
@Composable
private fun SearchRow(value: String, onChange: (String) -> Unit, chip: String, onChip: (String) -> Unit, placeholder: String, onTap: (() -> Unit)? = null) {
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val editing = onTap == null && (focused || value.isNotEmpty())
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 8.dp).height(32.dp)
            .clip(RoundedCornerShape(16.dp)).background(Bg3)
            .noRippleClick { if (onTap != null) onTap() else { focused = true; focus.requestFocus() } }
            .padding(start = 12.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SearchIcon(TextDim, 15.dp)
        Spacer(Modifier.width(6.dp))
        if (onTap != null) {
            Text(placeholder, color = TextDim, fontSize = 14.sp)
        } else {
            Box(Modifier.then(if (editing) Modifier.weight(1f) else Modifier.width(44.dp))) {
                if (value.isEmpty()) Text(placeholder, color = TextDim, fontSize = 14.sp, maxLines = 1)
                BasicTextField(
                    value, onChange, singleLine = true, textStyle = TextStyle(color = TextMain, fontSize = 14.sp), cursorBrush = SolidColor(Accent),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused },
                )
            }
        }
        if (editing) {
            Text("✕", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick { onChange(""); onChip(""); focused = false }.padding(horizontal = 6.dp))
        } else {
            Spacer(Modifier.weight(1f))
            LazyRow(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                items(QUICK_EMOJIS) { e ->
                    val on = chip == e
                    Box(
                        Modifier.size(30.dp).clip(CircleShape).background(if (on) Bg else Color.Transparent)
                            .noRippleClick { onChip(if (on) "" else e) }
                            .alpha(if (on) 1f else 0.45f),
                        contentAlignment = Alignment.Center,
                    ) {
                        // Text 不能直接套 ColorFilter，用 Canvas 画一层饱和度 0 的 emoji
                        if (on) Text(e, fontSize = 19.sp) else GrayEmoji(e)
                    }
                }
            }
        }
    }
}

/** 灰度 emoji：把 emoji 画到位图再用饱和度 0 的 ColorFilter 显示 */
@Composable
private fun GrayEmoji(e: String) {
    val density = LocalDensity.current
    val bmp = remember(e, density) {
        val px = with(density) { 22.sp.toPx() }
        val size = (px * 1.3f).toInt().coerceAtLeast(1)
        val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = px; textAlign = android.graphics.Paint.Align.CENTER }
        val y = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(e, size / 2f, y, paint)
        bitmap.asImageBitmap()
    }
    Image(bmp, contentDescription = e, colorFilter = GRAYSCALE, modifier = Modifier.size(24.dp))
}

@Composable
private fun SectionHeader(title: String, right: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), color = TextSub, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        right?.invoke()
    }
}

@Composable
private fun EmptyText(text: String) {
    Text(text, color = TextDim, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp))
}

private fun baseEmoji(e: String) = e.replace("\uFE0F", "")

// ---------- 贴纸页 ----------

private data class Section(val key: String, val title: String, val items: List<StickerPayload>)

/**
 * 贴纸页：顶部条（⊕ 商店 / 🕒 最近 / 我的包封面… / 库里没加的带 +）+ 搜索行，
 * 内容是所有包连续滚动、每包一个标题分区；滚到哪个包顶部封面跟着亮。
 * 搜索行整条是按钮：和「+」一样弹表情商店 sheet（onStore("") 聚焦搜索框）；点快捷 emoji 带着它去搜（onStore(emoji)）。
 */
@Composable
private fun StickerPane(chrome: PanelChrome, onPick: (StickerPayload) -> Unit, onStore: (String?) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { StickerStore.ensureLoaded(ctx); StickerStore.loadMine(ctx) }
    val mine = StickerStore.mineSets
    val others = StickerStore.otherSets
    val recent = StickerStore.recent
    var adding by remember { mutableStateOf<Int?>(null) }
    val grid = rememberLazyGridState()
    val row = rememberLazyListState()
    val expanded = rememberBarExpanded(row)
    ShowAtTop(chrome, grid)

    val sections = remember(mine, recent) {
        buildList {
            if (recent.isNotEmpty()) add(Section("recent", "最近使用", recent))
            mine.forEach { add(Section("s${it.id}", it.title, it.items)) }
        }
    }
    // 每个分区 = 1 个标题 + N 张；算每个分区的起始 index 用来定位当前分区 / 跳转
    val starts = remember(sections) { sections.runningFold(0) { acc, s -> acc + 1 + s.items.size } }
    val activeKey by remember(sections) {
        derivedStateOf {
            val idx = grid.firstVisibleItemIndex + 1
            var cur = sections.firstOrNull()?.key ?: "recent"
            sections.forEachIndexed { i, s -> if (starts[i] <= idx) cur = s.key }
            cur
        }
    }
    // 当前封面滚到可见（bar：0 商店，1 最近，2.. 我的包）
    LaunchedEffect(activeKey) {
        val i = if (activeKey == "recent") 1 else mine.indexOfFirst { "s${it.id}" == activeKey }.let { if (it < 0) -1 else it + 2 }
        if (i >= 0) row.animateScrollToItem((i - 2).coerceAtLeast(0))
    }
    fun jump(key: String) {
        val i = sections.indexOfFirst { it.key == key }
        scope.launch { grid.animateScrollToItem(if (i < 0) 0 else starts[i]) }
    }
    fun add(id: Int) {
        adding = id
        scope.launch { runCatching { StickerStore.addMine(ctx, id) }; adding = null }
    }

    Column(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible = !chrome.hidden, enter = expandVertically(), exit = shrinkVertically()) {
            Column {
                LazyRow(state = row, modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    item("store") { BarCell(false, expanded, "表情商店", onClick = { onStore(null) }) { PlusCircleIcon(TextSub, 26.dp) } }
                    item("recent") { BarCell(activeKey == "recent", expanded, "最近使用", onClick = { jump("recent") }) { ClockIcon(TextSub, 20.dp) } }
                    items(mine, key = { "m${it.id}" }) { s ->
                        BarCell(activeKey == "s${s.id}", expanded, s.title, onClick = { jump("s${s.id}") }) { Cover(s) }
                    }
                    items(others.take(12), key = { "o${it.id}" }) { s ->
                        BarCell(false, expanded, s.title, badge = true, onClick = { add(s.id) }) { Box(Modifier.alpha(if (adding == s.id) 0.4f else 1f)) { Cover(s) } }
                    }
                }
                SearchRow("", {}, "", { onStore(it) }, "搜索", onTap = { onStore("") })
            }
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(5), state = grid,
            modifier = Modifier.fillMaxSize().nestedScroll(chrome.connection),
            contentPadding = PaddingValues(8.dp, 0.dp, 8.dp, BOTTOM_PAD.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            sections.forEach { s ->
                item(key = "h${s.key}", span = { GridItemSpan(maxLineSpan) }) { SectionHeader(s.title) }
                items(s.items, key = { "${s.key}-${it.id}" }) { p ->
                    Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).noRippleClick { onPick(p) }, contentAlignment = Alignment.Center) { StickerThumb(p, 62.dp) }
                }
            }
            if (sections.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(if (mine.isEmpty()) "还没有贴纸包" else "还没用过贴纸，往下挑一个", color = TextDim, fontSize = 13.sp)
                    if (mine.isEmpty()) {
                        Spacer(Modifier.height(10.dp))
                        Box(Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).noRippleClick { onStore(null) }.padding(horizontal = 16.dp, vertical = 7.dp)) { Text("去表情商店添加", color = Color.White, fontSize = 13.sp) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Cover(s: StickerSetItem) {
    if (s.thumb.isNotEmpty()) AsyncImage(model = Api.fullUrl(s.thumb), contentDescription = s.title, contentScale = ContentScale.Fit, modifier = Modifier.size(28.dp))
    else Text(s.title.take(2), color = TextSub, fontSize = 11.sp)
}

@Composable
private fun AddBtn(busy: Boolean, primary: Boolean = true, label: String = "添加", onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(14.dp)).background(if (primary) Accent else Bg3).alpha(if (busy) 0.5f else 1f).noRippleClick { if (!busy) onClick() }.padding(horizontal = 14.dp, vertical = 5.dp),
    ) { Text(label, color = if (primary) Color.White else TextMain, fontSize = 13.sp) }
}

// ---------- 表情页 ----------

/**
 * 表情页：顶部 🕒 + 8 个分类图标，搜索行，内容 8 列按分类分区。
 * 搜索行整条是按钮：和贴纸页一样弹搜索 sheet（onSearch("") 聚焦输入框；点快捷 emoji 带着它去搜）。
 */
@Composable
private fun EmojiPane(chrome: PanelChrome, onEmoji: (String) -> Unit, onSearch: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { EmojiStore.ensureLoaded(ctx) }
    val groups = EmojiStore.groups
    val recent = EmojiStore.recent
    val grid = rememberLazyGridState()
    val row = rememberLazyListState()
    val expanded = rememberBarExpanded(row)
    ShowAtTop(chrome, grid)

    // 分区：最近 + 各分类；每区 1 个标题 + N 个
    val sections = remember(groups, recent) {
        buildList {
            if (recent.isNotEmpty()) add(Triple("recent", "最近使用", recent))
            groups.forEach { g -> add(Triple(g.key, g.name, g.items.map { it[0] })) }
        }
    }
    val starts = remember(sections) { sections.runningFold(0) { acc, s -> acc + 1 + s.third.size } }
    val activeKey by remember(sections) {
        derivedStateOf {
            val idx = grid.firstVisibleItemIndex + 1
            var cur = sections.firstOrNull()?.first ?: "recent"
            sections.forEachIndexed { i, s -> if (starts[i] <= idx) cur = s.first }
            cur
        }
    }
    LaunchedEffect(activeKey) {
        val i = if (activeKey == "recent") 0 else groups.indexOfFirst { it.key == activeKey }.let { if (it < 0) -1 else it + 1 }
        if (i >= 0) row.animateScrollToItem((i - 2).coerceAtLeast(0))
    }
    fun jump(key: String) {
        val i = sections.indexOfFirst { it.first == key }
        scope.launch { grid.animateScrollToItem(if (i < 0) 0 else starts[i]) }
    }

    Column(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible = !chrome.hidden, enter = expandVertically(), exit = shrinkVertically()) {
            Column {
                LazyRow(state = row, modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    item("recent") { BarCell(activeKey == "recent", expanded, "最近使用", onClick = { jump("recent") }) { ClockIcon(TextSub, 20.dp) } }
                    items(groups, key = { it.key }) { g ->
                        BarCell(activeKey == g.key, expanded, g.name, onClick = { jump(g.key) }) { Text(g.icon, fontSize = 20.sp, modifier = Modifier.alpha(if (activeKey == g.key) 1f else 0.6f)) }
                    }
                }
                SearchRow("", {}, "", { onSearch(it) }, "搜索表情", onTap = { onSearch("") })
            }
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(8), state = grid,
            modifier = Modifier.fillMaxSize().nestedScroll(chrome.connection),
            contentPadding = PaddingValues(6.dp, 0.dp, 6.dp, BOTTOM_PAD.dp),
        ) {
            sections.forEach { (key, title, items) ->
                item(key = "h$key", span = { GridItemSpan(maxLineSpan) }) { SectionHeader(title) }
                items(items.size, key = { "$key-$it" }) { i -> EmojiCell(items[i], onEmoji) }
            }
            if (groups.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { EmptyText("加载中…") }
        }
    }
}

@Composable
private fun EmojiCell(e: String, onEmoji: (String) -> Unit) {
    Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(8.dp)).noRippleClick { onEmoji(e) }, contentAlignment = Alignment.Center) {
        Text(e, fontSize = 26.sp)
    }
}

// ---------- GIF 页 ----------

/**
 * GIF 页：没有顶部封面条，只有搜索行；内容 3 列瓦片（最近使用 + 热门），滚到底自动翻页。
 * 搜索行整条是按钮：和贴纸页一样弹搜索 sheet。
 */
@Composable
private fun GifPane(chrome: PanelChrome, onPick: (StickerPayload) -> Unit, onSearch: (String) -> Unit) {
    val feed = rememberGifFeed("")
    val grid = rememberLazyGridState()
    val recent = StickerStore.recentGifs
    ShowAtTop(chrome, grid)
    GifPaging(grid, feed)

    Column(Modifier.fillMaxSize()) {
        AnimatedVisibility(visible = !chrome.hidden, enter = expandVertically(), exit = shrinkVertically()) {
            SearchRow("", {}, "", { onSearch(it) }, "搜索 GIF", onTap = { onSearch("") })
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(3), state = grid,
            modifier = Modifier.fillMaxSize().nestedScroll(chrome.connection),
            contentPadding = PaddingValues(0.dp, 0.dp, 0.dp, BOTTOM_PAD.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (recent.isNotEmpty()) {
                item(key = "hr", span = { GridItemSpan(maxLineSpan) }) { SectionHeader("最近使用") }
                items(recent, key = { "r${it.id}" }) { p -> GifTile(p) { onPick(p) } }
            }
            item(key = "ht", span = { GridItemSpan(maxLineSpan) }) { SectionHeader("热门") }
            items(feed.items, key = { it.id }) { p -> GifTile(p) { onPick(p) } }
            item(span = { GridItemSpan(maxLineSpan) }) { GifFooter(feed, "暂无 GIF") }
        }
    }
}

/** 一路 GIF 结果（热门或某个搜索词）：首页 + 翻页 + 首次搜索 3 秒后补拉 */
private class GifFeed(val query: String) {
    var items by mutableStateOf<List<StickerPayload>>(emptyList())
    var next by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf("")
}

@Composable
private fun rememberGifFeed(query: String): GifFeed {
    val feed = remember(query) { GifFeed(query) }
    LaunchedEffect(query) {
        feed.loading = true; feed.error = ""
        runCatching { StickerStore.searchGifs(query, "") }
            .onSuccess { (list, n) ->
                feed.items = list; feed.next = n
                // 首次搜索后端还在后台补齐时结果会少，3 秒后再拉一次
                if (list.size < 10 && n.isNotEmpty()) {
                    delay(3000)
                    runCatching { StickerStore.searchGifs(query, "") }.onSuccess { (l2, n2) -> if (l2.size > list.size) { feed.items = l2; feed.next = n2 } }
                }
            }
            .onFailure { feed.error = it.message ?: "加载失败" }
        feed.loading = false
    }
    return feed
}

/** 翻页：最后可见项接近末尾就拉下一页 */
@Composable
private fun GifPaging(grid: LazyGridState, feed: GifFeed) {
    val nearEnd by remember { derivedStateOf { val last = grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0; last >= grid.layoutInfo.totalItemsCount - 9 } }
    LaunchedEffect(nearEnd, feed.next, feed.loading, feed) {
        if (nearEnd && feed.next.isNotEmpty() && !feed.loading && feed.items.isNotEmpty()) {
            feed.loading = true
            runCatching { StickerStore.searchGifs(feed.query, feed.next) }.onSuccess { (list, n) ->
                val seen = feed.items.map { it.id }.toHashSet()
                feed.items = feed.items + list.filter { it.id !in seen }; feed.next = n
            }
            feed.loading = false
        }
    }
}

@Composable
private fun GifFooter(feed: GifFeed, emptyHint: String) {
    when {
        feed.loading -> EmptyText(if (feed.items.isEmpty()) "正在拉取 GIF，第一次会慢几秒…" else "加载更多…")
        feed.error.isNotEmpty() -> EmptyText(feed.error)
        feed.items.isEmpty() -> EmptyText(emptyHint)
    }
}

@Composable
private fun GifTile(p: StickerPayload, onClick: () -> Unit) {
    AsyncImage(
        model = Api.fullUrl(p.thumb.ifEmpty { p.url }), contentDescription = null, contentScale = ContentScale.Crop,
        modifier = Modifier.aspectRatio(1f).background(Bg3).noRippleClick(onClick),
    )
}

// ---------- 搜索 sheet（GIF / 表情，和贴纸「点搜索弹框」一致） ----------

/** 搜索 sheet 外壳：顶部搜索框（自动聚焦）+「完成」，一行快捷 emoji（点了当搜索词），下面放结果 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchSheetShell(placeholder: String, query: String, onQuery: (String) -> Unit, onClose: () -> Unit, autoFocus: Boolean = true, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) { delay(120); runCatching { focus.requestFocus() } } }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = state, containerColor = Bg, dragHandle = null, shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f)) {
            Row(Modifier.fillMaxWidth().padding(12.dp, 12.dp, 12.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(10.dp)).background(Bg3).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    SearchIcon(TextDim, 15.dp)
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.weight(1f)) {
                        if (query.isEmpty()) Text(placeholder, color = TextDim, fontSize = 15.sp)
                        BasicTextField(query, onQuery, singleLine = true, textStyle = TextStyle(color = TextMain, fontSize = 15.sp), cursorBrush = SolidColor(Accent), modifier = Modifier.fillMaxWidth().focusRequester(focus))
                    }
                    if (query.isNotEmpty()) Text("✕", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick { onQuery("") }.padding(start = 6.dp))
                }
                Spacer(Modifier.width(12.dp))
                Text("完成", color = Accent, fontSize = 16.sp, modifier = Modifier.noRippleClick(onClose))
            }
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                items(QUICK_EMOJIS) { e ->
                    val on = baseEmoji(query.trim()) == baseEmoji(e)
                    Box(
                        Modifier.size(36.dp).clip(CircleShape).background(if (on) Bg3 else Color.Transparent).noRippleClick { onQuery(if (on) "" else e) }.alpha(if (on) 1f else 0.5f),
                        contentAlignment = Alignment.Center,
                    ) { if (on) Text(e, fontSize = 22.sp) else GrayEmoji(e) }
                }
            }
            content()
        }
    }
}

/** GIF 搜索 sheet：输入防抖 400ms，快捷 emoji 立即；3 列瓦片，滚到底翻页；点了 GIF 回调并关闭 */
@Composable
fun GifSearchSheet(initialQuery: String, onPick: (StickerPayload) -> Unit, onClose: () -> Unit) {
    var q by remember { mutableStateOf(initialQuery) }
    // 防抖：打字 400ms 后才真正搜；空 / 快捷 emoji 立即
    var query by remember { mutableStateOf(initialQuery.trim()) }
    LaunchedEffect(q) {
        val t = q.trim()
        if (t.isNotEmpty() && t !in QUICK_EMOJIS) delay(400)
        query = t
    }
    val feed = rememberGifFeed(query)
    val grid = rememberLazyGridState()
    GifPaging(grid, feed)

    SearchSheetShell("搜索 GIF", q, { q = it }, onClose) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3), state = grid, modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(0.dp, 0.dp, 0.dp, 30.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (query.isEmpty()) item(key = "ht", span = { GridItemSpan(maxLineSpan) }) { SectionHeader("热门") }
            items(feed.items, key = { it.id }) { p -> GifTile(p) { onPick(p); onClose() } }
            item(span = { GridItemSpan(maxLineSpan) }) { GifFooter(feed, if (query.isEmpty()) "暂无 GIF" else "没有找到相关 GIF") }
        }
    }
}

/** 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起。打开时不自动弹键盘 */
@Composable
fun EmojiSearchSheet(initialQuery: String, onEmoji: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { EmojiStore.ensureLoaded(ctx) }
    var q by remember { mutableStateOf(initialQuery) }
    val query = q.trim()
    val recent = EmojiStore.recent
    val results = remember(EmojiStore.groups, query, recent) { if (query.isEmpty()) recent else EmojiStore.search(query) }

    SearchSheetShell("搜索表情", q, { q = it }, onClose, autoFocus = false) {
        LazyVerticalGrid(columns = GridCells.Fixed(8), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(6.dp, 0.dp, 6.dp, 30.dp)) {
            if (query.isEmpty() && recent.isNotEmpty()) item(key = "hr", span = { GridItemSpan(maxLineSpan) }) { SectionHeader("最近使用") }
            items(results.size, key = { "q$it" }) { i -> EmojiCell(results[i], onEmoji) }
            if (results.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyText(if (query.isEmpty()) "输入关键词搜表情，比如「笑」「猫」「爱心」" else "没有匹配的表情")
            }
        }
    }
}

// ---------- 表情商店 / 我的贴纸（底部 sheet） ----------

/**
 * 表情商店（manage=false）：搜索 + 全部包，每行前几张预览 + 添加 / 已添加（图 7）；
 * 我的贴纸（manage=true）：置顶 / 移除。库里的包由后台维护，用户只决定自己面板里有哪些、什么顺序。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StickerStoreSheet(manage: Boolean, initialQuery: String = "", focusSearch: Boolean = false, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(Unit) { StickerStore.ensureLoaded(ctx); StickerStore.loadMine(ctx) }
    val all = StickerStore.sets
    val mineIds = StickerStore.mineIds
    val mine = StickerStore.mineSets
    var q by remember { mutableStateOf(initialQuery) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (focusSearch) { delay(120); runCatching { focus.requestFocus() } } }
    var busy by remember { mutableStateOf<Int?>(null) }
    var toast by remember { mutableStateOf("") }
    LaunchedEffect(toast) { if (toast.isNotEmpty()) { delay(1600); toast = "" } }
    val kindName = mapOf("static" to "静态", "animated" to "动态", "video" to "动态")
    // 搜索：按包名，或按贴纸 emoji（面板搜索行的快捷 emoji 直接带进来）；搜 emoji 时预览只放命中的贴纸
    val list = remember(all, mine, q, manage) {
        val src = if (manage) mine else all
        val w = q.trim().lowercase()
        if (w.isEmpty()) src.map { it to it.items.take(6) }
        else {
            val wb = baseEmoji(w)
            src.mapNotNull { s ->
                val hit = s.items.filter { baseEmoji(it.emoji).contains(wb) }
                when {
                    hit.isNotEmpty() -> s to hit.take(6)
                    s.title.lowercase().contains(w) -> s to s.items.take(6)
                    else -> null
                }
            }
        }
    }
    fun run(id: Int, block: suspend () -> Unit) {
        busy = id
        scope.launch { runCatching { block() }.onFailure { toast = it.message ?: "操作失败" }; busy = null }
    }

    ModalBottomSheet(onDismissRequest = onClose, sheetState = state, containerColor = Bg, dragHandle = null, shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)) {
        Box(Modifier.fillMaxWidth().fillMaxHeight(0.9f)) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(12.dp, 12.dp, 12.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(10.dp)).background(Bg3).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        SearchIcon(TextDim, 15.dp)
                        Spacer(Modifier.width(6.dp))
                        Box(Modifier.weight(1f)) {
                            if (q.isEmpty()) Text(if (manage) "搜索我的贴纸" else "搜索贴纸", color = TextDim, fontSize = 15.sp)
                            BasicTextField(q, { q = it }, singleLine = true, textStyle = TextStyle(color = TextMain, fontSize = 15.sp), cursorBrush = SolidColor(Accent), modifier = Modifier.fillMaxWidth().focusRequester(focus))
                        }
                        if (q.isNotEmpty()) Text("✕", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick { q = "" }.padding(start = 6.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Text("完成", color = Accent, fontSize = 16.sp, modifier = Modifier.noRippleClick(onClose))
                }
                LazyColumn(Modifier.fillMaxSize()) {
                    if (manage) item { Text("我的贴纸（${mine.size}）", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(16.dp, 4.dp, 16.dp, 0.dp)) }
                    items(list, key = { it.first.id }) { (s, preview) ->
                        val idx = mineIds.indexOf(s.id)
                        StoreRow(s, preview, kindName[s.kind] ?: "") {
                            if (manage) {
                                if (idx > 0 && q.isEmpty()) AddBtn(busy == s.id, primary = false, label = "置顶") { run(s.id) { StickerStore.reorderMine(ctx, listOf(s.id) + mineIds.filter { it != s.id }) } }
                                Spacer(Modifier.width(6.dp))
                                AddBtn(busy == s.id, primary = false, label = "移除") { run(s.id) { StickerStore.removeMine(ctx, s.id) } }
                            } else if (s.id in mineIds) {
                                AddBtn(busy == s.id, primary = false, label = "已添加") { run(s.id) { StickerStore.removeMine(ctx, s.id) } }
                            } else {
                                AddBtn(busy == s.id) { run(s.id) { StickerStore.addMine(ctx, s.id) } }
                            }
                        }
                    }
                    if (list.isEmpty()) item { EmptyText(if (all.isEmpty()) "表情包还在路上…" else "没有匹配的贴纸包") }
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
}

@Composable
private fun StoreRow(s: StickerSetItem, preview: List<StickerPayload>, kind: String, actions: @Composable RowScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.title, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${s.items.size} 张贴图 · $kind", color = TextSub, fontSize = 12.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically) { actions() }
        }
        LazyRow(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(preview, key = { it.id }) { p -> StickerImage(p, 64.dp, autoplay = false) }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
}
