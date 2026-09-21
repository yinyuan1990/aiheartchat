package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.MomentUser
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import com.wh.peiwana.ui.sticker.SmileIcon
import com.wh.peiwana.ui.sticker.StickerImage
import com.wh.peiwana.ui.sticker.EmojiPanel
import com.wh.peiwana.ui.sticker.dropLastGrapheme
import com.wh.peiwana.ui.sticker.StickerPayload
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ---------- 模型 ----------

@Serializable
data class TreeholeCommenter(val avatar: String = "")

/** 私密树洞帖子（匿名：无作者信息，只有 mine 标记自己） */
@Serializable
data class TreeholePost(
    val id: String,
    val content: String = "",
    /** 配图（最多 9 张） */
    val images: List<String> = emptyList(),
    /** 0=用户投稿 1=后台录入 2=Telegram 同步 */
    val source: Int = 0,
    val viewCount: Int = 0,
    val commentCount: Int = 0,
    val commenters: List<TreeholeCommenter> = emptyList(),
    val mine: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class TreeholeComment(
    val id: String,
    val user: MomentUser? = null,
    val content: String = "",
    val sticker: StickerPayload? = null,
    val replyToId: String? = null,
    val replyToNickname: String = "",
    val createdAt: String = "",
)

/** 树洞列表进程级缓存：切 tab / 返回不重拉；发布、评论后主动刷新 */
object TreeholeCache {
    var items by mutableStateOf<List<TreeholePost>>(emptyList())
    var loaded by mutableStateOf(false)

    suspend fun refresh() {
        runCatching { Api.getList<TreeholePost>("/treehole") }.onSuccess { items = it }
        loaded = true
    }

    suspend fun loadMore(): Boolean {
        val last = items.lastOrNull() ?: return false
        val more = runCatching { Api.getList<TreeholePost>("/treehole?beforeId=${last.id}") }.getOrNull() ?: return false
        items = items + more
        return more.size >= 20
    }

    fun bumpComment(id: String) {
        items = items.map { if (it.id == id) it.copy(commentCount = it.commentCount + 1) else it }
    }

    fun remove(id: String) {
        items = items.filter { it.id != id }
    }
}

// ---------- 工具 ----------

private val ChannelColor = Color(0xFFB48CFF)
private val LinkBlue = Color(0xFF5AA9FF)
private val NameColors = listOf(
    Color(0xFFE57373), Color(0xFF64B5F6), Color(0xFF81C784), Color(0xFFFFB74D),
    Color(0xFFBA68C8), Color(0xFF4DD0E1), Color(0xFFF06292), Color(0xFFAED581),
)
private const val CHANNEL_NAME = "私密树洞"

/** 阅读数：1234 → 1.2K，12345 → 1.2万 */
fun fmtCount(n: Int): String = when {
    n >= 100_000 -> "${n / 10_000}万"
    n >= 10_000 -> String.format("%.1f万", n / 10_000.0)
    n >= 1_000 -> String.format("%.1fK", n / 1_000.0)
    else -> n.toString()
}

/** 今天只显示 HH:mm，今年 M月d日 HH:mm，更早带年份 */
fun fmtTreeholeTime(iso: String): String {
    if (iso.isEmpty()) return ""
    return try {
        val zdt = Instant.parse(iso).atZone(ZoneId.systemDefault())
        val today = LocalDate.now()
        val hm = zdt.format(DateTimeFormatter.ofPattern("HH:mm"))
        when {
            zdt.toLocalDate() == today -> hm
            zdt.year == today.year -> "${zdt.monthValue}月${zdt.dayOfMonth}日 $hm"
            else -> "${zdt.year}/${zdt.monthValue}/${zdt.dayOfMonth} $hm"
        }
    } catch (_: Exception) { "" }
}

private fun nameColor(id: String): Color {
    var h = 0
    for (ch in id) h = h * 31 + ch.code
    return NameColors[Math.floorMod(h, NameColors.size)]
}

// ---------- 广场「私密树洞」tab ----------

/** 信息流：Telegram 频道式卡片 + 右下角「写树洞」 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun TreeholeSection(onOpen: (String) -> Unit, onPublish: () -> Unit) {
    val scope = rememberCoroutineScope()
    val items = TreeholeCache.items
    var refreshing by remember { mutableStateOf(false) }
    var hasMore by remember { mutableStateOf(true) }
    var loadingMore by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) {
        if (!TreeholeCache.loaded) TreeholeCache.refresh()
    }
    // 滚到底自动加载更多
    LaunchedEffect(listState, items.size, hasMore) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
            .collect { last ->
                if (last != null && hasMore && !loadingMore && items.isNotEmpty() && last >= items.size - 2) {
                    loadingMore = true
                    hasMore = TreeholeCache.loadMore()
                    loadingMore = false
                }
            }
    }

    Box(Modifier.fillMaxSize()) {
        androidx.compose.material3.pulltorefresh.PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    TreeholeCache.refresh()
                    hasMore = true
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            if (items.isEmpty()) {
                LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Box(Modifier.fillParentMaxSize()) {
                            EmptyHint(if (TreeholeCache.loaded) "树洞还是空的\n说点只想让陌生人听见的话吧" else "加载中…")
                        }
                    }
                }
            } else {
                // 频道式：reverseLayout 让接口的「最新在前」数据显示为最新在最底部、进入时停在底部，
                // 往上滑到顶部（数据末尾）自动加载更早的
                LazyColumn(
                    state = listState,
                    reverseLayout = true,
                    contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 90.dp),
                ) {
                    items(items, key = { it.id }) { p ->
                        Spacer(Modifier.height(12.dp))
                        TreeholeCard(p, clamp = true, onOpen = { onOpen(p.id) })
                    }
                    if (loadingMore) {
                        item { Text("加载中…", color = TextDim, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(8.dp)) }
                    }
                }
            }
        }
        // 写树洞
        Box(
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 20.dp)
                .clip(RoundedCornerShape(22.dp)).background(AccentBrush).noRippleClick(onPublish)
                .padding(horizontal = 18.dp, vertical = 12.dp),
        ) {
            Text("✎ 写树洞", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** 帖子卡：频道名 + 正文 + 阅读/时间 + 评论条（clamp=列表折叠 10 行） */
@Composable
fun TreeholeCard(post: TreeholePost, clamp: Boolean, onOpen: (() -> Unit)? = null) {
    var fullImage by remember { mutableStateOf<String?>(null) }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2)
            .then(if (onOpen != null) Modifier.noRippleClick(onOpen) else Modifier)
            .padding(top = 12.dp, bottom = 10.dp),
    ) {
        Text(CHANNEL_NAME, color = ChannelColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 14.dp))
        Spacer(Modifier.height(6.dp))
        // 配图：单图通栏（Telegram 式，左右出血），多图网格
        if (post.images.size == 1) {
            coil.compose.AsyncImage(
                model = Api.fullUrl(post.images[0]), contentDescription = null,
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).background(Bg3).noRippleClick { fullImage = post.images[0] },
            )
            Spacer(Modifier.height(8.dp))
        } else if (post.images.size > 1) {
            val cols = if (post.images.size == 2 || post.images.size == 4) 2 else 3
            Column(Modifier.padding(horizontal = 14.dp).clip(RoundedCornerShape(10.dp)), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                post.images.chunked(cols).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        row.forEach { u ->
                            coil.compose.AsyncImage(
                                model = Api.fullUrl(u), contentDescription = null,
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                modifier = Modifier.weight(1f).aspectRatio(if (cols == 2) 4f / 3f else 1f).background(Bg3).noRippleClick { fullImage = u },
                            )
                        }
                        repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
        if (post.content.isNotEmpty()) {
            Text(
                post.content, color = TextMain, fontSize = 15.sp, lineHeight = 26.sp,
                maxLines = if (clamp) 10 else Int.MAX_VALUE,
                overflow = if (clamp) TextOverflow.Ellipsis else TextOverflow.Clip,
                modifier = Modifier.padding(horizontal = 14.dp),
            )
        }
        Column(Modifier.padding(horizontal = 14.dp)) {
        Spacer(Modifier.height(6.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            EyeIcon(TextDim, 13.dp)
            Text(" ${fmtCount(post.viewCount)}   ${fmtTreeholeTime(post.createdAt)}", color = TextDim, fontSize = 11.sp)
        }
        if (onOpen != null) {
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (post.commenters.isNotEmpty()) {
                    // 叠放的评论者头像
                    Box(Modifier.width((26 + (post.commenters.size - 1) * 18).dp).height(26.dp)) {
                        post.commenters.forEachIndexed { i, c ->
                            Box(Modifier.offset(x = (i * 18).dp).size(26.dp).clip(CircleShape).border(2.dp, Bg2, CircleShape)) {
                                Avatar(c.avatar, 26)
                            }
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                }
                Text(
                    if (post.commentCount > 0) "${post.commentCount} 条评论" else "发表评论",
                    color = LinkBlue, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f),
                )
                Text("›", color = LinkBlue, fontSize = 20.sp)
            }
        }
        } // 内边距 Column
    }
    fullImage?.let { u ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { fullImage = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            ImageViewer(post.images, post.images.indexOf(u).coerceAtLeast(0)) { fullImage = null }
        }
    }
}

// ---------- 详情：帖子 + 讨论 ----------

@Composable
fun TreeholeDetailScreen(id: String, onBack: () -> Unit) {
    var post by remember { mutableStateOf<TreeholePost?>(null) }
    var comments by remember { mutableStateOf<List<TreeholeComment>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<TreeholeComment?>(null) }
    /** 待发的贴纸：评论里点贴纸先挂到输入栏，再点发送 */
    var sticker by remember { mutableStateOf<StickerPayload?>(null) }
    var showSticker by remember { mutableStateOf(false) }
    val inputFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    var sending by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val ctx = LocalContext.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    suspend fun loadComments() {
        comments = runCatching { Api.getList<TreeholeComment>("/treehole/$id/comments") }.getOrDefault(emptyList())
    }
    LaunchedEffect(id) {
        post = runCatching { Api.getObj<TreeholePost>("/treehole/$id") }.getOrNull()
        loadComments()
    }
    LaunchedEffect(toast) {
        if (toast.isNotEmpty()) { kotlinx.coroutines.delay(1600); toast = "" }
    }

    val p = post
    Column(Modifier.fillMaxSize()) {
        NavBar(
            title = if (p != null && p.commentCount > 0) "${p.commentCount} 条评论" else CHANNEL_NAME,
            onBack = onBack,
            action = if (p?.mine == true) {
                { Text("删除", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { confirmDelete = true }) }
            } else null,
        )
        if (p == null) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Text("加载中…", color = TextSub, fontSize = 13.sp) }
            return@Column
        }
        LazyColumn(state = listState, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 14.dp)) {
            item {
                TreeholeCard(p, clamp = false)
                // 分隔
                Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (comments.isEmpty()) "还没有人评论，来说第一句" else "讨论已开始",
                        color = TextSub, fontSize = 12.sp,
                        modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.05f)).padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }
            items(comments, key = { it.id }) { c ->
                Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.Bottom) {
                    Avatar(c.user?.avatar, 34)
                    Spacer(Modifier.width(10.dp))
                    Column(
                        Modifier.widthIn(max = 300.dp)
                            .clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomEnd = 14.dp, bottomStart = 4.dp))
                            .background(Bg2).padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 6.dp),
                    ) {
                        Text(c.user?.nickname ?: "用户", color = nameColor(c.user?.id ?: c.id), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(2.dp))
                        if (c.content.isNotEmpty() || c.replyToNickname.isNotEmpty()) {
                            Text(
                                buildString {
                                    if (c.replyToNickname.isNotEmpty()) append("@${c.replyToNickname} ")
                                    append(c.content)
                                },
                                color = TextMain, fontSize = 15.sp, lineHeight = 23.sp,
                            )
                        }
                        c.sticker?.let { StickerImage(it, if (it.isGif) 160.dp else 96.dp, modifier = Modifier.padding(top = 4.dp)) }
                        Spacer(Modifier.height(3.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                            Text("回复", color = TextSub, fontSize = 11.sp, modifier = Modifier.noRippleClick { replyTo = c }.padding(end = 10.dp))
                            Text(fmtTreeholeTime(c.createdAt), color = TextDim, fontSize = 11.sp)
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(12.dp)) }
        }

        // 底部区域（回复提示 + 输入栏）：与聊天页一致，imePadding 让输入框贴在键盘上方（App 是 edge-to-edge，adjustResize 不会自动顶起）
        Column(Modifier.fillMaxWidth().background(Bg).imePadding().navigationBarsPadding()) {
        if (replyTo != null || sticker != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                sticker?.let { s ->
                    Box {
                        StickerImage(s, 56.dp, autoplay = !s.isGif)
                        Box(
                            Modifier.align(Alignment.TopEnd).size(18.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).noRippleClick { sticker = null },
                            contentAlignment = Alignment.Center,
                        ) { Text("×", color = Color.White, fontSize = 12.sp) }
                    }
                    Spacer(Modifier.width(10.dp))
                }
                replyTo?.let { r ->
                    Text("回复 @${r.user?.nickname ?: ""}", color = Accent, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    Text("取消", color = TextSub, fontSize = 12.sp, modifier = Modifier.noRippleClick { replyTo = null })
                } ?: Spacer(Modifier.weight(1f))
            }
        }

        // 底部输入栏
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(36.dp).clip(CircleShape).background(if (showSticker) BubbleMine else Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); showSticker = !showSticker },
                contentAlignment = Alignment.Center,
            ) { SmileIcon(if (showSticker) Accent else TextSub, 20.dp) }
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (input.isEmpty()) {
                    Text(
                        if (replyTo != null) "回复 @${replyTo?.user?.nickname ?: ""}" else "说点什么…（评论会显示你的昵称）",
                        color = TextSub, fontSize = 14.sp,
                    )
                }
                BasicTextField(
                    value = input, onValueChange = { if (it.length <= 500) input = it },
                    textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
                    cursorBrush = SolidColor(Accent),
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showSticker = false },
                )
            }
            Spacer(Modifier.width(8.dp))
            val canSend = (input.isNotBlank() || sticker != null) && !sending
            Box(
                Modifier.clip(RoundedCornerShape(15.dp)).background(if (canSend) AccentBrush else androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Bg3, Bg3)))
                    .noRippleClick {
                        if (!canSend) return@noRippleClick
                        sending = true
                        scope.launch {
                            runCatching {
                                Api.request("/treehole/$id/comments", "POST", buildJsonObject {
                                    put("content", JsonPrimitive(input.trim()))
                                    replyTo?.let { put("replyToId", JsonPrimitive(it.id)) }
                                    sticker?.let { put("stickerId", JsonPrimitive(it.id)) }
                                })
                            }.onSuccess {
                                                                input = ""
                                replyTo = null
                                sticker = null
                                showSticker = false
                                loadComments()
                                post = post?.copy(commentCount = (post?.commentCount ?: 0) + 1)
                                TreeholeCache.bumpComment(id)
                                // 滚到底部看到自己的评论
                                if (comments.isNotEmpty()) listState.animateScrollToItem(comments.size)
                            }.onFailure { toast = it.message ?: "发送失败" }
                            sending = false
                        }
                    }
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            ) { Text("发送", color = Color.White, fontSize = 13.sp) }
        }
        if (showSticker) EmojiPanel(onPick = { sticker = it }, onEmoji = { input += it }, onDelete = { input = dropLastGrapheme(input) }, onKeyboard = { showSticker = false; inputFocus.requestFocus(); keyboard?.show() })
        } // 底部区域 Column
    }

    if (toast.isNotEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(toast, color = Color.White, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.85f)).padding(horizontal = 22.dp, vertical = 10.dp))
        }
    }
    if (confirmDelete) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = Bg2,
            title = { Text("删除这条树洞？", color = TextMain) },
            text = { Text("评论也会一起消失", color = TextSub) },
            confirmButton = {
                Text("删除", color = Danger, modifier = Modifier.noRippleClick {
                    confirmDelete = false
                    scope.launch {
                        runCatching { Api.request("/treehole/$id", "DELETE") }
                            .onSuccess { TreeholeCache.remove(id); onBack() }
                            .onFailure { toast = it.message ?: "删除失败" }
                    }
                }.padding(8.dp))
            },
            dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick { confirmDelete = false }.padding(8.dp)) },
        )
    }
}

