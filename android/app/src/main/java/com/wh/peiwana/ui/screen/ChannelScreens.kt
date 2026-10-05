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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.i18n.t
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
    /** 频道主 / 管理员 */
    val canPost: Boolean = false,
    /** 订阅者也能发帖 */
    val memberPost: Boolean = false,
    /** 我能不能发帖（老后端没有这个字段时按 canPost） */
    val canSend: Boolean? = null,
    val muted: Boolean = false,
    /** 消息保留天数，0 = 永久 */
    val retentionDays: Int = 0,
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
    val senderNickname: String = "",
    val senderAvatar: String = "",
    val senderIsBot: Boolean = false,
    /** 订阅者发的：普通聊天气泡，不带评论 / 浏览数 / 表情回应 */
    val memberMsg: Boolean = false,
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
        dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}

/** 「订阅者可发消息」开关：创建页和频道资料里共用 */
@Composable
private fun MemberPostSwitch(on: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().noRippleClick { onChange(!on) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t("channel.memberPost"), color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
        androidx.compose.material3.Switch(
            checked = on, onCheckedChange = onChange,
            colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
        )
    }
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
                else Text(t("chat.preview.sticker"), color = TextMain, fontSize = 15.sp)
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
            val name = obj?.get("name")?.jsonPrimitive?.content ?: t("chat.location")
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
        "payreq" -> {
            val pay = LocalChannelPay.current
            Box(Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp)) {
                PayreqCard(p.content, mine = p.senderId == pay.myId, onPay = pay.open?.let { f -> { f(p) } })
            }
        }
        else -> LinkText(p.content, color = TextMain, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp))
    }
}

/** 频道里收款消息的「转账」：打开钱包（没有钱包入口时 open = null） */
private class ChannelPay(val myId: String, val open: ((ChannelPost) -> Unit)?)
private val LocalChannelPay = staticCompositionLocalOf { ChannelPay("", null) }

/** 一条帖子：频道头 + 内容 + 表情回应 + 浏览数 / 时间 + 评论入口 */
/** 订阅者发的消息：普通聊天气泡，自己的在右边；长按删除 */
@Composable
private fun MemberBubble(p: ChannelPost, mine: Boolean, onMedia: () -> Unit, onDelete: (() -> Unit)?) {
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.72f).dp.coerceAtMost(400.dp)
    val media = p.type == "image" || p.type == "video"
    val sizeMod = if (media) Modifier.width(maxW * 0.9f) else Modifier.widthIn(min = 64.dp, max = maxW).width(IntrinsicSize.Max)
    val shape = RoundedCornerShape(16.dp, 16.dp, if (mine) 4.dp else 16.dp, if (mine) 16.dp else 4.dp)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!mine) {
            Avatar(p.senderAvatar, 32)
            Spacer(Modifier.width(8.dp))
        }
        Column(
            sizeMod.clip(shape).background(if (mine) BubbleMine else Bg).alpha(if (p.pending) 0.6f else 1f)
                .pointerInput(onDelete, p.pending) {
                    detectTapGestures(onLongPress = { if (onDelete != null && !p.pending) onDelete() })
                },
        ) {
            if (!mine) Text(
                p.senderNickname, color = Accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 7.dp),
            )
            PostBody(p, onMedia)
            Text(
                if (p.pending) t("chat.sending") else fmtChatTime(p.createdAt), color = TextDim, fontSize = 11.sp,
                modifier = Modifier.align(Alignment.End).padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 6.dp),
            )
        }
    }
}

