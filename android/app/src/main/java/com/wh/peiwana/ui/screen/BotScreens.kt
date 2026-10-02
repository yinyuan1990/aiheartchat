package com.wh.peiwana.ui.screen

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.InlineButton
import com.wh.peiwana.net.InlineMarkup
import com.wh.peiwana.net.WsClient
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlin.coroutines.resume

/** 机器人（Telegram 式）：用户创建，第三方程序用兼容 Telegram 的 Bot API 收发消息 */

val BotBlue = Color(0xFF2F7CF6)

@Serializable
data class BotCommand(val command: String = "", val description: String = "")

@Serializable
data class BotPublic(val id: String, val username: String = "", val name: String = "", val avatar: String = "", val description: String = "", val commands: List<BotCommand> = emptyList())

@Serializable
private data class MyBot(
    val id: String,
    val username: String = "",
    val name: String = "",
    val avatar: String = "",
    val description: String = "",
    val privacy: Boolean = true,
    val commands: List<BotCommand> = emptyList(),
    val webhookUrl: String = "",
    val status: Int = 0,
    val pendingUpdates: Int = 0,
    val lastError: String = "",
    val token: String? = null,
)

@Serializable
private data class ChatMemberRow(val id: String, val nickname: String = "", val avatar: String = "", val isBot: Boolean = false)

@Serializable
private data class ChatMembers(val members: List<ChatMemberRow> = emptyList())

/** 机器人公开资料：按 id 缓存（不是机器人也缓存 null，免得反复请求） */
object BotInfoCache {
    private val cache = mutableMapOf<String, BotPublic?>()
    suspend fun get(key: String): BotPublic? {
        if (cache.containsKey(key)) return cache[key]
        val info = runCatching { Api.getObj<BotPublic>("/im/bot/info/$key") }.getOrNull()
        cache[key] = info
        return info
    }
    fun forget(key: String) { cache.remove(key) }
}

private data class CallbackAnswer(val text: String, val showAlert: Boolean, val url: String)

/** 机器人的回应可能比 /im/bot/callback 的 HTTP 响应先到：先缓存，再按 queryId 认领 */
private object BotCallbacks {
    private val answers = mutableMapOf<String, CallbackAnswer>()
    private val waiters = mutableMapOf<String, (CallbackAnswer) -> Unit>()
    private var installed = false

    fun install() {
        if (installed) return
        installed = true
        WsClient.addListener { frame ->
            if (frame["op"]?.jsonPrimitive?.content != "bot_callback_answer") return@addListener
            val d = frame["data"]?.jsonObject ?: return@addListener
            val id = d["queryId"]?.jsonPrimitive?.content ?: return@addListener
            val a = CallbackAnswer(d["text"]?.jsonPrimitive?.content.orEmpty(), d["showAlert"]?.jsonPrimitive?.booleanOrNull == true, d["url"]?.jsonPrimitive?.content.orEmpty())
            val w = waiters.remove(id)
            if (w != null) w(a) else answers[id] = a
        }
    }

    suspend fun await(queryId: String): CallbackAnswer? {
        answers.remove(queryId)?.let { return it }
        return withTimeoutOrNull(10_000) {
            suspendCancellableCoroutine { cont ->
                waiters[queryId] = { cont.resume(it) }
                cont.invokeOnCancellation { waiters.remove(queryId) }
            }
        }
    }
}

