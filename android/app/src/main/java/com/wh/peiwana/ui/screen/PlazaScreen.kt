package com.wh.peiwana.ui.screen

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.Geocoder
import android.location.LocationManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.Moment
import com.wh.peiwana.net.fmtPoints
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/** 最近一次定位（发布带经纬度 / 距离计算用） */
object LocationCache {
    var lat: Double? = null
    var lng: Double? = null
}

/** 广场数据进程级缓存：离开主页面返回时直接恢复，不重新定位/加载 */
object PlazaCache {
    var items: List<Moment> = emptyList()
    var city: String = ""
    /** feed=动态（推荐+同城合并） meet=遇见 */
    var tab: String = "feed"
    /** 进入抖音模式时从当前屏幕最近的视频起播 */
    var tiktokStartId: String = ""
}

@SuppressLint("MissingPermission")
suspend fun detectCity(ctx: Context): String? = withContext(Dispatchers.IO) {
    runCatching {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) ?: return@withContext null
        LocationCache.lat = loc.latitude
        LocationCache.lng = loc.longitude
        val addr = Geocoder(ctx, Locale.CHINA).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()
        (addr?.locality ?: addr?.subAdminArea ?: addr?.adminArea)?.removeSuffix("市")
    }.getOrNull()
}

/** 距离文案：优先作者实时上报位置，其次动态发布位置 */
fun distanceText(m: Moment): String? {
    val myLat = LocationCache.lat ?: return null
    val myLng = LocationCache.lng ?: return null
    val lat = m.user?.latitude ?: m.latitude
    val lng = m.user?.longitude ?: m.longitude
    if (lat == null || lng == null || (lat == 0.0 && lng == 0.0)) return null
    val out = FloatArray(1)
    android.location.Location.distanceBetween(myLat, myLng, lat, lng, out)
    val meters = out[0]
    return if (meters < 1000) "${meters.toInt()}m" else "%.1fkm".format(meters / 1000)
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun PlazaScreen(modifier: Modifier = Modifier, onOpenDetail: (String) -> Unit, onOpenChat: (String, String) -> Unit, onOpenTiktok: () -> Unit = {}, onOpenUser: (String) -> Unit = {}) {
    var tab by remember { mutableStateOf(if (PlazaCache.tab in listOf("meet", "quotes")) PlazaCache.tab else "feed") }
    var items by remember { mutableStateOf(PlazaCache.items) }
    var city by remember { mutableStateOf(PlazaCache.city) }
    var locating by remember { mutableStateOf(false) }
    // 状态回写缓存：返回主页面时原样恢复
    LaunchedEffect(tab) { PlazaCache.tab = tab }
    LaunchedEffect(items) { PlazaCache.items = items }
    LaunchedEffect(city) { PlazaCache.city = city }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val startCall = rememberStartCallAny()
    val listState = rememberLazyListState()

    /** 当前视口里离屏幕中心最近的视频动态；没有可见视频则取离首条可见动态最近的视频 */
    fun nearestVideoId(): String {
        val videos = items.filter { it.type == 2 && it.videoUrl.isNotEmpty() }
        if (videos.isEmpty()) return ""
        val info = listState.layoutInfo
        val center = (info.viewportStartOffset + info.viewportEndOffset) / 2
        val visible = info.visibleItemsInfo.mapNotNull { vi ->
            val m = items.getOrNull(vi.index) ?: return@mapNotNull null
            if (m.type != 2 || m.videoUrl.isEmpty()) return@mapNotNull null
            m.id to kotlin.math.abs(vi.offset + vi.size / 2 - center)
        }
        if (visible.isNotEmpty()) return visible.minBy { it.second }.first
        val anchor = info.visibleItemsInfo.firstOrNull()?.index ?: 0
        return items.withIndex()
            .filter { it.value.type == 2 && it.value.videoUrl.isNotEmpty() }
            .minByOrNull { kotlin.math.abs(it.index - anchor) }
            ?.value?.id ?: ""
    }

    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        scope.launch {
            locating = true
            city = if (g.values.any { it }) (detectCity(ctx) ?: "成都") else "成都"
            locating = false
        }
    }

    suspend fun loadNow(silent: Boolean = false) {
        val fresh = runCatching { Api.getList<Moment>("/moments/feed") }.getOrNull() ?: return
        items = if (silent && items.isNotEmpty()) {
            // 静默刷新：保持当前顺序只更新数据（在线状态等），避免列表跳动
            val freshMap = fresh.associateBy { it.id }
            items.mapNotNull { freshMap[it.id] } + fresh.filter { f -> items.none { it.id == f.id } }
        } else {
            fresh
        }
    }

    fun load(silent: Boolean = false) {
        scope.launch { loadNow(silent) }
    }

    LaunchedEffect(Unit) {
        // 有缓存则跳过定位，避免每次返回都“定位中…”跳动
        if (city.isEmpty()) {
            locating = true
            city = detectCity(ctx) ?: ""
            if (city.isEmpty()) locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            else locating = false
        }
    }
    var firstLoad by remember { mutableStateOf(true) }
    LaunchedEffect(tab) {
        if (tab != "feed") return@LaunchedEffect
        // 初次组合且有缓存：静默刷新保序不跳动；切 tab：全量加载
        loadNow(silent = firstLoad && items.isNotEmpty())
        firstLoad = false
    }
    // 在线状态兜底：每 30 秒静默刷新（保持顺序不跳动）
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            if (tab == "feed") load(silent = true)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(modifier = Modifier.padding(16.dp, 14.dp, 16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf("feed" to "动态", "meet" to "遇见", "quotes" to "励志行").forEach { (k, label) ->
                Text(
                    label,
                    color = if (tab == k) TextMain else TextSub,
                    fontSize = if (tab == k) 17.sp else 16.sp,
                    fontWeight = if (tab == k) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.padding(end = 20.dp).noRippleClick { tab = k },
                )
            }
            Spacer(Modifier.weight(1f))
            // 视频（抖音模式）入口只属于动态板块
            if (tab == "feed") {
                Text(
                    "视频", color = Accent, fontSize = 13.sp,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Accent.copy(alpha = 0.14f))
                        .noRippleClick {
                            PlazaCache.tiktokStartId = nearestVideoId()
                            onOpenTiktok()
                        }.padding(horizontal = 10.dp, vertical = 3.dp),
                )
                Spacer(Modifier.width(12.dp))
            }
            Text(
                if (locating) "定位中…" else (if (city.isEmpty()) "定位" else "$city ▾"),
                color = TextSub, fontSize = 13.sp,
                modifier = Modifier.noRippleClick {
                    locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                },
            )
        }
        if (tab == "meet") {
            // 遇见：异性卡片流（所有/新人/同城/亲密度）
            MeetSection(city = city, onOpenUser = onOpenUser, startCall = startCall)
            return@Column
        }
        if (tab == "quotes") {
            // 励志行：AI 每天一句励志话，按天累积
            QuoteSection()
            return@Column
        }
        // 下拉刷新（对齐 iOS）
        var refreshing by remember { mutableStateOf(false) }
        androidx.compose.material3.pulltorefresh.PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    loadNow()
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            if (items.isEmpty()) {
                // 空态也要可滚动才能触发下拉刷新
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    item {
                        Box(Modifier.fillParentMaxSize()) {
                            EmptyHint("暂无动态\n自己发布的仅异性可见")
                        }
                    }
                }
            } else {
                LazyColumn(state = listState) {
                    items(items, key = { it.id }) { m ->
                        MomentCard(
                            m,
                            onOpenDetail = { onOpenDetail(m.id) },
                            onVideoCall = { m.user?.let { startCall(it.id, it.nickname, it.avatar, 2) } },
                            onOpenUser = { m.user?.let { onOpenUser(it.id) } },
                        )
                    }
                }
            }
        }
    }
}

