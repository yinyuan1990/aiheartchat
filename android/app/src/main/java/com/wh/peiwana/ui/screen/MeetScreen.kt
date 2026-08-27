package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.MeetUser
import com.wh.peiwana.net.Session
import com.wh.peiwana.net.fmtPoints
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch

/** 遇见页进程级缓存：返回时原样恢复不跳动 */
object MeetCache {
    var items: List<MeetUser> = emptyList()
    var tab: String = "all"
}

/**
 * 主页「遇见」：异性用户卡片流。
 * 子栏：所有 / 新人 / 同城 / 亲密度（亲密度按互动记分倒序）。
 */
@Composable
fun MeetSection(
    city: String,
    onOpenUser: (String) -> Unit,
    startCall: (String, String, String, Int) -> Unit,
) {
    var tab by remember { mutableStateOf(MeetCache.tab) }
    var items by remember { mutableStateOf(MeetCache.items) }
    var loading by remember { mutableStateOf(false) }
    LaunchedEffect(tab) { MeetCache.tab = tab }
    LaunchedEffect(items) { MeetCache.items = items }
    val scope = rememberCoroutineScope()

    suspend fun loadNow() {
        val q = buildString {
            append("?tab=$tab")
            if (tab == "city" && city.isNotEmpty()) append("&city=$city")
        }
        val fresh = runCatching { Api.getList<MeetUser>("/user/meet/list$q") }.getOrNull() ?: return
        items = fresh
    }

    LaunchedEffect(tab, city) {
        loading = items.isEmpty()
        loadNow()
        loading = false
    }
    // 在线/占线状态兜底：30 秒静默刷新
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            loadNow()
        }
    }

    Column(Modifier.fillMaxSize()) {
        // 子栏胶囊：所有 / 新人 / 同城 / 亲密度
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp, 2.dp, 16.dp, 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("all" to "所有", "new" to "新人", "city" to "同城", "intimacy" to "亲密度").forEach { (k, label) ->
                val sel = tab == k
                Text(
                    label,
                    color = if (sel) Color.White else TextSub,
                    fontSize = 13.sp,
                    fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier
                        .clip(RoundedCornerShape(15.dp))
                        .background(if (sel) Accent else Bg2)
                        .noRippleClick { tab = k }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }
        }

        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize()) {
                EmptyHint(
                    when {
                        loading -> "加载中…"
                        tab == "intimacy" -> "还没有亲密的人\n聊天、视频、点赞评论都会累计亲密度"
                        tab == "city" -> "「${city.ifEmpty { "同城" }}」还没有人\n切到所有看看"
                        else -> "暂时没有人"
                    },
                )
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(items, key = { it.id }) { u ->
                    MeetCard(u, showIntimacy = tab == "intimacy", onOpen = { onOpenUser(u.id) }, startCall = startCall)
                }
            }
        }
    }
}

@Composable
private fun MeetCard(
    u: MeetUser,
    showIntimacy: Boolean,
    onOpen: () -> Unit,
    startCall: (String, String, String, Int) -> Unit,
) {
    val ctx = LocalContext.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(3f / 4f)
            .clip(RoundedCornerShape(14.dp))
            .background(Bg2)
            .noRippleClick(onOpen),
    ) {
        if (u.avatar.isNotEmpty()) {
            AsyncImage(
                model = Api.fullUrl(u.avatar), contentDescription = null,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            )
        }
        // 顶部徽章：已认证 > 新人
        Row(Modifier.align(Alignment.TopStart).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (u.isGuide || u.realnameVerified) {
                Text(
                    "已认证", color = Color.White, fontSize = 10.sp,
                    modifier = Modifier.clip(RoundedCornerShape(9.dp)).background(Accent).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            } else if (u.isNew) {
                Text(
                    "新人", color = Color.White, fontSize = 10.sp,
                    modifier = Modifier.clip(RoundedCornerShape(9.dp)).background(Color(0xFF6C5CE7)).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
        // 右上：在线小点
        Box(
            Modifier.align(Alignment.TopEnd).padding(10.dp).size(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(if (u.online) Success else TextDim),
        )
        // 底部信息浮层（渐变压暗保证可读）
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                .padding(10.dp, 26.dp, 10.dp, 9.dp),
        ) {
            Text(u.nickname, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                // 评分五星换算（0-100 → 5.0）
                Text(
                    "★ ${if (u.ratingCount > 0) "%.1f".format(u.ratingAvg / 20.0) else "新"}",
                    color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Warn.copy(alpha = 0.85f)).padding(horizontal = 6.dp, vertical = 1.dp),
                )
                if (u.cityName.isNotEmpty()) {
                    Spacer(Modifier.width(6.dp))
                    Text(u.cityName, color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                }
                Spacer(Modifier.weight(1f))
                if (showIntimacy && u.intimacy > 0) {
                    Text(
                        "♥ ${if (u.intimacy % 1.0 == 0.0) u.intimacy.toInt().toString() else "%.1f".format(u.intimacy)}",
                        color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Accent.copy(alpha = 0.9f)).padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                } else if (Session.gender == 1 && u.gender == 2) {
                    // 视频按钮三态：通话中 / 离线置灰 / 可打（显示价格）
                    val busyColor = Color(0xFFFFAA3C)
                    Text(
                        when {
                            u.busy -> "通话中"
                            u.videoPriceFen > 0 -> "视频 ${fmtPoints(u.videoPriceFen.toString())}/分"
                            else -> "视频"
                        },
                        color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(10.dp))
                            .background(if (u.busy) busyColor.copy(alpha = 0.9f) else if (u.online) Accent else TextDim.copy(alpha = 0.8f))
                            .noRippleClick {
                                when {
                                    u.busy -> android.widget.Toast.makeText(ctx, "对方正在通话中，请稍后再试", android.widget.Toast.LENGTH_SHORT).show()
                                    !u.online -> android.widget.Toast.makeText(ctx, "对方不在线", android.widget.Toast.LENGTH_SHORT).show()
                                    else -> startCall(u.id, u.nickname, u.avatar, 2)
                                }
                            }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
        }
    }
}
