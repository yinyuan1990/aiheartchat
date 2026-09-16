package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.UserProfile
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.serialization.Serializable

@Serializable
data class InviteMine(
    val code: String = "",
    val link: String = "",
    val clicks30d: Int = 0,
    val invited: Int = 0,
    val recent: List<InvitedUser> = emptyList(),
)

@Serializable
data class InvitedUser(val id: String, val nickname: String = "", val avatar: String = "", val gender: Int = 0, val createdAt: String = "")

/**
 * 我的邀请名片：专属网页（yyheart.com/t/?u=短号）链接 + 二维码。
 * 女生发给男生：他下载后自动打开她的主页；男生发给女生：她下载后自动和他成为好友。
 */
@Composable
fun InviteCardScreen(me: UserProfile?, onBack: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var info by remember { mutableStateOf<InviteMine?>(null) }
    var error by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        runCatching { Api.getObj<InviteMine>("/app/invite/mine") }
            .onSuccess { info = it }
            .onFailure { error = it.message ?: "加载失败" }
    }

    val isFemale = me?.gender == 2
    val shareText = if (isFemale) "我在心之音等你，来和我聊聊："
    else "我在心之音，想请你来聊聊，你的时间在这里每一分钟都算钱："

    fun toast(s: String) = android.widget.Toast.makeText(ctx, s, android.widget.Toast.LENGTH_SHORT).show()
    fun shareLink(link: String) {
        runCatching {
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(android.content.Intent.EXTRA_TEXT, "$shareText$link")
            }
            ctx.startActivity(android.content.Intent.createChooser(intent, "分享我的邀请名片"))
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("我的邀请名片", onBack)
        val i = info
        when {
            i == null && error.isNotEmpty() -> EmptyHint(error)
            i == null -> EmptyHint("加载中…")
            else -> Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // 名片预览
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp))
                        .background(Brush.linearGradient(listOf(Color(0xFF1C1219), Color(0xFF121216))))
                        .border(1.dp, Accent.copy(alpha = 0.45f), RoundedCornerShape(20.dp))
                        .padding(18.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(me?.avatar, 52)
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text("心之音 · 专属名片", color = TextSub, fontSize = 11.sp)
                            Text(me?.nickname ?: "", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                            Text("邀请码 ${i.code}", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                    Text(
                        if (isFemale) "发给男生：他打开网页能看到你的照片、价格和评分，下载后自动打开你的主页，第一条消息就是你的收入。"
                        else "发给女生：她打开网页能看到你的名片和在这里的收入方式，下载后自动和你成为好友。",
                        color = TextSub, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 14.dp),
                    )
                    // 二维码
                    val qr = remember(i.link) { makeQrBitmap(i.link, 520) }
                    Box(Modifier.padding(top = 16.dp).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        androidx.compose.foundation.Image(
                            bitmap = qr.asImageBitmap(), contentDescription = null,
                            modifier = Modifier.size(190.dp).clip(RoundedCornerShape(12.dp)).background(Color.White).padding(6.dp),
                        )
                    }
                    // 链接 + 复制
                    Row(
                        Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3)
                            .noRippleClick {
                                clipboard.setText(androidx.compose.ui.text.AnnotatedString(i.link))
                                toast("链接已复制")
                            }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(i.link.removePrefix("https://"), color = TextMain, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1)
                        Text("复制", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Row(Modifier.padding(top = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            "保存二维码", color = TextMain, fontSize = 14.sp,
                            modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp)).background(Bg3)
                                .noRippleClick { toast(if (saveQrToGallery(ctx, qr, "邀请名片")) "已保存到相册" else "保存失败") }
                                .padding(vertical = 12.dp),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        Text(
                            "分享链接", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp)).background(AccentBrush)
                                .noRippleClick { shareLink(i.link) }
                                .padding(vertical = 12.dp),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                }

                // 统计
                Row(Modifier.padding(top = 14.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    listOf("${i.clicks30d}" to "30 天内被打开", "${i.invited}" to "成功邀请").forEach { (n, label) ->
                        Column(
                            Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(Bg2).padding(vertical = 14.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(n, color = TextMain, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Text(label, color = TextSub, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                }

                if (i.recent.isNotEmpty()) {
                    Text("通过我加入的人", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 18.dp, bottom = 6.dp).align(Alignment.Start))
                    i.recent.forEach { u ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(u.avatar, 38)
                            Text(u.nickname, color = TextMain, fontSize = 14.sp, modifier = Modifier.weight(1f).padding(start = 12.dp))
                            Text(u.createdAt.take(10), color = TextDim, fontSize = 11.sp)
                        }
                    }
                }
                Spacer(Modifier.height(30.dp))
            }
        }
    }
}
