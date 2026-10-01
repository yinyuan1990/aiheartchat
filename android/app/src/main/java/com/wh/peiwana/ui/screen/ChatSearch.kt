package com.wh.peiwana.ui.screen

import android.content.Context
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.Avatar
import com.wh.peiwana.ui.RoundBadge
import com.wh.peiwana.ui.XMarkIcon
import com.wh.peiwana.ui.sticker.SearchIcon
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

@Serializable
data class NoticeLast(val title: String = "", val body: String = "", val createdAt: String = "")

@Serializable
data class NoticeSummary(val unread: Int = 0, val last: NoticeLast? = null)

/** GET /notifications/summary：评论 / 接单两个系统会话的未读数 + 最新一条 */
@Serializable
data class NoticeSummaryResp(val comment: NoticeSummary = NoticeSummary(), val task: NoticeSummary = NoticeSummary())

@Serializable
data class SearchMsgHit(
    val id: String,
    val conversationId: String,
    val convType: Int = 1,
    val targetId: String = "",
    val title: String = "",
    val avatar: String = "",
    val senderNickname: String = "",
    val content: String = "",
    val createdAt: String = "",
)

@Serializable
data class SearchUserHit(val id: String, val nickname: String = "", val avatar: String = "", val age: Int? = null, val cityName: String? = null)

@Serializable
data class SearchResp(val messages: List<SearchMsgHit> = emptyList(), val users: List<SearchUserHit> = emptyList())

/** 最近搜索：conv / extra 只存 id（显示时取当前数据），user 把展示信息也存下 */
@Serializable
data class SearchRecent(val kind: String, val id: String, val title: String = "", val avatar: String = "", val subtitle: String = "")

/** 消息页里不是会话的固定条目（AI 助手 / 音乐 / 评论通知 / 接单通知），也能被搜到 */
class SearchExtra(
    val key: String,
    val title: String,
    val subtitle: String,
    val unread: Int = 0,
    val icon: @Composable (sizeDp: Int) -> Unit,
    val onOpen: () -> Unit,
)

private const val RECENT_MAX = 20
private val recentSerializer = ListSerializer(SearchRecent.serializer())

private fun loadRecent(ctx: Context): List<SearchRecent> =
    runCatching {
        val raw = ctx.getSharedPreferences("chat_search", Context.MODE_PRIVATE).getString("recent", null) ?: return emptyList()
        Api.json.decodeFromString(recentSerializer, raw)
    }.getOrDefault(emptyList())

private fun saveRecent(ctx: Context, list: List<SearchRecent>) {
    ctx.getSharedPreferences("chat_search", Context.MODE_PRIVATE).edit()
        .putString("recent", Api.json.encodeToString(recentSerializer, list.take(RECENT_MAX)))
        .apply()
}

private fun convTitle(c: ConversationItem) = if (c.type == 1) c.peer?.nickname ?: "" else c.group?.name ?: ""
private fun convAvatar(c: ConversationItem) = if (c.type == 1) c.peer?.avatar else c.group?.avatar
private fun convTarget(c: ConversationItem) = if (c.type == 1) c.peer?.id ?: "" else c.group?.id ?: ""

/** 关键词高亮（不区分大小写） */
private fun highlight(text: String, q: String): AnnotatedString = buildAnnotatedString {
    val k = q.trim()
    if (k.isEmpty()) { append(text); return@buildAnnotatedString }
    var i = 0
    while (i < text.length) {
        val at = text.indexOf(k, i, ignoreCase = true)
        if (at < 0) { append(text.substring(i)); break }
        append(text.substring(i, at))
        withStyle(SpanStyle(color = Accent, fontWeight = FontWeight.SemiBold)) { append(text.substring(at, at + k.length)) }
        i = at + k.length
    }
}

private fun shortDate(iso: String): String {
    val instant = runCatching { java.time.Instant.parse(iso) }.getOrNull() ?: return ""
    val zone = java.time.ZoneId.systemDefault()
    val d = instant.atZone(zone)
    val today = java.time.LocalDate.now(zone)
    val pattern = when {
        d.toLocalDate() == today -> "HH:mm"
        d.year == today.year -> "M/d"
        else -> "yyyy/M/d"
    }
    return d.format(java.time.format.DateTimeFormatter.ofPattern(pattern))
}

/**
 * 消息页搜索弹框（Telegram 式，全屏）：
 * 空搜索 = 常用联系人横排 + 最近搜索；有关键词 = 聊天（本地会话名 + 全局用户）/ 消息（内容匹配）两栏。
 */
