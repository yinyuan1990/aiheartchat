package com.wh.peiwana.ui.screen

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.LocationManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import com.wh.peiwana.ui.sticker.SmileIcon
import com.wh.peiwana.ui.sticker.StickerImage
import com.wh.peiwana.ui.sticker.EmojiPanel
import com.wh.peiwana.ui.sticker.StickerStore
import com.wh.peiwana.ui.sticker.dropLastGrapheme
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

@Serializable
data class PeerBrief(val id: String, val nickname: String, val avatar: String = "", val gender: Int = 0, val isBot: Boolean = false)

@Serializable
data class GroupBrief(val id: String, val name: String, val avatar: String = "", /** 2 = 频道 */ val kind: Int = 1)

@Serializable
data class LastMsg(val id: String, val senderId: String, val type: String, val content: String = "", val createdAt: String)

@Serializable
data class ConversationItem(
    val id: String,
    val type: Int,
    val peer: PeerBrief? = null,
    val group: GroupBrief? = null,
    val lastMsg: LastMsg? = null,
    val unread: Int = 0,
    /** 频道静音：未读不计入底栏总数，角标显示灰色 */
    val muted: Boolean = false,
    val lastMsgAt: String,
)

@Serializable
data class MsgItem(
    val id: String,
    val conversationId: String,
    val senderId: String,
    val senderNickname: String = "",
    val senderAvatar: String = "",
    val receiverId: String? = null,
    val type: String,
    val content: String,
    val createdAt: String,
    val senderIsBot: Boolean = false,
    val markup: InlineMarkup? = null,
    val isRead: Boolean = false,
    val replyTo: ReplyPreview? = null,
    val fwdFrom: String? = null,
    val reactions: List<MsgReaction> = emptyList(),
) {
    /** 本地刚发、还没收到服务端 ack（id 还是 tempId） */
    val pending: Boolean get() = id.startsWith("t_")
}

private fun parseIso(iso: String?): java.time.Instant? =
    if (iso.isNullOrEmpty()) null else runCatching { java.time.Instant.parse(iso) }.getOrNull()

/** 今天显示 HH:mm，非今天显示 MM-dd HH:mm */
fun fmtChatTime(iso: String?): String {
    val instant = parseIso(iso) ?: return ""
    val zone = java.time.ZoneId.systemDefault()
    val dt = instant.atZone(zone)
    val today = java.time.LocalDate.now(zone)
    val pattern = if (dt.toLocalDate() == today) "HH:mm" else "MM-dd HH:mm"
    return dt.format(java.time.format.DateTimeFormatter.ofPattern(pattern))
}

/** 与上一条间隔超 5 分钟显示时间分隔条 */
fun shouldShowTime(messages: List<MsgItem>, idx: Int): Boolean {
    val cur = parseIso(messages[idx].createdAt) ?: return false
    if (idx == 0) return true
    val prev = parseIso(messages[idx - 1].createdAt) ?: return true
    return java.time.Duration.between(prev, cur).seconds > 300
}

internal fun preview(msg: LastMsg?): String = when {
    msg == null -> ""
    msg.type == "text" -> msg.content.take(30)
    msg.type == "image" -> "[图片]"
    msg.type == "video" -> "[视频]"
    msg.type == "sticker" -> if (msg.content.contains("\"mp4\"")) "[GIF]" else "[表情]"
    msg.type == "audio" -> "[语音]"
    msg.type == "location" -> "[位置]"
    msg.type == "gift" -> "[礼物]"
    msg.type.startsWith("call") -> "[通话]"
    else -> ""
}

/** 通知列表页标记已读后 +1，常驻的消息页据此刷新评论 / 接单的未读数 */
object NoticeRefresh {
    val tick = kotlinx.coroutines.flow.MutableStateFlow(0)
}

private sealed interface MsgEntry { val at: String; val key: String }
private data class ConvEntry(val c: ConversationItem) : MsgEntry {
    override val at get() = c.lastMsgAt
    override val key get() = "c-${c.id}"
}
private data class NoticeEntry(val kind: String, val s: NoticeSummary) : MsgEntry {
    override val at get() = s.last?.createdAt ?: ""
    override val key get() = "n-$kind"
}

private fun noticeTitle(kind: String) = if (kind == "task") "接单通知" else "评论通知"

/** 评论 / 接单系统会话的圆形图标 */
@Composable
private fun NoticeIcon(kind: String, sizeDp: Int) {
    val colors = if (kind == "task") listOf(Color(0xFF2FB5FF), Color(0xFF4C6FFF)) else listOf(Color(0xFFFF9A3C), Accent)
    Box(
        Modifier.size(sizeDp.dp).clip(RoundedCornerShape(50)).background(androidx.compose.ui.graphics.Brush.linearGradient(colors)),
        contentAlignment = Alignment.Center,
    ) {
        if (kind == "task") BriefcaseIcon(Color.White, (sizeDp * 0.46f).dp) else BubbleIcon(Color.White, (sizeDp * 0.5f).dp)
    }
}

@Composable
private fun AiIcon(sizeDp: Int) {
    Box(
        Modifier.size(sizeDp.dp).clip(RoundedCornerShape(50)).background(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Accent, Accent2))),
        contentAlignment = Alignment.Center,
    ) {
        Text("AI", color = Color.White, fontSize = (sizeDp * 0.31f).sp, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
private fun MusicEntryIcon(sizeDp: Int) {
    Box(
        Modifier.size(sizeDp.dp).clip(RoundedCornerShape(50)).background(androidx.compose.ui.graphics.Brush.linearGradient(listOf(Color(0xFF7B5CFF), Accent))),
        contentAlignment = Alignment.Center,
    ) {
        NoteIcon(Color.White, (sizeDp * 0.48f).dp)
    }
}

/** 消息列表一行：左图标 54 + 标题 / 时间 + 预览 / 角标，分隔线和文字对齐 */
@Composable
private fun MsgListRow(onClick: () -> Unit, leading: @Composable () -> Unit, title: @Composable RowScope.() -> Unit, end: String, sub: String, badge: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.padding(vertical = 9.dp)) { leading() }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Column(Modifier.padding(end = 16.dp, top = 9.dp, bottom = 9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, content = title)
                    if (end.isNotEmpty()) Text(end, color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
                }
                Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(sub, color = TextSub, fontSize = 14.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    badge()
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
        }
    }
}

private class PlusMenuItem(val label: String, val icon: @Composable (Color) -> Unit, val onClick: () -> Unit)

/** 消息页右上「+」弹出菜单：白色圆角卡片 + 阴影，从按钮右上角缩放展开 */
@Composable
private fun PlusMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<PlusMenuItem>) {
    val visible = remember { MutableTransitionState(false) }
    visible.targetState = expanded
    if (!visible.currentState && !visible.targetState) return
    val density = LocalDensity.current
    // 卡片四周留 12dp 给阴影（Popup 窗口外的阴影会被裁掉），offset 再抵回去
    Popup(
        alignment = Alignment.TopEnd,
        offset = with(density) { IntOffset(12.dp.roundToPx(), 30.dp.roundToPx()) },
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        AnimatedVisibility(
            visibleState = visible,
            enter = fadeIn(tween(140)) + scaleIn(tween(180), initialScale = 0.85f, transformOrigin = TransformOrigin(1f, 0f)),
            exit = fadeOut(tween(110)) + scaleOut(tween(110), targetScale = 0.92f, transformOrigin = TransformOrigin(1f, 0f)),
        ) {
            Column(
                Modifier.padding(12.dp)
                    .shadow(10.dp, RoundedCornerShape(14.dp), ambientColor = Color.Black.copy(alpha = 0.10f), spotColor = Color.Black.copy(alpha = 0.16f))
                    .clip(RoundedCornerShape(14.dp)).background(Bg)
                    .width(168.dp).padding(vertical = 6.dp),
            ) {
                items.forEach { item ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onDismiss(); item.onClick() }.padding(horizontal = 14.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(32.dp).clip(CircleShape).background(Accent.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
                            item.icon(Accent)
                        }
                        Spacer(Modifier.width(12.dp))
                        Text(item.label, color = TextMain, fontSize = 15.sp)
                    }
                }
            }
        }
    }
}

