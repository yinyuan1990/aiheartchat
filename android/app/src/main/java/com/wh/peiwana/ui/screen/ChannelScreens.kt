package com.wh.peiwana.ui.screen

import android.Manifest
import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.sticker.EmojiPanel
import com.wh.peiwana.ui.sticker.SmileIcon
import com.wh.peiwana.ui.sticker.StickerImage
import com.wh.peiwana.ui.sticker.StickerPayload
import com.wh.peiwana.ui.sticker.StickerStore
import com.wh.peiwana.ui.sticker.dropLastGrapheme
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 频道（kind=2 的群）：频道主发帖，订阅者看帖 + 表情回应 + 评论。帖子就是这个群会话里的消息。 */

val CHANNEL_REACTIONS = listOf("❤️", "👍", "🔥", "😂", "😮", "😢", "🎉", "👎")

@Serializable
data class ChannelOwner(val id: String = "", val nickname: String = "", val avatar: String = "")

@Serializable
data class ChannelInfo(
    val id: String,
    val name: String = "",
    val avatar: String = "",
    val description: String = "",
    val ownerId: String = "",
    val owner: ChannelOwner? = null,
    val subscribers: Int = 0,
    val conversationId: String? = null,
    val isMember: Boolean = false,
    val role: String? = null,
    val canPost: Boolean = false,
    val muted: Boolean = false,
)

@Serializable
data class ChannelReaction(val emoji: String, val count: Int = 0)

@Serializable
private data class ChannelPost(
    val id: String,
    val senderId: String = "",
    val type: String = "text",
    val content: String = "",
    val createdAt: String = "",
    val views: Int = 0,
    val reactions: List<ChannelReaction> = emptyList(),
    val myReaction: String? = null,
    val commentCount: Int = 0,
    val markup: InlineMarkup? = null,
    /** 本地发出的帖子：ack 前 pending，tempId 一直留着当列表 key */
    val tempId: String? = null,
    val pending: Boolean = false,
)

@Serializable
private data class ReactResp(val reactions: List<ChannelReaction> = emptyList(), val myReaction: String? = null)

@Serializable
private data class ChannelListItem(
    val id: String,
    val name: String = "",
    val avatar: String = "",
    val description: String = "",
    val ownerNickname: String = "",
    val subscribers: Int = 0,
    val isMember: Boolean = false,
)

private fun toast(ctx: Context, msg: String) = Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()

@Composable
private fun ConfirmDialog(text: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Bg2,
        text = { Text(text, color = TextMain, fontSize = 15.sp) },
        confirmButton = { Text(confirm, color = Danger, modifier = Modifier.noRippleClick { onDismiss(); onConfirm() }.padding(8.dp)) },
        dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}

@Composable
private fun ReactChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label, color = if (on) Accent else TextMain, fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(if (on) BubbleMine else Bg3)
            .noRippleClick(onClick).padding(horizontal = 9.dp, vertical = 4.dp),
    )
}

