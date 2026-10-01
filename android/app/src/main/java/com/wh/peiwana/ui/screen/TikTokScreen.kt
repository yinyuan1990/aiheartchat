package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.Moment
import com.wh.peiwana.ui.Avatar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.Accent
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 抖音模式：全屏竖向翻页浏览视频动态 */
@Composable
fun TikTokScreen(onExit: () -> Unit) {
    var items by remember { mutableStateOf<List<Moment>>(emptyList()) }
    val startCall = rememberStartCallAny()
    LaunchedEffect(Unit) {
        items = runCatching { Api.getList<Moment>("/moments/feed?onlyVideo=1") }.getOrDefault(emptyList())
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (items.isEmpty()) {
            Text("暂无视频动态", color = Color.White.copy(alpha = 0.6f), fontSize = 14.sp, modifier = Modifier.align(Alignment.Center))
        } else {
            val startPage = items.indexOfFirst { it.id == PlazaCache.tiktokStartId }.let { if (it >= 0) it else 0 }
            val pagerState = rememberPagerState(initialPage = startPage, pageCount = { items.size })
            VerticalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
                TikTokPage(
                    m = items[page],
                    // 停稳后才播放：滑动过程中所有页面静音，避免声画不同步
                    playing = pagerState.settledPage == page && !pagerState.isScrollInProgress,
                    onVideoCall = { m -> m.user?.let { startCall(it.id, it.nickname, it.avatar, 2) } },
                )
            }
        }
        // 关闭按钮
        Box(
            modifier = Modifier.align(Alignment.TopStart).padding(start = 16.dp, top = 54.dp)
                .size(38.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.15f)).noRippleClick(onExit),
            contentAlignment = Alignment.Center,
        ) { Text("×", color = Color.White, fontSize = 22.sp) }
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun TikTokPage(m: Moment, playing: Boolean, onVideoCall: (Moment) -> Unit) {
    val ctx = LocalContext.current
    var liked by remember { mutableStateOf(m.liked) }
    var likeCount by remember { mutableIntStateOf(m.likeCount) }
    val scope = rememberCoroutineScope()

    val player = remember {
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(androidx.media3.common.MediaItem.fromUri(Api.fullUrl(m.videoUrl)))
            repeatMode = androidx.media3.common.Player.REPEAT_MODE_ONE
            prepare()
        }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }
    LaunchedEffect(playing) {
        if (playing) { player.seekTo(0); player.play() } else player.pause()
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize().noRippleClick { if (player.isPlaying) player.pause() else player.play() },
            factory = {
                androidx.media3.ui.PlayerView(it).apply {
                    this.player = player
                    useController = false
                    resizeMode = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
                }
            },
        )

        // 底部信息 + 右侧操作
        Row(modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(16.dp, 0.dp, 16.dp, 50.dp), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(m.user?.avatar, 40)
                    Spacer(Modifier.width(8.dp))
                    Text(m.user?.nickname ?: "", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    if (m.cityName.isNotEmpty()) {
                        Spacer(Modifier.width(6.dp))
                        Text(m.cityName, color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp)
                    }
                }
                if (m.content.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(m.content, color = Color.White.copy(alpha = 0.9f), fontSize = 14.sp, maxLines = 2)
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    if (liked) "♥" else "♡", color = if (liked) Accent else Color.White, fontSize = 30.sp,
                    modifier = Modifier.noRippleClick {
                        scope.launch {
                            runCatching {
                                val r = Api.request("/moments/${m.id}/like", "POST")
                                val nl = (r as? JsonObject)?.get("liked")?.jsonPrimitive?.content == "true"
                                liked = nl; likeCount += if (nl) 1 else -1
                            }
                        }
                    },
                )
                Text("$likeCount", color = Color.White, fontSize = 12.sp)
                // 视频通话仅男方可发起；对方离线置灰
                if (com.wh.peiwana.net.Session.gender == 1) {
                    val peerOnline = m.user?.online == true
                    Spacer(Modifier.height(18.dp))
                    Box(
                        modifier = Modifier.clip(RoundedCornerShape(15.dp))
                            .background(if (peerOnline) Accent.copy(alpha = 0.85f) else Color.White.copy(alpha = 0.15f))
                            .noRippleClick {
                                if (peerOnline) onVideoCall(m)
                                else android.widget.Toast.makeText(ctx, "对方不在线", android.widget.Toast.LENGTH_SHORT).show()
                            }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    ) { Text(if (peerOnline) "视频通话" else "对方离线", color = Color.White.copy(alpha = if (peerOnline) 1f else 0.5f), fontSize = 12.sp) }
                }
            }
        }
    }
}