/** 消息主页：标题 + 搜索 + 合并列表（AI 助手 / 音乐置顶，会话与评论 / 接单通知按最新时间排） */
@Composable
fun MessagesScreen(modifier: Modifier = Modifier, onOpenChat: (convId: String, convType: Int, targetId: String, title: String) -> Unit, onOpenMessage: (convId: String, convType: Int, targetId: String, title: String, msgId: String) -> Unit, onOpenNotices: (String) -> Unit, onOpenUser: (userId: String, nickname: String) -> Unit, onScan: () -> Unit, onCreateGroup: () -> Unit, onOpenAi: () -> Unit, onOpenNews: () -> Unit = {}, onJoinGroup: () -> Unit = {}, onOpenChannel: (groupId: String) -> Unit = {}, onOpenChannels: () -> Unit = {}, onCreateChannel: () -> Unit = {}, onOpenBots: () -> Unit = {}) {
    var convs by remember { mutableStateOf<List<ConversationItem>>(emptyList()) }
    // 频道会话进频道页，其余进聊天页
    val openConv: (String, Int, String, String) -> Unit = { id, type, target, title ->
        val g = convs.find { it.id == id }?.group
        if (g?.kind == 2) onOpenChannel(g.id) else onOpenChat(id, type, target, title)
    }
    var summary by remember { mutableStateOf(NoticeSummaryResp()) }
    var showSearch by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun loadConvs() { scope.launch { convs = runCatching { Api.getList<ConversationItem>("/im/conversations") }.getOrDefault(convs) } }
    fun loadSummary() { scope.launch { summary = runCatching { Api.getObj<NoticeSummaryResp>("/notifications/summary") }.getOrDefault(summary) } }

    val noticeTick by NoticeRefresh.tick.collectAsState()
    LaunchedEffect(Unit) { loadConvs() }
    LaunchedEffect(noticeTick) { loadSummary() }
    DisposableEffect(Unit) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                // conv_refresh：入群/退群等成员变动（扫码入群后新群立即出现在列表）
                "msg", "conv_cleared", "conv_refresh" -> loadConvs()
                "notify" -> loadSummary()
            }
        }
        onDispose { remove() }
    }

    val entries: List<MsgEntry> = remember(convs, summary) {
        val list = convs.map { ConvEntry(it) } +
            listOf("comment" to summary.comment, "task" to summary.task).filter { it.second.last != null }.map { NoticeEntry(it.first, it.second) }
        list.sortedByDescending { parseIso(it.at) ?: java.time.Instant.EPOCH }
    }

    // 音乐播放弹层（顶部「正在播放」栏 / 置顶入口打开）
    var showMusic by remember { mutableStateOf(false) }
    if (showMusic) MusicSheet(onDismiss = { showMusic = false })

    if (showSearch) {
        val extras = buildList {
            add(SearchExtra("ai", "AI 助手", "有问必答，随便问", icon = { AiIcon(it) }, onOpen = { showSearch = false; onOpenAi() }))
            add(SearchExtra("music", "音乐", "DJ 热曲 · 情感音乐，边聊边听", icon = { MusicEntryIcon(it) }, onOpen = { showSearch = false; showMusic = true }))
            listOf("comment" to summary.comment, "task" to summary.task).filter { it.second.last != null }.forEach { (k, s) ->
                add(SearchExtra(k, noticeTitle(k), s.last?.title ?: "", s.unread, icon = { NoticeIcon(k, it) }, onOpen = { showSearch = false; onOpenNotices(k) }))
            }
        }
        ChatSearchDialog(
            convs = convs,
            extras = extras,
            onDismiss = { showSearch = false },
            onOpenChat = { id, type, target, title -> showSearch = false; openConv(id, type, target, title) },
            onOpenMessage = { id, type, target, title, msgId ->
                showSearch = false
                val g = convs.find { it.id == id }?.group
                if (g?.kind == 2) onOpenChannel(g.id) else onOpenMessage(id, type, target, title, msgId)
            },
            onOpenUser = { id, name -> showSearch = false; onOpenUser(id, name) },
            onScan = { showSearch = false; onScan() },
        )
    }

    Column(modifier = modifier.fillMaxSize()) {
        // 播放中：固定在消息页最上面
        NowPlayingBar(onOpen = { showMusic = true })
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 12.dp, 16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("消息", color = TextMain, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Box {
                var showPlusMenu by remember { mutableStateOf(false) }
                Box(modifier = Modifier.size(34.dp).clip(CircleShape).background(Bg3).clickable { showPlusMenu = true }, contentAlignment = Alignment.Center) { PlusIcon(TextMain, 18.dp) }
                PlusMenu(
                    expanded = showPlusMenu,
                    onDismiss = { showPlusMenu = false },
                    items = listOf(
                        PlusMenuItem("创建群聊", { PersonPlusIcon(it, 19.dp) }, onCreateGroup),
                        PlusMenuItem("加入群聊", { PeopleIcon(it, 19.dp) }, onJoinGroup),
                        PlusMenuItem("创建频道", { BroadcastIcon(it, 19.dp) }, onCreateChannel),
                        PlusMenuItem("发现频道", { com.wh.peiwana.ui.sticker.SearchIcon(it, 18.dp) }, onOpenChannels),
                        PlusMenuItem("我的机器人", { Text("Bot", color = it, fontSize = 11.sp, fontWeight = FontWeight.Bold) }, onOpenBots),
                        PlusMenuItem("扫一扫", { ScanIcon(it, 18.dp) }, onScan),
                    ),
                )
            }
        }

        // 搜索胶囊：点了弹全屏搜索框；右端扫一扫
        Box(
            Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp).fillMaxWidth().height(36.dp)
                .clip(RoundedCornerShape(18.dp)).background(Bg3).clickable { showSearch = true },
        ) {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                com.wh.peiwana.ui.sticker.SearchIcon(TextSub, 16.dp)
                Text("搜索", color = TextSub, fontSize = 15.sp, modifier = Modifier.padding(start = 6.dp))
            }
            Box(
                Modifier.align(Alignment.CenterEnd).padding(end = 4.dp).size(28.dp).clip(androidx.compose.foundation.shape.CircleShape).clickable(onClick = onScan),
                contentAlignment = Alignment.Center,
            ) { ScanIcon(TextSub, 17.dp) }
        }

        val tag: @Composable (String) -> Unit = { label ->
            Text(
                label, color = Accent, fontSize = 10.sp,
                modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp))
                    .background(Accent.copy(alpha = 0.12f))
                    .padding(horizontal = 5.dp, vertical = 2.dp),
            )
        }
        LazyColumn(Modifier.fillMaxSize()) {
            // AI 助手 / 音乐固定置顶
            item("ai") {
                MsgListRow(
                    onClick = onOpenAi, leading = { AiIcon(54) },
                    title = { Text("AI 助手", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium); tag("免费") },
                    end = "", sub = "有问必答，随便问", badge = {},
                )
            }
            item("music") {
                MsgListRow(
                    onClick = { showMusic = true }, leading = { MusicEntryIcon(54) },
                    title = { Text("音乐", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium); tag("每日上新") },
                    end = "", sub = "DJ 热曲 · 情感音乐，边聊边听", badge = {},
                )
            }
            items(entries, key = { it.key }) { e ->
                when (e) {
                    is NoticeEntry -> MsgListRow(
                        onClick = { onOpenNotices(e.kind) }, leading = { NoticeIcon(e.kind, 54) },
                        title = { Text(noticeTitle(e.kind), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium) },
                        end = fmtChatTime(e.at), sub = e.s.last?.title ?: "",
                        badge = { com.wh.peiwana.ui.RoundBadge(e.s.unread, Modifier.padding(start = 8.dp)) },
                    )
                    is ConvEntry -> {
                        val c = e.c
                        val name = if (c.type == 1) c.peer?.nickname ?: "" else c.group?.name ?: ""
                        val title = if (c.type == 1) name else "$name（群）"
                        val avatar = if (c.type == 1) c.peer?.avatar else c.group?.avatar
                        val target = if (c.type == 1) c.peer?.id else c.group?.id
                        MsgListRow(
                            onClick = { target?.let { openConv(c.id, c.type, it, title) } }, leading = { Avatar(avatar, 54) },
                            title = {
                                Text(name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                if (c.type == 2) Text(
                                    if (c.group?.kind == 2) "频道" else "群", color = TextSub, fontSize = 10.sp,
                                    modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(Bg3).padding(horizontal = 4.dp),
                                )
                                if (c.peer?.isBot == true) BotTag()
                            },
                            end = fmtChatTime(c.lastMsgAt), sub = preview(c.lastMsg),
                            badge = { com.wh.peiwana.ui.RoundBadge(c.unread, Modifier.padding(start = 8.dp), color = if (c.muted) TextDim else Accent) },
                        )
                    }
                }
            }
            if (entries.isEmpty()) item("empty") {
                Box(Modifier.fillMaxWidth().padding(vertical = 70.dp), contentAlignment = Alignment.Center) {
                    Text("暂无消息\n去广场或大厅找人打招呼", color = TextSub, fontSize = 14.sp, lineHeight = 26.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

/** 评论 / 接单通知列表（消息页里的系统会话点进来），拉取即已读 */
@Composable
fun NoticesScreen(kind: String, onBack: () -> Unit, onOpenMoment: (String) -> Unit, onOpenTask: (String) -> Unit) {
    var list by remember { mutableStateOf<List<NotificationItem>?>(null) }
    LaunchedEffect(kind) {
        list = runCatching { Api.getList<NotificationItem>("/notifications?kind=$kind") }.getOrDefault(emptyList())
        NoticeRefresh.tick.value++
    }
    Column(Modifier.fillMaxSize()) {
        NavBar(noticeTitle(kind), onBack)
        val items = list
        when {
            items == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { Text("加载中…", color = TextDim, fontSize = 13.sp) }
            items.isEmpty() -> EmptyHint(if (kind == "task") "暂无接单消息" else "暂无评论消息")
            else -> LazyColumn {
                items(items, key = { it.id }) { n ->
                    Column(modifier = Modifier.fillMaxWidth().clickable { if (kind == "task") onOpenTask(n.refId) else onOpenMoment(n.refId) }.padding(16.dp, 12.dp)) {
                        Row { Text(n.title, color = TextMain, fontSize = 15.sp, fontWeight = if (n.isRead) FontWeight.Normal else FontWeight.SemiBold, modifier = Modifier.weight(1f)); Text(timeAgo(n.createdAt), color = TextDim, fontSize = 11.sp) }
                        if (n.body.isNotEmpty()) Text(n.body, color = TextSub, fontSize = 13.sp, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
                    }
                    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
                }
            }
        }
    }
}

@Serializable
private data class GiftWallItem(val id: Int, val name: String, val icon: String, val price: String)

/** 聊天页：文字/图片/语音/位置/礼物 */
@SuppressLint("MissingPermission")
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ChatRoomScreen(convId: String, convType: Int, targetId: String, title: String, focusMsgId: String = "", myUserId: String, myAvatar: String, myNickname: String, onBack: () -> Unit, onCall: (Int) -> Unit, onGroupInfo: () -> Unit) {
    var messages by remember { mutableStateOf<List<MsgItem>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var bot by remember { mutableStateOf<BotPublic?>(null) }
    var showCmds by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    var showGift by remember { mutableStateOf(false) }
    var fullImage by remember { mutableStateOf<String?>(null) }
    var recording by remember { mutableStateOf(false) }
    var voiceMode by remember { mutableStateOf(false) }
    var showAttach by remember { mutableStateOf(false) }
    var showSticker by remember { mutableStateOf(false) }
    val inputFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var recFile by remember { mutableStateOf<File?>(null) }
    var recStart by remember { mutableLongStateOf(0L) }

    // ---------- 长按菜单相关状态 ----------
    var menuMsg by remember { mutableStateOf<MsgItem?>(null) }
    var replyTo by remember { mutableStateOf<MsgItem?>(null) }
    var pins by remember { mutableStateOf<List<PinItem>>(emptyList()) }
    var pinIdx by remember { mutableIntStateOf(0) }
    var selecting by remember { mutableStateOf<Set<String>?>(null) }
    var forwardIds by remember { mutableStateOf<List<String>?>(null) }
    var reportId by remember { mutableStateOf<String?>(null) }
    var deleteIds by remember { mutableStateOf<List<String>?>(null) }
    var myRole by remember { mutableStateOf("member") }
    val isGroupAdmin = convType == 2 && (myRole == "owner" || myRole == "admin")
    val canPin = convType == 1 || isGroupAdmin

    fun toast(msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()

    /** 发消息并乐观显示；正在回复的话只挂在这一条上 */
    fun sendMsg(type: String, content: String) {
        val r = replyTo
        replyTo = null
        val tempId = WsClient.send(convType, targetId, type, content, r?.id)
        val preview = r?.let { ReplyPreview(it.id, it.senderId, it.senderNickname, it.type, if (it.type == "text") it.content.take(100) else if (it.type == "image") it.content else "") }
        messages = messages + MsgItem(tempId, convId, myUserId, myNickname, myAvatar, null, type, content, java.time.Instant.now().toString(), replyTo = preview)
    }

    suspend fun loadPins() {
        pins = runCatching { Api.getList<PinItem>("/im/conversations/$convId/pins") }.getOrDefault(emptyList())
        pinIdx = 0
    }

    // 重新拉取消息列表（清空记录后本端及其他端同步用）
    suspend fun reloadMessages() {
        messages = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId") }.getOrDefault(emptyList())
    }

    // 从搜索结果进来：首屏定位到该消息并闪一下，之后照常滚到底
    var focusTarget by remember { mutableStateOf(focusMsgId) }
    var flashId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(convId) {
        val around = if (focusMsgId.isNotEmpty()) "&aroundId=$focusMsgId" else ""
        val list = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId$around") }.getOrDefault(emptyList())
        // 列表回来之前就发出 / 收到的消息不能被覆盖掉
        val ids = list.map { it.id }.toSet()
        messages = list + messages.filterNot { it.id in ids }
        loaded = true
        launch { loadPins() }
        if (convType == 2) launch {
            runCatching {
                val g = Api.request("/im/group/$targetId")?.jsonObject
                myRole = g?.get("members")?.jsonArray?.map { it.jsonObject }
                    ?.firstOrNull { it["id"]?.jsonPrimitive?.content == myUserId }?.get("role")?.jsonPrimitive?.content ?: "member"
            }
        }
        messages.lastOrNull()?.let { WsClient.markRead(convId, it.id) }
        WsClient.connect()
        // 空会话或对方发过机器人消息：查一下对方是不是机器人（简介卡片 / 开始按钮 / 命令菜单）
        if (convType == 1 && (messages.isEmpty() || messages.any { it.senderIsBot && it.senderId == targetId })) bot = BotInfoCache.get(targetId)
    }
    DisposableEffect(convId) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                "msg" -> {
                    val data = frame["data"]?.jsonObject ?: return@addListener
                    val m = WsClient.json.decodeFromJsonElement(MessagePayload.serializer(), data)
                    if (m.conversationId == convId) {
                        messages = messages + MsgItem(
                            m.id, m.conversationId, m.senderId, m.senderNickname, m.senderAvatar, m.receiverId, m.type, m.content, m.createdAt, m.senderIsBot, m.markup,
                            replyTo = m.replyTo, fwdFrom = m.fwdFrom, reactions = m.reactions,
                        )
                        WsClient.markRead(convId, m.id)
                        if (m.senderIsBot && convType == 1 && bot == null) scope.launch { bot = BotInfoCache.get(m.senderId) }
                    }
                }
                "msg_edit" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val content = d["content"]?.jsonPrimitive?.content
                    val mk = d["markup"]?.let { el -> runCatching { WsClient.json.decodeFromJsonElement(InlineMarkup.serializer(), el) }.getOrNull() }
                    messages = messages.map { if (it.id == id) it.copy(content = content ?: it.content, markup = mk) else it }
                }
                "msg_delete" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    messages = messages.filterNot { it.id == id }
                    pins = pins.filterNot { it.id == id }
                }
                "ack" -> {
                    val tid = frame["tempId"]?.jsonPrimitive?.content ?: return@addListener
                    val mid = frame["msgId"]?.jsonPrimitive?.content ?: return@addListener
                    val at = frame["createdAt"]?.jsonPrimitive?.content
                    messages = messages.map { if (it.id == tid) it.copy(id = mid, createdAt = at ?: it.createdAt) else it }
                }
                "read" -> {
                    if (frame["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val upTo = frame["msgId"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@addListener
                    messages = messages.map { m -> if (m.senderId == myUserId && (m.id.toLongOrNull() ?: Long.MAX_VALUE) <= upTo) m.copy(isRead = true) else m }
                }
                "msg_reactions" -> {
                    val d = frame["data"]?.jsonObject ?: return@addListener
                    if (d["conversationId"]?.jsonPrimitive?.content != convId) return@addListener
                    val id = d["msgId"]?.jsonPrimitive?.content
                    val rs = runCatching { WsClient.json.decodeFromJsonElement(ListSerializer(MsgReaction.serializer()), d["reactions"]!!) }.getOrDefault(emptyList())
                    messages = messages.map { if (it.id == id) it.copy(reactions = rs) else it }
                }
                "msg_pin" -> {
                    if (frame["data"]?.jsonObject?.get("conversationId")?.jsonPrimitive?.content == convId) scope.launch { loadPins() }
                }
                "error" -> {
                    // 发送被后端拒绝（如积分不足）：提示并撤回乐观显示的消息
                    val msg = frame["msg"]?.jsonPrimitive?.content ?: "发送失败"
                    android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()
                    val tid = frame["tempId"]?.jsonPrimitive?.content
                    (if (tid != null) messages.firstOrNull { it.id == tid } else messages.lastOrNull { it.pending })?.let { last -> messages = messages - last }
                }
                "conv_cleared" -> {
                    // 有人清空了记录（单聊=全部，群聊=其发送的消息）：重新拉取同步
                    val cid = frame["data"]?.jsonObject?.get("conversationId")?.jsonPrimitive?.content
                    if (cid == convId) scope.launch { reloadMessages() }
                }
            }
        }
        onDispose { remove() }
    }
    LaunchedEffect(messages.size) {
        if (messages.isEmpty()) return@LaunchedEffect
        if (focusTarget.isNotEmpty()) {
            val target = focusTarget
            focusTarget = ""
            val idx = messages.indexOfFirst { it.id == target }
            if (idx >= 0) {
                // 目标消息上方留两条上下文
                listState.scrollToItem((idx - 2).coerceAtLeast(0))
                flashId = target
                return@LaunchedEffect
            }
        }
        // 首次进入直接定位到底部，之后新消息平滑滚动
        listState.scrollToItem(messages.size - 1)
    }
    LaunchedEffect(flashId) {
        if (flashId != null) { kotlinx.coroutines.delay(1600); flashId = null }
    }
    // 键盘高度变化时把列表滚到底，内容随键盘上移、最后一条贴着输入框
    val imeBottom = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current)
    LaunchedEffect(imeBottom) {
        if (messages.isNotEmpty()) runCatching { listState.scrollToItem(messages.size - 1) }
    }

    // ---------- 长按菜单的操作 ----------

    /** 跳到某条消息（引用 / 置顶）：不在当前列表就按 aroundId 重新拉一段 */
    fun jumpTo(id: String) = scope.launch {
        val idx = messages.indexOfFirst { it.id == id }
        if (idx >= 0) {
            listState.scrollToItem((idx - 2).coerceAtLeast(0))
            flashId = id
            return@launch
        }
        val list = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId&aroundId=$id") }.getOrDefault(emptyList())
        if (list.none { it.id == id }) { toast("原消息已不存在"); return@launch }
        // 交给 LaunchedEffect(messages.size) 定位（列表条数没变时它不会触发，就地滚）
        focusTarget = id
        val sameSize = list.size == messages.size
        messages = list
        if (sameSize) {
            kotlinx.coroutines.delay(50)
            focusTarget = ""
            listState.scrollToItem((list.indexOfFirst { it.id == id } - 2).coerceAtLeast(0))
            flashId = id
        }
    }

    fun react(id: String, emoji: String) = scope.launch {
        runCatching {
            val r = Api.request("/im/messages/$id/react", "POST", buildJsonObject { put("emoji", JsonPrimitive(emoji)) })
            val rs = WsClient.json.decodeFromJsonElement(ListSerializer(MsgReaction.serializer()), r!!.jsonObject["reactions"]!!)
            messages = messages.map { if (it.id == id) it.copy(reactions = rs) else it }
        }.onFailure { toast(it.message ?: "操作失败") }
    }

    fun togglePin(id: String, pin: Boolean) = scope.launch {
        runCatching { Api.request("/im/messages/$id/pin", "POST", buildJsonObject { put("pin", JsonPrimitive(pin)) }) }
            .onSuccess { loadPins(); toast(if (pin) "已置顶" else "已取消置顶") }
            .onFailure { toast(it.message ?: "操作失败") }
    }

    fun doDelete(ids: List<String>, forAll: Boolean) = scope.launch {
        runCatching {
            Api.request("/im/messages/delete", "POST", buildJsonObject {
                put("conversationId", JsonPrimitive(convId)); put("ids", jsonIds(ids)); put("forAll", JsonPrimitive(forAll))
            })
        }.onSuccess { messages = messages.filterNot { it.id in ids }; selecting = null }
            .onFailure { toast(it.message ?: "删除失败") }
    }

    /** 能否「为双方删除」：自己的或群管理员，礼物不行 */
    fun canDeleteForAll(m: MsgItem) = m.type != "gift" && (m.senderId == myUserId || isGroupAdmin)

    fun menuActions(m: MsgItem) = MenuActions(
        onReact = { react(m.id, it) },
        onReply = { replyTo = m; showSticker = false; voiceMode = false; runCatching { inputFocus.requestFocus() } },
        onCopy = if (m.type == "text") ({ copyToClipboard(ctx, m.content) }) else null,
        onSave = if (m.type == "image" || m.type == "video") ({ scope.launch { saveMediaToGallery(ctx, m.content, m.type) } }) else null,
        onPin = if (canPin) ({ togglePin(m.id, pins.none { it.id == m.id }) }) else null,
        onForward = if (m.type in FORWARDABLE) ({ forwardIds = listOf(m.id) }) else null,
        onReport = if (m.senderId != myUserId) ({ reportId = m.id }) else null,
        onDelete = { deleteIds = listOf(m.id) },
        onSelect = { selecting = setOf(m.id) },
    )

    val audioPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) sendLocation(ctx) { name, lat, lng ->
            sendMsg("location", buildJsonObject { put("name", JsonPrimitive(name)); put("lat", JsonPrimitive(lat)); put("lng", JsonPrimitive(lng)) }.toString())
        }
    }
    // 「+」弹框选的图 / 拍的照：按顺序逐张上传发送，说明文字最后单独发一条
    fun sendImages(uris: List<Uri>, caption: String) = scope.launch {
        var failed = 0
        for (uri in uris) {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                val url = Api.upload("image", b, "img.jpg", "image/jpeg")
                sendMsg("image", url)
            }.onFailure { failed++ }
        }
        val text = caption.trim()
        if (text.isNotEmpty()) sendMsg("text", text)
        if (failed > 0) android.widget.Toast.makeText(ctx, "$failed 张图片发送失败", android.widget.Toast.LENGTH_SHORT).show()
    }

    fun startRec() {
        runCatching {
            val f = File(ctx.cacheDir, "rec_${System.currentTimeMillis()}.m4a")
            val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setOutputFile(f.absolutePath)
            r.prepare(); r.start()
            recorder = r; recFile = f; recStart = System.currentTimeMillis(); recording = true
        }
    }
    fun stopRec() {
        recording = false
        runCatching { recorder?.stop(); recorder?.release() }
        recorder = null
        val f = recFile ?: return
        val dur = ((System.currentTimeMillis() - recStart) / 1000).toInt().coerceAtLeast(1)
        scope.launch {
            runCatching {
                val url = Api.upload("audio", f.readBytes(), "a.m4a", "audio/m4a")
                val c = buildJsonObject { put("url", JsonPrimitive(url)); put("duration", JsonPrimitive(dur)) }.toString()
                sendMsg("audio", c)
            }
        }
    }

    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current

    var showClearConfirm by remember { mutableStateOf(false) }
    var showVoiceRoom by remember { mutableStateOf(false) }
    val vrJoinedGid by com.wh.peiwana.rtc.VoiceRoomManager.joinedGroupId.collectAsState()
    val vrMembers by com.wh.peiwana.rtc.VoiceRoomManager.members.collectAsState()
    val vrPreview by com.wh.peiwana.rtc.VoiceRoomManager.roomPreview.collectAsState()
    val vrCount = if (vrJoinedGid == targetId) vrMembers.size else vrPreview[targetId]?.size ?: 0
    LaunchedEffect(targetId) {
        if (convType == 2) com.wh.peiwana.rtc.VoiceRoomManager.refreshInfo(targetId)
    }

    Column(Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { BackIcon(TextMain, 24.dp) }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (bot != null) BotTag()
            }
            Text("清空", color = TextSub, fontSize = 13.sp, modifier = Modifier.noRippleClick { showClearConfirm = true })
            if (convType == 2) {
                Spacer(Modifier.width(14.dp))
                Text(
                    if (vrCount > 0) "语音房·$vrCount" else "语音房",
                    color = if (vrJoinedGid == targetId) Accent else TextMain, fontSize = 13.sp,
                    modifier = Modifier.noRippleClick { showVoiceRoom = true },
                )
                Spacer(Modifier.width(14.dp))
                Text("群信息", color = Accent, fontSize = 13.sp, modifier = Modifier.noRippleClick(onGroupInfo))
            }
        }

        if (pins.isNotEmpty()) {
            PinBar(
                pins, pinIdx, canPin,
                onJump = { jumpTo(pins[pinIdx % pins.size].id); pinIdx = (pinIdx + 1) % pins.size },
                onUnpin = { togglePin(pins[pinIdx % pins.size].id, false) },
            )
        }

        if (showVoiceRoom) {
            VoiceRoomDialog(groupId = targetId, groupName = title) { showVoiceRoom = false }
        }

        if (showClearConfirm) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { showClearConfirm = false },
                containerColor = Bg2,
                title = { Text("清空聊天记录", color = TextMain) },
                text = {
                    Text(
                        if (convType == 1) "清空后双方的聊天记录都将删除，不可恢复" else "将删除我在本群发送的全部消息，所有成员都将不再看到",
                        color = TextSub,
                    )
                },
                confirmButton = {
                    Text("清空", color = Danger, modifier = Modifier.noRippleClick {
                        showClearConfirm = false
                        scope.launch {
                            runCatching { Api.request("/im/conversations/$convId/clear", "POST") }
                                .onSuccess { reloadMessages() }
                        }
                    }.padding(8.dp))
                },
                dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick { showClearConfirm = false }.padding(8.dp)) },
            )
        }
        val botFresh = bot != null && loaded && messages.isEmpty()
        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 12.dp).noRippleClick { showSticker = false; showCmds = false; focus.clearFocus(); keyboard?.hide() }) {
            if (botFresh) item(key = "bot_intro") {
                val b = bot!!
                Column(
                    Modifier.fillMaxWidth().padding(top = 40.dp, start = 24.dp, end = 24.dp).clip(RoundedCornerShape(14.dp)).background(Bg2).padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Avatar(b.avatar, 64)
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(b.name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold); BotTag()
                    }
                    Text("@${b.username}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                    if (b.description.isNotBlank()) Text(
                        b.description, color = TextMain, fontSize = 14.sp, lineHeight = 20.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
            itemsIndexed(messages, key = { _, m -> m.id }) { idx, m ->
                // 微信式时间分隔条：与上一条间隔超 5 分钟显示
                if (shouldShowTime(messages, idx)) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(fmtChatTime(m.createdAt), color = TextDim, fontSize = 11.sp)
                    }
                }
                val flashBg by androidx.compose.animation.animateColorAsState(
                    if (flashId == m.id) Accent.copy(alpha = 0.14f) else Color.Transparent,
                    androidx.compose.animation.core.tween(if (flashId == m.id) 150 else 900), label = "flash",
                )
                val sel = selecting
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(flashBg)) {
                    if (sel != null) {
                        Row(
                            Modifier.fillMaxWidth().noRippleClick { if (!m.pending) selecting = if (m.id in sel) sel - m.id else sel + m.id },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SelectCircle(m.id in sel)
                            Spacer(Modifier.width(10.dp))
                            Box(Modifier.weight(1f)) {
                                Bubble(m, m.senderId == myUserId, convType, myUserId, onImage = {}, onMenu = {}, onReact = {}, onJump = {})
                                // 多选时盖一层，点哪都是勾选
                                Box(Modifier.matchParentSize().noRippleClick { if (!m.pending) selecting = if (m.id in sel) sel - m.id else sel + m.id })
                            }
                        }
                    } else {
                        Bubble(
                            m, m.senderId == myUserId, convType, myUserId,
                            onImage = { fullImage = it },
                            onMenu = { if (!m.pending) { focus.clearFocus(); keyboard?.hide(); menuMsg = m } },
                            onReact = { react(m.id, it) },
                            onJump = { jumpTo(it) },
                        )
                    }
                }
            }
        }
        val sel = selecting
        if (sel != null) {
            val chosen = messages.filter { it.id in sel }
            Row(Modifier.fillMaxWidth().background(Bg2).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("取消", color = TextMain, fontSize = 15.sp, modifier = Modifier.noRippleClick { selecting = null })
                Text("已选 ${sel.size} 条", color = TextSub, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(start = 14.dp))
                val on = chosen.isNotEmpty()
                Text("拷贝", color = if (on) TextMain else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick {
                    val texts = chosen.filter { it.type == "text" }
                    if (texts.isEmpty()) toast("选中的消息里没有文字")
                    else { copyToClipboard(ctx, texts.joinToString("\n") { if (convType == 2) "${it.senderNickname}：${it.content}" else it.content }); selecting = null }
                })
                Spacer(Modifier.width(18.dp))
                Text("转发", color = if (on) TextMain else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick {
                    val ok = chosen.filter { it.type in FORWARDABLE }.map { it.id }
                    if (ok.isEmpty()) toast("礼物、通话记录不能转发")
                    else { if (ok.size < chosen.size) toast("礼物、通话记录不会被转发"); forwardIds = ok }
                })
                Spacer(Modifier.width(18.dp))
                Text("删除", color = if (on) Danger else TextDim, fontSize = 15.sp, modifier = Modifier.noRippleClick { if (on) deleteIds = chosen.map { it.id } })
            }
        } else
        // 和机器人的空会话：底部是「开始」按钮（发 /start），同 Telegram
        if (botFresh) {
            Box(
                Modifier.fillMaxWidth().background(Bg2).navigationBarsPadding().noRippleClick {
                    sendMsg("text", "/start")
                }.padding(vertical = 16.dp),
                contentAlignment = Alignment.Center,
            ) { Text("开始", color = Accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
        } else
        // 微信式底部区（随键盘上移）：左语音切换 / 输入框 / +面板 / 发送
        Column(modifier = Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
            replyTo?.let { r -> ReplyBar(r.senderNickname, msgSnippet(r.type, r.content)) { replyTo = null } }
            val cmds = bot?.commands.orEmpty()
            val cmdQuery = if (input.startsWith("/")) input.drop(1).substringBefore(' ') else null
            val shownCmds = when {
                showCmds -> cmds
                cmdQuery != null && !input.contains(' ') -> cmds.filter { it.command.startsWith(cmdQuery, ignoreCase = true) }
                else -> emptyList()
            }
            if (shownCmds.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()).background(Bg2)) {
                    shownCmds.forEach { c ->
                        Row(
                            Modifier.fillMaxWidth().noRippleClick {
                                showCmds = false; input = ""
                                sendMsg("text", "/${c.command}")
                            }.padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("/${c.command}", color = BotBlue, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            Spacer(Modifier.width(12.dp))
                            Text(c.description, color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Row(modifier = Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                if (cmds.isNotEmpty()) {
                    Box(
                        modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(if (showCmds) BubbleMine else Bg3).noRippleClick { showSticker = false; showCmds = !showCmds },
                        contentAlignment = Alignment.Center,
                    ) { Text("/", color = if (showCmds) BotBlue else TextSub, fontSize = 18.sp, fontWeight = FontWeight.Bold) }
                    Spacer(Modifier.width(8.dp))
                }
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { voiceMode = !voiceMode; showSticker = false; focus.clearFocus(); keyboard?.hide() },
                    contentAlignment = Alignment.Center,
                ) { if (voiceMode) KeyboardIcon(TextSub, 20.dp) else WaveformIcon(TextSub, 18.dp) } // 与 iOS 一致：waveform / keyboard
                Spacer(Modifier.width(8.dp))

                if (voiceMode) {
                    Box(
                        modifier = Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(20.dp)).background(if (recording) Accent else Bg3)
                            .pointerInputRecord(onStart = { audioPerm.launch(Manifest.permission.RECORD_AUDIO); startRec() }, onStop = { stopRec() }),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (recording) {
                            val trans = rememberInfiniteTransition(label = "rec")
                            val a by trans.animateFloat(0.35f, 1f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "a")
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                WaveformIcon(Color.White.copy(alpha = a), 16.dp); Spacer(Modifier.width(8.dp)); Text("松开发送", color = Color.White, fontSize = 14.sp)
                            }
                        } else Text("按住 说话", color = TextMain, fontSize = 14.sp)
                    }
                } else {
                    Box(
                        modifier = Modifier.weight(1f).heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).padding(horizontal = 14.dp, vertical = 9.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        if (input.isEmpty()) Text("发消息", color = TextDim, fontSize = 15.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = input, onValueChange = { input = it },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 15.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            maxLines = 4,
                            modifier = Modifier.fillMaxWidth().focusRequester(inputFocus).onFocusChanged { if (it.isFocused) showSticker = false },
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                // 表情按钮：面板顶替键盘（Telegram 式，点贴纸即发送）
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(if (showSticker) BubbleMine else Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); voiceMode = false; showSticker = !showSticker },
                    contentAlignment = Alignment.Center,
                ) { SmileIcon(if (showSticker) Accent else TextSub, 22.dp) }
                Spacer(Modifier.width(8.dp))
                Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); showSticker = false; showAttach = true }, contentAlignment = Alignment.Center) { PlusIcon(TextSub, 22.dp) }
                if (input.isNotBlank() && !voiceMode) {
                    Spacer(Modifier.width(8.dp))
                    Box(modifier = Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Accent).noRippleClick {
                        sendMsg("text", input.trim()); input = ""
                    }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) { Text("发送", color = Color.White, fontSize = 14.sp) }
                }
            }

            if (showSticker) {
                // 贴纸 / GIF 点即发送（消息类型都是 sticker，GIF 的 format=mp4）；「最近使用」由面板自己记
                EmojiPanel(
                    onPick = { p ->
                        val content = StickerStore.encode(p)
                        sendMsg("sticker", content)
                    },
                    onEmoji = { input += it },
                    onDelete = { input = dropLastGrapheme(input) },
                    onKeyboard = { showSticker = false; inputFocus.requestFocus(); keyboard?.show() },
                )
            }
        }
    }

    if (showAttach) {
        AttachSheet(
            isSingle = convType == 1 && bot == null,
            // 视频通话仅男方可发起（女方只能接听）
            canVideoCall = com.wh.peiwana.net.Session.gender == 1,
            onDismiss = { showAttach = false },
            onSend = { uris, caption -> sendImages(uris, caption) },
            onAction = { a ->
                when (a) {
                    AttachAction.Gift -> { showGift = true }
                    AttachAction.Location -> locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                    AttachAction.VoiceCall -> onCall(1)
                    AttachAction.VideoCall -> onCall(2)
                }
            },
        )
    }
    if (showGift) GiftSheet(targetId) { showGift = false }
    menuMsg?.let { m ->
        MsgMenuDialog(
            msgId = m.id, mine = m.senderId == myUserId, convType = convType,
            myReaction = m.reactions.firstOrNull { myUserId in it.userIds }?.emoji,
            pinned = pins.any { it.id == m.id },
            actions = menuActions(m),
        ) { menuMsg = null }
    }
    deleteIds?.let { ids ->
        DeleteMsgDialog(
            count = ids.size,
            canForAll = messages.filter { it.id in ids }.all { canDeleteForAll(it) },
            convType = convType, peerName = title,
            onConfirm = { forAll -> deleteIds = null; doDelete(ids, forAll) },
        ) { deleteIds = null }
    }
    forwardIds?.let { ids ->
        ForwardDialog(convId, ids, onDone = { tip, convIds ->
            forwardIds = null; selecting = null; toast(tip)
            if (convId in convIds) scope.launch { reloadMessages() }
        }) { forwardIds = null }
    }
    reportId?.let { id ->
        ReportMsgDialog(id, onDone = { tip -> reportId = null; toast(tip) }) { reportId = null }
    }
    fullImage?.let { u ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { fullImage = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            val imgs = messages.filter { it.type == "image" }.map { it.content }
            ImageViewer(imgs.ifEmpty { listOf(u) }, imgs.indexOf(u).coerceAtLeast(0)) { fullImage = null }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Bubble(
    m: MsgItem, mine: Boolean, convType: Int, myId: String,
    onImage: (String) -> Unit, onMenu: () -> Unit, onReact: (String) -> Unit, onJump: (String) -> Unit,
) {
    val menu by rememberUpdatedState(onMenu)
    // 微信式：对方左侧灰气泡，自己右侧主题气泡，头像顶部对齐、贴边尾角
    val bubbleShape = if (mine) RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp) else RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp)
    val bg = if (mine) BubbleMine else Bg3
    // 浅色主题：自己的气泡是浅玫红底，文字同样用深色
    val fg = TextMain

    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
        if (!mine) { Avatar(m.senderAvatar, 38); Spacer(Modifier.width(8.dp)) }
        // 点 / 长按气泡弹消息菜单；图片、语音、链接、按钮各自的点击优先
        Column(
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 240.dp).pointerInput(Unit) { detectTapGestures(onTap = { menu() }, onLongPress = { menu() }) },
        ) {
            if (!mine) Row(Modifier.padding(bottom = 2.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(m.senderNickname, color = TextSub, fontSize = 11.sp)
                if (m.senderIsBot && convType == 2) BotTag()
            }
            if (m.fwdFrom != null) Text("转发自 ${m.fwdFrom}", color = BotBlue, fontSize = 11.sp, modifier = Modifier.padding(bottom = 2.dp, start = 4.dp, end = 4.dp))
            m.replyTo?.let { r -> ReplyQuote(r) { onJump(r.id) } }
            when (m.type) {
                "image" -> AsyncImage(
                    model = Api.fullUrl(m.content), contentDescription = null, contentScale = ContentScale.FillWidth,
                    modifier = Modifier.widthIn(max = 160.dp).clip(RoundedCornerShape(10.dp))
                        .combinedClickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null, onLongClick = { menu() }) { onImage(m.content) },
                )
                "sticker" -> {
                    // 贴纸不画气泡底
                    val p = remember(m.content) { StickerStore.parse(m.content) }
                    // GIF 比贴纸大一号、带圆角
                    if (p != null) StickerImage(p, if (p.isGif) 220.dp else 140.dp)
                    else Box(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp)) { Text("[表情]", color = fg, fontSize = 15.sp) }
                }
                "audio" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val url = obj?.get("url")?.jsonPrimitive?.content ?: m.content
                    val dur = (obj?.get("duration")?.jsonPrimitive?.content ?: "1").toIntOrNull() ?: 1
                    var voicePlaying by remember { mutableStateOf(false) }
                    Row(
                        modifier = Modifier.widthIn(min = 70.dp, max = (70 + dur * 8).coerceAtMost(220).dp).clip(bubbleShape).background(bg).combinedClickable(onLongClick = { menu() }) {
                            runCatching {
                                android.media.MediaPlayer().apply {
                                    setDataSource(Api.fullUrl(url))
                                    setOnCompletionListener { voicePlaying = false; it.release() }
                                    setOnErrorListener { mp, _, _ -> voicePlaying = false; mp.release(); true }
                                    prepare(); start()
                                    voicePlaying = true
                                }
                            }
                        }.padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (voicePlaying) PlayingVoiceBars(fg) else WaveformIcon(fg, 15.dp)
                        Spacer(Modifier.width(8.dp)); Text("${dur}\"", color = fg, fontSize = 14.sp)
                    }
                }
                "location" -> {
                    val name = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject["name"]?.jsonPrimitive?.content }.getOrNull() ?: "位置"
                    Row(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        PinIcon(fg, 16.dp); Spacer(Modifier.width(8.dp)); Text(name, color = fg, fontSize = 14.sp)
                    }
                }
                "gift" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val giftName = obj?.get("name")?.jsonPrimitive?.content ?: "礼物"
                    val giftIcon = obj?.get("icon")?.jsonPrimitive?.content ?: ""
                    val giftPrice = obj?.get("price")?.jsonPrimitive?.content ?: "0"
                    Row(
                        modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AsyncImage(
                            model = Api.fullUrl(giftIcon),
                            contentDescription = null,
                            modifier = Modifier.size(42.dp).clip(RoundedCornerShape(8.dp)),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text("${if (mine) "送出" else "收到"}「$giftName」", color = fg, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            Spacer(Modifier.height(3.dp))
                            Text("${fmtPoints(giftPrice)} 积分", color = Warn, fontSize = 12.sp)
                        }
                    }
                }
                "call" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val callType = obj?.get("callType")?.jsonPrimitive?.content?.toIntOrNull() ?: 1
                    val result = obj?.get("result")?.jsonPrimitive?.content ?: "end"
                    val dur = obj?.get("duration")?.jsonPrimitive?.content?.toIntOrNull() ?: 0
                    val label = if (callType == 2) "视频通话" else "语音通话"
                    val text = when (result) {
                        "end" -> "$label %02d:%02d".format(dur / 60, dur % 60)
                        "reject" -> "$label 已拒绝"
                        else -> "$label 已取消"
                    }
                    Row(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (callType == 2) VideoIcon(fg, 16.dp) else MicIcon(fg, 16.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(text, color = fg, fontSize = 14.sp)
                    }
                }
                else -> Box(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp)) { LinkText(m.content, color = fg, fontSize = 15.sp, lineHeight = 21.sp) }
            }
            InlineKeyboard(m.markup, m.id, Modifier.width(230.dp))
            ReactionChips(m.reactions, myId, onReact)
        }
        if (mine) { Spacer(Modifier.width(8.dp)); Avatar(m.senderAvatar, 38) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GiftSheet(toUserId: String, onClose: () -> Unit) {
    var gifts by remember { mutableStateOf<List<GiftWallItem>>(emptyList()) }
    var balance by remember { mutableStateOf("0") }
    var selected by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        gifts = runCatching { Api.getList<GiftWallItem>("/gifts") }.getOrDefault(emptyList())
        balance = runCatching { Api.getObj<WalletData>("/wallet").balance }.getOrDefault("0")
    }
    var toast by remember { mutableStateOf("") }
    var toastOk by remember { mutableStateOf(false) }
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onClose, containerColor = Bg2) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.size(28.dp))
                Text("送礼物", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.weight(1f))
                Box(modifier = Modifier.size(28.dp).clip(RoundedCornerShape(14.dp)).background(Bg3).noRippleClick(onClose), contentAlignment = Alignment.Center) { Text("×", color = TextSub, fontSize = 18.sp) }
            }
            LazyVerticalGrid(columns = GridCells.Fixed(4), modifier = Modifier.height(220.dp).padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(gifts, key = { it.id }) { g ->
                    Column(modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (selected == g.id) Accent.copy(alpha = 0.15f) else Color.Transparent).clickable { selected = g.id }.padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        AsyncImage(model = Api.fullUrl(g.icon), contentDescription = null, modifier = Modifier.size(42.dp))
                        Text(g.name, color = TextMain, fontSize = 12.sp)
                        Text("${fmtPoints(g.price)}", color = Warn, fontSize = 11.sp)
                    }
                }
            }
            if (toast.isNotEmpty()) Text(toast, color = if (toastOk) Warn else Danger, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("余额 ${fmtPoints(balance)} 积分", color = TextSub, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable {
                    val gid = selected ?: run { toastOk = false; toast = "请先选择礼物"; return@clickable }
                    scope.launch {
                        runCatching { Api.request("/gifts/send", "POST", buildJsonObject { put("toUserId", JsonPrimitive(toUserId)); put("giftId", JsonPrimitive(gid)) }) }
                            .onSuccess {
                                // 送出后不关面板，刷新余额，可连续赠送
                                toastOk = true; toast = "已送出"
                                balance = runCatching { Api.getObj<WalletData>("/wallet").balance }.getOrDefault(balance)
                                kotlinx.coroutines.delay(1500)
                                if (toastOk) toast = ""
                            }
                            .onFailure { toastOk = false; toast = it.message ?: "赠送失败" }
                    }
                }.padding(horizontal = 16.dp, vertical = 8.dp)) { Text("赠送", color = Color.White, fontSize = 13.sp) }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

/** 语音播放中的声条动画：三根声条循环跳动 */
@Composable
private fun PlayingVoiceBars(color: Color) {
    val transition = rememberInfiniteTransition(label = "voiceBars")
    val p by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(350), RepeatMode.Reverse),
        label = "voiceBarsP",
    )
    val bars = listOf(6f to 15f, 11f to 6f, 15f to 10f)
    Row(
        modifier = Modifier.size(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        bars.forEach { (a, b) ->
            Box(
                Modifier
                    .width(3.dp)
                    .height((a + (b - a) * p).dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(color),
            )
        }
    }
}

/** 简单的按住录音手势 */
private fun Modifier.pointerInputRecord(onStart: () -> Unit, onStop: () -> Unit): Modifier =
    this.pointerInput(Unit) {
        detectTapGestures(onPress = {
            onStart()
            tryAwaitRelease()
            onStop()
        })
    }

@SuppressLint("MissingPermission")
internal fun sendLocation(ctx: Context, cb: (String, Double, Double) -> Unit) {
    runCatching {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER) ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        if (loc != null) cb("我的位置", loc.latitude, loc.longitude) else cb("位置获取失败", 0.0, 0.0)
    }.onFailure { cb("位置获取失败", 0.0, 0.0) }
}