@Composable
private fun PostBody(p: ChannelPost, onMedia: () -> Unit) {
    val ctx = LocalContext.current
    when (p.type) {
        "image" -> AsyncImage(
            model = Api.fullUrl(p.content), contentDescription = null, contentScale = ContentScale.FillWidth,
            modifier = Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(max = 460.dp).noRippleClick(onMedia),
        )
        "video" -> Box(
            Modifier.padding(top = 8.dp).fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black).noRippleClick(onMedia),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(52.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.25f)), contentAlignment = Alignment.Center) {
                Text("▶", color = Color.White, fontSize = 22.sp)
            }
        }
        "sticker" -> {
            val s = remember(p.content) { StickerStore.parse(p.content) }
            Box(Modifier.padding(start = 12.dp, top = 10.dp)) {
                if (s != null) StickerImage(s, if (s.isGif) 220.dp else 140.dp)
                else Text("[表情]", color = TextMain, fontSize = 15.sp)
            }
        }
        "audio" -> {
            val obj = remember(p.content) { runCatching { WsClient.json.parseToJsonElement(p.content).jsonObject }.getOrNull() }
            val url = obj?.get("url")?.jsonPrimitive?.content ?: p.content
            val dur = obj?.get("duration")?.jsonPrimitive?.intOrNull ?: 1
            var playing by remember { mutableStateOf(false) }
            Row(
                Modifier.padding(start = 12.dp, top = 10.dp).clip(RoundedCornerShape(16.dp)).background(Bg3).clickable {
                    if (playing) return@clickable
                    runCatching {
                        android.media.MediaPlayer().apply {
                            setDataSource(Api.fullUrl(url))
                            setOnCompletionListener { playing = false; it.release() }
                            setOnErrorListener { mp, _, _ -> playing = false; mp.release(); true }
                            prepare(); start()
                            playing = true
                        }
                    }
                }.padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WaveformIcon(if (playing) Accent else TextMain, 15.dp)
                Spacer(Modifier.width(8.dp))
                Text("$dur\"", color = TextMain, fontSize = 14.sp)
            }
        }
        "location" -> {
            val obj = remember(p.content) { runCatching { WsClient.json.parseToJsonElement(p.content).jsonObject }.getOrNull() }
            val name = obj?.get("name")?.jsonPrimitive?.content ?: "位置"
            val lat = obj?.get("lat")?.jsonPrimitive?.content
            val lng = obj?.get("lng")?.jsonPrimitive?.content
            Row(
                Modifier.padding(start = 12.dp, top = 10.dp).noRippleClick {
                    if (lat != null && lng != null) runCatching {
                        ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse("https://uri.amap.com/marker?position=$lng,$lat")))
                    }
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PinIcon(Accent, 16.dp); Spacer(Modifier.width(6.dp)); Text(name, color = TextMain, fontSize = 15.sp)
            }
        }
        else -> Text(p.content, color = TextMain, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp))
    }
}

/** 一条帖子：频道头 + 内容 + 表情回应 + 浏览数 / 时间 + 评论入口 */
@Composable
private fun PostCard(ch: ChannelInfo, p: ChannelPost, onReact: (String) -> Unit, onComments: () -> Unit, onMedia: () -> Unit, onDelete: (() -> Unit)?) {
    var picker by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(14.dp)).background(Bg).alpha(if (p.pending) 0.6f else 1f),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(ch.avatar, 26)
            Text(
                ch.name, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 8.dp),
            )
            if (onDelete != null && !p.pending) Text("删除", color = TextDim, fontSize = 12.sp, modifier = Modifier.noRippleClick(onDelete))
        }
        PostBody(p, onMedia)
        InlineKeyboard(p.markup, p.id, Modifier.fillMaxWidth().padding(horizontal = 12.dp))
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                p.reactions.forEach { r -> ReactChip("${r.emoji} ${fmtCount(r.count)}", p.myReaction == r.emoji) { onReact(r.emoji) } }
                if (!p.pending) ReactChip("☺+", false) { picker = !picker }
            }
            if (p.pending) {
                Text("发送中…", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
            } else {
                Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    EyeIcon(TextDim, 13.dp)
                    Text(" ${fmtCount(p.views)} · ${fmtChatTime(p.createdAt)}", color = TextDim, fontSize = 11.sp)
                }
            }
        }
        if (picker) {
            Row(
                Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Bg2).padding(6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                CHANNEL_REACTIONS.forEach { e ->
                    Box(
                        Modifier.size(34.dp).clip(CircleShape).background(if (p.myReaction == e) BubbleMine else Color.Transparent)
                            .noRippleClick { picker = false; onReact(e) },
                        contentAlignment = Alignment.Center,
                    ) { Text(e, fontSize = 20.sp) }
                }
            }
        }
        if (!p.pending) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
            Row(Modifier.fillMaxWidth().clickable(onClick = onComments).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                BubbleIcon(Accent, 16.dp)
                Text(
                    if (p.commentCount > 0) "  ${p.commentCount} 条评论" else "  评论",
                    color = Accent, fontSize = 13.sp, modifier = Modifier.weight(1f),
                )
                Text("›", color = TextDim, fontSize = 18.sp)
            }
        }
    }
}