@Composable
private fun PostCard(ch: ChannelInfo, p: ChannelPost, onReact: (String) -> Unit, onComments: () -> Unit, onMedia: () -> Unit, onDelete: (() -> Unit)?) {
    var picker by remember { mutableStateOf(false) }
    // 气泡按内容宽度（Telegram 式）；图片 / 视频 / 贴纸 / 带按钮的固定宽
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.85f).dp.coerceAtMost(480.dp)
    val fixed = p.type == "image" || p.type == "video" || p.type == "sticker" || p.markup != null
    val sizeMod = if (fixed) Modifier.width(maxW) else Modifier.widthIn(min = 220.dp, max = maxW).width(IntrinsicSize.Max)
    Column(
        Modifier.padding(horizontal = 12.dp, vertical = 5.dp).then(sizeMod)
            .clip(RoundedCornerShape(14.dp)).background(Bg).alpha(if (p.pending) 0.6f else 1f),
    ) {
        // 频道主 / 机器人发的算频道发帖；订阅者（和其他管理员）发的显示作者
        val byAuthor = p.senderId != ch.ownerId && !p.senderIsBot && p.senderNickname.isNotEmpty()
        Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(if (byAuthor) p.senderAvatar else ch.avatar, 26)
            Text(
                if (byAuthor) p.senderNickname else ch.name, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 8.dp),
            )
            if (onDelete != null && !p.pending) Text(t("common.delete"), color = TextDim, fontSize = 12.sp, modifier = Modifier.noRippleClick(onDelete))
        }
        PostBody(p, onMedia)
        InlineKeyboard(p.markup, p.id, Modifier.fillMaxWidth().padding(horizontal = 12.dp))
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                p.reactions.forEach { r -> ReactChip("${r.emoji} ${fmtCount(r.count)}", p.myReaction == r.emoji) { onReact(r.emoji) } }
                if (!p.pending) ReactChip("☺+", false) { picker = !picker }
            }
            if (p.pending) {
                Text(t("chat.sending"), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
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
                    if (p.commentCount > 0) "  " + t("channel.commentsN", "n" to p.commentCount) else "  " + t("channel.comments"),
                    color = Accent, fontSize = 13.sp, modifier = Modifier.weight(1f),
                )
                Text("›", color = TextDim, fontSize = 18.sp)
            }
        }
    }
}

/** 频道页：订阅前也能预览；频道主底部是发帖栏，订阅者是静音开关，没订阅是「订阅」 */
@Composable
fun ChannelScreen(
    groupId: String, myUserId: String, onBack: () -> Unit, onExit: () -> Unit, onOpenComments: (msgId: String, canAdmin: Boolean) -> Unit,
    onOpenWallet: ((String) -> Unit)? = null,
    walletResult: String? = null,
    onWalletResultUsed: () -> Unit = {},
) {
    val ctx = LocalContext.current
    // 付了频道里的收款消息：转账卡片私聊发给收款人（服务端按 req 决定）
    LaunchedEffect(walletResult) {
        val r = walletResult ?: return@LaunchedEffect
        onWalletResultUsed()
        toast(ctx, t("chat.transfer.verifying"))
        runCatching { postTransferCard("", r) }
            .onSuccess { toast(ctx, t("channel.transferDone")) }
            .onFailure { toast(ctx, t("chat.transfer.cardFailed", "msg" to (it.message ?: t("chat.tryLater")))) }
    }
    val pay = remember(myUserId, onOpenWallet) {
        ChannelPay(myUserId, onOpenWallet?.let { open -> { p: ChannelPost -> payreqPath(p.content, p.id, p.senderNickname.ifEmpty { t("channel.title") })?.let(open) } })
    }
    CompositionLocalProvider(LocalChannelPay provides pay) {
        ChannelScreenBody(groupId, myUserId, onBack, onExit, onOpenComments)
    }
}

