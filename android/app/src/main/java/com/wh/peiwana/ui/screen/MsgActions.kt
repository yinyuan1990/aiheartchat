package com.wh.peiwana.ui.screen

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import com.wh.peiwana.i18n.t
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.MsgReaction
import com.wh.peiwana.net.ReplyPreview
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 与后端 MSG_REACTIONS 一致；前 7 个是菜单顶上那一排 */
val MSG_REACTIONS = listOf("❤️", "👍", "👎", "🔥", "🥰", "👏", "😁", "😂", "😮", "😢", "🎉", "🙏")

/** 能转发的类型（礼物、通话记录、转账卡片不行；喊单卡片可以），和后端 message.service FORWARDABLE 一致 */
val FORWARDABLE = setOf("text", "image", "video", "audio", "location", "sticker", "callout")

fun msgSnippet(type: String, content: String): String = when (type) {
    "text" -> content.replace(Regex("\\s+"), " ").take(60)
    "image" -> t("msg.snippet.image")
    "video" -> t("msg.snippet.video")
    "audio" -> t("msg.snippet.audio")
    "sticker" -> t("msg.snippet.sticker")
    "location" -> t("msg.snippet.location")
    "gift" -> t("msg.snippet.gift")
    "transfer", "callout", "payreq", "perp" -> chainCardPreview(type, content) ?: t("msg.snippet.message")
    else -> if (type.startsWith("call")) t("msg.snippet.call") else t("msg.snippet.message")
}

// ---------- 链接 ----------

private val URL_RE = Regex("(https?://|www\\.)[^\\s<>\"'“”‘’，。！？；：、（）【】《》]+", RegexOption.IGNORE_CASE)
private val TRAILING = Regex("[.,;:!?)\\]}>]+$")

/** 把文本切成普通文字和链接（url 已补全 https://） */
fun splitLinks(text: String): List<Pair<String, String?>> {
    val out = mutableListOf<Pair<String, String?>>()
    var last = 0
    for (m in URL_RE.findAll(text)) {
        val raw = m.value.replace(TRAILING, "")
        if (raw.isEmpty() || raw.equals("www.", true)) continue
        if (m.range.first > last) out += text.substring(last, m.range.first) to null
        out += raw to (if (raw.startsWith("www.", true)) "https://$raw" else raw)
        last = m.range.first + raw.length
    }
    if (last < text.length) out += text.substring(last) to null
    return out
}

fun hostOf(url: String): String = runCatching { Uri.parse(url).host }.getOrNull() ?: url

/** 文字里的链接可点，点开走应用内网页（顶部可浏览器打开 / 复制链接） */
@Composable
fun LinkText(text: String, color: Color, fontSize: TextUnit, lineHeight: TextUnit = TextUnit.Unspecified, modifier: Modifier = Modifier) {
    var openUrl by remember { mutableStateOf<String?>(null) }
    val parts = remember(text) { splitLinks(text) }
    if (parts.none { it.second != null }) {
        Text(text, color = color, fontSize = fontSize, lineHeight = lineHeight, modifier = modifier)
        return
    }
    val annotated = remember(text) {
        buildAnnotatedString {
            parts.forEach { (seg, url) ->
                if (url == null) append(seg)
                else withLink(LinkAnnotation.Clickable(url, TextLinkStyles(SpanStyle(color = BotBlue, textDecoration = TextDecoration.Underline))) { openUrl = url }) { append(seg) }
            }
        }
    }
    Text(annotated, color = color, fontSize = fontSize, lineHeight = lineHeight, modifier = modifier)
    openUrl?.let { u -> WebPreviewDialog(url = u, title = hostOf(u)) { openUrl = null } }
}

// ---------- 长按菜单 ----------

class MenuActions(
    val onReact: (String) -> Unit,
    val onReply: () -> Unit,
    val onCopy: (() -> Unit)?,
    val onSave: (() -> Unit)?,
    val onPin: (() -> Unit)?,
    val onForward: (() -> Unit)?,
    val onReport: (() -> Unit)?,
    val onDelete: () -> Unit,
    val onSelect: () -> Unit,
)