/** 频道页：订阅前也能预览；频道主底部是发帖栏，订阅者是静音开关，没订阅是「订阅」 */
@Composable
fun ChannelScreen(groupId: String, myUserId: String, onBack: () -> Unit, onExit: () -> Unit, onOpenComments: (msgId: String, canAdmin: Boolean) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var ch by remember { mutableStateOf<ChannelInfo?>(null) }
    var error by remember { mutableStateOf("") }
    var posts by remember { mutableStateOf<List<ChannelPost>>(emptyList()) }
    var hasMore by remember { mutableStateOf(false) }
    var stickBottom by remember { mutableStateOf(true) }
    var input by remember { mutableStateOf("") }
    var showSticker by remember { mutableStateOf(false) }
    var showAttach by remember { mutableStateOf(false) }
    var showInfo by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<ChannelPost?>(null) }
    var viewer by remember { mutableStateOf<Pair<List<List<MediaItem>>, Int>?>(null) }
    val listState = rememberLazyListState()
    val inputFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current

    LaunchedEffect(groupId) {
        runCatching { Api.getObj<ChannelInfo>("/im/channel/$groupId") }
            .onSuccess { c ->
                ch = c
                val list = runCatching { Api.getList<ChannelPost>("/im/channel/$groupId/posts") }.getOrDefault(emptyList())
                posts = list + posts.filter { p -> list.none { it.id == p.id } }
                hasMore = list.size >= 30
                val last = list.lastOrNull()
                val conv = c.conversationId
                if (c.isMember && last != null && conv != null) WsClient.markRead(conv, last.id)
            }
            .onFailure { error = it.message ?: "频道不存在" }
        WsClient.connect()
    }

    DisposableEffect(groupId) {
        val remove = WsClient.addListener { frame ->
            val conv = ch?.conversationId ?: return@addListener
            when (frame["op"]?.jsonPrimitive?.content) {
                "msg" -> {
                    val data = frame["data"]?.jsonObject ?: return@addListener
                    val m = WsClient.json.decodeFromJsonElement(MessagePayload.serializer(), data)
                    if (m.conversationId != conv) return@addListener
                    if (posts.none { it.id == m.id }) {
                        stickBottom = true
                        posts = posts + ChannelPost(m.id, m.senderId, m.type, m.content, m.createdAt, views = 1, markup = m.markup)
                    }
                    WsClient.markRead(conv, m.id)
                }
                "ack" -> {
                    val tempId = frame["tempId"]?.jsonPrimitive?.content ?: return@addListener
                    val msgId = frame["msgId"]?.jsonPrimitive?.content ?: return@addListener
                    val at = frame["createdAt"]?.jsonPrimitive?.content
                    posts = posts.map { if (it.tempId == tempId) it.copy(id = msgId, createdAt = at ?: it.createdAt, pending = false) else it }
                }
                "error" -> {
                    val tempId = frame["tempId"]?.jsonPrimitive?.content
                    if (posts.any { it.pending && it.tempId == tempId }) {
                        posts = posts.filterNot { it.pending && it.tempId == tempId }
                        toast(ctx, frame["msg"]?.jsonPrimitive?.content ?: "发送失败")
                    }
                }
                "channel_stats" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != conv) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val rx = WsClient.json.decodeFromJsonElement(ListSerializer(ChannelReaction.serializer()), d["reactions"] ?: JsonArray(emptyList()))
                    val cc = d["commentCount"]?.jsonPrimitive?.intOrNull ?: 0
                    posts = posts.map { if (it.id == id) it.copy(reactions = rx, commentCount = cc) else it }
                }
                "channel_post_deleted", "msg_delete" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != conv) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    posts = posts.filterNot { it.id == id }
                }
                "msg_edit" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != conv) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val content = d["content"]?.jsonPrimitive?.content
                    val mk = d["markup"]?.let { el -> runCatching { WsClient.json.decodeFromJsonElement(InlineMarkup.serializer(), el) }.getOrNull() }
                    posts = posts.map { if (it.id == id) it.copy(content = content ?: it.content, markup = mk) else it }
                }
            }
        }
        onDispose { remove() }
    }

    val header = if (hasMore && posts.isNotEmpty()) 1 else 0
    LaunchedEffect(posts.size) {
        if (stickBottom && posts.isNotEmpty()) runCatching { listState.scrollToItem(posts.size - 1 + header) }
    }

    fun loadMore() {
        val first = posts.firstOrNull { !it.pending } ?: return
        stickBottom = false
        scope.launch {
            val older = runCatching { Api.getList<ChannelPost>("/im/channel/$groupId/posts?beforeId=${first.id}") }.getOrDefault(emptyList())
            hasMore = older.size >= 30
            posts = older + posts
            runCatching { listState.scrollToItem(older.size) }
        }
    }

    fun sendRaw(type: String, content: String) {
        val c = ch ?: return
        stickBottom = true
        val tempId = WsClient.send(2, c.id, type, content)
        posts = posts + ChannelPost(tempId, myUserId, type, content, java.time.Instant.now().toString(), views = 1, tempId = tempId, pending = true)
    }

    fun sendImages(uris: List<Uri>, caption: String) = scope.launch {
        var failed = 0
        for (uri in uris) {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                sendRaw("image", Api.upload("image", b, "img.jpg", "image/jpeg"))
            }.onFailure { failed++ }
        }
        if (caption.isNotBlank()) sendRaw("text", caption.trim())
        if (failed > 0) toast(ctx, "$failed 张图片发送失败")
    }

    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) sendLocation(ctx) { name, lat, lng ->
            sendRaw("location", buildJsonObject { put("name", JsonPrimitive(name)); put("lat", JsonPrimitive(lat)); put("lng", JsonPrimitive(lng)) }.toString())
        }
    }

    fun react(p: ChannelPost, emoji: String) {
        scope.launch {
            runCatching { Api.request("/im/channel/posts/${p.id}/react", "POST", buildJsonObject { put("emoji", JsonPrimitive(emoji)) })!! }
                .onSuccess { d ->
                    val r = Api.json.decodeFromJsonElement(ReactResp.serializer(), d)
                    posts = posts.map { if (it.id == p.id) it.copy(reactions = r.reactions, myReaction = r.myReaction) else it }
                }
                .onFailure { toast(ctx, it.message ?: "操作失败") }
        }
    }

    fun setMuted(muted: Boolean) {
        val c = ch ?: return
        scope.launch {
            runCatching { Api.request("/im/channel/$groupId/mute", "POST", buildJsonObject { put("muted", JsonPrimitive(muted)) }) }
                .onSuccess { ch = c.copy(muted = muted) }
                .onFailure { toast(ctx, it.message ?: "操作失败") }
        }
    }

    fun openMedia(p: ChannelPost) {
        val media = posts.filter { !it.pending && (it.type == "image" || it.type == "video") }
        viewer = media.map { listOf(MediaItem(it.type, it.content)) } to media.indexOfFirst { it.id == p.id }.coerceAtLeast(0)
    }

    val c = ch
    if (c == null) {
        Column(Modifier.fillMaxSize()) {
            NavBar("频道", onBack)
            EmptyHint(error.ifEmpty { "加载中…" })
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { BackIcon(TextMain, 24.dp) }
            Row(Modifier.weight(1f).noRippleClick { showInfo = true }, verticalAlignment = Alignment.CenterVertically) {
                Avatar(c.avatar, 36)
                Column(Modifier.padding(start = 10.dp)) {
                    Text(c.name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${fmtCount(c.subscribers)} 位订阅者", color = TextSub, fontSize = 12.sp)
                }
            }
            Text("···", color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.noRippleClick { showInfo = true }.padding(horizontal = 12.dp))
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().background(Bg2).noRippleClick { showSticker = false; focus.clearFocus(); keyboard?.hide() },
            contentPadding = PaddingValues(vertical = 6.dp),
        ) {
            if (header == 1) item("more") {
                Text(
                    "查看更早的帖子", color = TextSub, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().noRippleClick { loadMore() }.padding(10.dp),
                )
            }
            if (posts.isEmpty()) item("empty") {
                Text(
                    if (c.canPost) "发第一条帖子吧，订阅者都会收到" else "频道还没有发帖",
                    color = TextSub, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 80.dp),
                )
            }
            items(posts, key = { it.tempId ?: it.id }) { p ->
                PostCard(
                    ch = c, p = p,
                    onReact = { react(p, it) },
                    onComments = { onOpenComments(p.id, c.canPost) },
                    onMedia = { openMedia(p) },
                    onDelete = if (c.canPost) ({ confirmDelete = p }) else null,
                )
            }
        }

        if (c.canPost) {
            Column(Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                    Box(
                        Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 9.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (input.isEmpty()) Text("发帖…", color = TextDim, fontSize = 15.sp)
                        BasicTextField(
                            value = input, onValueChange = { input = it },
                            textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
                            cursorBrush = SolidColor(Accent),
                            maxLines = 6,
                            modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showSticker = false },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier.size(40.dp).clip(CircleShape).background(if (showSticker) BubbleMine else Bg3)
                            .noRippleClick { focus.clearFocus(); keyboard?.hide(); showSticker = !showSticker },
                        contentAlignment = Alignment.Center,
                    ) { SmileIcon(if (showSticker) Accent else TextSub, 22.dp) }
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier.size(40.dp).clip(CircleShape).background(Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); showSticker = false; showAttach = true },
                        contentAlignment = Alignment.Center,
                    ) { PlusIcon(TextSub, 22.dp) }
                    if (input.isNotBlank()) {
                        Spacer(Modifier.width(8.dp))
                        Box(
                            Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Accent)
                                .noRippleClick { sendRaw("text", input.trim()); input = "" }.padding(horizontal = 16.dp),
                            contentAlignment = Alignment.Center,
                        ) { Text("发送", color = Color.White, fontSize = 14.sp) }
                    }
                }
                if (showSticker) {
                    EmojiPanel(
                        onPick = { sendRaw("sticker", StickerStore.encode(it)) },
                        onEmoji = { input += it },
                        onDelete = { input = dropLastGrapheme(input) },
                        onKeyboard = { showSticker = false; inputFocus.requestFocus(); keyboard?.show() },
                    )
                }
            }
        } else {
            Box(
                Modifier.fillMaxWidth().background(Bg2).navigationBarsPadding().clickable {
                    if (c.isMember) setMuted(!c.muted)
                    else scope.launch {
                        runCatching {
                            val d = Api.request("/im/channel/$groupId/subscribe", "POST")!!
                            val n = Api.json.decodeFromJsonElement(ChannelInfo.serializer(), d)
                            ch = n
                            val last = posts.lastOrNull { !it.pending }
                            val conv = n.conversationId
                            if (last != null && conv != null) WsClient.markRead(conv, last.id)
                        }.onFailure { toast(ctx, it.message ?: "订阅失败") }
                    }
                }.padding(vertical = 15.dp),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    !c.isMember -> Text("订阅", color = Accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    c.muted -> Text("取消静音", color = TextMain, fontSize = 15.sp)
                    else -> Text("静音", color = TextMain, fontSize = 15.sp)
                }
            }
        }
    }

    if (showAttach) {
        AttachSheet(
            isSingle = false,
            canVideoCall = false,
            onDismiss = { showAttach = false },
            onSend = { uris, caption -> sendImages(uris, caption) },
            onAction = { a ->
                if (a == AttachAction.Location) locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            },
        )
    }
    confirmDelete?.let { p ->
        ConfirmDialog("删除这条帖子？评论和表情回应会一起删除", "删除", onDismiss = { confirmDelete = null }, onConfirm = {
            scope.launch {
                runCatching { Api.request("/im/channel/posts/${p.id}/delete", "POST") }
                    .onSuccess { posts = posts.filterNot { it.id == p.id } }
                    .onFailure { toast(ctx, it.message ?: "删除失败") }
            }
        })
    }
    if (showInfo) {
        ChannelInfoSheet(c, onClose = { showInfo = false }, onChanged = { ch = it }, onExit = { showInfo = false; onExit() })
    }
    viewer?.let { (groups, start) ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { viewer = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            MediaViewer(groups, start, 0) { viewer = null }
        }
    }
}

