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
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

@Serializable
data class PeerBrief(val id: String, val nickname: String, val avatar: String = "", val gender: Int = 0)

@Serializable
data class GroupBrief(val id: String, val name: String, val avatar: String = "")

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
)

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

private fun preview(msg: LastMsg?): String = when {
    msg == null -> ""
    msg.type == "text" -> msg.content.take(30)
    msg.type == "image" -> "[图片]"
    msg.type == "video" -> "[视频]"
    msg.type == "audio" -> "[语音]"
    msg.type == "location" -> "[位置]"
    msg.type == "gift" -> "[礼物]"
    msg.type.startsWith("call") -> "[通话]"
    else -> ""
}

/** 消息主页：四分类 私聊/群聊/评论/接单 */
@Composable
fun MessagesScreen(modifier: Modifier = Modifier, onOpenChat: (convId: String, convType: Int, targetId: String, title: String) -> Unit, onOpenMoment: (String) -> Unit, onOpenTask: (String) -> Unit, onCreateGroup: () -> Unit, onOpenAi: () -> Unit, onOpenNews: () -> Unit = {}, onJoinGroup: () -> Unit = {}) {
    var tab by remember { mutableStateOf("single") }
    var convs by remember { mutableStateOf<List<ConversationItem>>(emptyList()) }
    var notices by remember { mutableStateOf<List<NotificationItem>>(emptyList()) }
    var unread by remember { mutableStateOf(UnreadCounts()) }
    val scope = rememberCoroutineScope()

    fun loadConvs() { scope.launch { convs = runCatching { Api.getList<ConversationItem>("/im/conversations") }.getOrDefault(emptyList()) } }
    fun loadUnread() { scope.launch { unread = runCatching { Api.getObj<UnreadCounts>("/notifications/unread") }.getOrDefault(UnreadCounts()) } }
    fun loadNotices(kind: String) { scope.launch { notices = runCatching { Api.getList<NotificationItem>("/notifications?kind=$kind") }.getOrDefault(emptyList()); loadUnread() } }

    LaunchedEffect(Unit) { loadConvs(); loadUnread() }
    LaunchedEffect(tab) { if (tab == "comment" || tab == "task") loadNotices(tab) }
    DisposableEffect(Unit) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                "msg", "conv_cleared" -> loadConvs()
                "notify" -> loadUnread()
            }
        }
        onDispose { remove() }
    }

    val singleUnread = convs.filter { it.type == 1 }.sumOf { it.unread }
    val groupUnread = convs.filter { it.type == 2 }.sumOf { it.unread }
    val tabs = listOf(
        Triple("single", "私聊", singleUnread), Triple("group", "群聊", groupUnread),
        Triple("comment", "评论", unread.comment), Triple("task", "接单", unread.task),
    )

    Column(modifier = modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 14.dp, 16.dp, 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tabs.forEach { (k, label, badge) -> PillTab(label, tab == k, badge) { tab = k } }
            Spacer(Modifier.weight(1f))
            Box {
                var showPlusMenu by remember { mutableStateOf(false) }
                Box(modifier = Modifier.size(34.dp).clip(RoundedCornerShape(17.dp)).background(Bg3).clickable { showPlusMenu = true }, contentAlignment = Alignment.Center) { Text("+", color = TextMain, fontSize = 18.sp) }
                androidx.compose.material3.DropdownMenu(expanded = showPlusMenu, onDismissRequest = { showPlusMenu = false }) {
                    androidx.compose.material3.DropdownMenuItem(text = { Text("创建群聊", fontSize = 14.sp) }, onClick = { showPlusMenu = false; onCreateGroup() })
                    androidx.compose.material3.DropdownMenuItem(text = { Text("加入群聊", fontSize = 14.sp) }, onClick = { showPlusMenu = false; onJoinGroup() })
                }
            }
        }

        if (tab == "single" || tab == "group") {
            // AI 助手置顶入口（免费问答）
            if (tab == "single") {
                Column(Modifier.fillMaxWidth().clickable(onClick = onOpenAi)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(48.dp).clip(RoundedCornerShape(24.dp))
                                .background(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Accent, Accent2))),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("AI", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold)
                        }
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text("AI 助手", color = TextMain, fontSize = 15.sp)
                            Text("有问必答，随便问", color = TextSub, fontSize = 13.sp, maxLines = 1)
                        }
                        Text(
                            "免费", color = Accent, fontSize = 10.sp,
                            modifier = Modifier.clip(RoundedCornerShape(4.dp))
                                .background(Accent.copy(alpha = 0.12f))
                                .padding(horizontal = 5.dp, vertical = 2.dp),
                        )
                    }
                    Box(modifier = Modifier.fillMaxWidth().padding(start = 76.dp).height(1.dp).background(Line))
                }
                // 花边新闻置顶入口（每小时更新）
                Column(Modifier.fillMaxWidth().clickable(onClick = onOpenNews)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(48.dp).clip(RoundedCornerShape(24.dp))
                                .background(androidx.compose.ui.graphics.Brush.linearGradient(listOf(Color(0xFFFF9500), Accent))),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("📰", fontSize = 22.sp)
                        }
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text("花边新闻", color = TextMain, fontSize = 15.sp)
                            Text("逆袭·励志·情感，看看别人的故事", color = TextSub, fontSize = 13.sp, maxLines = 1)
                        }
                        Text(
                            "每小时更新", color = Accent, fontSize = 10.sp,
                            modifier = Modifier.clip(RoundedCornerShape(4.dp))
                                .background(Accent.copy(alpha = 0.12f))
                                .padding(horizontal = 5.dp, vertical = 2.dp),
                        )
                    }
                    Box(modifier = Modifier.fillMaxWidth().padding(start = 76.dp).height(1.dp).background(Line))
                }
            }
            val shown = convs.filter { if (tab == "single") it.type == 1 else it.type == 2 }
            if (shown.isEmpty()) EmptyHint(if (tab == "single") "暂无私聊\n去广场或大厅找人打招呼" else "暂无群聊\n点右上角发起群聊")
            else LazyColumn {
                items(shown, key = { it.id }) { c ->
                    val title = if (c.type == 1) c.peer?.nickname ?: "" else "${c.group?.name}（群）"
                    val avatar = if (c.type == 1) c.peer?.avatar else c.group?.avatar
                    val target = if (c.type == 1) c.peer?.id else c.group?.id
                    Column(modifier = Modifier.fillMaxWidth().clickable { target?.let { onOpenChat(c.id, c.type, it, title) } }) {
                        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(avatar, 48)
                            Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                                Text(title, color = TextMain, fontSize = 15.sp)
                                Text(preview(c.lastMsg), color = TextSub, fontSize = 13.sp, maxLines = 1)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(fmtChatTime(c.lastMsgAt), color = TextDim, fontSize = 11.sp)
                                com.wh.peiwana.ui.RoundBadge(c.unread, Modifier.padding(top = 4.dp))
                            }
                        }
                        // 微信式分隔线（与头像右侧对齐）
                        Box(modifier = Modifier.fillMaxWidth().padding(start = 76.dp).height(1.dp).background(Line))
                    }
                }
            }
        } else {
            if (notices.isEmpty()) EmptyHint(if (tab == "comment") "暂无评论消息" else "暂无接单消息")
            else LazyColumn {
                items(notices, key = { it.id }) { n ->
                    Column(modifier = Modifier.fillMaxWidth().clickable { if (tab == "comment") onOpenMoment(n.refId) else onOpenTask(n.refId) }.padding(16.dp, 12.dp)) {
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
fun ChatRoomScreen(convId: String, convType: Int, targetId: String, title: String, myUserId: String, myAvatar: String, myNickname: String, onBack: () -> Unit, onCall: (Int) -> Unit, onGroupInfo: () -> Unit) {
    var messages by remember { mutableStateOf<List<MsgItem>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var showGift by remember { mutableStateOf(false) }
    var fullImage by remember { mutableStateOf<String?>(null) }
    var recording by remember { mutableStateOf(false) }
    var voiceMode by remember { mutableStateOf(false) }
    var showPanel by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var recFile by remember { mutableStateOf<File?>(null) }
    var recStart by remember { mutableLongStateOf(0L) }

    fun appendLocal(type: String, content: String) {
        messages = messages + MsgItem("local_${System.currentTimeMillis()}", convId, myUserId, myNickname, myAvatar, null, type, content, java.time.Instant.now().toString())
    }

    // 重新拉取消息列表（清空记录后本端及其他端同步用）
    suspend fun reloadMessages() {
        messages = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId") }.getOrDefault(emptyList())
    }

    LaunchedEffect(convId) {
        messages = runCatching { Api.getList<MsgItem>("/im/messages?conversationId=$convId") }.getOrDefault(emptyList())
        messages.lastOrNull()?.let { WsClient.markRead(convId, it.id) }
        WsClient.connect()
    }
    DisposableEffect(convId) {
        val remove = WsClient.addListener { frame ->
            when (frame["op"]?.jsonPrimitive?.content) {
                "msg" -> {
                    val data = frame["data"]?.jsonObject ?: return@addListener
                    val m = WsClient.json.decodeFromJsonElement(MessagePayload.serializer(), data)
                    if (m.conversationId == convId) {
                        messages = messages + MsgItem(m.id, m.conversationId, m.senderId, m.senderNickname, m.senderAvatar, m.receiverId, m.type, m.content, m.createdAt)
                        WsClient.markRead(convId, m.id)
                    }
                }
                "error" -> {
                    // 发送被后端拒绝（如积分不足）：提示并撤回乐观显示的消息
                    val msg = frame["msg"]?.jsonPrimitive?.content ?: "发送失败"
                    android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()
                    messages.lastOrNull { it.id.startsWith("local_") }?.let { last -> messages = messages - last }
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
        if (messages.isNotEmpty()) {
            // 首次进入直接定位到底部，之后新消息平滑滚动
            listState.scrollToItem(messages.size - 1)
        }
    }
    // 键盘高度变化时把列表滚到底，内容随键盘上移、最后一条贴着输入框
    val imeBottom = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current)
    LaunchedEffect(imeBottom) {
        if (messages.isNotEmpty()) runCatching { listState.scrollToItem(messages.size - 1) }
    }

    val audioPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) sendLocation(ctx) { name, lat, lng ->
            WsClient.send(convType, targetId, "location", buildJsonObject { put("name", JsonPrimitive(name)); put("lat", JsonPrimitive(lat)); put("lng", JsonPrimitive(lng)) }.toString())
            appendLocal("location", "{\"name\":\"$name\"}")
        }
    }
    val pickImg = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                val url = Api.upload("image", b, "img.jpg", "image/jpeg")
                WsClient.send(convType, targetId, "image", url); appendLocal("image", url)
            }
        }
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
                WsClient.send(convType, targetId, "audio", c); appendLocal("audio", c)
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
            Text(title, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.weight(1f))
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
        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 12.dp).noRippleClick { showPanel = false; focus.clearFocus(); keyboard?.hide() }) {
            itemsIndexed(messages, key = { _, m -> m.id }) { idx, m ->
                // 微信式时间分隔条：与上一条间隔超 5 分钟显示
                if (shouldShowTime(messages, idx)) {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(fmtChatTime(m.createdAt), color = TextDim, fontSize = 11.sp)
                    }
                }
                Bubble(m, m.senderId == myUserId, convType, onImage = { fullImage = it })
            }
        }
        // 微信式底部区（随键盘上移）：左语音切换 / 输入框 / +面板 / 发送
        Column(modifier = Modifier.background(Bg2).imePadding().navigationBarsPadding()) {
            Row(modifier = Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { voiceMode = !voiceMode; showPanel = false; focus.clearFocus(); keyboard?.hide() },
                    contentAlignment = Alignment.Center,
                ) { VoiceIcon(TextSub, 20.dp) }
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
                                VoiceIcon(Color.White.copy(alpha = a), 18.dp); Spacer(Modifier.width(8.dp)); Text("松开发送", color = Color.White, fontSize = 14.sp)
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
                            modifier = Modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) showPanel = false },
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                Box(modifier = Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(Bg3).noRippleClick { focus.clearFocus(); keyboard?.hide(); voiceMode = false; showPanel = !showPanel }, contentAlignment = Alignment.Center) { PlusIcon(TextSub, 22.dp) }
                if (input.isNotBlank() && !voiceMode) {
                    Spacer(Modifier.width(8.dp))
                    Box(modifier = Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Accent).noRippleClick {
                        WsClient.send(convType, targetId, "text", input.trim()); appendLocal("text", input.trim()); input = ""
                    }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) { Text("发送", color = Color.White, fontSize = 14.sp) }
                }
            }

            // + 号功能面板（九宫格）
            if (showPanel) {
                val actions = buildList {
                    add(Triple<String, @Composable (Color) -> Unit, () -> Unit>("相册", { ImageIcon(it, 26.dp) }, { showPanel = false; pickImg.launch("image/*") }))
                    add(Triple<String, @Composable (Color) -> Unit, () -> Unit>("位置", { PinIcon(it, 24.dp) }, { showPanel = false; locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }))
                    if (convType == 1) {
                        add(Triple<String, @Composable (Color) -> Unit, () -> Unit>("语音通话", { MicIcon(it, 26.dp) }, { showPanel = false; onCall(1) }))
                        // 视频通话仅男方可发起（女方只能接听）
                        if (com.wh.peiwana.net.Session.gender == 1) {
                            add(Triple<String, @Composable (Color) -> Unit, () -> Unit>("视频通话", { VideoIcon(it, 26.dp) }, { showPanel = false; onCall(2) }))
                        }
                        add(Triple<String, @Composable (Color) -> Unit, () -> Unit>("礼物", { GiftIcon(it, 26.dp) }, { showPanel = false; showGift = true }))
                    }
                }
                Column(modifier = Modifier.fillMaxWidth().padding(12.dp, 12.dp, 12.dp, 20.dp)) {
                    actions.chunked(4).forEach { rowItems ->
                        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            rowItems.forEach { (label, icon, act) ->
                                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f).noRippleClick(act)) {
                                    Box(modifier = Modifier.size(56.dp).clip(RoundedCornerShape(14.dp)).background(Bg3), contentAlignment = Alignment.Center) { icon(TextMain) }
                                    Text(label, color = TextSub, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
                                }
                            }
                            repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
    }

    if (showGift) GiftSheet(targetId) { showGift = false }
    fullImage?.let { u ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { fullImage = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            val imgs = messages.filter { it.type == "image" }.map { it.content }
            ImageViewer(imgs.ifEmpty { listOf(u) }, imgs.indexOf(u).coerceAtLeast(0)) { fullImage = null }
        }
    }
}

