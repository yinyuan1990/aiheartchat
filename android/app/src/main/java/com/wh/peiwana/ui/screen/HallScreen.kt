package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 大厅：App 内嵌 H5（WebView），业务模块在网页端热更、无需发版。
 * 地址后台可配（GET /modules/hall，env HALL_H5_URL），默认加载 Web 端的 /site/#/hall-embed，
 * URL 携带 token 免登录（用 App 的身份），页面内自行导航，其它 tab 保持原生。
 */
@Composable
fun HallScreen(
    modifier: Modifier = Modifier,
    onOpenProject: (String) -> Unit,
    onOpenChat: (convId: String, convType: Int, targetId: String, title: String) -> Unit = { _, _, _, _ -> },
    onOpenWeb: (url: String, title: String, landscape: Boolean) -> Unit = { _, _, _ -> },
    /** 大厅 tab 是否当前可见（各 tab 常驻，只有可见时才接管返回键） */
    active: Boolean = true,
) {
    var url by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        val webviewPkg = if (android.os.Build.VERSION.SDK_INT >= 26) {
            runCatching { android.webkit.WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        } else null
        GameLog.d("hall: start, base=${Api.BASE_URL} hasToken=${!Api.token.isNullOrEmpty()} webview=$webviewPkg sdk=${android.os.Build.VERSION.SDK_INT}")
        val cfg = runCatching {
            Api.request("/modules/hall")!!.jsonObject["url"]?.jsonPrimitive?.contentOrNull
        }.onFailure { GameLog.w("hall: GET /modules/hall failed: $it") }.getOrNull()
        val base = if (cfg.isNullOrEmpty()) "${Api.BASE_URL}/site/#/hall-embed" else cfg
        val sep = if (base.contains("?")) "&" else "?"
        url = withIndexCacheBuster("$base${sep}token=${Api.token ?: ""}&embed=1")
        GameLog.d("hall: load url=${url?.substringBefore("token=")}token=*** (cfg='${cfg ?: ""}')")
    }

    val u = url
    // 大厅 H5 内有子页面（树洞详情/发布等）：系统返回键先让网页后退，退不了才交给系统
    var webView by remember { mutableStateOf<android.webkit.WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }
    // H5 经桥打开的原生媒体查看器（养眼图片：看大图 / 播视频）
    var viewer by remember { mutableStateOf<Triple<List<List<com.wh.peiwana.ui.MediaItem>>, Int, Int>?>(null) }
    viewer?.let { (groups, g, idx) ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { viewer = null },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            com.wh.peiwana.ui.MediaViewer(groups, g, idx) { viewer = null }
        }
    }
    // 原生播放状态回推给 H5（切歌 / 暂停时），H5 的播放 UI 据此同步：window.PeiwanMusicState({id, playing})
    val musicCur = MusicCenter.current.value
    val musicPlaying = MusicCenter.isPlaying.value
    LaunchedEffect(webView, musicCur?.id, musicPlaying) {
        val w = webView ?: return@LaunchedEffect
        val id = musicCur?.id?.let { "\"$it\"" } ?: "null"
        w.evaluateJavascript("window.PeiwanMusicState&&window.PeiwanMusicState({id:$id,playing:$musicPlaying})", null)
    }
    androidx.activity.compose.BackHandler(enabled = active && canGoBack) { webView?.goBack() }
    // 切到大厅 tab：打一条尺寸/进度日志（黑屏时看这里是不是 0x0），并强制 WebView 重绘一次
    LaunchedEffect(active, webView) {
        val w = webView ?: return@LaunchedEffect
        if (active) {
            GameLog.d("hall: tab active, view=${w.width}x${w.height} visible=${w.isShown} layer=${w.layerType} hw=${w.isHardwareAccelerated} progress=${w.progress} url=${w.url?.substringBefore("token=")}")
            w.invalidate()
            // 页面侧自检：视口尺寸 / DOM 是否有内容 / 是否被判定为不可见。view 尺寸正常但仍黑屏时，用这条区分「没渲染」还是「画不出来」
            w.evaluateJavascript(
                "(function(){try{var h=function(s){var e=document.querySelector(s);if(!e)return null;var r=e.getBoundingClientRect();return Math.round(r.height)};" +
                    "return JSON.stringify({vw:innerWidth,vh:innerHeight,icb:document.documentElement.clientHeight,html:h('html'),body:h('body'),root:h('#root'),app:h('.app'),page:h('.page'),tabs:h('.top-tabs'),text:(document.body.innerText||'').length,vis:document.visibilityState,ua:(navigator.userAgent.match(/Chrome\\/[\\d.]+/)||[''])[0]})}catch(e){return 'err:'+e}})()",
            ) { GameLog.d("hall: dom $it") }
        }
    }

    if (u == null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("加载中…", color = TextSub, fontSize = 13.sp)
        }
    } else {
        AndroidView(
            // AndroidView 官方建议：WebView 不裁剪、会越界铺底色，Compose 里必须 clipToBounds + clipToOutline
            modifier = modifier.fillMaxSize().clipToBounds(),
            factory = { ctx ->
                android.webkit.WebView(ctx).apply {
                    clipToOutline = true
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    // 与页面底色一致（浅色主题），避免加载时闪一下别的颜色
                    setBackgroundColor(Bg.toArgb())
                    webViewClient = GameLog.webViewClient("hall") { canGoBack = it }
                    // H5 的 console.log / JS 报错转到 logcat（tag=YGameXd），排查黑屏/点击无反应
                    webChromeClient = GameLog.chromeClient("hall")
                    // JS 桥（window.PeiwanNative）：H5 聊天入口唤起原生聊天页 / 小游戏唤起原生全屏网页
                    addJavascriptInterface(HallJsBridge(ctx, onOpenChat, onOpenWeb, onViewMedia = { groups, g, i -> viewer = Triple(groups, g, i) }), "PeiwanNative")
                    // 布局尺寸变化打日志：大厅黑屏时先确认 WebView 有没有拿到真实尺寸
                    addOnLayoutChangeListener { v, l, t, r, b, ol, ot, or, ob ->
                        if (r - l != or - ol || b - t != ob - ot) GameLog.d("hall: webview layout ${r - l}x${b - t}")
                    }
                    GameLog.d("hall: webview created, bridge PeiwanNative registered")
                    loadUrl(u)
                    webView = this
                }
            },
        )
    }
}