/** 频道资料：头像 / 名称 / 简介（频道主可改）、订阅数、分享、静音、退订 / 删除 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelInfoSheet(ch: ChannelInfo, onClose: () -> Unit, onChanged: (ChannelInfo) -> Unit, onExit: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf(ch.name) }
    var desc by remember { mutableStateOf(ch.description) }
    var showShare by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    var showBots by remember { mutableStateOf(false) }
    val owner = ch.role == "owner"

    fun save(body: kotlinx.serialization.json.JsonObject) {
        scope.launch {
            runCatching { Api.request("/im/channel/${ch.id}", "PUT", body)!! }
                .onSuccess { onChanged(Api.json.decodeFromJsonElement(ChannelInfo.serializer(), it)); editing = false }
                .onFailure { toast(ctx, it.message ?: "保存失败") }
        }
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                Api.upload("image", b, "c.jpg", "image/jpeg")
            }.onSuccess { save(buildJsonObject { put("avatar", JsonPrimitive(it)) }) }
                .onFailure { toast(ctx, it.message ?: "上传失败") }
        }
    }

    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onClose, containerColor = Bg) {
        Column(Modifier.fillMaxWidth().clearFocusOnTap().padding(horizontal = 20.dp).padding(bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.noRippleClick { if (ch.canPost) pickAvatar.launch("image/*") }) { Avatar(ch.avatar, 72) }
            if (editing) {
                OutlinedTextField(name, { if (it.length <= 50) name = it }, placeholder = { Text("频道名称") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
                OutlinedTextField(desc, { if (it.length <= 500) desc = it }, placeholder = { Text("频道简介") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.End) {
                    Text("取消", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { editing = false }.padding(10.dp))
                    Text("保存", color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick {
                        save(buildJsonObject { put("name", JsonPrimitive(name)); put("description", JsonPrimitive(desc)) })
                    }.padding(10.dp))
                }
            } else {
                Text(ch.name, color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 10.dp))
                Text("${fmtCount(ch.subscribers)} 位订阅者 · 频道主 ${ch.owner?.nickname ?: ""}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                if (ch.description.isNotEmpty()) {
                    Text(ch.description, color = TextMain, fontSize = 14.sp, lineHeight = 22.sp, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
                }
                Box(Modifier.padding(top = 16.dp).fillMaxWidth().height(1.dp).background(Line))
                val menu: @Composable (String, Color, () -> Unit) -> Unit = { label, color, onClick ->
                    Text(label, color = color, fontSize = 15.sp, modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp))
                }
                if (ch.canPost) menu("编辑频道资料", TextMain) { name = ch.name; desc = ch.description; editing = true }
                if (ch.isMember) menu("分享频道（二维码 / 邀请码）", TextMain) { showShare = true }
                if (owner) menu("机器人（自动发帖）", TextMain) { showBots = true }
                if (ch.isMember && !owner) menu(if (ch.muted) "取消静音" else "静音", TextMain) {
                    scope.launch {
                        runCatching { Api.request("/im/channel/${ch.id}/mute", "POST", buildJsonObject { put("muted", JsonPrimitive(!ch.muted)) }) }
                            .onSuccess { onChanged(ch.copy(muted = !ch.muted)) }
                    }
                }
                if (ch.isMember) menu(if (owner) "删除频道" else "退订", Danger) { confirmLeave = true }
            }
        }
    }
    if (showShare) GroupShareDialog(groupId = ch.id, onClose = { showShare = false }, channel = true)
    if (showBots) AddBotSheet(groupId = ch.id, channel = true, onDismiss = { showBots = false })
    if (confirmLeave) {
        ConfirmDialog(
            if (owner) "删除频道后所有订阅者都看不到它，确定删除？" else "确定退订这个频道？",
            if (owner) "删除" else "退订",
            onDismiss = { confirmLeave = false },
            onConfirm = {
                scope.launch {
                    runCatching { Api.request("/im/channel/${ch.id}/${if (owner) "delete" else "unsubscribe"}", "POST") }
                        .onSuccess { onExit() }
                        .onFailure { toast(ctx, it.message ?: "操作失败") }
                }
            },
        )
    }
}

/** 帖子评论：任何登录用户都能评，可带贴纸、可回复某条 */
@Composable
fun ChannelCommentsScreen(msgId: String, canAdmin: Boolean, myUserId: String, onBack: () -> Unit, onOpenUser: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<CommentItem>?>(null) }
    var input by remember { mutableStateOf("") }
    var sticker by remember { mutableStateOf<StickerPayload?>(null) }
    var replyTo by remember { mutableStateOf<CommentItem?>(null) }
    var showEmoji by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<CommentItem?>(null) }
    val inputFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current

    suspend fun load() {
        list = runCatching { Api.getList<CommentItem>("/im/channel/posts/$msgId/comments") }.getOrDefault(list ?: emptyList())
    }
    LaunchedEffect(msgId) { load() }

    fun send() {
        val content = input.trim()
        if (busy || (content.isEmpty() && sticker == null)) return
        busy = true
        scope.launch {
            runCatching {
                Api.request("/im/channel/posts/$msgId/comments", "POST", buildJsonObject {
                    put("content", JsonPrimitive(content))
                    sticker?.let { put("stickerId", JsonPrimitive(it.id)) }
                    replyTo?.let { put("replyToId", JsonPrimitive(it.id)) }
                })
            }.onSuccess {
                input = ""; sticker = null; replyTo = null; showEmoji = false
                load()
            }.onFailure { toast(ctx, it.message ?: "评论失败") }
            busy = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar(list?.let { "${it.size} 条评论" } ?: "评论", onBack)
        val items = list
        Box(Modifier.weight(1f).fillMaxWidth().noRippleClick { showEmoji = false; focus.clearFocus(); keyboard?.hide() }) {
            when {
                items == null -> EmptyHint("加载中…")
                items.isEmpty() -> EmptyHint("还没有评论，来抢沙发")
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp)) {
                    items(items, key = { it.id }) { c ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.Top) {
                            Box(Modifier.noRippleClick { c.user?.id?.let(onOpenUser) }) { Avatar(c.user?.avatar, 34) }
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(c.user?.nickname ?: "", color = TextMain, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                    Text("  ${fmtChatTime(c.createdAt)}", color = TextDim, fontSize = 11.sp, modifier = Modifier.weight(1f))
                                    Text("回复", color = Accent, fontSize = 12.sp, modifier = Modifier.noRippleClick { replyTo = c; inputFocus.requestFocus(); keyboard?.show() }.padding(horizontal = 6.dp))
                                    if (c.user?.id == myUserId || canAdmin) {
                                        Text("删除", color = TextDim, fontSize = 12.sp, modifier = Modifier.noRippleClick { confirmDelete = c }.padding(start = 6.dp))
                                    }
                                }
                                if (c.content.isNotEmpty() || c.replyToNickname.isNotEmpty()) {
                                    Text(
                                        androidx.compose.ui.text.buildAnnotatedString {
                                            if (c.replyToNickname.isNotEmpty()) {
                                                pushStyle(androidx.compose.ui.text.SpanStyle(color = Accent))
                                                append("@${c.replyToNickname} ")
                                                pop()
                                            }
                                            append(c.content)
                                        },
                                        color = TextMain, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 3.dp),
                                    )
                                }
                                c.sticker?.let { Box(Modifier.padding(top = 4.dp)) { StickerImage(it, 96.dp) } }
                            }
                        }
                        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
                    }
                }
            }
        }

        Column(Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
            if (replyTo != null || sticker != null) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    sticker?.let { s ->
                        Box {
                            StickerImage(s, 56.dp)
                            Box(
                                Modifier.align(Alignment.TopEnd).size(18.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).noRippleClick { sticker = null },
                                contentAlignment = Alignment.Center,
                            ) { Text("×", color = Color.White, fontSize = 12.sp) }
                        }
                        Spacer(Modifier.width(10.dp))
                    }
                    replyTo?.let { r ->
                        Text("回复 @${r.user?.nickname ?: ""}", color = TextSub, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text("取消", color = TextSub, fontSize = 12.sp, modifier = Modifier.noRippleClick { replyTo = null })
                    } ?: Spacer(Modifier.weight(1f))
                }
            }
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                Box(
                    Modifier.size(40.dp).clip(CircleShape).background(if (showEmoji) BubbleMine else Bg3)
                        .noRippleClick { focus.clearFocus(); keyboard?.hide(); showEmoji = !showEmoji },
                    contentAlignment = Alignment.Center,
                ) { SmileIcon(if (showEmoji) Accent else TextSub, 22.dp) }
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 9.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (input.isEmpty()) Text(replyTo?.let { "回复 @${it.user?.nickname ?: ""}" } ?: "说点什么…", color = TextDim, fontSize = 15.sp)
                    BasicTextField(
                        value = input, onValueChange = { if (it.length <= 500) input = it },
                        textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
                        cursorBrush = SolidColor(Accent),
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showEmoji = false },
                    )
                }
                Spacer(Modifier.width(8.dp))
                val canSend = !busy && (input.isNotBlank() || sticker != null)
                Box(
                    Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(if (canSend) Accent else Bg3)
                        .noRippleClick { send() }.padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("发送", color = if (canSend) Color.White else TextDim, fontSize = 14.sp) }
            }
            if (showEmoji) {
                EmojiPanel(
                    onPick = { sticker = it },
                    onEmoji = { input += it },
                    onDelete = { input = dropLastGrapheme(input) },
                    onKeyboard = { showEmoji = false; inputFocus.requestFocus(); keyboard?.show() },
                )
            }
        }
    }

    confirmDelete?.let { c ->
        ConfirmDialog("删除这条评论？", "删除", onDismiss = { confirmDelete = null }, onConfirm = {
            scope.launch {
                runCatching { Api.request("/im/channel/comments/${c.id}/delete", "POST") }
                    .onSuccess { list = list?.filterNot { it.id == c.id } }
                    .onFailure { toast(ctx, it.message ?: "删除失败") }
            }
        })
    }
}