@Composable
private fun ChannelScreenBody(groupId: String, myUserId: String, onBack: () -> Unit, onExit: () -> Unit, onOpenComments: (msgId: String, canAdmin: Boolean) -> Unit) {
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
    /** 正在播删除动画（灰飞烟灭）的帖子 id */
    var dying by remember { mutableStateOf(setOf<String>()) }

    /** 屏幕上看得见的播完动画再移除，看不见的直接移除；2 秒兜底防止滚走后卡住 */
    fun removePosts(ids: Set<String>) {
        if (ids.isEmpty()) return
        val visible = listState.layoutInfo.visibleItemsInfo.map { it.key.toString() }.toSet()
        val keyOf = posts.associate { it.id to (it.tempId ?: it.id) }
        val (show, hide) = ids.partition { keyOf[it] in visible }
        if (hide.isNotEmpty()) posts = posts.filterNot { it.id in hide }
        if (show.isEmpty()) return
        dying = dying + show
        scope.launch {
            kotlinx.coroutines.delay(2000)
            posts = posts.filterNot { it.id in show }
            dying = dying - show.toSet()
        }
    }
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
            .onFailure { error = it.message ?: t("channel.notFound") }
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
                        posts = posts + ChannelPost(
                            m.id, m.senderId, m.type, m.content, m.createdAt, views = 1, markup = m.markup,
                            senderNickname = m.senderNickname, senderAvatar = m.senderAvatar, senderIsBot = m.senderIsBot,
                            memberMsg = m.memberMsg,
                        )
                    } else {
                        // 自己发的：ack 先到时本地那条没有昵称头像，用推送补上
                        posts = posts.map { if (it.id == m.id && it.senderNickname.isEmpty()) it.copy(senderNickname = m.senderNickname, senderAvatar = m.senderAvatar, senderIsBot = m.senderIsBot) else it }
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
                        toast(ctx, frame["msg"]?.jsonPrimitive?.content ?: t("chat.sendFailed"))
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
                    val id = d["msgId"]?.jsonPrimitive?.content ?: return@addListener
                    if (id !in dying) removePosts(setOf(id))
                }
                "channel_purged" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != conv) return@addListener
                    val max = d["maxId"]?.jsonPrimitive?.content?.toBigIntegerOrNull() ?: return@addListener
                    removePosts(posts.filter { !it.pending && (it.id.toBigIntegerOrNull()?.let { n -> n <= max } ?: false) }.map { it.id }.toSet() - dying)
                }
                "msg_edit" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != conv) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val content = d["content"]?.jsonPrimitive?.content
                    val mk = d["markup"]?.let { el -> runCatching { WsClient.json.decodeFromJsonElement(InlineMarkup.serializer(), el) }.getOrNull() }
                    posts = posts.map { if (it.id == id) it.copy(content = content ?: it.content, markup = mk) else it }
                }
                "channel_info" -> {
                    if (frame["data"]?.jsonObject?.get("groupId")?.jsonPrimitive?.content != groupId) return@addListener
                    scope.launch { runCatching { Api.getObj<ChannelInfo>("/im/channel/$groupId") }.onSuccess { ch = it } }
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
        posts = posts + ChannelPost(tempId, myUserId, type, content, java.time.Instant.now().toString(), views = 1, tempId = tempId, pending = true, memberMsg = !c.canPost)
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
        if (failed > 0) toast(ctx, t("chat.imagesFailed", "n" to failed))
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
                .onFailure { toast(ctx, it.message ?: t("common.failed")) }
        }
    }

    fun setMuted(muted: Boolean) {
        val c = ch ?: return
        scope.launch {
            runCatching { Api.request("/im/channel/$groupId/mute", "POST", buildJsonObject { put("muted", JsonPrimitive(muted)) }) }
                .onSuccess { ch = c.copy(muted = muted) }
                .onFailure { toast(ctx, it.message ?: t("common.failed")) }
        }
    }

    fun openMedia(p: ChannelPost) {
        val media = posts.filter { !it.pending && (it.type == "image" || it.type == "video") }
        viewer = media.map { listOf(MediaItem(it.type, it.content)) } to media.indexOfFirst { it.id == p.id }.coerceAtLeast(0)
    }

    val c = ch
    if (c == null) {
        Column(Modifier.fillMaxSize()) {
            NavBar(t("channel.title"), onBack)
            EmptyHint(error.ifEmpty { t("common.loading") })
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
                    Text(t("channel.subscribersN", "n" to fmtCount(c.subscribers)), color = TextSub, fontSize = 12.sp)
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
                    t("channel.olderPosts"), color = TextSub, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().noRippleClick { loadMore() }.padding(10.dp),
                )
            }
            if (posts.isEmpty()) item("empty") {
                Text(
                    if (c.canSend ?: c.canPost) t("channel.emptyCanPost") else t("channel.emptyNoPosts"),
                    color = TextSub, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 80.dp),
                )
            }
            items(posts, key = { it.tempId ?: it.id }) { p ->
                Box(Modifier.dustOut(p.id in dying) { posts = posts.filterNot { it.id == p.id }; dying = dying - p.id }) {
                    if (p.memberMsg) MemberBubble(
                        p, mine = p.senderId == myUserId,
                        onMedia = { openMedia(p) },
                        onDelete = if (c.canPost || p.senderId == myUserId) ({ confirmDelete = p }) else null,
                    ) else PostCard(
                        ch = c, p = p,
                        onReact = { react(p, it) },
                        onComments = { onOpenComments(p.id, c.canPost) },
                        onMedia = { openMedia(p) },
                        onDelete = if (c.canPost || p.senderId == myUserId) ({ confirmDelete = p }) else null,
                    )
                }
            }
        }

        if (c.canSend ?: c.canPost) {
            Column(Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                    Box(
                        Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 9.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (input.isEmpty()) Text(if (c.canPost) t("channel.postHint") else t("channel.msgHint"), color = TextDim, fontSize = 15.sp)
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
                        ) { Text(t("common.send"), color = Color.White, fontSize = 14.sp) }
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
                        }.onFailure { toast(ctx, it.message ?: t("channel.subscribeFailed")) }
                    }
                }.padding(vertical = 15.dp),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    !c.isMember -> Text(t("channel.subscribe"), color = Accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    c.muted -> Text(t("channel.unmute"), color = TextMain, fontSize = 15.sp)
                    else -> Text(t("channel.mute"), color = TextMain, fontSize = 15.sp)
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
        ConfirmDialog(t("channel.deletePostConfirm"), t("common.delete"), onDismiss = { confirmDelete = null }, onConfirm = {
            scope.launch {
                runCatching { Api.request("/im/channel/posts/${p.id}/delete", "POST") }
                    .onSuccess { if (p.id !in dying) removePosts(setOf(p.id)) }
                    .onFailure { toast(ctx, it.message ?: t("chat.deleteFailed")) }
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
    var confirmClear by remember { mutableStateOf(false) }
    val owner = ch.role == "owner"

    fun save(body: kotlinx.serialization.json.JsonObject) {
        scope.launch {
            runCatching { Api.request("/im/channel/${ch.id}", "PUT", body)!! }
                .onSuccess { onChanged(Api.json.decodeFromJsonElement(ChannelInfo.serializer(), it)); editing = false }
                .onFailure { toast(ctx, it.message ?: t("channel.saveFailed")) }
        }
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                Api.upload("image", b, "c.jpg", "image/jpeg")
            }.onSuccess { save(buildJsonObject { put("avatar", JsonPrimitive(it)) }) }
                .onFailure { toast(ctx, it.message ?: t("channel.uploadFailed")) }
        }
    }

    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onClose, containerColor = Bg) {
        Column(Modifier.fillMaxWidth().clearFocusOnTap().padding(horizontal = 20.dp).padding(bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.noRippleClick { if (ch.canPost) pickAvatar.launch("image/*") }) { Avatar(ch.avatar, 72) }
            if (editing) {
                OutlinedTextField(name, { if (it.length <= 50) name = it }, placeholder = { Text(t("channel.name")) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
                OutlinedTextField(desc, { if (it.length <= 500) desc = it }, placeholder = { Text(t("channel.desc")) }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.End) {
                    Text(t("common.cancel"), color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { editing = false }.padding(10.dp))
                    Text(t("common.save"), color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick {
                        save(buildJsonObject { put("name", JsonPrimitive(name)); put("description", JsonPrimitive(desc)) })
                    }.padding(10.dp))
                }
            } else {
                Text(ch.name, color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 10.dp))
                Text(t("channel.subscribersOwner", "n" to fmtCount(ch.subscribers), "name" to (ch.owner?.nickname ?: "")), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                if (ch.description.isNotEmpty()) {
                    Text(ch.description, color = TextMain, fontSize = 14.sp, lineHeight = 22.sp, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
                }
                if (ch.retentionDays > 0) {
                    Text(t("channel.retention", "n" to ch.retentionDays), color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
                }
                Box(Modifier.padding(top = 16.dp).fillMaxWidth().height(1.dp).background(Line))
                val menu: @Composable (String, Color, () -> Unit) -> Unit = { label, color, onClick ->
                    Text(label, color = color, fontSize = 15.sp, modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp))
                }
                if (ch.canPost) menu(t("channel.editInfo"), TextMain) { name = ch.name; desc = ch.description; editing = true }
                if (ch.canPost) MemberPostSwitch(ch.memberPost) { save(buildJsonObject { put("memberPost", JsonPrimitive(it)) }) }
                if (ch.isMember) menu(t("channel.share"), TextMain) { showShare = true }
                if (owner) menu(t("channel.bots"), TextMain) { showBots = true }
                if (ch.isMember && !owner) menu(if (ch.muted) t("channel.unmute") else t("channel.mute"), TextMain) {
                    scope.launch {
                        runCatching { Api.request("/im/channel/${ch.id}/mute", "POST", buildJsonObject { put("muted", JsonPrimitive(!ch.muted)) }) }
                            .onSuccess { onChanged(ch.copy(muted = !ch.muted)) }
                    }
                }
                if (owner) menu(t("channel.clearAll"), Danger) { confirmClear = true }
                if (ch.isMember) menu(if (owner) t("channel.delete") else t("channel.unsubscribe"), Danger) { confirmLeave = true }
            }
        }
    }
    if (showShare) GroupShareDialog(groupId = ch.id, onClose = { showShare = false }, channel = true)
    if (showBots) AddBotSheet(groupId = ch.id, channel = true, onDismiss = { showBots = false })
    if (confirmLeave) {
        ConfirmDialog(
            if (owner) t("channel.deleteConfirm") else t("channel.unsubscribeConfirm"),
            if (owner) t("common.delete") else t("channel.unsubscribe"),
            onDismiss = { confirmLeave = false },
            onConfirm = {
                scope.launch {
                    runCatching { Api.request("/im/channel/${ch.id}/${if (owner) "delete" else "unsubscribe"}", "POST") }
                        .onSuccess { onExit() }
                        .onFailure { toast(ctx, it.message ?: t("common.failed")) }
                }
            },
        )
    }
    if (confirmClear) {
        ConfirmDialog(
            t("channel.clearConfirm"),
            t("chat.clear"),
            onDismiss = { confirmClear = false },
            onConfirm = {
                confirmClear = false
                scope.launch {
                    runCatching { Api.request("/im/channel/${ch.id}/clear", "POST") }
                        .onSuccess { r ->
                            val n = r?.jsonObject?.get("deleted")?.jsonPrimitive?.intOrNull ?: 0
                            toast(ctx, if (n > 0) t("channel.clearedN", "n" to n) else t("channel.noMessages"))
                            onClose()
                        }
                        .onFailure { toast(ctx, it.message ?: t("channel.clearFailed")) }
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
            }.onFailure { toast(ctx, it.message ?: t("channel.commentFailed")) }
            busy = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar(list?.let { t("channel.commentsN", "n" to it.size) } ?: t("channel.comments"), onBack)
        val items = list
        Box(Modifier.weight(1f).fillMaxWidth().noRippleClick { showEmoji = false; focus.clearFocus(); keyboard?.hide() }) {
            when {
                items == null -> EmptyHint(t("common.loading"))
                items.isEmpty() -> EmptyHint(t("channel.noComments"))
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp)) {
                    items(items, key = { it.id }) { c ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.Top) {
                            Box(Modifier.noRippleClick { c.user?.id?.let(onOpenUser) }) { Avatar(c.user?.avatar, 34) }
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(c.user?.nickname ?: "", color = TextMain, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                    Text("  ${fmtChatTime(c.createdAt)}", color = TextDim, fontSize = 11.sp, modifier = Modifier.weight(1f))
                                    Text(t("chat.reply"), color = Accent, fontSize = 12.sp, modifier = Modifier.noRippleClick { replyTo = c; inputFocus.requestFocus(); keyboard?.show() }.padding(horizontal = 6.dp))
                                    if (c.user?.id == myUserId || canAdmin) {
                                        Text(t("common.delete"), color = TextDim, fontSize = 12.sp, modifier = Modifier.noRippleClick { confirmDelete = c }.padding(start = 6.dp))
                                    }
                                }
                                if (c.content.isNotEmpty() || c.replyToNickname.isNotEmpty()) {
                                    var linkUrl by remember { mutableStateOf<String?>(null) }
                                    Text(
                                        androidx.compose.ui.text.buildAnnotatedString {
                                            if (c.replyToNickname.isNotEmpty()) {
                                                pushStyle(androidx.compose.ui.text.SpanStyle(color = Accent))
                                                append("@${c.replyToNickname} ")
                                                pop()
                                            }
                                            splitLinks(c.content).forEach { (t, url) ->
                                                if (url == null) append(t)
                                                else withLink(
                                                    androidx.compose.ui.text.LinkAnnotation.Clickable(
                                                        url,
                                                        androidx.compose.ui.text.TextLinkStyles(androidx.compose.ui.text.SpanStyle(color = BotBlue, textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline)),
                                                    ) { linkUrl = url },
                                                ) { append(t) }
                                            }
                                        },
                                        color = TextMain, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 3.dp),
                                    )
                                    linkUrl?.let { u -> WebPreviewDialog(url = u, title = hostOf(u)) { linkUrl = null } }
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
                        Text(t("channel.replyTo", "name" to (r.user?.nickname ?: "")), color = TextSub, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Text(t("common.cancel"), color = TextSub, fontSize = 12.sp, modifier = Modifier.noRippleClick { replyTo = null })
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
                    if (input.isEmpty()) Text(replyTo?.let { t("channel.replyTo", "name" to (it.user?.nickname ?: "")) } ?: t("channel.commentHint"), color = TextDim, fontSize = 15.sp)
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
                ) { Text(t("common.send"), color = if (canSend) Color.White else TextDim, fontSize = 14.sp) }
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
        ConfirmDialog(t("channel.deleteCommentConfirm"), t("common.delete"), onDismiss = { confirmDelete = null }, onConfirm = {
            scope.launch {
                runCatching { Api.request("/im/channel/comments/${c.id}/delete", "POST") }
                    .onSuccess { list = list?.filterNot { it.id == c.id } }
                    .onFailure { toast(ctx, it.message ?: t("chat.deleteFailed")) }
            }
        })
    }
}

private val GroupBg = Color(0xFFF2F2F7)

@Serializable
private data class ChannelQuota(val owned: Int = 0, val limit: Int = 0)

/** 白色分组卡片里的无边框输入框，右上角字数 */
@Composable
private fun GroupField(value: String, hint: String, max: Int, singleLine: Boolean, onChange: (String) -> Unit) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
        BasicTextField(
            value, { if (it.length <= max) onChange(it) },
            singleLine = singleLine, minLines = if (singleLine) 1 else 3, maxLines = if (singleLine) 1 else 6,
            textStyle = TextStyle(color = TextMain, fontSize = 16.sp, lineHeight = 24.sp),
            cursorBrush = SolidColor(Accent),
            modifier = Modifier.fillMaxWidth().padding(end = 48.dp),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text(hint, color = TextDim, fontSize = 16.sp, lineHeight = 24.sp)
                    inner()
                }
            },
        )
        if (value.isNotEmpty()) Text("${value.length}/$max", color = TextDim, fontSize = 12.sp, modifier = Modifier.align(Alignment.TopEnd).padding(top = 3.dp))
    }
}

@Composable
private fun GroupCaption(text: String) {
    Text(text, color = TextSub, fontSize = 13.sp, lineHeight = 19.sp, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 18.dp))
}

@Composable
private fun CameraGlyph(size: androidx.compose.ui.unit.Dp, color: Color) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        val st = androidx.compose.ui.graphics.drawscope.Stroke(width = w * 0.08f)
        drawRoundRect(
            color, topLeft = androidx.compose.ui.geometry.Offset(w * 0.12f, w * 0.28f),
            size = androidx.compose.ui.geometry.Size(w * 0.76f, w * 0.54f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.1f), style = st,
        )
        drawLine(color, androidx.compose.ui.geometry.Offset(w * 0.38f, w * 0.18f), androidx.compose.ui.geometry.Offset(w * 0.62f, w * 0.18f), strokeWidth = w * 0.08f)
        drawCircle(color, radius = w * 0.14f, center = androidx.compose.ui.geometry.Offset(w * 0.5f, w * 0.55f), style = st)
    }
}

