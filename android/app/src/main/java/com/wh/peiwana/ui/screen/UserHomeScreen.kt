package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import com.wh.peiwana.net.HomeProfile
import com.wh.peiwana.net.Moment
import com.wh.peiwana.net.Session
import com.wh.peiwana.net.fmtPoints
import com.wh.peiwana.rtc.CallManager
import com.wh.peiwana.ui.Avatar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.Accent
import com.wh.peiwana.ui.theme.Accent2
import com.wh.peiwana.ui.theme.Bg
import com.wh.peiwana.ui.theme.Bg2
import com.wh.peiwana.ui.theme.Bg3
import com.wh.peiwana.ui.theme.Line
import com.wh.peiwana.ui.theme.Success
import com.wh.peiwana.ui.theme.TextDim
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub
import kotlinx.coroutines.launch

private val BusyOrange = Color(0xFFFFAA3C)

private fun fmtDate(s: String): String =
    if (s.length >= 10) "${s.substring(5, 7)}月${s.substring(8, 10)}日" else ""

/** 他人主页：顶部大图 hero + 圆角资料卡（关于我/我的动态 tab）+ 底部操作栏 */
@Composable
fun UserHomeScreen(
    userId: String,
    onBack: () -> Unit,
    onOpenChat: (String, String) -> Unit,
    onOpenMoment: (String) -> Unit,
) {
    var p by remember { mutableStateOf<HomeProfile?>(null) }
    var moments by remember { mutableStateOf<List<Moment>>(emptyList()) }
    var following by remember { mutableStateOf(false) }
    var showGift by remember { mutableStateOf(false) }
    var tab by remember { mutableIntStateOf(0) }
    var wallImage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    LaunchedEffect(userId) {
        p = runCatching { Api.getObj<HomeProfile>("/user/$userId") }.getOrNull()
        following = p?.isFollowing == true
        moments = runCatching { Api.getList<Moment>("/moments/user/$userId") }.getOrDefault(emptyList())
    }

    val profile = p
    if (profile == null) {
        Box(Modifier.fillMaxSize().background(Bg), contentAlignment = Alignment.Center) {
            Text("加载中…", color = TextDim, fontSize = 13.sp)
        }
        return
    }
    val isFemale = profile.gender == 2
    val canVideo = Session.gender == 1 && isFemale

    Box(Modifier.fillMaxSize().background(Bg)) {
        LazyColumn(Modifier.fillMaxSize()) {
            // ===== 顶部大图 hero：头像 + 照片墙横滑轮播 =====
            item {
                val heroImages = (listOf(profile.avatar) + profile.albums.filter { it.type == 1 }.map { it.url })
                    .filter { it.isNotEmpty() }.distinct()
                val pagerState = androidx.compose.foundation.pager.rememberPagerState { heroImages.size.coerceAtLeast(1) }
                // 自动轮播：3.5 秒翻页，用户滑动时跳过本次
                if (heroImages.size > 1) {
                    LaunchedEffect(heroImages.size) {
                        while (true) {
                            kotlinx.coroutines.delay(3500)
                            if (!pagerState.isScrollInProgress) {
                                pagerState.animateScrollToPage((pagerState.currentPage + 1) % heroImages.size)
                            }
                        }
                    }
                }
                Box(Modifier.fillMaxWidth().aspectRatio(0.82f).background(Bg2)) {
                    if (heroImages.isNotEmpty()) {
                        androidx.compose.foundation.pager.HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { pageIdx ->
                            AsyncImage(
                                model = Api.fullUrl(heroImages[pageIdx]), contentDescription = null,
                                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                    // 页码圆点（多图才显示）
                    if (heroImages.size > 1) {
                        Row(
                            Modifier.align(Alignment.BottomCenter).padding(bottom = 30.dp),
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            repeat(heroImages.size) { i ->
                                Box(
                                    Modifier.size(if (i == pagerState.currentPage) 7.dp else 5.dp)
                                        .clip(CircleShape)
                                        .background(if (i == pagerState.currentPage) Color.White else Color.White.copy(alpha = 0.4f)),
                                )
                            }
                        }
                    }
                    // 底部压暗，保证叠层文字可读
                    Box(
                        Modifier.fillMaxSize().background(
                            Brush.verticalGradient(
                                0f to Color.Transparent, 0.55f to Color.Transparent, 1f to Bg.copy(alpha = 0.9f),
                            ),
                        ),
                    )
                    // 返回按钮
                    Box(
                        Modifier.statusBarsPadding().padding(12.dp).size(34.dp)
                            .clip(CircleShape).background(Color.Black.copy(alpha = 0.35f))
                            .noRippleClick(onBack),
                        contentAlignment = Alignment.Center,
                    ) { Text("‹", color = Color.White, fontSize = 22.sp) }
                    // 左下叠层：接通率 / 视频价格（仅女生）
                    Column(
                        Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = 34.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        if (isFemale && profile.answerRate != null && profile.answerRate >= 0) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text("${profile.answerRate}", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                                Text(" % 接通率", color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp))
                            }
                        }
                        if (isFemale && profile.videoPriceActualFen > 0) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text(fmtPoints(profile.videoPriceActualFen.toString()), color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                                Text(" 积分/分钟", color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp))
                            }
                        }
                    }
                }
            }

            // ===== 圆角资料卡：tab 行 + 关注按钮 =====
            item {
                Column(
                    Modifier.fillMaxWidth().offset(y = (-20).dp)
                        .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                        .background(Bg)
                        .padding(top = 18.dp),
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TabLabel("关于我", tab == 0) { tab = 0 }
                        Spacer(Modifier.width(24.dp))
                        TabLabel("我的动态", tab == 1) { tab = 1 }
                        Spacer(Modifier.weight(1f))
                        // 关注胶囊
                        Box(
                            Modifier.clip(RoundedCornerShape(50))
                                .background(
                                    if (following) Brush.horizontalGradient(listOf(Bg3, Bg3))
                                    else Brush.horizontalGradient(listOf(Accent, Accent2)),
                                )
                                .noRippleClick {
                                    scope.launch {
                                        runCatching {
                                            val r = Api.request("/user/${profile.id}/follow", "POST")
                                            following = (r as? kotlinx.serialization.json.JsonObject)?.get("following")
                                                ?.let { (it as kotlinx.serialization.json.JsonPrimitive).content == "true" } ?: !following
                                        }
                                    }
                                }
                                .padding(horizontal = 18.dp, vertical = 8.dp),
                        ) {
                            Text(
                                if (following) "已关注" else "＋ 关注",
                                color = if (following) TextSub else Color.White,
                                fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                    Spacer(Modifier.height(18.dp))
                }
            }

            if (tab == 0) {
                // ===== 关于我 =====
                item {
                    Column(Modifier.fillMaxWidth().offset(y = (-20).dp).background(Bg).padding(horizontal = 16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(profile.nickname, color = TextMain, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Spacer(Modifier.width(8.dp))
                            val (stColor, stText) = when {
                                profile.busy -> BusyOrange to "通话中"
                                profile.online -> Success to "在线"
                                else -> TextDim to "离线"
                            }
                            Text("● $stText", color = stColor, fontSize = 11.sp)
                        }
                        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                "${if (profile.gender == 1) "男" else "女"} ${profile.age}",
                                color = if (profile.gender == 1) Color(0xFF6DB3FF) else Color(0xFFFF7A95), fontSize = 11.sp,
                                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Color.White.copy(alpha = 0.07f)).padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                            if (profile.cityName.isNotEmpty()) {
                                Text(
                                    profile.cityName, color = TextSub, fontSize = 11.sp,
                                    modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Color.White.copy(alpha = 0.07f)).padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                        }
                        if (profile.signature.isNotEmpty()) {
                            Text(profile.signature, color = TextSub, fontSize = 13.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 12.dp))
                        }
                        // 数据行：关注 / 粉丝（评分独立展示在下方）
                        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                            StatCell("${profile.following}", "关注", TextMain)
                            StatCell("${profile.fans}", "粉丝", TextMain)
                        }
                        // ===== 评分：星级总分 + 五维度方格，最高维度渐变高亮 =====
                        val r = profile.rating
                        if (isFemale && r != null && r.count > 0) {
                            val star = r.avg / 20.0
                            val filled = Math.round(star).toInt().coerceIn(0, 5)
                            Row(Modifier.padding(top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("评分", color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.width(8.dp))
                                Text("★".repeat(filled) + "☆".repeat(5 - filled), color = Accent, fontSize = 13.sp)
                                Spacer(Modifier.width(6.dp))
                                Text("%.1f".format(star), color = Accent, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                                Spacer(Modifier.width(6.dp))
                                Text("${r.count}次评价", color = TextDim, fontSize = 11.sp)
                            }
                            // 按分从高到低排成 3+2 方格，第一格（她最突出的）用渐变填充
                            val dims = listOf(
                                "真实度" to r.photo, "配合度" to r.obedience,
                                "腿型" to r.legs, "曲线" to r.chest, "肤质" to r.skin,
                            ).sortedByDescending { it.second }
                            dims.chunked(3).forEachIndexed { rowI, rowItems ->
                                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    rowItems.forEachIndexed { colI, (label, score) ->
                                        val best = rowI == 0 && colI == 0 && score > 0
                                        Column(
                                            Modifier.weight(1f).clip(RoundedCornerShape(10.dp))
                                                .then(
                                                    if (best) Modifier.background(Brush.horizontalGradient(listOf(Accent, Accent2)))
                                                    else Modifier.background(Color.White.copy(alpha = 0.06f)),
                                                )
                                                .padding(vertical = 10.dp),
                                            horizontalAlignment = Alignment.CenterHorizontally,
                                        ) {
                                            Text(
                                                "%.1f".format(score / 20.0),
                                                color = if (best) Color.White else TextMain,
                                                fontSize = 16.sp, fontWeight = FontWeight.Bold,
                                            )
                                            Text(
                                                label,
                                                color = if (best) Color.White.copy(alpha = 0.9f) else TextSub,
                                                fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                                            )
                                        }
                                    }
                                    repeat(3 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                        // 照片墙（最多 8 张）
                        val wall = profile.albums.filter { it.type == 1 }
                        if (wall.isNotEmpty()) {
                            Text("照片墙", color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 18.dp))
                            wall.chunked(4).forEach { rowItems ->
                                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    rowItems.forEach { a ->
                                        AsyncImage(
                                            model = Api.fullUrl(a.url), contentDescription = null,
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.weight(1f).aspectRatio(1f)
                                                .clip(RoundedCornerShape(10.dp))
                                                .noRippleClick { wallImage = a.url },
                                        )
                                    }
                                    repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                        // 认证信息：简约行，无背景卡
                        Text("认证信息", color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 18.dp))
                        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                            CertLine("平台认证", profile.isGuide)
                            if (isFemale) CertLine("实名认证", profile.realnameVerified)
                        }
                        Spacer(Modifier.height(120.dp))
                    }
                }
            } else {
                // ===== 我的动态：列表式（参考样式） =====
                if (moments.isEmpty()) {
                    item {
                        Box(Modifier.fillMaxWidth().offset(y = (-20).dp).background(Bg).padding(40.dp), contentAlignment = Alignment.Center) {
                            Text("暂无动态", color = TextDim, fontSize = 13.sp)
                        }
                    }
                }
                items(moments.size) { i ->
                    val m = moments[i]
                    Column(
                        Modifier.fillMaxWidth().offset(y = (-20).dp).background(Bg)
                            .noRippleClick { onOpenMoment(m.id) }
                            .padding(16.dp, 6.dp, 16.dp, 14.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(profile.avatar, 38)
                            Column(Modifier.padding(start = 10.dp)) {
                                Text(profile.nickname, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                Text(fmtDate(m.createdAt), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                            }
                        }
                        if (m.content.isNotEmpty()) {
                            Text(m.content, color = TextMain, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 10.dp))
                        }
                        // 媒体：单图/视频大图（2/3 宽 3:4），两图/三图等分方格铺满整行
                        val thumbs = if (m.type == 2) listOf(m.coverUrl).filter { it.isNotEmpty() } else m.images.take(3)
                        if (thumbs.isNotEmpty()) {
                            if (thumbs.size == 1) {
                                Box(
                                    Modifier.padding(top = 10.dp).fillMaxWidth(0.66f).aspectRatio(0.75f)
                                        .clip(RoundedCornerShape(10.dp)).background(Bg2),
                                ) {
                                    AsyncImage(
                                        model = Api.fullUrl(thumbs[0]), contentDescription = null,
                                        contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                                    )
                                    if (m.type == 2) {
                                        Text(
                                            "▶", color = Color.White, fontSize = 18.sp,
                                            modifier = Modifier.align(Alignment.Center)
                                                .clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)).padding(horizontal = 14.dp, vertical = 10.dp),
                                        )
                                    }
                                }
                            } else {
                                Row(
                                    Modifier.padding(top = 10.dp).fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    thumbs.forEach { u ->
                                        Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(8.dp)).background(Bg2)) {
                                            AsyncImage(
                                                model = Api.fullUrl(u), contentDescription = null,
                                                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                        Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("♡ ${m.likeCount}", color = TextSub, fontSize = 13.sp)
                            Spacer(Modifier.width(18.dp))
                            Text("评论 ${m.commentCount}", color = TextSub, fontSize = 13.sp)
                        }
                        Spacer(Modifier.height(14.dp))
                        Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
                    }
                }
                item { Spacer(Modifier.height(100.dp)) }
            }
        }

        // ===== 底部操作栏：聊天圆钮 + 礼物圆钮 + 视频聊天大按钮 =====
        Row(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Bg.copy(alpha = 0.95f), Bg)))
                .navigationBarsPadding()
                .padding(16.dp, 10.dp, 16.dp, 14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(Bg2)
                    .noRippleClick { onOpenChat(profile.id, profile.nickname) },
                contentAlignment = Alignment.Center,
            ) { Text("聊天", color = TextMain, fontSize = 12.sp) }
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(Bg2)
                    .noRippleClick { showGift = true },
                contentAlignment = Alignment.Center,
            ) { Text("礼物", color = Accent2, fontSize = 12.sp) }
            if (canVideo) {
                val busy = profile.busy
                val online = profile.online
                Box(
                    Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(50))
                        .background(
                            when {
                                busy -> Brush.horizontalGradient(listOf(Bg3, Bg3))
                                !online -> Brush.horizontalGradient(listOf(Bg3, Bg3))
                                else -> Brush.horizontalGradient(listOf(Accent, Accent2))
                            },
                        )
                        .noRippleClick {
                            when {
                                busy -> android.widget.Toast.makeText(context, "对方正在通话中，请稍后再试", android.widget.Toast.LENGTH_SHORT).show()
                                !online -> android.widget.Toast.makeText(context, "对方不在线", android.widget.Toast.LENGTH_SHORT).show()
                                else -> {
                                    CallManager.attachContext(context)
                                    CallManager.startCall(context, profile.id, 2, profile.nickname, profile.avatar)
                                }
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    val mainColor = when {
                        busy -> BusyOrange
                        !online -> TextDim
                        else -> Color.White
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            if (busy) "通话中" else "视频聊天",
                            color = mainColor, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                        )
                        if (!busy) {
                            when {
                                !online -> Text("对方离线", color = TextDim, fontSize = 10.sp)
                                profile.videoPriceActualFen > 0 -> Text(
                                    "${fmtPoints(profile.videoPriceActualFen.toString())}积分/分钟",
                                    color = Color.White.copy(alpha = 0.85f), fontSize = 10.sp,
                                )
                            }
                        }
                    }
                }
            } else {
                Box(
                    Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(50))
                        .background(Brush.horizontalGradient(listOf(Accent, Accent2)))
                        .noRippleClick { onOpenChat(profile.id, profile.nickname) },
                    contentAlignment = Alignment.Center,
                ) { Text("发消息", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
            }
        }
    }

    if (showGift) {
        GiftSheet(toUserId = profile.id, onClose = { showGift = false })
    }

    // 照片墙大图查看
    wallImage?.let { u ->
        val urls = profile.albums.filter { it.type == 1 }.map { it.url }
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { wallImage = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            com.wh.peiwana.ui.ImageViewer(urls, urls.indexOf(u).coerceAtLeast(0)) { wallImage = null }
        }
    }
}

/** 认证徽章 chip：圆形 ✓ 图标 + 标签，已认证玫红、未认证置灰 */
@Composable
private fun CertLine(label: String, verified: Boolean) {
    // 简约风：勾 + 文字，无背景
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("✓", color = if (verified) Accent else TextDim, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(5.dp))
        Text(if (verified) label else "$label（未认证）", color = if (verified) TextMain else TextDim, fontSize = 13.sp)
    }
}

@Composable
private fun TabLabel(text: String, selected: Boolean, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.noRippleClick(onClick)) {
        Text(
            text,
            color = if (selected) TextMain else TextSub,
            fontSize = if (selected) 16.sp else 15.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
        )
        Spacer(Modifier.height(5.dp))
        Box(
            Modifier.width(20.dp).height(3.dp).clip(RoundedCornerShape(2.dp))
                .background(if (selected) Accent else Color.Transparent),
        )
    }
}

@Composable
private fun StatCell(value: String, label: String, valueColor: Color) {
    Row(verticalAlignment = Alignment.Bottom) {
        Text(value, color = valueColor, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(4.dp))
        Text(label, color = TextDim, fontSize = 12.sp)
    }
}