/**
 * 在 hash（#）之前加 _t 时间戳：让 index.html 请求每次都不同，绕过 WebView 对旧 index.html 的缓存
 * （旧 index 引用的旧 hash 资源部署后已删除 → 黑屏）。hash 后的路由参数不受影响。
 */
fun withIndexCacheBuster(url: String): String {
    val hashAt = url.indexOf('#')
    val head = if (hashAt >= 0) url.substring(0, hashAt) else url
    val tail = if (hashAt >= 0) url.substring(hashAt) else ""
    val sep = if (head.contains("?")) "&" else "?"
    return "$head${sep}_t=${System.currentTimeMillis()}$tail"
}

/** H5 → 原生播放器的指令（web/src/bridge.ts nativeMusic 发出） */
@kotlinx.serialization.Serializable
private data class MusicCmd(
    val action: String = "",
    val track: MusicTrack? = null,
    val queue: List<MusicTrack>? = null,
    val ratio: Float? = null,
    val value: Float? = null,
)

/** 大厅 H5 → 原生 的 JS 桥（JS 侧调用 PeiwanNative.openChat / openWeb / music） */
private class HallJsBridge(
    private val ctx: android.content.Context,
    private val onOpenChat: (String, Int, String, String) -> Unit,
    private val onOpenWeb: (String, String, Boolean) -> Unit,
    private val onViewMedia: (List<List<com.wh.peiwana.ui.MediaItem>>, Int, Int) -> Unit = { _, _, _ -> },
) {
    /**
     * H5 点图放大 / 点视频：原生全屏查看器（上下滑切帖子、左右滑切图、缩放、原生播放器）。
     * groupsJson: [[{type:image|video,url,cover}], ...] 按显示顺序的所有帖子；group/index = 点开的位置
     */
    @android.webkit.JavascriptInterface
    fun viewMediaGroups(groupsJson: String, group: String, index: String) {
        val itemSer = com.wh.peiwana.ui.MediaItem.serializer()
        val groups = runCatching {
            Api.json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.builtins.ListSerializer(itemSer)), groupsJson)
        }.onFailure { GameLog.w("bridge.viewMediaGroups bad json: ${it.message}") }.getOrNull() ?: return
        val g = group.toIntOrNull() ?: 0
        val i = index.toIntOrNull() ?: 0
        GameLog.d("bridge.viewMediaGroups ${groups.size} groups, group=$g index=$i")
        android.os.Handler(android.os.Looper.getMainLooper()).post { onViewMedia(groups, g, i) }
    }

    /** 兼容：单条帖子的媒体 */
    @android.webkit.JavascriptInterface
    fun viewMedia(itemsJson: String, index: String) = viewMediaGroups("[$itemsJson]", "0", index)

    /**
     * H5 里播音乐交给原生播放器（后台可播、消息页顶部栏/锁屏可控，与原生音乐页共用 MusicCenter）。
     * json: {action: play|pause|resume|stop|seek|rate, track?, queue?, ratio?, value?}
     */
    @android.webkit.JavascriptInterface
    fun music(json: String) {
        val cmd = runCatching { Api.json.decodeFromString(MusicCmd.serializer(), json) }
            .onFailure { GameLog.w("bridge.music bad json: ${it.message}") }.getOrNull() ?: return
        GameLog.d("bridge.music ${cmd.action} track=${cmd.track?.title} queue=${cmd.queue?.size}")
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            when (cmd.action) {
                "play" -> {
                    val t = cmd.track ?: return@post
                    cmd.queue?.takeIf { it.isNotEmpty() }?.let { MusicCenter.setQueue(it) }
                    if (MusicCenter.queue.none { it.id == t.id }) MusicCenter.setQueue(MusicCenter.queue + t)
                    if (MusicCenter.current.value?.id == t.id) { if (!MusicCenter.isPlaying.value) MusicCenter.toggle(ctx) }
                    else MusicCenter.play(ctx, t)
                }
                "pause" -> MusicCenter.pause()
                "resume" -> if (!MusicCenter.isPlaying.value) MusicCenter.toggle(ctx)
                "stop" -> MusicCenter.stop()
                "seek" -> cmd.ratio?.let { MusicCenter.seekTo(it) }
                "rate" -> cmd.value?.let { MusicCenter.setRate(it) }
                else -> GameLog.w("bridge.music unknown action ${cmd.action}")
            }
        }
    }

    @android.webkit.JavascriptInterface
    fun openChat(convId: String, convType: String, targetId: String, title: String) {
        GameLog.d("bridge.openChat conv=$convId type=$convType target=$targetId title=$title")
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            onOpenChat(convId, convType.toIntOrNull() ?: 1, targetId, title)
        }
    }

    /** 小游戏等第三方 H5：独立原生 WebView 全屏打开，不污染大厅页；orientation=landscape 时该页旋转为横屏 */
    @android.webkit.JavascriptInterface
    fun openWeb(url: String, title: String, orientation: String?) {
        GameLog.d("bridge.openWeb url=$url title=$title orientation=$orientation")
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            GameLog.w("bridge.openWeb rejected: url must be http(s)")
            return
        }
        val landscape = orientation == "landscape"
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            GameLog.d("bridge.openWeb -> navigate landscape=$landscape")
            onOpenWeb(url, title, landscape)
        }
    }

    /** 兼容两参调用（默认竖屏） */
    @android.webkit.JavascriptInterface
    fun openWeb(url: String, title: String) = openWeb(url, title, null)
}