@Serializable
data class ReaderUser(val id: String, val nickname: String = "", val avatar: String = "")

@Serializable
data class ReadInfo(val read: Boolean? = null, val readAt: String? = null, val count: Int? = null, val users: List<ReaderUser> = emptyList())

private fun fmtReadAt(iso: String): String = runCatching {
    val tm = java.time.Instant.parse(iso).atZone(java.time.ZoneId.systemDefault())
    t("msg.readDate", "m" to tm.monthValue, "d" to tm.dayOfMonth, "time" to "%02d:%02d".format(tm.hour, tm.minute))
}.getOrDefault("")

/** Telegram 式消息菜单：顶上一排表情，自己的消息显示已读时间，下面按类型给操作（传 null 的不显示） */
@Composable
fun MsgMenuDialog(msgId: String, mine: Boolean, convType: Int, myReaction: String?, pinned: Boolean, actions: MenuActions, onDismiss: () -> Unit) {
    var expand by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf<ReadInfo?>(null) }
    var showReaders by remember { mutableStateOf(false) }
    LaunchedEffect(msgId) {
        if (mine) info = runCatching { Api.getObj<ReadInfo>("/im/messages/$msgId/readers") }.getOrNull()
    }
    fun run(fn: (() -> Unit)?) { onDismiss(); fn?.invoke() }

    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.width(270.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val shown = if (expand) MSG_REACTIONS else MSG_REACTIONS.take(7)
            Column(Modifier.clip(RoundedCornerShape(22.dp)).background(Bg).padding(horizontal = 8.dp, vertical = 6.dp)) {
                shown.chunked(7).forEach { row ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        row.forEach { e ->
                            Box(
                                Modifier.size(34.dp).clip(CircleShape).background(if (myReaction == e) BotBlue.copy(alpha = 0.15f) else Color.Transparent).noRippleClick { run { actions.onReact(e) } },
                                contentAlignment = Alignment.Center,
                            ) { Text(e, fontSize = 21.sp) }
                        }
                        if (!expand && row === shown.chunked(7).last()) {
                            Box(Modifier.size(30.dp).clip(CircleShape).background(Bg3).noRippleClick { expand = true }, contentAlignment = Alignment.Center) {
                                Text("⌄", color = TextSub, fontSize = 15.sp)
                            }
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg)) {
                info?.let { r ->
                    val line = if (convType == 1) {
                        val at = r.readAt?.let { fmtReadAt(it) }.orEmpty()
                        if (r.read == true) "✓✓ " + (if (at.isNotEmpty()) t("msg.readAt", "time" to at) else t("msg.read")) else "✓ " + t("msg.unread")
                    } else {
                        val n = r.count ?: 0
                        if (n > 0) "✓✓ ${t("msg.readByN", "n" to n)} ${if (showReaders) "⌃" else "›"}" else "✓✓ " + t("msg.readByNone")
                    }
                    Text(line, color = TextSub, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().background(Bg2).noRippleClick { if ((r.count ?: 0) > 0) showReaders = !showReaders }.padding(16.dp, 9.dp))
                    if (showReaders) Column(Modifier.fillMaxWidth().background(Bg2).heightIn(max = 160.dp).padding(horizontal = 16.dp)) {
                        r.users.forEach { u ->
                            Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(u.avatar, 22); Spacer(Modifier.width(8.dp)); Text(u.nickname, color = TextMain, fontSize = 13.sp, maxLines = 1)
                            }
                        }
                    }
                }
                val items = listOf(
                    "msg.reply" to actions.onReply, "msg.copy" to actions.onCopy, "common.save" to actions.onSave,
                    (if (pinned) "msg.unpin" else "msg.pin") to actions.onPin, "msg.forward" to actions.onForward,
                    "common.report" to actions.onReport, "common.delete" to actions.onDelete, "msg.select" to actions.onSelect,
                ).filter { it.second != null }
                items.forEachIndexed { i, (key, fn) ->
                    if (i > 0 || info != null) Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
                    Text(
                        t(key), color = if (key == "common.delete") Danger else TextMain, fontSize = 15.sp,
                        modifier = Modifier.fillMaxWidth().noRippleClick { run(fn) }.padding(16.dp, 12.dp),
                    )
                }
            }
        }
    }
}