/** 关注动态（原主页「关注」tab，入口移到「我的」） */
@Composable
fun FollowMomentsScreen(onBack: () -> Unit, onOpenDetail: (String) -> Unit, onOpenUser: (String) -> Unit) {
    var items by remember { mutableStateOf<List<Moment>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    val startCall = rememberStartCallAny()
    LaunchedEffect(Unit) {
        items = runCatching { Api.getList<Moment>("/moments/feed?follow=1") }.getOrDefault(emptyList())
        loaded = true
    }
    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("关注动态", onBack)
        if (loaded && items.isEmpty()) {
            EmptyHint("关注的人还没有动态\n去遇见里关注一些人吧")
        } else {
            LazyColumn {
                items(items, key = { it.id }) { m ->
                    MomentCard(
                        m,
                        onOpenDetail = { onOpenDetail(m.id) },
                        onVideoCall = { m.user?.let { startCall(it.id, it.nickname, it.avatar, 2) } },
                        onOpenUser = { m.user?.let { onOpenUser(it.id) } },
                    )
                }
            }
        }
    }
}

@Composable
fun MomentCard(m: Moment, onOpenDetail: () -> Unit, onVideoCall: () -> Unit, onOpenUser: () -> Unit = {}) {
    var liked by remember { mutableStateOf(m.liked) }
    var likeCount by remember { mutableIntStateOf(m.likeCount) }
    var following by remember { mutableStateOf(m.isFollowing) }
    var fullImage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp, 14.dp, 16.dp, 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // 点头像进入他人主页（自己的动态不跳转）
            Box(Modifier.noRippleClick { if (m.user?.id != com.wh.peiwana.net.Session.uid) onOpenUser() }) {
                Avatar(m.user?.avatar, 40)
            }
            Column(modifier = Modifier.weight(1f).padding(start = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(m.user?.nickname ?: "", color = TextMain, fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
                    if (m.user?.isGuide == true) {
                        Spacer(Modifier.width(5.dp))
                        Text("认证", color = Accent, fontSize = 10.sp, modifier = Modifier.clip(RoundedCornerShape(3.dp)).background(Accent.copy(alpha = 0.12f)).padding(horizontal = 5.dp, vertical = 1.dp))
                    }
                    // 位置紧跟昵称（迷你淡色标签）
                    if (m.cityName.isNotEmpty()) {
                        Spacer(Modifier.width(5.dp))
                        Text(m.cityName, color = TextDim, fontSize = 10.sp, modifier = Modifier.clip(RoundedCornerShape(3.dp)).background(androidx.compose.ui.graphics.Color.White.copy(alpha = 0.06f)).padding(horizontal = 5.dp, vertical = 1.dp))
                    }
                }
                Text(timeAgo(m.createdAt), color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
            }
            // 自己的动态不显示关注/视频通话按钮
            val isSelf = m.user?.id == com.wh.peiwana.net.Session.uid
            if (!isSelf) {
                // 迷你按钮组：关注（实底）+ 视频通话（细描边）
                Box(
                    modifier = Modifier.clip(RoundedCornerShape(13.dp))
                        .then(
                            if (following) Modifier.border(1.dp, Line, RoundedCornerShape(13.dp))
                            else Modifier.background(Accent),
                        )
                        .noRippleClick {
                            scope.launch {
                                runCatching {
                                    val r = Api.request("/user/${m.user?.id}/follow", "POST")
                                    following = (r as? kotlinx.serialization.json.JsonObject)?.get("following")
                                        ?.let { (it as kotlinx.serialization.json.JsonPrimitive).content == "true" } ?: !following
                                }
                            }
                        }.padding(horizontal = 11.dp, vertical = 4.dp),
                ) { Text(if (following) "已关注" else "关注", color = if (following) TextSub else androidx.compose.ui.graphics.Color.White, fontSize = 12.sp) }
                // 视频通话仅男方可发起（女方只能接听）；三态：通话中（占线）/ 离线置灰 / 可打（显示价格）
                if (com.wh.peiwana.net.Session.gender == 1) {
                    val peerOnline = m.user?.online == true
                    val peerBusy = m.user?.busy == true
                    val busyColor = androidx.compose.ui.graphics.Color(0xFFFFAA3C)
                    val headerCtx = androidx.compose.ui.platform.LocalContext.current
                    Spacer(Modifier.width(8.dp))
                    Box(
                        modifier = Modifier.clip(RoundedCornerShape(13.dp))
                            .border(
                                1.dp,
                                if (peerBusy) busyColor.copy(alpha = 0.5f) else if (peerOnline) Accent.copy(alpha = 0.5f) else Line,
                                RoundedCornerShape(13.dp),
                            )
                            .noRippleClick {
                                when {
                                    peerBusy -> android.widget.Toast.makeText(headerCtx, "对方正在通话中，请稍后再试", android.widget.Toast.LENGTH_SHORT).show()
                                    !peerOnline -> android.widget.Toast.makeText(headerCtx, "对方不在线", android.widget.Toast.LENGTH_SHORT).show()
                                    else -> onVideoCall()
                                }
                            }
                            .padding(horizontal = 11.dp, vertical = 4.dp),
                    ) {
                        // 叠加显示女方视频价格（积分/分钟）
                        val priceFen = m.user?.videoPriceFen ?: 0
                        val label = when {
                            peerBusy -> "通话中"
                            priceFen > 0 -> "视频通话 ${fmtPoints(priceFen.toString())}/分"
                            else -> "视频通话"
                        }
                        Text(label, color = if (peerBusy) busyColor else if (peerOnline) Accent else TextDim, fontSize = 12.sp)
                    }
                }
            }
        }

        if (m.content.isNotEmpty()) {
            Text(m.content, color = TextMain, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 10.dp).noRippleClick(onOpenDetail))
        }
        if (m.type == 1 && m.images.isNotEmpty()) {
            // 说明文字与图片间距 8，无文字时与头部保持 10
            Spacer(Modifier.height(if (m.content.isNotEmpty()) 8.dp else 10.dp))
            // 普通布局九宫格（嵌套 LazyVerticalGrid 会拖慢列表滚动）
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                m.images.chunked(3).forEach { rowImages ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                        rowImages.forEach { url ->
                            // 点图直接放大查看（进详情走文字/评论）
                            AsyncImage(
                                model = Api.fullUrl(url), contentDescription = null, contentScale = ContentScale.Crop,
                                modifier = Modifier.weight(1f).height(112.dp).clip(RoundedCornerShape(8.dp)).noRippleClick { fullImage = url },
                            )
                        }
                        repeat(3 - rowImages.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        if (m.type == 2 && m.videoUrl.isNotEmpty()) {
            Spacer(Modifier.height(if (m.content.isNotEmpty()) 8.dp else 10.dp))
            val ctx = androidx.compose.ui.platform.LocalContext.current
            var playingVideo by remember { mutableStateOf(false) }
            if (playingVideo) {
                // 点击封面后原地播放，不跳详情；高度与封面一致避免跳动
                VideoPlayerBox(Api.fullUrl(m.videoUrl), height = 200.dp)
            } else {
                Box(modifier = Modifier.fillMaxWidth().height(200.dp).clip(RoundedCornerShape(10.dp)).background(androidx.compose.ui.graphics.Color.Black).noRippleClick { playingVideo = true }, contentAlignment = Alignment.Center) {
                    if (m.coverUrl.isNotEmpty()) {
                        AsyncImage(model = Api.fullUrl(m.coverUrl), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    } else {
                        // 老数据无封面：直接取视频首帧
                        AsyncImage(
                            model = coil.request.ImageRequest.Builder(ctx).data(Api.fullUrl(m.videoUrl)).decoderFactory(coil.decode.VideoFrameDecoder.Factory()).build(),
                            contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                        )
                    }
                    Text("▶", color = androidx.compose.ui.graphics.Color.White, fontSize = 34.sp)
                }
            }
        }
        // 操作行：左侧 在线状态 + 距离，右侧 点赞 / 评论
        Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            val online = m.user?.online == true
            Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(if (online) Success else TextDim))
            Spacer(Modifier.width(4.dp))
            Text(if (online) "在线" else "离线", color = if (online) Success else TextDim, fontSize = 12.sp)
            distanceText(m)?.let { d ->
                Spacer(Modifier.width(12.dp))
                Text("· $d", color = TextSub, fontSize = 12.sp)
            }
            Spacer(Modifier.weight(1f))
            Text(
                // 图标统一用实心，颜色区分状态，避免 ♥/♡ 字形不一致
                "♥ 点赞${if (likeCount > 0) " $likeCount" else ""}",
                color = if (liked) Accent else TextSub, fontSize = 13.sp,
                modifier = Modifier.noRippleClick {
                    scope.launch {
                        runCatching {
                            val r = Api.request("/moments/${m.id}/like", "POST")
                            val nl = (r as? kotlinx.serialization.json.JsonObject)?.get("liked")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content == "true" } ?: !liked
                            liked = nl; likeCount += if (nl) 1 else -1
                        }
                    }
                }.padding(end = 18.dp),
            )
            Text("评论${if (m.commentCount > 0) " ${m.commentCount}" else ""}", color = TextSub, fontSize = 13.sp, modifier = Modifier.noRippleClick(onOpenDetail))
        }
    }
    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))

    fullImage?.let { u ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { fullImage = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            com.wh.peiwana.ui.ImageViewer(m.images, m.images.indexOf(u).coerceAtLeast(0)) { fullImage = null }
        }
    }
}