/**
 * 小游戏/大厅 WebView 调试日志，logcat 过滤 tag=YGameXd 即可（tag 取得独特些，避免和系统里的 Game 日志混在一起）：
 * adb logcat -s YGameXd
 */
object GameLog {
    const val TAG = "YGameXd"
    fun d(msg: String) = android.util.Log.d(TAG, msg)
    fun w(msg: String) = android.util.Log.w(TAG, msg)
    fun e(msg: String, t: Throwable? = null) = android.util.Log.e(TAG, msg, t)

    /**
     * 页面加载 / 错误 / 渲染进程崩溃日志；
     * onCanGoBack：历史变化（含 hash 路由跳转）时回调网页能否后退，供系统返回键接管
     */
    fun webViewClient(scope: String, onCanGoBack: ((Boolean) -> Unit)? = null) = object : android.webkit.WebViewClient() {
        override fun onPageStarted(view: android.webkit.WebView, url: String?, favicon: android.graphics.Bitmap?) {
            d("$scope: page started ${url?.substringBefore("token=")}")
        }

        override fun onPageFinished(view: android.webkit.WebView, url: String?) {
            d("$scope: page finished ${url?.substringBefore("token=")} title='${view.title}' progress=${view.progress}")
            onCanGoBack?.invoke(view.canGoBack())
        }

        // hash 路由（#/treehole/1）切换不触发 onPageFinished，这里能拿到
        override fun doUpdateVisitedHistory(view: android.webkit.WebView, url: String?, isReload: Boolean) {
            onCanGoBack?.invoke(view.canGoBack())
        }

        override fun onReceivedError(view: android.webkit.WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError) {
            e("$scope: load error main=${request.isForMainFrame} url=${request.url} code=${error.errorCode} desc=${error.description}")
        }

        override fun onReceivedHttpError(view: android.webkit.WebView, request: android.webkit.WebResourceRequest, errorResponse: android.webkit.WebResourceResponse) {
            // 子资源（js/css）404 也要打出来：旧 index.html 引用已删除的 hash 文件就是这种表现
            e("$scope: http error ${errorResponse.statusCode} main=${request.isForMainFrame} url=${request.url}")
        }

        override fun onReceivedSslError(view: android.webkit.WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
            e("$scope: ssl error $error")
            super.onReceivedSslError(view, handler, error)
        }

        override fun onRenderProcessGone(view: android.webkit.WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            e("$scope: render process gone crash=${detail.didCrash()}")
            return super.onRenderProcessGone(view, detail)
        }
    }