// ---------- 匿名发布 ----------

@Composable
fun TreeholePublishScreen(onBack: () -> Unit, onDone: () -> Unit) {
    var content by remember { mutableStateOf("") }
    var images by remember { mutableStateOf<List<String>>(emptyList()) }
    var uploading by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val max = 3000
    val canSubmit = (content.trim().length >= 5 || images.isNotEmpty()) && !busy && !uploading

    // 多选配图（最多 9 张）
    val pickImages = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetMultipleContents()) { uris ->
        val picked = uris.take(9 - images.size)
        if (picked.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            uploading = true
            picked.forEach { uri ->
                runCatching {
                    val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    images = images + Api.upload("image", bytes, "img.jpg", "image/jpeg")
                }.onFailure { toast = it.message ?: "上传失败" }
            }
            uploading = false
        }
    }

    LaunchedEffect(toast) {
        if (toast.isNotEmpty()) { kotlinx.coroutines.delay(1600); toast = "" }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("写树洞", onBack) {
            Text(
                if (busy) "发布中" else "发布", color = if (canSubmit) Accent else Accent.copy(alpha = 0.4f), fontSize = 14.sp,
                modifier = Modifier.noRippleClick {
                    if (!canSubmit) {
                        if (content.trim().length < 5 && images.isEmpty()) toast = "至少写 5 个字，或配一张图"
                        return@noRippleClick
                    }
                    busy = true
                    scope.launch {
                        runCatching {
                            Api.request("/treehole", "POST", buildJsonObject {
                                put("content", JsonPrimitive(content.trim()))
                                put("images", kotlinx.serialization.json.JsonArray(images.map { JsonPrimitive(it) }))
                            })
                        }.onSuccess {
                            TreeholeCache.refresh()
                            onDone()
                        }.onFailure {
                            toast = it.message ?: "发布失败"
                            busy = false
                        }
                    }
                },
            )
        }
        Column(Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState())) {
            Box(
                Modifier.fillMaxWidth().heightIn(min = 200.dp).clip(RoundedCornerShape(12.dp)).background(Bg3).padding(14.dp),
            ) {
                if (content.isEmpty()) Text("把想说却无处说的话放进树洞…", color = TextSub, fontSize = 15.sp)
                BasicTextField(
                    value = content, onValueChange = { if (it.length <= max) content = it },
                    textStyle = TextStyle(color = TextMain, fontSize = 15.sp, lineHeight = 26.sp),
                    cursorBrush = SolidColor(Accent),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(10.dp))
            // 配图选择（点已选图片移除）
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                (images + if (images.size < 9) listOf("+") else emptyList()).chunked(4).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { u ->
                            if (u == "+") {
                                Box(
                                    Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(Bg3)
                                        .noRippleClick { if (!uploading) pickImages.launch("image/*") },
                                    contentAlignment = Alignment.Center,
                                ) { Text(if (uploading) "…" else "+", color = TextDim, fontSize = 26.sp) }
                            } else {
                                coil.compose.AsyncImage(
                                    model = Api.fullUrl(u), contentDescription = null,
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    modifier = Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).noRippleClick { images = images - u },
                                )
                            }
                        }
                        repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth()) {
                Text("匿名发布：其他人只能看到内容，不会显示你的昵称和头像", color = TextDim, fontSize = 11.sp, modifier = Modifier.weight(1f))
                Text("${content.length} / $max", color = TextDim, fontSize = 11.sp)
            }
        }
    }
    if (toast.isNotEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(toast, color = Color.White, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.85f)).padding(horizontal = 22.dp, vertical = 10.dp))
        }
    }
}
