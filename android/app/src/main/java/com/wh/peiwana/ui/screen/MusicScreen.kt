package com.wh.peiwana.ui.screen

import android.content.Context
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.EmptyHint
import com.wh.peiwana.ui.NavBar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data class MusicTrack(
    val id: String = "0",
    val title: String = "",
    val performer: String = "",
    val duration: Int = 0,
    val size: Int = 0,
    val url: String = "",
    val cover: String = "",
    val postedAt: String = "",
    val playCount: Int = 0,
)

@Serializable
data class MusicSourceInfo(val title: String = "", val channel: String = "")

@Serializable
data class MusicList(val source: MusicSourceInfo? = null, val list: List<MusicTrack> = emptyList())

/**
 * 全局音乐播放器：单例 ExoPlayer，离开音乐页也继续播（边聊边听）；
 * 打视频/语音电话、播动态视频时由外部调用 pause() 让位。
 */
object MusicCenter {
    private var player: ExoPlayer? = null
    var queue: List<MusicTrack> = emptyList()
        private set
    val current = mutableStateOf<MusicTrack?>(null)
    val isPlaying = mutableStateOf(false)
    val buffering = mutableStateOf(false)
    private val counted = HashSet<String>()

    private fun ensure(ctx: Context): ExoPlayer = player ?: ExoPlayer.Builder(ctx.applicationContext).build().also { p ->
        p.setAudioAttributes(
            androidx.media3.common.AudioAttributes.Builder()
                .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MUSIC).build(),
            true,
        )
        p.setHandleAudioBecomingNoisy(true)
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) { isPlaying.value = playing }
            override fun onPlaybackStateChanged(state: Int) {
                buffering.value = state == Player.STATE_BUFFERING
                if (state == Player.STATE_ENDED) next()
            }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                buffering.value = false
                isPlaying.value = false
            }
        })
        player = p
    }

    fun setQueue(list: List<MusicTrack>) { queue = list }

    /** 点击列表项：同一首切换播放/暂停，不同首切歌 */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    fun play(ctx: Context, t: MusicTrack) {
        val p = ensure(ctx)
        if (current.value?.id == t.id) {
            if (p.isPlaying) p.pause() else p.play()
            return
        }
        // 让动态视频停下来
        FeedVideoCenter.current?.pause()
        current.value = t
        val meta = MediaMetadata.Builder().setTitle(t.title).setArtist(t.performer.ifEmpty { null }).build()
        p.setMediaItem(MediaItem.Builder().setUri(Api.fullUrl(t.url)).setMediaMetadata(meta).build())
        p.prepare()
        p.play()
        if (counted.add(t.id)) {
            kotlinx.coroutines.GlobalScope.launch { runCatching { Api.request("/music/${t.id}/play", "POST") } }
        }
    }

    fun toggle(ctx: Context) {
        val p = ensure(ctx)
        val cur = current.value
        if (cur == null) { queue.firstOrNull()?.let { play(ctx, it) }; return }
        if (p.isPlaying) p.pause() else { if (p.playbackState == Player.STATE_IDLE) p.prepare(); p.play() }
    }

    fun step(ctx: Context, delta: Int) {
        if (queue.isEmpty()) return
        val idx = queue.indexOfFirst { it.id == current.value?.id }
        val nextIdx = if (idx < 0) 0 else ((idx + delta) % queue.size + queue.size) % queue.size
        play(ctx, queue[nextIdx])
    }

    /** 单曲结束自动下一首（循环整个列表） */
    private fun next() {
        val p = player ?: return
        if (queue.isEmpty()) return
        val idx = queue.indexOfFirst { it.id == current.value?.id }
        val t = queue[if (idx < 0) 0 else (idx + 1) % queue.size]
        current.value = t
        p.setMediaItem(MediaItem.Builder().setUri(Api.fullUrl(t.url)).setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.performer.ifEmpty { null }).build()).build())
        p.prepare(); p.play()
    }

    fun pause() { player?.pause() }

    fun positionMs(): Long = player?.currentPosition ?: 0L
    fun durationMs(): Long = player?.duration?.takeIf { it > 0 } ?: 0L
    fun seekTo(ratio: Float) { val d = durationMs(); if (d > 0) player?.seekTo((d * ratio.coerceIn(0f, 1f)).toLong()) }
}

/** 音乐页：列表 + 底部常驻播放器；数据来自后端从 Telegram 频道同步的最近 3 天曲目 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun MusicScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<MusicList?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val current by MusicCenter.current
    val playing by MusicCenter.isPlaying
    val buffering by MusicCenter.buffering

    suspend fun load() {
        val d = runCatching { Api.getObj<MusicList>("/music") }.getOrNull() ?: MusicList()
        data = d
        MusicCenter.setQueue(d.list)
    }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize().background(Bg)) {
        Box {
            NavBar("音乐", onBack)
            data?.source?.title?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = TextDim, fontSize = 10.sp, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 2.dp))
            }
        }
        val d = data
        Box(Modifier.weight(1f)) {
            if (d == null) {
                EmptyHint("加载中…")
            } else androidx.compose.material3.pulltorefresh.PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = if (current != null) 92.dp else 0.dp)) {
                    if (d.list.isEmpty()) item(key = "empty") { EmptyHint("最近 3 天还没有新歌\n稍后再来看看") }
                    else item(key = "head") {
                        Text("只保留最近 3 天 · 共 ${d.list.size} 首", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(16.dp, 10.dp, 16.dp, 2.dp))
                    }
                    items(d.list, key = { it.id }) { t ->
                        val active = current?.id == t.id
                        Row(
                            Modifier.fillMaxWidth().noRippleClick { MusicCenter.play(ctx, t) }.padding(16.dp, 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            MusicCover(t, 52.dp, spinning = active && playing)
                            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(
                                        t.title, color = if (active) Accent else TextMain, fontSize = 15.sp,
                                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                                    )
                                    if (active && playing) PlayingBars()
                                }
                                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    if (t.performer.isNotEmpty()) Text(t.performer, color = TextDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
                                    Text(fmtDur(t.duration.toLong() * 1000), color = TextDim, fontSize = 11.sp)
                                    Text(fmtSize(t.size), color = TextDim, fontSize = 11.sp)
                                    Text(com.wh.peiwana.ui.timeAgo(t.postedAt), color = TextDim, fontSize = 11.sp)
                                }
                            }
                            PlayPauseIcon(playing = active && playing, tint = if (active) Accent else TextDim, size = 20.dp)
                        }
                    }
                }
            }

            // 底部播放器
            current?.let { t ->
                MusicPlayerBar(t, playing, buffering, subtitle = t.performer.ifEmpty { d?.source?.title ?: "" }, modifier = Modifier.align(Alignment.BottomCenter))
            }
        }
    }
}

@Composable
private fun MusicPlayerBar(t: MusicTrack, playing: Boolean, buffering: Boolean, subtitle: String, modifier: Modifier) {
    val ctx = LocalContext.current
    var pos by remember { mutableStateOf(0L) }
    var dur by remember { mutableStateOf(0L) }
    // 每半秒刷一次进度
    LaunchedEffect(t.id, playing) {
        while (true) {
            pos = MusicCenter.positionMs()
            dur = MusicCenter.durationMs().takeIf { it > 0 } ?: (t.duration.toLong() * 1000)
            delay(500)
        }
    }
    val ratio = if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f
    Column(modifier.fillMaxWidth().background(Color(0xF5161619))) {
        // 进度条（可点按跳转）
        Box(
            Modifier.fillMaxWidth().height(14.dp).pointerInput(Unit) {
                detectTapGestures { off -> MusicCenter.seekTo(off.x / size.width) }
            },
            contentAlignment = Alignment.TopStart,
        ) {
            Box(Modifier.fillMaxWidth().height(3.dp).background(Bg3))
            Box(Modifier.fillMaxWidth(ratio).height(3.dp).background(Brush.horizontalGradient(listOf(Accent, Accent2))))
        }
        Row(Modifier.fillMaxWidth().padding(14.dp, 0.dp, 14.dp, 12.dp), verticalAlignment = Alignment.CenterVertically) {
            MusicCover(t, 44.dp, spinning = playing)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(t.title, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    buildString {
                        if (subtitle.isNotEmpty()) append(subtitle).append(" · ")
                        append(fmtDur(pos)).append(" / ").append(fmtDur(dur))
                        if (buffering) append(" · 缓冲中…")
                    },
                    color = TextDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp),
                )
            }
            Box(Modifier.size(36.dp).noRippleClick { MusicCenter.step(ctx, -1) }, contentAlignment = Alignment.Center) { SkipIcon(prev = true, tint = TextMain) }
            Box(
                Modifier.size(42.dp).clip(CircleShape).background(Brush.linearGradient(listOf(Accent, Accent2))).noRippleClick { MusicCenter.toggle(ctx) },
                contentAlignment = Alignment.Center,
            ) { PlayPauseIcon(playing, Color.White, 22.dp) }
            Box(Modifier.size(36.dp).noRippleClick { MusicCenter.step(ctx, 1) }, contentAlignment = Alignment.Center) { SkipIcon(prev = false, tint = TextMain) }
        }
    }
}

/** 封面：有图用图，没有用渐变圆 + 音符；播放中缓慢旋转 */
@Composable
private fun MusicCover(t: MusicTrack, size: Dp, spinning: Boolean) {
    val angle = if (spinning) {
        val tr = rememberInfiniteTransition(label = "spin")
        tr.animateFloat(0f, 360f, infiniteRepeatable(tween(8000, easing = LinearEasing), RepeatMode.Restart), label = "angle").value
    } else 0f
    Box(
        Modifier.size(size).rotate(angle).clip(CircleShape).background(Brush.linearGradient(listOf(Color(0xFF7B5CFF), Accent))),
        contentAlignment = Alignment.Center,
    ) {
        if (t.cover.isNotEmpty()) {
            AsyncImage(model = Api.fullUrl(t.cover), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            NoteIcon(Color.White, size * 0.46f)
        }
    }
}

/** 音符图标（矢量绘制，不用 emoji） */
@Composable
fun NoteIcon(tint: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.11f
        // 竖杆
        drawLine(tint, Offset(w * 0.46f, w * 0.14f), Offset(w * 0.46f, w * 0.7f), strokeWidth = stroke, cap = StrokeCap.Round)
        // 旗
        drawLine(tint, Offset(w * 0.46f, w * 0.14f), Offset(w * 0.82f, w * 0.26f), strokeWidth = stroke, cap = StrokeCap.Round)
        // 符头
        drawOval(tint, topLeft = Offset(w * 0.14f, w * 0.6f), size = Size(w * 0.42f, w * 0.3f))
    }
}

@Composable
private fun PlayPauseIcon(playing: Boolean, tint: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        if (playing) {
            drawRoundRect(tint, Offset(w * 0.25f, w * 0.2f), Size(w * 0.17f, w * 0.6f), androidx.compose.ui.geometry.CornerRadius(w * 0.04f))
            drawRoundRect(tint, Offset(w * 0.58f, w * 0.2f), Size(w * 0.17f, w * 0.6f), androidx.compose.ui.geometry.CornerRadius(w * 0.04f))
        } else {
            val p = Path().apply {
                moveTo(w * 0.32f, w * 0.2f); lineTo(w * 0.8f, w * 0.5f); lineTo(w * 0.32f, w * 0.8f); close()
            }
            drawPath(p, tint)
        }
    }
}

@Composable
private fun SkipIcon(prev: Boolean, tint: Color) {
    Canvas(Modifier.size(20.dp)) {
        val w = this.size.width
        val tri = Path().apply {
            if (prev) { moveTo(w * 0.7f, w * 0.22f); lineTo(w * 0.3f, w * 0.5f); lineTo(w * 0.7f, w * 0.78f) }
            else { moveTo(w * 0.3f, w * 0.22f); lineTo(w * 0.7f, w * 0.5f); lineTo(w * 0.3f, w * 0.78f) }
            close()
        }
        drawPath(tri, tint)
        val x = if (prev) w * 0.24f else w * 0.76f
        drawLine(tint, Offset(x, w * 0.22f), Offset(x, w * 0.78f), strokeWidth = w * 0.1f, cap = StrokeCap.Round)
    }
}

/** 正在播放的三根跳动小条 */
@Composable
private fun PlayingBars() {
    val tr = rememberInfiniteTransition(label = "bars")
    val a = tr.animateFloat(0.3f, 1f, infiniteRepeatable(tween(450, easing = LinearEasing), RepeatMode.Reverse), label = "a").value
    val b = tr.animateFloat(1f, 0.3f, infiniteRepeatable(tween(520, easing = LinearEasing), RepeatMode.Reverse), label = "b").value
    val c = tr.animateFloat(0.5f, 1f, infiniteRepeatable(tween(380, easing = LinearEasing), RepeatMode.Reverse), label = "c").value
    Row(Modifier.height(12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(a, b, c).forEach { f -> Box(Modifier.width(3.dp).height(12.dp * f).clip(RoundedCornerShape(1.dp)).background(Accent)) }
    }
}

private fun fmtDur(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

private fun fmtSize(b: Int): String = if (b >= 1048576) "%.1f MB".format(b / 1048576.0) else "${b / 1024} KB"