@Composable
fun ChatSearchDialog(
    convs: List<ConversationItem>,
    extras: List<SearchExtra>,
    onDismiss: () -> Unit,
    onOpenChat: (convId: String, convType: Int, targetId: String, title: String) -> Unit,
    onOpenMessage: (convId: String, convType: Int, targetId: String, title: String, msgId: String) -> Unit,
    onOpenUser: (String) -> Unit,
) {
    val ctx = LocalContext.current
    var q by remember { mutableStateOf("") }
    var tab by remember { mutableIntStateOf(0) }
    var recent by remember { mutableStateOf(loadRecent(ctx)) }
    var result by remember { mutableStateOf<Pair<String, SearchResp>?>(null) }
    var loading by remember { mutableStateOf(false) }
    val keyword = q.trim()
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(keyword) {
        if (keyword.isEmpty()) { result = null; loading = false; return@LaunchedEffect }
        loading = true
        delay(300)
        val r = runCatching { Api.getObj<SearchResp>("/im/search?q=${Uri.encode(keyword)}") }.getOrDefault(SearchResp())
        result = keyword to r
        loading = false
    }

    fun addRecent(item: SearchRecent) {
        recent = listOf(item) + recent.filterNot { it.kind == item.kind && it.id == item.id }
        saveRecent(ctx, recent)
    }
    fun openConv(c: ConversationItem) {
        addRecent(SearchRecent("conv", c.id))
        keyboard?.hide()
        val title = if (c.type == 2) "${convTitle(c)}（群）" else convTitle(c)
        onOpenChat(c.id, c.type, convTarget(c), title)
    }
    fun openExtra(e: SearchExtra) {
        addRecent(SearchRecent("extra", e.key))
        keyboard?.hide()
        e.onOpen()
    }
    fun openUser(r: SearchRecent) {
        addRecent(r)
        keyboard?.hide()
        onOpenUser(r.id)
    }

    val convById = remember(convs) { convs.associateBy { it.id } }
    val extraByKey = remember(extras) { extras.associateBy { it.key } }
    val peerIds = remember(convs) { convs.filter { it.type == 1 }.mapNotNull { it.peer?.id }.toSet() }
    val chatHits = if (keyword.isEmpty()) emptyList() else convs.filter { convTitle(it).contains(keyword, ignoreCase = true) }
    val extraHits = if (keyword.isEmpty()) emptyList() else extras.filter { it.title.contains(keyword, ignoreCase = true) }
    val fresh = result?.takeIf { it.first == keyword }?.second
    val userHits = fresh?.users.orEmpty().filterNot { it.id in peerIds }
    val msgHits = fresh?.messages.orEmpty()

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val view = LocalView.current
        val window = (view.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.let {
                it.setDimAmount(0f)
                WindowCompat.getInsetsController(it, view).isAppearanceLightStatusBars = true
            }
        }
        LaunchedEffect(Unit) {
            delay(120)
            runCatching { focus.requestFocus() }
            keyboard?.show()
        }

        Column(Modifier.fillMaxSize().background(Bg).windowInsetsPadding(WindowInsets.statusBars)) {
            // 搜索框 + 圆形关闭
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(22.dp)).background(Bg2).padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SearchIcon(TextSub, 17.dp)
                    Spacer(Modifier.width(8.dp))
                    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                        if (q.isEmpty()) Text("搜索", color = TextDim, fontSize = 17.sp)
                        BasicTextField(
                            value = q,
                            onValueChange = { q = it },
                            singleLine = true,
                            textStyle = TextStyle(color = TextMain, fontSize = 17.sp),
                            cursorBrush = SolidColor(Accent),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                            modifier = Modifier.fillMaxWidth().focusRequester(focus),
                        )
                    }
                    if (q.isNotEmpty()) {
                        Box(Modifier.size(18.dp).clip(CircleShape).background(TextDim).clickable { q = "" }, contentAlignment = Alignment.Center) {
                            XMarkIcon(Color.White, 12.dp)
                        }
                    }
                }
                Spacer(Modifier.width(10.dp))
                Box(Modifier.size(44.dp).clip(CircleShape).background(Bg2).clickable(onClick = onDismiss), contentAlignment = Alignment.Center) {
                    XMarkIcon(TextMain, 20.dp)
                }
            }

            if (keyword.isNotEmpty()) {
                Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("聊天", if (msgHits.isNotEmpty()) "消息 ${msgHits.size}" else "消息").forEachIndexed { i, label ->
                        Text(
                            label,
                            color = if (tab == i) TextMain else TextSub,
                            fontSize = 14.sp,
                            fontWeight = if (tab == i) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clip(RoundedCornerShape(16.dp))
                                .background(if (tab == i) Bg3 else Color.Transparent)
                                .clickable { tab = i }
                                .padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }
            }

            LazyColumn(
                Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
            ) {
                if (keyword.isEmpty()) {
                    val top = convs.take(12)
                    if (top.isNotEmpty()) item("top") {
                        LazyRow(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            items(top, key = { it.id }) { c ->
                                Column(Modifier.width(72.dp).clickable { openConv(c) }, horizontalAlignment = Alignment.CenterHorizontally) {
                                    Box(contentAlignment = Alignment.TopEnd) {
                                        Avatar(convAvatar(c), 56)
                                        RoundBadge(c.unread)
                                    }
                                    Text(convTitle(c), color = TextMain, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                                }
                            }
                        }
                    }
                    val rows = recent.mapNotNull { r ->
                        when (r.kind) {
                            "conv" -> convById[r.id]?.let { r to it }
                            "extra" -> extraByKey[r.id]?.let { r to it }
                            else -> r to r
                        }
                    }
                    if (rows.isEmpty()) {
                        item("hint") { SearchHint("搜索聊天、消息内容和用户") }
                    } else {
                        item("recent-head") {
                            SectionHead("最近", "清空") { recent = emptyList(); saveRecent(ctx, emptyList()) }
                        }
                        items(rows, key = { "${it.first.kind}-${it.first.id}" }) { (r, v) ->
                            when (v) {
                                is ConversationItem -> ConvResultRow(v, "", ::openConv)
                                is SearchExtra -> ExtraResultRow(v, "", ::openExtra)
                                else -> UserResultRow(r.title, r.avatar, r.subtitle, "") { openUser(r) }
                            }
                        }
                    }
                } else if (tab == 0) {
                    items(extraHits, key = { "e-${it.key}" }) { ExtraResultRow(it, keyword, ::openExtra) }
                    items(chatHits, key = { "c-${it.id}" }) { ConvResultRow(it, keyword, ::openConv) }
                    if (userHits.isNotEmpty()) {
                        item("global-head") { SectionHead("全局搜索") }
                        items(userHits, key = { "u-${it.id}" }) { u ->
                            val sub = listOfNotNull(u.age?.takeIf { it > 0 }?.let { "$it 岁" }, u.cityName?.takeIf { it.isNotEmpty() }).joinToString(" · ").ifEmpty { "用户" }
                            UserResultRow(u.nickname, u.avatar, sub, keyword) { openUser(SearchRecent("user", u.id, u.nickname, u.avatar, sub)) }
                        }
                    }
                    if (extraHits.isEmpty() && chatHits.isEmpty() && userHits.isEmpty()) {
                        item("none") { SearchHint(if (loading) "搜索中…" else "没有找到相关聊天") }
                    }
                } else {
                    items(msgHits, key = { "m-${it.id}" }) { m ->
                        MessageResultRow(m, keyword) {
                            val c = convById[m.conversationId]
                            if (c != null) addRecent(SearchRecent("conv", c.id))
                            keyboard?.hide()
                            val title = if (c != null) convTitle(c) else m.title
                            val target = if (c != null) convTarget(c) else m.targetId
                            onOpenMessage(m.conversationId, m.convType, target, if (m.convType == 2) "$title（群）" else title, m.id)
                        }
                    }
                    if (msgHits.isEmpty()) item("none") { SearchHint(if (loading) "搜索中…" else "没有找到相关消息") }
                }
            }
        }
    }
}

