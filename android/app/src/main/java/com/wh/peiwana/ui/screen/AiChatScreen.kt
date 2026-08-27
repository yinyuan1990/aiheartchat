package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.EmptyHint
import com.wh.peiwana.ui.NavBar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class AiMsg(
    val id: String = "0",
    val role: String = "user",
    val content: String = "",
    val createdAt: String = "",
)

/** 把回复拆成 文字说明 + HTML 文档（AI 写攻略/页面时输出 ```html 代码块） */
private fun extractHtml(content: String): Pair<String, String?> {
    val fence = Regex("```html\\s*([\\s\\S]*?)```", RegexOption.IGNORE_CASE).find(content)
    if (fence != null) return content.replace(fence.value, "").trim() to fence.groupValues[1].trim()
    val bare = Regex("<!DOCTYPE html[\\s\\S]*</html\\s*>|<html[\\s\\S]*</html\\s*>", RegexOption.IGNORE_CASE).find(content)
    if (bare != null) return content.replace(bare.value, "").trim() to bare.value
    return content to null
}

/** AI 助手：免费问答，历史存服务端（GET /ai/messages POST /ai/chat POST /ai/clear） */
@Composable
fun AiChatScreen(myAvatar: String, onBack: () -> Unit) {
    var messages by remember { mutableStateOf<List<AiMsg>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var thinking by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    LaunchedEffect(Unit) {
        messages = runCatching { Api.getList<AiMsg>("/ai/messages") }.getOrDefault(emptyList())
    }
    LaunchedEffect(messages.size, thinking) {
        val n = messages.size + if (thinking) 1 else 0
        if (n > 0) runCatching { listState.scrollToItem(n - 1) }
    }

    fun send() {
        val text = input.trim()
        if (text.isEmpty() || thinking) return
        input = ""
        messages = messages + AiMsg(id = "local_${System.currentTimeMillis()}", role = "user", content = text)
        thinking = true
        scope.launch {
            runCatching {
                val data = Api.request("/ai/chat", "POST", buildJsonObject { put("content", text) })
                Api.json.decodeFromJsonElement(AiMsg.serializer(), data!!)
            }.onSuccess { reply ->
                messages = messages + reply
            }.onFailure { e ->
                android.widget.Toast.makeText(ctx, e.message ?: "AI 暂时不可用", android.widget.Toast.LENGTH_SHORT).show()
            }
            thinking = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("AI 助手", onBack) {
            Text("清空", color = TextSub, fontSize = 13.sp, modifier = Modifier.noRippleClick {
                scope.launch {
                    runCatching { Api.request("/ai/clear", "POST") }
                    messages = emptyList()
                }
            })
        }

        Box(Modifier.weight(1f)) {
            if (messages.isEmpty() && !thinking) {
                EmptyHint("我是 AI 助手，完全免费\n有什么想问的尽管说")
            } else {
                LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp, 8.dp)) {
                    itemsIndexed(messages, key = { _, m -> m.id }) { _, m ->
                        AiBubble(m.content, mine = m.role == "user", myAvatar = myAvatar, onOpenHtml = { preview = it })
                    }
                    if (thinking) {
                        item(key = "thinking") { AiBubble("正在思考…", mine = false, dim = true) }
                    }
                }
            }
        }

        // 底部输入区（对齐聊天页：圆角输入框 + 有文字才显示发送键）
        Row(
            Modifier.fillMaxWidth().background(Bg2).padding(8.dp)
                .navigationBarsPadding().imePadding(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(20.dp)).background(Bg3)
                    .padding(14.dp, 10.dp),
            ) {
                if (input.isEmpty()) Text("随便问点什么…", color = TextDim, fontSize = 14.sp)
                BasicTextField(
                    value = input,
                    onValueChange = { input = it },
                    textStyle = TextStyle(color = TextMain, fontSize = 14.sp),
                    cursorBrush = SolidColor(Accent),
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (input.trim().isNotEmpty() && !thinking) {
                Box(
                    Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Accent)
                        .noRippleClick { send() }.padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("发送", color = Color.White, fontSize = 14.sp)
                }
            }
        }
    }

    // AI 生成的网页全屏预览（共用组件）
    preview?.let { html ->
        com.wh.peiwana.ui.WebPreviewDialog(html = html, onClose = { preview = null })
    }
}

/** AI 对话气泡：AI 在左（带渐变 AI 头像），我在右（带自己头像）；AI 回复带 HTML 时显示可点开的网页卡片 */
@Composable
private fun AiBubble(content: String, mine: Boolean, dim: Boolean = false, myAvatar: String = "", onOpenHtml: (String) -> Unit = {}) {
    val (text, html) = if (mine) content to null else remember(content) { extractHtml(content) }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (mine) Spacer(Modifier.width(50.dp))
        if (!mine) {
            Box(
                Modifier.size(38.dp).clip(RoundedCornerShape(19.dp))
                    .background(Brush.horizontalGradient(listOf(Accent, Accent2))),
                contentAlignment = Alignment.Center,
            ) {
                Text("AI", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold)
            }
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            if (text.isNotEmpty()) {
                Box(
                    Modifier
                        .clip(
                            if (mine) RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp)
                            else RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp),
                        )
                        .background(if (mine) BubbleMine else Bg3)
                        .padding(14.dp, 10.dp),
                ) {
                    Text(
                        text,
                        color = if (dim) TextSub else if (mine) Color.White else TextMain,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                    )
                }
            }
            if (html != null) {
                Row(
                    Modifier.padding(top = if (text.isNotEmpty()) 6.dp else 0.dp)
                        .clip(RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp)).background(Bg3)
                        .noRippleClick { onOpenHtml(html) }.padding(14.dp, 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("🌐", fontSize = 22.sp)
                    Column {
                        Text("网页内容", color = TextMain, fontSize = 14.sp)
                        Text("点击打开预览 ›", color = Accent, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
        if (mine) {
            Spacer(Modifier.width(8.dp))
            com.wh.peiwana.ui.Avatar(myAvatar, 38)
        }
        if (!mine) Spacer(Modifier.width(50.dp))
    }
}