    /** H5 console 输出转 logcat */
    fun chromeClient(scope: String) = object : android.webkit.WebChromeClient() {
        override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
            val line = "$scope: [H5 ${m.messageLevel()}] ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})"
            when (m.messageLevel()) {
                android.webkit.ConsoleMessage.MessageLevel.ERROR -> e(line)
                android.webkit.ConsoleMessage.MessageLevel.WARNING -> w(line)
                else -> d(line)
            }
            return true
        }
    }
}

/** 地陪项目主页 */
@Composable
fun GuideProjectScreen(myGender: Int, onBack: () -> Unit, onNav: (String) -> Unit, onOpenChat: (String, String) -> Unit) {
    val isFemale = myGender == 2
    var guides by remember { mutableStateOf<List<com.wh.peiwana.net.Person>>(emptyList()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { guides = runCatching { Api.getList<com.wh.peiwana.net.Person>("/guide/list") }.getOrDefault(emptyList()).take(6) }

    val entries = listOf(
        Triple("找搭子", "按城市寻找认证搭子", "people/guide"),
        Triple("找人", "发现新朋友打招呼", "people/all"),
        if (isFemale) Triple("接单大厅", "报名接单赚积分", "task/hall") else Triple("发布约单", "时间地点报酬托管", "task/post"),
        Triple(if (isFemale) "我的接单" else "我的约单", "查看进行中的约单", "task/mine"),
    )

    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("同城搭子", onBack)
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                entries.take(2).forEach { EntryCard(it, Modifier.weight(1f)) { onNav(it.third) } }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                entries.drop(2).forEach { EntryCard(it, Modifier.weight(1f)) { onNav(it.third) } }
            }
            Text("推荐搭子", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 16.dp))
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(guides, key = { it.id }) { p ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.avatar, 48)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("${p.nickname} · ${p.age}", color = TextMain, fontSize = 15.sp)
                        Text(if (p.signature.isNotEmpty()) p.signature else "这个人很神秘", color = TextSub, fontSize = 12.sp, maxLines = 1)
                    }
                    Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable { onOpenChat(p.id, p.nickname) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                        Text("打招呼", color = Color.White, fontSize = 13.sp)
                    }
                }
            }
            if (guides.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(40.dp), Alignment.Center) { Text("暂无认证搭子", color = TextSub) } }
        }
    }
}

@Composable
private fun EntryCard(e: Triple<String, String, String>, modifier: Modifier, onClick: () -> Unit) {
    Column(modifier = modifier.clip(RoundedCornerShape(14.dp)).background(Bg2).clickable(onClick = onClick).padding(16.dp)) {
        Text(e.first, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Text(e.second, color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 5.dp))
    }
}

/** 找人 / 找搭子 */
@Composable
fun PeopleScreen(mode: String, onBack: () -> Unit, onOpenChat: (String, String) -> Unit) {
    var tab by remember { mutableStateOf(if (mode == "guide") "guide" else "all") }
    var items by remember { mutableStateOf<List<com.wh.peiwana.net.Person>>(emptyList()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(tab) {
        items = runCatching { Api.getList<com.wh.peiwana.net.Person>(if (tab == "guide") "/guide/list" else "/guide/discover") }.getOrDefault(emptyList())
    }
    Column(modifier = Modifier.fillMaxSize()) {
        NavBar(if (tab == "guide") "找搭子" else "找人", onBack)
        Row(modifier = Modifier.padding(16.dp, 0.dp, 16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            listOf("guide" to "认证", "all" to "全部").forEach { (k, label) ->
                Text(label, color = if (tab == k) TextMain else TextSub, fontSize = if (tab == k) 17.sp else 16.sp, fontWeight = if (tab == k) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.noRippleClick { tab = k })
            }
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(items, key = { it.id }) { p ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.avatar, 56)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${p.nickname} · ${p.age}", color = TextMain, fontSize = 15.sp)
                            if (p.isGuide) Text(" 认证", color = Accent, fontSize = 11.sp)
                        }
                        Text(if (p.signature.isNotEmpty()) p.signature else "这个人很神秘", color = TextSub, fontSize = 12.sp, maxLines = 1)
                        if (p.cityName.isNotEmpty()) Text(p.cityName, color = TextDim, fontSize = 11.sp)
                    }
                    Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable { onOpenChat(p.id, p.nickname) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                        Text("打招呼", color = Color.White, fontSize = 13.sp)
                    }
                }
            }
            if (items.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(40.dp), Alignment.Center) { Text("暂无用户", color = TextSub) } }
        }
    }
}