@Composable
private fun Bubble(m: MsgItem, mine: Boolean, convType: Int, onImage: (String) -> Unit) {
    // 微信式：对方左侧灰气泡，自己右侧主题气泡，头像顶部对齐、贴边尾角
    val bubbleShape = if (mine) RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp) else RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp)
    val bg = if (mine) BubbleMine else Bg3
    val fg = if (mine) Color.White else TextMain

    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
        if (!mine) { Avatar(m.senderAvatar, 38); Spacer(Modifier.width(8.dp)) }
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start, modifier = Modifier.widthIn(max = 240.dp)) {
            if (!mine) Text(m.senderNickname, color = TextSub, fontSize = 11.sp, modifier = Modifier.padding(bottom = 2.dp, start = 4.dp))
            when (m.type) {
                "image" -> AsyncImage(model = Api.fullUrl(m.content), contentDescription = null, contentScale = ContentScale.FillWidth, modifier = Modifier.widthIn(max = 160.dp).clip(RoundedCornerShape(10.dp)).noRippleClick { onImage(m.content) })
                "audio" -> {
                    val obj = runCatching { WsClient.json.parseToJsonElement(m.content).jsonObject }.getOrNull()
                    val url = obj?.get("url")?.jsonPrimitive?.content ?: m.content
                    val dur = (obj?.get("duration")?.jsonPrimitive?.content ?: "1").toIntOrNull() ?: 1
                    var voicePlaying by remember { mutableStateOf(false) }
                    Row(
                        modifier = Modifier.widthIn(min = 70.dp, max = (70 + dur * 8).coerceAtMost(220).dp).clip(bubbleShape).background(bg).clickable {
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
                        if (voicePlaying) PlayingVoiceBars(fg) else VoiceIcon(fg, 16.dp)
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
                            Text("${fmtPoints(giftPrice)} 积分", color = if (mine) Color.White.copy(alpha = 0.85f) else Warn, fontSize = 12.sp)
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
                else -> Box(modifier = Modifier.clip(bubbleShape).background(bg).padding(horizontal = 14.dp, vertical = 10.dp)) { Text(m.content, color = fg, fontSize = 15.sp, lineHeight = 21.sp) }
            }
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
private fun sendLocation(ctx: Context, cb: (String, Double, Double) -> Unit) {
    runCatching {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER) ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
        if (loc != null) cb("我的位置", loc.latitude, loc.longitude) else cb("位置获取失败", 0.0, 0.0)
    }.onFailure { cb("位置获取失败", 0.0, 0.0) }
}