/** 创建频道 */
@Composable
fun CreateChannelScreen(onBack: () -> Unit, onCreated: (groupId: String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            busy = true
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                avatar = Api.upload("image", b, "c.jpg", "image/jpeg")
            }.onFailure { toast(ctx, it.message ?: "上传失败") }
            busy = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("创建频道", onBack)
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(56.dp).clip(CircleShape).background(Bg3).noRippleClick { pickAvatar.launch("image/*") }, contentAlignment = Alignment.Center) {
                    if (avatar.isNotEmpty()) Avatar(avatar, 56) else Text(if (busy) "…" else "头像", color = TextDim, fontSize = 11.sp)
                }
                OutlinedTextField(name, { if (it.length <= 50) name = it }, placeholder = { Text("频道名称") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            OutlinedTextField(
                desc, { if (it.length <= 500) desc = it },
                placeholder = { Text("频道简介（可选）：这个频道发什么") },
                minLines = 3, maxLines = 6,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            Text(
                "频道是一对多的广播：只有你能发帖，订阅的人可以看、点表情、评论。",
                color = TextSub, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 10.dp, bottom = 16.dp),
            )
            AccentButton(if (busy) "请稍候…" else "创建", enabled = !busy) {
                if (name.isBlank()) { toast(ctx, "请填写频道名称"); return@AccentButton }
                busy = true
                scope.launch {
                    runCatching {
                        val d = Api.request("/im/channel", "POST", buildJsonObject {
                            put("name", JsonPrimitive(name.trim()))
                            put("description", JsonPrimitive(desc.trim()))
                            put("avatar", JsonPrimitive(avatar))
                        })!!
                        Api.json.decodeFromJsonElement(ChannelInfo.serializer(), d)
                    }.onSuccess { onCreated(it.id) }
                        .onFailure { toast(ctx, it.message ?: "创建失败") }
                    busy = false
                }
            }
        }
    }
}