@Composable
private fun SearchHint(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 60.dp), contentAlignment = Alignment.Center) {
        Text(text, color = TextDim, fontSize = 14.sp)
    }
}

@Composable
private fun SectionHead(title: String, action: String? = null, onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = TextSub, fontSize = 13.sp, modifier = Modifier.weight(1f))
        if (action != null) Text(action, color = TextSub, fontSize = 13.sp, modifier = Modifier.clickable(onClick = onAction))
    }
}

@Composable
private fun ResultRow(onClick: () -> Unit, leading: @Composable () -> Unit, content: @Composable ColumnScope.() -> Unit, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        leading()
        Column(Modifier.weight(1f).padding(start = 12.dp), content = content)
        trailing()
    }
}

@Composable
private fun GroupTag() {
    Text(
        "群", color = TextSub, fontSize = 10.sp,
        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(Bg3).padding(horizontal = 4.dp),
    )
}

@Composable
private fun ConvResultRow(c: ConversationItem, keyword: String, onOpen: (ConversationItem) -> Unit) {
    ResultRow(
        onClick = { onOpen(c) },
        leading = { Avatar(convAvatar(c), 44) },
        content = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(highlight(convTitle(c), keyword), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (c.type == 2) GroupTag()
            }
            Text(preview(c.lastMsg), color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        },
        trailing = { RoundBadge(c.unread) },
    )
}

@Composable
private fun ExtraResultRow(e: SearchExtra, keyword: String, onOpen: (SearchExtra) -> Unit) {
    ResultRow(
        onClick = { onOpen(e) },
        leading = { e.icon(44) },
        content = {
            Text(highlight(e.title, keyword), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1)
            Text(e.subtitle, color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        },
        trailing = { RoundBadge(e.unread) },
    )
}

@Composable
private fun UserResultRow(title: String, avatar: String, subtitle: String, keyword: String, onClick: () -> Unit) {
    ResultRow(
        onClick = onClick,
        leading = { Avatar(avatar, 44) },
        content = {
            Text(highlight(title, keyword), color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = TextSub, fontSize = 13.sp, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
        },
    )
}

@Composable
private fun MessageResultRow(m: SearchMsgHit, keyword: String, onClick: () -> Unit) {
    ResultRow(
        onClick = onClick,
        leading = { Avatar(m.avatar, 44) },
        content = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(m.title, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (m.convType == 2) GroupTag()
                }
                Text(shortDate(m.createdAt), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
            }
            val text = buildAnnotatedString {
                if (m.convType == 2 || m.senderNickname == "我") {
                    withStyle(SpanStyle(color = TextMain)) { append("${m.senderNickname}：") }
                }
                append(highlight(m.content, keyword))
            }
            Text(text, color = TextSub, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        },
    )
}