// ---------- 气泡里的小部件 ----------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReactionChips(reactions: List<MsgReaction>, myId: String, onToggle: (String) -> Unit) {
    if (reactions.isEmpty()) return
    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        reactions.forEach { r ->
            val mine = myId in r.userIds
            Text(
                "${r.emoji} ${r.count}", fontSize = 13.sp, color = if (mine) BotBlue else TextMain,
                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(if (mine) BotBlue.copy(alpha = 0.16f) else Bg3).noRippleClick { onToggle(r.emoji) }.padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
fun ReplyQuote(r: ReplyPreview, onClick: () -> Unit) {
    Row(
        Modifier.padding(bottom = 5.dp).widthIn(max = 220.dp).clip(RoundedCornerShape(4.dp)).background(BotBlue.copy(alpha = 0.08f)).noRippleClick { if (!r.deleted) onClick() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(36.dp).background(BotBlue))
        if (r.type == "image" && r.content.isNotEmpty() && !r.deleted) {
            AsyncImage(Api.fullUrl(r.content), null, contentScale = ContentScale.Crop, modifier = Modifier.padding(start = 6.dp).size(28.dp).clip(RoundedCornerShape(3.dp)))
        }
        Column(Modifier.padding(horizontal = 8.dp, vertical = 3.dp)) {
            if (r.deleted) Text(t("msg.originalDeleted"), color = TextSub, fontSize = 12.sp)
            else {
                Text(r.senderNickname, color = BotBlue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(if (r.type == "text") r.content else msgSnippet(r.type, ""), color = TextMain, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 输入框上方「回复 xxx」条 */
@Composable
fun ReplyBar(nickname: String, snippet: String, onCancel: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(Bg2).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("↩", color = BotBlue, fontSize = 18.sp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(t("msg.replyTo", "name" to nickname), color = BotBlue, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            Text(snippet, color = TextSub, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("×", color = TextDim, fontSize = 22.sp, modifier = Modifier.noRippleClick(onCancel).padding(horizontal = 6.dp))
    }
}

@Serializable
data class PinItem(val id: String, val senderId: String = "", val senderNickname: String = "", val type: String = "", val content: String = "", val pinnedAt: String = "")

/** 顶部置顶条：点一下跳到这条，再点轮到下一条（新的在前） */
@Composable
fun PinBar(pins: List<PinItem>, index: Int, canUnpin: Boolean, onJump: () -> Unit, onUnpin: () -> Unit) {
    val p = pins.getOrNull(index % pins.size.coerceAtLeast(1)) ?: return
    Row(Modifier.fillMaxWidth().background(Bg2).noRippleClick(onJump).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.height(32.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            pins.take(5).forEachIndexed { i, _ ->
                Box(Modifier.width(2.dp).weight(1f).background(if (i == index % pins.size) BotBlue else BotBlue.copy(alpha = 0.3f)))
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("${t("msg.pinnedMessage")}${if (pins.size > 1) " #${index % pins.size + 1}" else ""}", color = BotBlue, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(if (p.type == "text") p.content else msgSnippet(p.type, ""), color = TextSub, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (canUnpin) Text("×", color = TextDim, fontSize = 22.sp, modifier = Modifier.noRippleClick(onUnpin).padding(horizontal = 6.dp))
    }
}

// ---------- 删除 / 举报 / 转发 ----------

/** 删除确认（Telegram 式）：能为双方删除时默认勾上「同时为对方删除」 */
@Composable
fun DeleteMsgDialog(count: Int, canForAll: Boolean, convType: Int, peerName: String, onConfirm: (Boolean) -> Unit, onDismiss: () -> Unit) {
    var forAll by remember { mutableStateOf(true) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Bg2,
        title = { Text(if (count > 1) t("msg.deleteN", "n" to count) else t("msg.deleteOne"), color = TextMain) },
        text = {
            if (canForAll) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.noRippleClick { forAll = !forAll }) {
                Checkbox(forAll, { forAll = it }, colors = CheckboxDefaults.colors(checkedColor = Accent))
                Text(if (convType == 1) t("msg.deleteForPeer", "name" to peerName) else t("msg.deleteForAll"), color = TextMain, fontSize = 14.sp)
            } else Text(t("msg.deleteForMeHint"), color = TextSub)
        },
        confirmButton = { Text(t("common.delete"), color = Danger, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick { onConfirm(canForAll && forAll) }.padding(8.dp)) },
        dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}

/** 提交给服务端的举报理由（中文原值） → 界面文字 key */
private val REPORT_REASONS = listOf(
    "垃圾广告" to "msg.report.spam", "色情低俗" to "msg.report.porn", "诈骗" to "msg.report.fraud",
    "辱骂骚扰" to "msg.report.abuse", "违法违规" to "msg.report.illegal", "其他" to "msg.report.other",
)

@Composable
fun ReportMsgDialog(msgId: String, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var other by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    fun submit(reason: String) = scope.launch {
        val tip = runCatching {
            val r = Api.request("/im/messages/$msgId/report", "POST", buildJsonObject { put("reason", reason) })
            if (r?.jsonObject?.get("duplicated")?.jsonPrimitive?.content == "true") t("msg.reportDuplicated") else t("msg.reported")
        }.getOrElse { it.message ?: t("msg.reportFailed") }
        onDone(tip)
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Bg2,
        title = { Text(t("msg.reportTitle"), color = TextMain) },
        text = {
            if (!other) Column {
                REPORT_REASONS.forEach { (r, key) ->
                    Text(t(key), color = TextMain, fontSize = 15.sp, modifier = Modifier.fillMaxWidth().noRippleClick { if (r == "其他") other = true else submit(r) }.padding(vertical = 11.dp))
                }
            } else androidx.compose.material3.OutlinedTextField(text, { text = it.take(200) }, placeholder = { Text(t("msg.reportPlaceholder"), color = TextDim) }, minLines = 3)
        },
        confirmButton = {
            if (other) Text(t("common.submit"), color = if (text.isBlank()) TextDim else Accent, modifier = Modifier.noRippleClick { if (text.isNotBlank()) submit("其他：${text.trim()}") }.padding(8.dp))
        },
        dismissButton = { Text(t("common.cancel"), color = TextSub, modifier = Modifier.noRippleClick(onDismiss).padding(8.dp)) },
    )
}

/** 转发：选会话（最多 10 个），按原消息顺序发过去 */
@Composable
fun ForwardDialog(fromConvId: String, ids: List<String>, onDone: (String, List<String>) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var convs by remember { mutableStateOf<List<ConversationItem>>(emptyList()) }
    var q by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        convs = runCatching { Api.getList<ConversationItem>("/im/conversations") }.getOrDefault(emptyList()).filter { it.peer != null || it.group != null }
    }
    fun name(c: ConversationItem) = c.peer?.nickname ?: c.group?.name ?: ""
    val shown = convs.filter { q.isBlank() || name(it).contains(q.trim(), ignoreCase = true) }

    fun send() {
        busy = true
        scope.launch {
            var ok = false
            val tip = runCatching {
                val body = buildJsonObject {
                    put("fromConversationId", fromConvId)
                    put("ids", buildJsonArray { ids.forEach { add(it) } })
                    put("targets", buildJsonArray {
                        picked.mapNotNull { id -> convs.find { it.id == id } }.forEach { c ->
                            addJsonObject {
                                put("convType", if (c.type == 1) 1 else 2)
                                put("targetId", if (c.type == 1) c.peer!!.id else c.group!!.id)
                            }
                        }
                    })
                }
                val r = Api.request("/im/messages/forward", "POST", body)
                val failed = r?.jsonObject?.get("results")?.jsonArray?.filter { it.jsonObject["ok"]?.jsonPrimitive?.content != "true" }.orEmpty()
                ok = failed.isEmpty()
                if (ok) t("msg.forwarded") else t("msg.forwardPartialFail", "n" to failed.size, "error" to (failed[0].jsonObject["error"]?.jsonPrimitive?.content ?: ""))
            }.getOrElse { it.message ?: t("msg.forwardFailed") }
            busy = false
            onDone(tip, if (ok) picked else emptyList())
        }
    }

    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).clip(RoundedCornerShape(16.dp)).background(Bg2).padding(16.dp)) {
            Text(if (ids.size > 1) t("msg.forwardNTo", "n" to ids.size) else t("msg.forwardTo"), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.CenterHorizontally))
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp, 9.dp)) {
                if (q.isEmpty()) Text(t("common.search"), color = TextDim, fontSize = 14.sp)
                androidx.compose.foundation.text.BasicTextField(q, { q = it }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 14.sp), modifier = Modifier.fillMaxWidth())
            }
            LazyColumn(Modifier.weight(1f, fill = false).padding(top = 6.dp)) {
                items(shown, key = { it.id }) { c ->
                    val on = c.id in picked
                    Row(
                        Modifier.fillMaxWidth().noRippleClick { picked = if (on) picked - c.id else if (picked.size >= 10) picked else picked + c.id }.padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(c.peer?.avatar ?: c.group?.avatar, 38)
                        Spacer(Modifier.width(10.dp))
                        Text(name(c), color = TextMain, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (c.group != null) Text(" · " + if (c.group.kind == 2) t("msg.tagChannel") else t("msg.tagGroup"), color = TextSub, fontSize = 12.sp)
                        if (c.peer?.isBot == true) BotTag()
                        Spacer(Modifier.weight(1f))
                        SelectCircle(on)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Box(
                Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(22.dp)).background(if (picked.isEmpty() || busy) Bg3 else Accent).noRippleClick { if (picked.isNotEmpty() && !busy) send() },
                contentAlignment = Alignment.Center,
            ) { Text(if (busy) t("msg.sending") else if (picked.isNotEmpty()) t("msg.sendN", "n" to picked.size) else t("common.send"), color = if (picked.isEmpty()) TextDim else Color.White, fontSize = 15.sp) }
        }
    }
}

@Composable
fun SelectCircle(on: Boolean) {
    Box(
        Modifier.size(22.dp).clip(CircleShape).then(if (on) Modifier.background(BotBlue) else Modifier.border(2.dp, TextDim, CircleShape)),
        contentAlignment = Alignment.Center,
    ) { if (on) Text("✓", color = Color.White, fontSize = 13.sp) }
}

// ---------- 拷贝 / 保存 ----------

fun copyToClipboard(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("msg", text))
    Toast.makeText(ctx, t("common.copied"), Toast.LENGTH_SHORT).show()
}

/** 保存图片 / 视频到相册（Android 10+ 走 MediaStore，不需要存储权限；更老的系统交给浏览器下载） */
suspend fun saveMediaToGallery(ctx: Context, url: String, type: String) {
    val full = Api.fullUrl(url)
    if (Build.VERSION.SDK_INT < 29) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(full))) }
        return
    }
    val ok = withContext(Dispatchers.IO) {
        runCatching {
            val isVideo = type == "video"
            val ext = full.substringBefore('?').substringAfterLast('.', "").lowercase().takeIf { it.length in 2..5 } ?: if (isVideo) "mp4" else "jpg"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, "${type}_${System.currentTimeMillis()}.$ext")
                put(MediaStore.MediaColumns.MIME_TYPE, if (isVideo) "video/$ext" else if (ext == "png") "image/png" else if (ext == "gif") "image/gif" else "image/jpeg")
                put(MediaStore.MediaColumns.RELATIVE_PATH, if (isVideo) "Movies/心之音" else "Pictures/心之音")
            }
            val coll = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            val uri = ctx.contentResolver.insert(coll, values)!!
            java.net.URL(full).openStream().use { input -> ctx.contentResolver.openOutputStream(uri)!!.use { input.copyTo(it) } }
            true
        }.getOrDefault(false)
    }
    Toast.makeText(ctx, if (ok) t("msg.savedToGallery") else t("msg.saveFailed"), Toast.LENGTH_SHORT).show()
}

/** 把一组 id 打包成 JSON 数组（删除 / 转发接口用） */
fun jsonIds(ids: List<String>) = buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }
