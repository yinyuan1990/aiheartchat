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
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
    /** 曲目列表（带来源标题），进过一次音乐页后就有 */
    val data = mutableStateOf<MusicList?>(null)
    val current = mutableStateOf<MusicTrack?>(null)
    val isPlaying = mutableStateOf(false)
    val buffering = mutableStateOf(false)
    /** 倍速 1 / 1.5 / 2 */
    val rate = mutableStateOf(1f)
    val shuffle = mutableStateOf(false)
    /** 单曲循环（否则列表循环） */
    val repeatOne = mutableStateOf(false)
    private val counted = HashSet<String>()

    val queue: List<MusicTrack> get() = data.value?.list ?: emptyList()

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

    /** 拉列表（force 重新拉） */
    suspend fun load(force: Boolean = false): MusicList {
        data.value?.takeIf { !force }?.let { return it }
        val d = runCatching { Api.getObj<MusicList>("/music") }.getOrNull() ?: MusicList()
        data.value = d
        return d
    }

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
        p.setPlaybackSpeed(rate.value)
        p.repeatMode = if (repeatOne.value) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        p.prepare()
        p.play()
        if (counted.add(t.id)) {
            kotlinx.coroutines.GlobalScope.launch { runCatching { Api.request("/music/${t.id}/play", "POST") } }
        }
    }

    fun toggle(ctx: Context) {
        val p = ensure(ctx)
        if (current.value == null) { queue.firstOrNull()?.let { play(ctx, it) }; return }
        if (p.isPlaying) p.pause() else { if (p.playbackState == Player.STATE_IDLE) p.prepare(); p.play() }
    }

    fun step(ctx: Context, delta: Int) {
        val q = queue
        if (q.isEmpty()) return
        play(ctx, q[nextIndex(delta)])
    }

    private fun nextIndex(delta: Int): Int {
        val q = queue
        val idx = q.indexOfFirst { it.id == current.value?.id }
        if (shuffle.value && q.size > 1) {
            var n: Int
            do { n = (0 until q.size).random() } while (n == idx)
            return n
        }
        return if (idx < 0) 0 else ((idx + delta) % q.size + q.size) % q.size
    }

    /** 单曲结束自动下一首（单曲循环时 ExoPlayer 自己循环，不会走到这里） */
    private fun next() {
        val p = player ?: return
        val q = queue
        if (q.isEmpty()) return
        val t = q[nextIndex(1)]
        current.value = t
        p.setMediaItem(MediaItem.Builder().setUri(Api.fullUrl(t.url)).setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.performer.ifEmpty { null }).build()).build())
        p.prepare(); p.play()
    }

    fun pause() { player?.pause() }

    /** 关闭：停止并收起顶部栏 */
    fun stop() {
        player?.stop()
        player?.clearMediaItems()
        current.value = null
        isPlaying.value = false
        buffering.value = false
    }

    /** 倍速循环 1x → 1.5x → 2x */
    fun cycleRate() = setRate(when (rate.value) { 1f -> 1.5f; 1.5f -> 2f; else -> 1f })

    fun setRate(v: Float) {
        rate.value = v.coerceIn(0.5f, 3f)
        player?.setPlaybackSpeed(rate.value)
    }

    /** H5（大厅）交过来的播放列表：只换列表，来源标题沿用 */
    fun setQueue(list: List<MusicTrack>) {
        data.value = MusicList(source = data.value?.source, list = list)
    }

    fun toggleShuffle() { shuffle.value = !shuffle.value }
    fun toggleRepeat() {
        repeatOne.value = !repeatOne.value
        player?.repeatMode = if (repeatOne.value) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    fun positionMs(): Long = player?.currentPosition ?: 0L
    fun durationMs(): Long = player?.duration?.takeIf { it > 0 } ?: 0L
    fun seekTo(ratio: Float) { val d = durationMs(); if (d > 0) player?.seekTo((d * ratio.coerceIn(0f, 1f)).toLong()) }

    // ---------- 保存 / 分享 ----------

    /** 分享落地页（不用登录就能听 + 保存 + 下载 App） */
    fun shareLink(t: MusicTrack) = "https://app.yyheart.com/#/music/share/${t.id}"

    private fun extOf(url: String) = url.substringAfterLast('.', "mp3").take(5).ifEmpty { "mp3" }
    private fun safeName(t: MusicTrack) = t.title.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(60).ifEmpty { "music" }

    /** 保存到手机：系统下载管理器下到「音乐」目录（Android 10 以下没有存储权限时放 App 私有目录），通知栏可见进度 */
    fun saveToPhone(ctx: Context, t: MusicTrack) {
        val name = "${safeName(t)}.${extOf(t.url)}"
        try {
            val req = android.app.DownloadManager.Request(android.net.Uri.parse(Api.fullUrl(t.url)))
                .setTitle(t.title)
                .setDescription("心之音 · 音乐")
                .setMimeType("audio/mpeg")
                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_MUSIC, "心之音/$name")
            } else {
                req.setDestinationInExternalFilesDir(ctx, android.os.Environment.DIRECTORY_MUSIC, name)
            }
            (ctx.getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(req)
            android.widget.Toast.makeText(ctx, "开始下载，完成后在「音乐/心之音」目录", android.widget.Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            android.widget.Toast.makeText(ctx, "下载失败：${e.message}", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    /** 分享链接（微信/QQ 等以文字发出，点开是落地页） */
    fun shareLinkTo(ctx: Context, t: MusicTrack) {
        val text = "${t.title}${if (t.performer.isNotEmpty()) " - ${t.performer}" else ""}\n${shareLink(t)}"
        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(android.content.Intent.EXTRA_SUBJECT, t.title)
            putExtra(android.content.Intent.EXTRA_TEXT, text)
        }
        ctx.startActivity(android.content.Intent.createChooser(intent, "分享音乐").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** 分享音乐文件本身：先下到缓存再用 FileProvider 发出（文件大，要等一会） */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    fun shareFileTo(ctx: Context, t: MusicTrack) {
        val app = ctx.applicationContext
        android.widget.Toast.makeText(app, "正在准备文件（${"%.0f".format(t.size / 1048576.0)}MB）…", android.widget.Toast.LENGTH_SHORT).show()
        kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            val result = runCatching {
                val dir = java.io.File(app.cacheDir, "share_music").apply { mkdirs() }
                val file = java.io.File(dir, "${safeName(t)}.${extOf(t.url)}")
                if (!file.exists() || file.length() != t.size.toLong()) {
                    java.net.URL(Api.fullUrl(t.url)).openStream().use { input -> file.outputStream().use { input.copyTo(it) } }
                }
                androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
            }
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                result.onSuccess { uri ->
                    val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "audio/*"
                        putExtra(android.content.Intent.EXTRA_STREAM, uri)
                        putExtra(android.content.Intent.EXTRA_SUBJECT, t.title)
                        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    app.startActivity(android.content.Intent.createChooser(intent, "发送音乐文件").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                }.onFailure {
                    android.widget.Toast.makeText(app, "准备文件失败：${it.message}", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}

// ---------- 消息页顶部「正在播放」栏 ----------

/** 播放中固定在消息页顶部：暂停 / 标题·艺术家 / 倍速 / 关闭；点中间打开播放弹层 */
@Composable
fun NowPlayingBar(onOpen: () -> Unit) {
    val ctx = LocalContext.current
    val t = MusicCenter.current.value ?: return
    val playing by MusicCenter.isPlaying
    val buffering by MusicCenter.buffering
    val rate by MusicCenter.rate
    val source = MusicCenter.data.value?.source?.title ?: ""
    Row(
        Modifier.fillMaxWidth().padding(12.dp, 8.dp, 12.dp, 0.dp)
            .clip(RoundedCornerShape(14.dp)).background(Bg2).border(1.dp, Line, RoundedCornerShape(14.dp))
            .padding(6.dp, 6.dp, 8.dp, 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(34.dp).noRippleClick { MusicCenter.toggle(ctx) }, contentAlignment = Alignment.Center) { PlayPauseIcon(playing, TextMain, 20.dp) }
        Column(Modifier.weight(1f).noRippleClick(onOpen).padding(horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(t.title, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                (t.performer.ifEmpty { source.ifEmpty { "未知艺术家" } }) + if (buffering) " · 缓冲中…" else "",
                color = TextSub, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        RateChip(rate) { MusicCenter.cycleRate() }
        Spacer(Modifier.width(4.dp))
        Box(Modifier.size(34.dp).noRippleClick { MusicCenter.stop() }, contentAlignment = Alignment.Center) { CloseIcon(TextMain, 16.dp) }
    }
}

/** 倍速小标签（虚线框，像 Telegram 的 1X） */
@Composable
private fun RateChip(rate: Float, onClick: () -> Unit) {
    val label = if (rate == 1f) "1X" else "${rate}X".replace(".0X", "X")
    Box(
        Modifier.noRippleClick(onClick).drawDashedBorder(TextDim).padding(horizontal = 6.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = TextSub, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
}

private fun Modifier.drawDashedBorder(color: Color): Modifier = this.drawBehind {
    drawRoundRect(
        color, cornerRadius = CornerRadius(5.dp.toPx()),
        style = Stroke(width = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
    )
}

// ---------- 播放弹层 / 页面 ----------

/** 独立弹层（从消息页顶部栏或入口打开）：列表 + 大播放器 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MusicSheet(onDismiss: () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        containerColor = Bg2,
        dragHandle = { Box(Modifier.padding(top = 8.dp, bottom = 2.dp).size(36.dp, 4.dp).clip(RoundedCornerShape(2.dp)).background(TextDim)) },
    ) {
        Box(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            MusicSheetContent(onClose = onDismiss)
        }
    }
}

/** 路由页形式（直接进 music 路由时用）：顶栏标题用频道名 */
@Composable
fun MusicScreen(onBack: () -> Unit) {
    val data by MusicCenter.data
    LaunchedEffect(Unit) { MusicCenter.load() }
    Column(Modifier.fillMaxSize().background(Bg)) {
        NavBar(data?.source?.title?.ifEmpty { null } ?: "音乐", onBack)
        Box(Modifier.weight(1f)) { MusicSheetContent(onClose = null) }
    }
}

/** 弹层内容：头部（频道名 + 关闭）/ 列表 / 大播放器 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MusicSheetContent(onClose: (() -> Unit)?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val data by MusicCenter.data
    val current by MusicCenter.current
    val playing by MusicCenter.isPlaying
    var loaded by remember { mutableStateOf(data != null) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { MusicCenter.load(); loaded = true }

    Column(Modifier.fillMaxSize()) {
        if (onClose != null) {
            Row(Modifier.fillMaxWidth().padding(16.dp, 4.dp, 8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(data?.source?.title?.ifEmpty { null } ?: "音乐", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("最多保留 100 首" + (data?.list?.size?.takeIf { it > 0 }?.let { " · 共 $it 首" } ?: ""), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                }
                Box(Modifier.size(34.dp).noRippleClick(onClose), contentAlignment = Alignment.Center) { CloseIcon(TextMain, 16.dp) }
            }
        }

        // 列表
        Box(Modifier.weight(1f)) {
            val d = data
            when {
                !loaded || d == null -> EmptyHint("加载中…")
                d.list.isEmpty() -> EmptyHint("还没有歌曲\n稍后再来看看")
                else -> androidx.compose.material3.pulltorefresh.PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { refreshing = true; MusicCenter.load(force = true); refreshing = false } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (onClose == null) item(key = "head") {
                            Text("最多保留 100 首 · 共 ${d.list.size} 首", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(16.dp, 10.dp, 16.dp, 2.dp))
                        }
                        items(d.list, key = { it.id }) { t ->
                            val active = current?.id == t.id
                            Row(
                                Modifier.fillMaxWidth().noRippleClick { MusicCenter.play(ctx, t) }.padding(16.dp, 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MusicCover(t, 48.dp, spinning = active && playing)
                                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text(
                                            t.title, color = if (active) Accent else TextMain, fontSize = 15.sp,
                                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                                        )
                                        if (active && playing) PlayingBars()
                                    }
                                    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text(fmtDur(t.duration.toLong() * 1000), color = TextDim, fontSize = 11.sp)
                                        if (t.performer.isNotEmpty()) Text("· ${t.performer}", color = TextDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 120.dp))
                                        Text("· ${fmtSize(t.size)}", color = TextDim, fontSize = 11.sp)
                                        Text("· ${com.wh.peiwana.ui.timeAgo(t.postedAt)}", color = TextDim, fontSize = 11.sp)
                                    }
                                }
                                PlayPauseIcon(playing = active && playing, tint = if (active) Accent else TextDim, size = 20.dp)
                            }
                        }
                    }
                }
            }
        }

        // 大播放器
        BigPlayer(current, subtitleFallback = data?.source?.title ?: "")
    }
}

/** 底部大播放器：封面 + 标题/艺术家 / 进度（可点）+ 时间 + 倍速 / 随机 · 上一首 · 播放 · 下一首 · 循环 */
@Composable
private fun BigPlayer(t: MusicTrack?, subtitleFallback: String) {
    val ctx = LocalContext.current
    val playing by MusicCenter.isPlaying
    val rate by MusicCenter.rate
    val shuffle by MusicCenter.shuffle
    val repeatOne by MusicCenter.repeatOne
    var pos by remember { mutableStateOf(0L) }
    var dur by remember { mutableStateOf(0L) }
    LaunchedEffect(t?.id, playing) {
        while (true) {
            pos = MusicCenter.positionMs()
            dur = MusicCenter.durationMs().takeIf { it > 0 } ?: ((t?.duration ?: 0).toLong() * 1000)
            delay(500)
        }
    }
    val ratio = if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f

    Column(Modifier.fillMaxWidth().background(Bg)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
        Column(Modifier.fillMaxWidth().padding(16.dp, 12.dp, 16.dp, 14.dp)) {
        if (t != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MusicCover(t, 52.dp, spinning = false, round = false)
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(t.title, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(t.performer.ifEmpty { "未知艺术家" }, color = TextSub, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
                }
                // 保存到手机 / 分享（链接 或 文件）
                Box(Modifier.size(36.dp).noRippleClick { MusicCenter.saveToPhone(ctx, t) }, contentAlignment = Alignment.Center) { DownloadIcon(TextMain) }
                var showShare by remember { mutableStateOf(false) }
                Box {
                    Box(Modifier.size(36.dp).noRippleClick { showShare = true }, contentAlignment = Alignment.Center) { ShareIcon(TextMain) }
                    androidx.compose.material3.DropdownMenu(expanded = showShare, onDismissRequest = { showShare = false }) {
                        androidx.compose.material3.DropdownMenuItem(text = { Text("分享链接", fontSize = 14.sp) }, onClick = { showShare = false; MusicCenter.shareLinkTo(ctx, t) })
                        androidx.compose.material3.DropdownMenuItem(text = { Text("发送音乐文件", fontSize = 14.sp) }, onClick = { showShare = false; MusicCenter.shareFileTo(ctx, t) })
                    }
                }
            }
            // 进度条（可点按跳转）+ 圆点
            Box(
                Modifier.fillMaxWidth().padding(top = 14.dp).height(20.dp).pointerInput(Unit) {
                    detectTapGestures { off -> MusicCenter.seekTo(off.x / size.width) }
                },
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Bg3))
                Box(Modifier.fillMaxWidth(ratio).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Brush.horizontalGradient(listOf(Accent, Accent2))))
                Box(Modifier.fillMaxWidth(ratio), contentAlignment = Alignment.CenterEnd) {
                    Box(Modifier.size(12.dp).offset(x = 6.dp).clip(CircleShape).background(Color.White))
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(fmtDur(pos), color = TextDim, fontSize = 11.sp, modifier = Modifier.width(56.dp))
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { RateChip(rate) { MusicCenter.cycleRate() } }
                Text(fmtDur(dur), color = TextDim, fontSize = 11.sp, modifier = Modifier.width(56.dp), textAlign = TextAlign.End)
            }
        } else {
            Text("点上面的歌开始播放", color = TextSub, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, start = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Box(Modifier.size(44.dp).noRippleClick { MusicCenter.toggleShuffle() }, contentAlignment = Alignment.Center) { ShuffleIcon(if (shuffle) Accent else TextMain) }
            Box(Modifier.size(44.dp).noRippleClick { MusicCenter.step(ctx, -1) }, contentAlignment = Alignment.Center) { SkipIcon(prev = true, tint = TextMain, size = 26.dp) }
            Box(
                Modifier.size(60.dp).clip(CircleShape).background(Brush.linearGradient(listOf(Accent, Accent2))).noRippleClick { MusicCenter.toggle(ctx) },
                contentAlignment = Alignment.Center,
            ) { PlayPauseIcon(playing, Color.White, 30.dp) }
            Box(Modifier.size(44.dp).noRippleClick { MusicCenter.step(ctx, 1) }, contentAlignment = Alignment.Center) { SkipIcon(prev = false, tint = TextMain, size = 26.dp) }
            Box(Modifier.size(44.dp).noRippleClick { MusicCenter.toggleRepeat() }, contentAlignment = Alignment.Center) { RepeatIcon(if (repeatOne) Accent else TextMain, one = repeatOne) }
        }
        }
    }
}

// ---------- 小部件 ----------

/** 封面：有图用图，没有用渐变 + 音符；播放中缓慢旋转 */
@Composable
private fun MusicCover(t: MusicTrack, size: Dp, spinning: Boolean, round: Boolean = true) {
    val angle = if (spinning) {
        val tr = rememberInfiniteTransition(label = "spin")
        tr.animateFloat(0f, 360f, infiniteRepeatable(tween(8000, easing = LinearEasing), RepeatMode.Restart), label = "angle").value
    } else 0f
    Box(
        Modifier.size(size).rotate(angle).clip(if (round) CircleShape else RoundedCornerShape(10.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF7B5CFF), Accent))),
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
        drawLine(tint, Offset(w * 0.46f, w * 0.14f), Offset(w * 0.46f, w * 0.7f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.46f, w * 0.14f), Offset(w * 0.82f, w * 0.26f), strokeWidth = stroke, cap = StrokeCap.Round)
        drawOval(tint, topLeft = Offset(w * 0.14f, w * 0.6f), size = Size(w * 0.42f, w * 0.3f))
    }
}

@Composable
private fun PlayPauseIcon(playing: Boolean, tint: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        if (playing) {
            drawRoundRect(tint, Offset(w * 0.25f, w * 0.2f), Size(w * 0.17f, w * 0.6f), CornerRadius(w * 0.04f))
            drawRoundRect(tint, Offset(w * 0.58f, w * 0.2f), Size(w * 0.17f, w * 0.6f), CornerRadius(w * 0.04f))
        } else {
            val p = Path().apply { moveTo(w * 0.32f, w * 0.2f); lineTo(w * 0.8f, w * 0.5f); lineTo(w * 0.32f, w * 0.8f); close() }
            drawPath(p, tint)
        }
    }
}

@Composable
private fun SkipIcon(prev: Boolean, tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        // 双三角（像 ⏮ ⏭）
        fun tri(x0: Float, x1: Float) = Path().apply {
            if (prev) { moveTo(w * x1, w * 0.22f); lineTo(w * x0, w * 0.5f); lineTo(w * x1, w * 0.78f) }
            else { moveTo(w * x0, w * 0.22f); lineTo(w * x1, w * 0.5f); lineTo(w * x0, w * 0.78f) }
            close()
        }
        drawPath(tri(0.12f, 0.5f), tint)
        drawPath(tri(0.5f, 0.88f), tint)
    }
}

@Composable
private fun ShuffleIcon(tint: Color) {
    Canvas(Modifier.size(20.dp)) {
        val w = this.size.width
        val s = w * 0.09f
        drawLine(tint, Offset(w * 0.15f, w * 0.82f), Offset(w * 0.85f, w * 0.18f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.62f, w * 0.18f), Offset(w * 0.85f, w * 0.18f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.85f, w * 0.18f), Offset(w * 0.85f, w * 0.41f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.15f, w * 0.18f), Offset(w * 0.38f, w * 0.38f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.62f, w * 0.62f), Offset(w * 0.85f, w * 0.82f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.62f, w * 0.82f), Offset(w * 0.85f, w * 0.82f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.85f, w * 0.82f), Offset(w * 0.85f, w * 0.59f), strokeWidth = s, cap = StrokeCap.Round)
    }
}

@Composable
private fun RepeatIcon(tint: Color, one: Boolean) {
    Box(contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(20.dp)) {
            val w = this.size.width
            val s = w * 0.09f
            // 两条带箭头的半环
            drawLine(tint, Offset(w * 0.15f, w * 0.55f), Offset(w * 0.15f, w * 0.42f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.15f, w * 0.42f), Offset(w * 0.85f, w * 0.42f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.72f, w * 0.29f), Offset(w * 0.85f, w * 0.42f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.72f, w * 0.55f), Offset(w * 0.85f, w * 0.42f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.85f, w * 0.45f), Offset(w * 0.85f, w * 0.58f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.85f, w * 0.58f), Offset(w * 0.15f, w * 0.58f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.28f, w * 0.71f), Offset(w * 0.15f, w * 0.58f), strokeWidth = s, cap = StrokeCap.Round)
            drawLine(tint, Offset(w * 0.28f, w * 0.45f), Offset(w * 0.15f, w * 0.58f), strokeWidth = s, cap = StrokeCap.Round)
        }
        if (one) Text("1", color = tint, fontSize = 7.sp, fontWeight = FontWeight.Bold, modifier = Modifier.background(Bg2).padding(horizontal = 1.dp))
    }
}

/** 下载（保存到手机）：向下箭头 + 托盘 */
@Composable
private fun DownloadIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = w * 0.09f
        drawLine(tint, Offset(w * 0.5f, w * 0.14f), Offset(w * 0.5f, w * 0.62f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.3f, w * 0.44f), Offset(w * 0.5f, w * 0.64f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.7f, w * 0.44f), Offset(w * 0.5f, w * 0.64f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.18f, w * 0.72f), Offset(w * 0.18f, w * 0.86f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.18f, w * 0.86f), Offset(w * 0.82f, w * 0.86f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.82f, w * 0.86f), Offset(w * 0.82f, w * 0.72f), strokeWidth = s, cap = StrokeCap.Round)
    }
}

/** 分享：向上箭头 + 托盘（iOS 风格） */
@Composable
private fun ShareIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = w * 0.09f
        drawLine(tint, Offset(w * 0.5f, w * 0.14f), Offset(w * 0.5f, w * 0.62f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.32f, w * 0.32f), Offset(w * 0.5f, w * 0.14f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.68f, w * 0.32f), Offset(w * 0.5f, w * 0.14f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.22f, w * 0.5f), Offset(w * 0.22f, w * 0.86f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.22f, w * 0.86f), Offset(w * 0.78f, w * 0.86f), strokeWidth = s, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.78f, w * 0.86f), Offset(w * 0.78f, w * 0.5f), strokeWidth = s, cap = StrokeCap.Round)
    }
}

@Composable
private fun CloseIcon(tint: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawLine(tint, Offset(w * 0.2f, w * 0.2f), Offset(w * 0.8f, w * 0.8f), strokeWidth = w * 0.12f, cap = StrokeCap.Round)
        drawLine(tint, Offset(w * 0.8f, w * 0.2f), Offset(w * 0.2f, w * 0.8f), strokeWidth = w * 0.12f, cap = StrokeCap.Round)
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
    val h = s / 3600
    return if (h > 0) "%d:%02d:%02d".format(h, (s % 3600) / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

private fun fmtSize(b: Int): String = if (b >= 1048576) "%.1f MB".format(b / 1048576.0) else "${b / 1024} KB"