@Composable
private fun BubbleGlyph(size: androidx.compose.ui.unit.Dp, color: Color) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawCircle(color, radius = w * 0.4f, center = androidx.compose.ui.geometry.Offset(w * 0.5f, w * 0.48f), style = androidx.compose.ui.graphics.drawscope.Stroke(width = w * 0.11f))
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
    var memberPost by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var quota by remember { mutableStateOf<ChannelQuota?>(null) }
    LaunchedEffect(Unit) { quota = runCatching { Api.getObj<ChannelQuota>("/im/channel/quota") }.getOrNull() }
    val left = quota?.let { (it.limit - it.owned).coerceAtLeast(0) }

    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            busy = true
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                avatar = Api.upload("image", b, "c.jpg", "image/jpeg")
            }.onFailure { toast(ctx, it.message ?: t("channel.uploadFailed")) }
            busy = false
        }
    }

    val pick = { if (!busy) pickAvatar.launch("image/*") }
    Column(Modifier.fillMaxSize().background(GroupBg)) {
        NavBar(t("channel.new"), onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
            Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(88.dp).noRippleClick(pick)) {
                    Box(Modifier.fillMaxSize().clip(CircleShape).background(AccentBrush), contentAlignment = Alignment.Center) {
                        when {
                            avatar.isNotEmpty() -> Avatar(avatar, 88)
                            name.isNotBlank() -> Text(String(Character.toChars(name.trim().codePointAt(0))), color = Color.White, fontSize = 36.sp, fontWeight = FontWeight.SemiBold)
                            else -> CameraGlyph(30.dp, Color.White)
                        }
                        if (busy) Box(Modifier.fillMaxSize().background(Color(0x73000000)), contentAlignment = Alignment.Center) {
                            Text(t("channel.uploading"), color = Color.White, fontSize = 12.sp)
                        }
                    }
                    Box(
                        Modifier.align(Alignment.BottomEnd).offset(2.dp, 2.dp).size(28.dp).clip(CircleShape).background(Bg),
                        contentAlignment = Alignment.Center,
                    ) { CameraGlyph(14.dp, Accent) }
                }
                Text(
                    if (avatar.isEmpty()) t("channel.setAvatar") else t("channel.changeAvatar"), color = Accent, fontSize = 14.sp,
                    modifier = Modifier.padding(top = 8.dp).noRippleClick(pick),
                )
            }

            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg)) {
                GroupField(name, t("channel.name"), 50, singleLine = true) { name = it }
                Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(Line))
                GroupField(desc, t("channel.descOptional"), 500, singleLine = false) { desc = it }
            }
            GroupCaption(t("channel.descCaption"))

            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg)
                    .noRippleClick { memberPost = !memberPost }.padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF34C759)), contentAlignment = Alignment.Center) {
                    BubbleGlyph(16.dp, Color.White)
                }
                Text(t("channel.memberPost"), color = TextMain, fontSize = 16.sp, modifier = Modifier.weight(1f).padding(start = 12.dp))
                androidx.compose.material3.Switch(
                    checked = memberPost, onCheckedChange = { memberPost = it },
                    colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
                )
            }
            GroupCaption(
                if (memberPost) t("channel.memberPostOnCaption") else t("channel.memberPostOffCaption"),
            )

            quota?.let { q ->
                Text(
                    if (left == 0) t("channel.quotaFull", "n" to q.limit) else t("channel.quotaLeft", "left" to left, "n" to q.limit),
                    color = TextSub, fontSize = 12.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
                )
            }
            AccentButton(if (busy) t("channel.pleaseWait") else t("channel.create"), enabled = !busy && name.isNotBlank() && left != 0) {
                if (name.isBlank()) { toast(ctx, t("channel.nameRequired")); return@AccentButton }
                busy = true
                scope.launch {
                    runCatching {
                        val d = Api.request("/im/channel", "POST", buildJsonObject {
                            put("name", JsonPrimitive(name.trim()))
                            put("description", JsonPrimitive(desc.trim()))
                            put("avatar", JsonPrimitive(avatar))
                            put("memberPost", JsonPrimitive(memberPost))
                        })!!
                        Api.json.decodeFromJsonElement(ChannelInfo.serializer(), d)
                    }.onSuccess { onCreated(it.id) }
                        .onFailure { toast(ctx, it.message ?: t("channel.createFailed")) }
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
        NavBar(t("channel.discover"), onBack, action = {
            Text(t("channel.createShort"), color = Accent, fontSize = 14.sp, modifier = Modifier.noRippleClick(onCreate))
        })
        Box(
            Modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth().height(36.dp).clip(RoundedCornerShape(18.dp)).background(Bg3).padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (q.isEmpty()) Text(t("channel.search"), color = TextSub, fontSize = 14.sp)
            BasicTextField(
                value = q, onValueChange = { q = it.take(30) },
                textStyle = TextStyle(color = TextMain, fontSize = 14.sp),
                cursorBrush = SolidColor(Accent), singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        val items = list
        when {
            items == null -> EmptyHint(t("common.loading"))
            items.isEmpty() -> EmptyHint(if (q.isNotBlank()) t("channel.searchEmpty") else t("channel.listEmpty"))
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
                                Text("  " + t("channel.subsShort", "n" to fmtCount(c.subscribers)), color = TextDim, fontSize = 11.sp)
                            }
                            Text(
                                c.description.ifEmpty { t("channel.ownerBy", "name" to c.ownerNickname) },
                                color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp),
                            )
                        }
                        Text(
                            if (c.isMember) t("channel.subscribed") else t("channel.subscribe"),
                            color = if (c.isMember) TextSub else Color.White, fontSize = 12.sp,
                            modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(if (c.isMember) Bg3 else Accent)
                                .noRippleClick {
                                    if (c.isMember) onOpen(c.id)
                                    else scope.launch {
                                        runCatching { Api.request("/im/channel/${c.id}/subscribe", "POST") }
                                            .onSuccess { list = list?.map { x -> if (x.id == c.id) x.copy(isMember = true, subscribers = x.subscribers + 1) else x } }
                                            .onFailure { toast(ctx, it.message ?: t("channel.subscribeFailed")) }
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