@Composable
fun BotTag() {
    Text(
        "机器人", color = BotBlue, fontSize = 10.sp,
        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(BotBlue.copy(alpha = 0.1f)).padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/** 消息下面的内联按钮：url 按钮确认后打开；回调按钮发给机器人，机器人 answerCallbackQuery 后 Toast / 弹窗 */
@Composable
fun InlineKeyboard(markup: InlineMarkup?, messageId: String, modifier: Modifier = Modifier) {
    val rows = markup?.inlineKeyboard?.filter { it.isNotEmpty() }.orEmpty()
    if (rows.isEmpty() || messageId.startsWith("local_") || messageId.startsWith("t_")) return
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var alertText by remember { mutableStateOf<String?>(null) }
    var confirmUrl by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { BotCallbacks.install() }

    fun press(b: InlineButton, key: String) {
        if (b.url != null) { confirmUrl = b.url; return }
        val data = b.callbackData ?: return
        if (busy != null) return
        busy = key
        scope.launch {
            runCatching {
                val r = Api.request("/im/bot/callback", "POST", buildJsonObject { put("messageId", JsonPrimitive(messageId)); put("data", JsonPrimitive(data)) })
                val queryId = r?.jsonObject?.get("queryId")?.jsonPrimitive?.content ?: return@runCatching
                val a = BotCallbacks.await(queryId) ?: return@runCatching
                if (a.url.isNotEmpty()) confirmUrl = a.url
                if (a.text.isNotEmpty()) { if (a.showAlert) alertText = a.text else Toast.makeText(ctx, a.text, Toast.LENGTH_SHORT).show() }
            }.onFailure { Toast.makeText(ctx, it.message ?: "机器人没有响应", Toast.LENGTH_SHORT).show() }
            busy = null
        }
    }

    Column(modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        rows.forEachIndexed { i, row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.forEachIndexed { j, b ->
                    val key = "$i-$j"
                    Box(
                        Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(BotBlue.copy(alpha = if (busy == key) 0.05f else 0.1f))
                            .clickable { press(b, key) }.padding(horizontal = 6.dp, vertical = 9.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(if (busy == key) "…" else b.text, color = BotBlue, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (b.url != null) Text("↗", color = BotBlue, fontSize = 9.sp, modifier = Modifier.align(Alignment.TopEnd))
                    }
                }
            }
        }
    }
    confirmUrl?.let { url ->
        WebPreviewDialog(url = url, title = runCatching { Uri.parse(url).host }.getOrNull() ?: url) { confirmUrl = null }
    }
    alertText?.let { t ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { alertText = null },
            containerColor = Bg2,
            text = { Text(t, color = TextMain, fontSize = 15.sp) },
            confirmButton = { Text("好", color = Accent, modifier = Modifier.noRippleClick { alertText = null }.padding(8.dp)) },
        )
    }
}

/** 群 / 频道里管理机器人：按用户名添加（可从我的机器人里点选），已加入的可移出 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddBotSheet(groupId: String, channel: Boolean, onDismiss: () -> Unit, onChanged: () -> Unit = {}) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf("") }
    var inChat by remember { mutableStateOf<List<ChatMemberRow>>(emptyList()) }
    var mine by remember { mutableStateOf<List<MyBot>>(emptyList()) }
    fun load() = scope.launch {
        inChat = runCatching { Api.getObj<ChatMembers>("/im/group/$groupId").members.filter { it.isBot } }.getOrDefault(inChat)
    }
    LaunchedEffect(groupId) {
        load()
        mine = runCatching { Api.getList<MyBot>("/im/bots").filter { it.status == 0 } }.getOrDefault(emptyList())
    }
    fun add(name: String) {
        val u = name.trim().removePrefix("@")
        if (u.isEmpty()) return
        scope.launch {
            runCatching { Api.request("/im/group/$groupId/bot", "POST", buildJsonObject { put("username", JsonPrimitive(u)) }) }
                .onSuccess { username = ""; Toast.makeText(ctx, "已添加", Toast.LENGTH_SHORT).show(); load(); onChanged() }
                .onFailure { Toast.makeText(ctx, it.message ?: "添加失败", Toast.LENGTH_SHORT).show() }
        }
    }
    fun remove(b: ChatMemberRow) = scope.launch {
        runCatching { Api.request("/im/group/$groupId/kick/${b.id}", "POST") }
            .onSuccess { load(); onChanged() }
            .onFailure { Toast.makeText(ctx, it.message ?: "移出失败", Toast.LENGTH_SHORT).show() }
    }

    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Bg) {
        Column(Modifier.fillMaxWidth().clearFocusOnTap().padding(horizontal = 20.dp).padding(bottom = 24.dp).verticalScroll(rememberScrollState())) {
            Text(if (channel) "频道机器人" else "群机器人", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.CenterHorizontally))
            Text(
                if (channel) "机器人在频道里是管理员，可以发帖，能收到所有帖子" else "机器人默认只收到 /命令 和 @它 的消息（创建者可关闭隐私模式）",
                color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp).align(Alignment.CenterHorizontally),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(username, { username = it }, placeholder = { Text("机器人用户名，如 @weather_bot", fontSize = 13.sp) }, singleLine = true, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text("添加", color = Color.White, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(Accent).noRippleClick { add(username) }.padding(horizontal = 16.dp, vertical = 8.dp))
            }
            if (inChat.isNotEmpty()) Text("已加入", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
            inChat.forEach { b ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(b.avatar, 36)
                    Text(b.nickname, color = TextMain, fontSize = 14.sp, maxLines = 1, modifier = Modifier.padding(start = 10.dp))
                    BotTag()
                    Spacer(Modifier.weight(1f))
                    Text("移出", color = Danger, fontSize = 13.sp, modifier = Modifier.noRippleClick { remove(b) })
                }
            }
            val addable = mine.filter { m -> inChat.none { it.id == m.id } }
            if (addable.isNotEmpty()) Text("我的机器人", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
            addable.forEach { b ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(b.avatar, 36)
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Text(b.name, color = TextMain, fontSize = 14.sp, maxLines = 1)
                        Text("@${b.username}", color = TextDim, fontSize = 11.sp)
                    }
                    Text("添加", color = Accent, fontSize = 13.sp, modifier = Modifier.noRippleClick { add(b.username) })
                }
            }
        }
    }
}

/** token 只在创建 / 重置时返回一次 */
@Composable
private fun TokenDialog(token: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    androidx.compose.material3.AlertDialog(
        onDismissRequest = {},
        containerColor = Bg2,
        title = { Text("机器人 Token", color = TextMain) },
        text = {
            Column {
                Text("只显示这一次，请马上保存。拿到 token 就能控制这个机器人，不要泄露；泄露了就去重置。", color = TextSub, fontSize = 13.sp)
                Text(token, color = TextMain, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(top = 10.dp).clip(RoundedCornerShape(8.dp)).background(Bg3).padding(10.dp))
            }
        },
        confirmButton = { Text("我已保存", color = TextSub, modifier = Modifier.noRippleClick(onClose).padding(8.dp)) },
        dismissButton = {
            Text("复制", color = Accent, modifier = Modifier.noRippleClick {
                clipboard.setText(AnnotatedString(token))
                Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show()
            }.padding(8.dp))
        },
    )
}

/** 我的机器人：列表 + 创建 */
@Composable
fun BotsScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<MyBot>?>(null) }
    var creating by remember { mutableStateOf(false) }
    var created by remember { mutableStateOf<MyBot?>(null) }
    fun load() = scope.launch { list = runCatching { Api.getList<MyBot>("/im/bots") }.getOrDefault(emptyList()) }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        NavBar("我的机器人", onBack, action = { Text("创建", color = Accent, fontSize = 14.sp, modifier = Modifier.clickable { creating = true }) })
        Text(
            "机器人可以接入你自己的程序：用 Telegram 兼容的 Bot API 收发消息、发图片、带按钮，能私聊、进群、在频道发帖。现有的 Telegram 机器人代码改一下接口地址就能直接用。",
            color = TextSub, fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.padding(16.dp, 8.dp),
        )
        val l = list
        when {
            l == null -> Text("加载中…", color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(30.dp).align(Alignment.CenterHorizontally))
            l.isEmpty() -> Column(Modifier.fillMaxWidth().padding(top = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("还没有机器人", color = TextSub, fontSize = 14.sp)
                Box(Modifier.padding(top = 16.dp).width(200.dp)) { AccentButton("创建第一个机器人") { creating = true } }
            }
            else -> l.forEach { b ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(b.id) }.padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(b.avatar, 48)
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(b.name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                            BotTag()
                            if (b.status != 0) Text("  已封禁", color = Warn, fontSize = 11.sp)
                        }
                        Text("@${b.username} · ${if (b.webhookUrl.isNotEmpty()) "Webhook" else "getUpdates"}", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                    Text("›", color = TextDim, fontSize = 18.sp)
                }
                Box(Modifier.fillMaxWidth().padding(start = 76.dp).height(1.dp).background(Line))
            }
        }
    }

    if (creating) {
        var name by remember { mutableStateOf("") }
        var username by remember { mutableStateOf("") }
        var desc by remember { mutableStateOf("") }
        var saving by remember { mutableStateOf(false) }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { creating = false },
            containerColor = Bg2,
            title = { Text("创建机器人", color = TextMain) },
            text = {
                Column(Modifier.clearFocusOnTap(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(name, { if (it.length <= 30) name = it }, placeholder = { Text("名称（聊天里显示的名字）", fontSize = 13.sp) }, singleLine = true)
                    OutlinedTextField(username, { username = it.filter { c -> c.isLetterOrDigit() && c.code < 128 || c == '_' }.take(32) }, placeholder = { Text("用户名，以 bot 结尾，如 weather_bot", fontSize = 13.sp) }, singleLine = true)
                    OutlinedTextField(desc, { if (it.length <= 500) desc = it }, placeholder = { Text("简介（用户第一次打开聊天时看到）", fontSize = 13.sp) }, minLines = 2, maxLines = 4)
                }
            },
            confirmButton = {
                Text(if (saving) "创建中…" else "创建", color = Accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick {
                    if (saving || name.isBlank() || username.isBlank()) return@noRippleClick
                    saving = true
                    scope.launch {
                        runCatching {
                            Api.request("/im/bots", "POST", buildJsonObject {
                                put("name", JsonPrimitive(name.trim())); put("username", JsonPrimitive(username.trim())); put("description", JsonPrimitive(desc.trim()))
                            })!!
                        }.onSuccess {
                            creating = false
                            created = Api.json.decodeFromJsonElement(MyBot.serializer(), it)
                            load()
                        }.onFailure { Toast.makeText(ctx, it.message ?: "创建失败", Toast.LENGTH_SHORT).show() }
                        saving = false
                    }
                }.padding(8.dp))
            },
            dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick { creating = false }.padding(8.dp)) },
        )
    }
    created?.let { b -> TokenDialog(b.token.orEmpty()) { created = null; onOpen(b.id) } }
}

/** 机器人详情：资料、隐私模式、接收状态、token、接入说明 */
@Composable
fun BotDetailScreen(botId: String, onBack: () -> Unit, onOpenChat: (botId: String, name: String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var bot by remember { mutableStateOf<MyBot?>(null) }
    var error by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var token by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }

    fun load() = scope.launch {
        runCatching { Api.getObj<MyBot>("/im/bots/$botId") }
            .onSuccess { bot = it; name = it.name; desc = it.description }
            .onFailure { error = it.message ?: "机器人不存在" }
    }
    LaunchedEffect(botId) { load() }
    fun save(body: kotlinx.serialization.json.JsonObject) = scope.launch {
        runCatching { Api.request("/im/bots/$botId", "PUT", body) }
            .onSuccess { BotInfoCache.forget(botId); editing = false; load() }
            .onFailure { Toast.makeText(ctx, it.message ?: "保存失败", Toast.LENGTH_SHORT).show() }
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                Api.upload("image", b, "bot.jpg", "image/jpeg")
            }.onSuccess { save(buildJsonObject { put("avatar", JsonPrimitive(it)) }) }
                .onFailure { Toast.makeText(ctx, it.message ?: "上传失败", Toast.LENGTH_SHORT).show() }
        }
    }

    val b = bot
    Column(Modifier.fillMaxSize()) {
        NavBar(b?.name ?: "机器人", onBack, action = {
            if (b != null) Text("聊天", color = Accent, fontSize = 14.sp, modifier = Modifier.clickable { onOpenChat(b.id, b.name) })
        })
        if (b == null) {
            Text(error.ifEmpty { "加载中…" }, color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(30.dp).align(Alignment.CenterHorizontally))
            return@Column
        }
        val apiBase = "${Api.BASE_URL}/api"
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).clearFocusOnTap().padding(16.dp)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.noRippleClick { pickAvatar.launch("image/*") }) { Avatar(b.avatar, 76) }
                Text("点头像可修改", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                if (editing) {
                    OutlinedTextField(name, { if (it.length <= 30) name = it }, placeholder = { Text("名称") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
                    OutlinedTextField(desc, { if (it.length <= 500) desc = it }, placeholder = { Text("简介") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                        Text("取消", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { editing = false }.padding(10.dp))
                        Text("保存", color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick {
                            save(buildJsonObject { put("name", JsonPrimitive(name.trim())); put("description", JsonPrimitive(desc.trim())) })
                        }.padding(10.dp))
                    }
                } else {
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(b.name, color = TextMain, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                        BotTag()
                    }
                    Text("@${b.username}" + if (b.status != 0) "  · 已被平台封禁" else "", color = if (b.status != 0) Warn else TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                    Text(b.description.ifEmpty { "（无简介）" }, color = if (b.description.isEmpty()) TextDim else TextMain, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 10.dp))
                    Text("编辑资料", color = Accent, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp).noRippleClick { editing = true })
                }
            }

            Column(Modifier.padding(top = 16.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(horizontal = 14.dp)) {
                Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("群隐私模式", color = TextMain, fontSize = 15.sp)
                        Text("开启：群里只收到 /命令 和 @它 的消息；关闭：收到全部群消息", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                    Text(
                        if (b.privacy) "已开启" else "已关闭", color = if (b.privacy) Color.White else TextSub, fontSize = 12.sp,
                        modifier = Modifier.padding(start = 8.dp).clip(RoundedCornerShape(14.dp)).background(if (b.privacy) Accent else Bg3)
                            .noRippleClick { save(buildJsonObject { put("privacy", JsonPrimitive(!b.privacy)) }) }.padding(horizontal = 14.dp, vertical = 5.dp),
                    )
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
                Column(Modifier.padding(vertical = 12.dp)) {
                    Text("接收方式", color = TextMain, fontSize = 15.sp)
                    Text(
                        (if (b.webhookUrl.isNotEmpty()) "Webhook：${b.webhookUrl}" else "getUpdates 轮询（没有设置 Webhook）") + " · 待取消息 ${b.pendingUpdates} 条",
                        color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                    if (b.lastError.isNotEmpty()) Text("最近一次推送失败：${b.lastError}", color = Danger, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
                Column(Modifier.padding(vertical = 12.dp)) {
                    Text("命令菜单", color = TextMain, fontSize = 15.sp)
                    Text(
                        if (b.commands.isEmpty()) "还没设置，程序里调用 setMyCommands 设置" else b.commands.joinToString("\n") { "/${it.command} ${it.description}" },
                        color = TextSub, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }

            Column(Modifier.padding(top = 12.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(horizontal = 14.dp)) {
                Text("重置 Token", color = TextMain, fontSize = 15.sp, modifier = Modifier.fillMaxWidth().clickable { confirm = "reset" }.padding(vertical = 14.dp))
                Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
                Text("删除机器人", color = Danger, fontSize = 15.sp, modifier = Modifier.fillMaxWidth().clickable { confirm = "delete" }.padding(vertical = 14.dp))
            }

            Text("接入说明", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 20.dp, bottom = 6.dp))
            Text(
                "接口和 Telegram Bot API 一样，只是地址换成：\n$apiBase/bot<token>/方法名\n\n" +
                    "支持 getMe、getUpdates、setWebhook、deleteWebhook、getWebhookInfo、sendMessage、sendPhoto、editMessageText、editMessageReplyMarkup、deleteMessage、answerCallbackQuery、setMyCommands、getChat、getFile 等。" +
                    "按钮只支持 inline_keyboard（url / callback_data）。chat_id：私聊是用户 id，群和频道是负数。用户要先给机器人发过消息，机器人才能私聊他。\n\n" +
                    "Python（python-telegram-bot）：base_url 设为 $apiBase/bot，base_file_url 设为 $apiBase/file/bot\n" +
                    "Node.js（Telegraf）：telegram.apiRoot 设为 ${Api.BASE_URL}/api\n\n" +
                    "Webhook 需要 https 公网地址；设置 secret_token 后每次推送都会带 X-Telegram-Bot-Api-Secret-Token 头。",
                color = TextSub, fontSize = 12.sp, lineHeight = 19.sp,
            )
            Spacer(Modifier.height(30.dp))
        }
    }

    when (confirm) {
        "reset", "delete" -> androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirm = null },
            containerColor = Bg2,
            text = {
                Text(
                    if (confirm == "reset") "重置后旧 token 立即失效，正在运行的程序要换成新 token。确定重置？" else "删除机器人 @${b?.username}？会退出所有群和频道，不能恢复",
                    color = TextMain, fontSize = 15.sp,
                )
            },
            confirmButton = {
                Text(if (confirm == "reset") "重置" else "删除", color = Danger, modifier = Modifier.noRippleClick {
                    val what = confirm
                    confirm = null
                    scope.launch {
                        if (what == "reset") {
                            runCatching { Api.request("/im/bots/$botId/token", "POST")?.jsonObject?.get("token")?.jsonPrimitive?.content }
                                .onSuccess { token = it }
                                .onFailure { Toast.makeText(ctx, it.message ?: "重置失败", Toast.LENGTH_SHORT).show() }
                        } else {
                            runCatching { Api.request("/im/bots/$botId/delete", "POST") }
                                .onSuccess { BotInfoCache.forget(botId); onBack() }
                                .onFailure { Toast.makeText(ctx, it.message ?: "删除失败", Toast.LENGTH_SHORT).show() }
                        }
                    }
                }.padding(8.dp))
            },
            dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick { confirm = null }.padding(8.dp)) },
        )
    }
    token?.let { TokenDialog(it) { token = null } }
}