/** 发现频道：按订阅数排，可搜索，右上角创建 */
@Composable
fun ChannelsScreen(onBack: () -> Unit, onOpen: (groupId: String) -> Unit, onCreate: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var list by remember { mutableStateOf<List<ChannelListItem>?>(null) }

    LaunchedEffect(q) {
        if (q.isNotEmpty()) kotlinx.coroutines.delay(300)
        val kw = q.trim()
        list = runCatching { Api.getList<ChannelListItem>("/im/channel/list" + if (kw.isNotEmpty()) "?q=${Uri.encode(kw)}" else "") }.getOrDefault(emptyList())
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("发现频道", onBack, action = {
            Text("创建", color = Accent, fontSize = 14.sp, modifier = Modifier.noRippleClick(onCreate))
        })
        Box(
            Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().height(36.dp).clip(RoundedCornerShape(18.dp)).background(Bg3).padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (q.isEmpty()) Text("搜索频道", color = TextSub, fontSize = 14.sp)
            BasicTextField(
                value = q, onValueChange = { q = it.take(30) },
                textStyle = TextStyle(color = TextMain, fontSize = 14.sp),
                cursorBrush = SolidColor(Accent), singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        val items = list
        when {
            items == null -> EmptyHint("加载中…")
            items.isEmpty() -> EmptyHint(if (q.isNotBlank()) "没有找到相关频道" else "还没有频道，创建第一个吧")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { c ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpen(c.id) }.padding(horizontal = 16.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(c.avatar, 54)
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(c.name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                Text("  ${fmtCount(c.subscribers)} 订阅", color = TextDim, fontSize = 11.sp)
                            }
                            Text(
                                c.description.ifEmpty { "频道主 ${c.ownerNickname}" },
                                color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp),
                            )
                        }
                        Text(
                            if (c.isMember) "已订阅" else "订阅",
                            color = if (c.isMember) TextSub else Color.White, fontSize = 12.sp,
                            modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(if (c.isMember) Bg3 else Accent)
                                .noRippleClick {
                                    if (c.isMember) onOpen(c.id)
                                    else scope.launch {
                                        runCatching { Api.request("/im/channel/${c.id}/subscribe", "POST") }
                                            .onSuccess { list = list?.map { x -> if (x.id == c.id) x.copy(isMember = true, subscribers = x.subscribers + 1) else x } }
                                            .onFailure { toast(ctx, it.message ?: "订阅失败") }
                                    }
                                }
                                .padding(horizontal = 14.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }
}
