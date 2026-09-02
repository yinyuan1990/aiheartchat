package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.zIndex
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.UserProfile
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch

/** 抖音式底部导航：广场 大厅 [+] 消息 我的 */
@Composable
fun MainScreen(
    initialUser: UserProfile?,
    onOpenChat: (convId: String, convType: Int, targetId: String, title: String) -> Unit,
    onOpenChatWithUser: (userId: String, nickname: String) -> Unit,
    onNav: (String) -> Unit,
) {
    // rememberSaveable：从详情页等返回时恢复所在 tab（不再总是回到广场）
    var tab by androidx.compose.runtime.saveable.rememberSaveable { mutableIntStateOf(0) }
    var meKey by remember { mutableIntStateOf(0) }
    var unreadTotal by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    // 未读总数（私聊+群聊+评论+接单），消息到达实时刷新
    fun refreshUnread() {
        scope.launch {
            runCatching {
                val convs = com.wh.peiwana.net.Api.getList<ConversationItem>("/im/conversations")
                val n = com.wh.peiwana.net.Api.getObj<com.wh.peiwana.net.UnreadCounts>("/notifications/unread")
                unreadTotal = convs.sumOf { it.unread } + n.comment + n.task
            }
        }
    }
    LaunchedEffect(tab) {
        refreshUnread()
        // 切换页面停止列表内正在播放的视频
        FeedVideoCenter.current?.pause()
    }
    DisposableEffect(Unit) {
        val remove = com.wh.peiwana.net.WsClient.addListener { frame ->
            val op = (frame["op"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            if (op == "msg" || op == "notify") refreshUnread()
        }
        onDispose { remove() }
    }

    Scaffold(
        containerColor = Bg,
        bottomBar = {
            Row(
                modifier = Modifier.fillMaxWidth().background(Color.Black).padding(vertical = 8.dp).navigationBarsPadding(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TabText("广场", tab == 0, Modifier.weight(1f)) { tab = 0 }
                TabText("大厅", tab == 1, Modifier.weight(1f)) { tab = 1 }
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    Box(modifier = Modifier.size(44.dp, 30.dp).clip(RoundedCornerShape(8.dp)).background(Color.White).clickable { onNav("publish") }, contentAlignment = Alignment.Center) {
                        Text("+", color = Color.Black, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    }
                }
                TabText("消息", tab == 2, Modifier.weight(1f), badge = unreadTotal) { tab = 2 }
                TabText("我的", tab == 3, Modifier.weight(1f)) {
                    if (tab != 3) meKey++
                    tab = 3
                }
            }
        },
    ) { pad ->
        // 四个页面常驻保活（对齐 iOS）：切 tab 不销毁重建，状态/数据/滚动位置全保留
        Box(Modifier.padding(pad)) {
            Pane(active = tab == 0) {
                PlazaScreen(onOpenDetail = { onNav("moment/$it") }, onOpenChat = onOpenChatWithUser, onOpenTiktok = { onNav("tiktok") }, onOpenUser = { onNav("u/$it") })
            }
            Pane(active = tab == 1) {
                HallScreen(
                    onOpenProject = { entry -> if (entry == "guide") onNav("project/guide") },
                    onOpenChat = { convId, convType, targetId, title ->
                        onNav("chatroom/$convId?convType=$convType&targetId=$targetId&title=${android.net.Uri.encode(title)}")
                    },
                    onOpenWeb = { url, title, landscape ->
                        val route = "web?url=${android.net.Uri.encode(url)}&title=${android.net.Uri.encode(title)}&landscape=$landscape"
                        GameLog.d("main: nav -> $route")
                        runCatching { onNav(route) }.onFailure { GameLog.e("main: nav failed", it) }
                    },
                )
            }
            Pane(active = tab == 2) {
                MessagesScreen(
                    onOpenChat = onOpenChat,
                    onOpenMoment = { onNav("moment/$it") },
                    onOpenTask = { onNav("task/$it") },
                    onCreateGroup = { onNav("create-group") },
                    onOpenAi = { onNav("aichat") },
                    onOpenNews = { onNav("news") },
                    onJoinGroup = { onNav("join-group") },
                )
            }
            Pane(active = tab == 3) {
                // 每次切到「我的」重建刷新（余额/资料保持最新）
                androidx.compose.runtime.key(meKey) {
                    MeScreen(initialUser = initialUser, onNav = onNav)
                }
            }
        }
    }
}

/** 保活页面容器：当前页置顶显示，其余页隐藏在底层（不销毁、不响应点击） */
@Composable
private fun Pane(active: Boolean, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .zIndex(if (active) 1f else 0f)
            .alpha(if (active) 1f else 0f)
            .background(Bg),
    ) { content() }
}

@Composable
private fun TabText(text: String, active: Boolean, modifier: Modifier, badge: Int = 0, onClick: () -> Unit) {
    val src = remember { MutableInteractionSource() }
    Box(modifier = modifier.clickable(interactionSource = src, indication = null, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, color = if (active) Color.White else TextSub, fontSize = if (active) 17.sp else 16.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal)
        // 未读角标（红色正圆数字）
        com.wh.peiwana.ui.RoundBadge(
            badge,
            Modifier.align(Alignment.TopCenter).padding(start = 52.dp),
        )
    }
}
