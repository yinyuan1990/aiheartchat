package com.wh.peiwana.ui.screen

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.wh.peiwana.ui.BackIcon
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*

/**
 * 小游戏 / 第三方 H5 全屏容器：独立于大厅 WebView，游戏内跳转不影响大厅页。
 * - landscape=true：仅本页旋转为横屏（Activity 清单锁竖屏，这里运行时改 requestedOrientation，离开还原），
 *   横屏时隐藏系统栏沉浸式、不显示顶栏，左上角浮动返回键
 * - 竖屏顶栏：返回（优先网页后退）、标题（跟随网页 title）、关闭
 * - WebView 按游戏场景配置：JS / DOM 存储 / 自动播放媒体 / 视口自适应 / 混合内容 / 网页全屏（video、canvas）
 * - 系统返回键：网页有历史先后退，否则关闭页面
 * - 非 http(s) 链接（如 weixin://、alipays://）交给系统处理
 */
private fun android.content.Context.findActivity(): android.app.Activity? {
    var ctx: android.content.Context? = this
    while (ctx != null) {
        if (ctx is android.app.Activity) return ctx
        ctx = (ctx as? android.content.ContextWrapper)?.baseContext
    }
    return null
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun GameWebScreen(url: String, title: String, landscape: Boolean = false, onBack: () -> Unit) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    var pageTitle by remember { mutableStateOf(title) }
    var progress by remember { mutableIntStateOf(0) }
    var canGoBack by remember { mutableStateOf(false) }
    // 网页请求全屏（video.requestFullscreen / canvas 全屏）时的自定义视图
    var fullscreenView by remember { mutableStateOf<View?>(null) }
    var fullscreenCallback by remember { mutableStateOf<WebChromeClient.CustomViewCallback?>(null) }

    // 横屏游戏：进入时旋转 + 沉浸式（隐藏状态栏/导航栏），离开还原竖屏
    val activity = androidx.compose.ui.platform.LocalContext.current.findActivity()
    DisposableEffect(landscape, activity) {
        GameLog.d("game: enter url=$url title=$title landscape=$landscape activity=${activity?.javaClass?.simpleName}")
        val window = activity?.window
        val controller = window?.let { androidx.core.view.WindowCompat.getInsetsController(it, it.decorView) }
        if (landscape && activity != null) {
            activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            controller?.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            GameLog.d("game: requested landscape, system bars hidden")
        }
        onDispose {
            if (landscape && activity != null) {
                controller?.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                GameLog.d("game: restored portrait")
            }
            GameLog.d("game: leave")
        }
    }

    fun exitFullscreen() {
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        fullscreenView = null
    }

    fun goBack() {
        when {
            fullscreenView != null -> exitFullscreen()
            webView?.canGoBack() == true -> webView?.goBack()
            else -> onBack()
        }
    }

    BackHandler { goBack() }

    // 页面离开时暂停并销毁，避免游戏音频/定时器在后台继续跑
    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                loadUrl("about:blank")
                onPause()
                (parent as? ViewGroup)?.removeView(this)
                destroy()
            }
            webView = null
        }
    }

    Box(Modifier.fillMaxSize().background(if (landscape) Color.Black else Bg)) {
        Column(Modifier.fillMaxSize()) {
            if (!landscape) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(modifier = Modifier.size(40.dp).noRippleClick { goBack() }, contentAlignment = Alignment.Center) {
                        BackIcon(TextMain, 24.dp)
                    }
                    Text(
                        pageTitle.ifBlank { title },
                        color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center, maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    Box(modifier = Modifier.size(56.dp, 40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) {
                        Text(if (canGoBack) "关闭" else "", color = TextSub, fontSize = 14.sp)
                    }
                }
            }
            if (progress in 1..99) {
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth().height(2.dp),
                    color = Accent,
                    trackColor = Color.Transparent,
                )
            }
            AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth().then(if (landscape) Modifier else Modifier.navigationBarsPadding()),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        setBackgroundColor(0xFF000000.toInt())
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            databaseEnabled = true
                            // 游戏多用 viewport meta 自适配；无 viewport 的老页面缩放到屏宽
                            useWideViewPort = true
                            loadWithOverviewMode = true
                            builtInZoomControls = false
                            displayZoomControls = false
                            // 游戏音效/背景音乐无需用户手势即可播放
                            mediaPlaybackRequiresUserGesture = false
                            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                            javaScriptCanOpenWindowsAutomatically = true
                            setSupportMultipleWindows(false)
                            cacheMode = WebSettings.LOAD_DEFAULT
                            allowFileAccess = false
                            userAgentString = "$userAgentString PeiwanApp/Android"
                        }
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val u = request.url ?: return false
                                val scheme = u.scheme?.lowercase() ?: return false
                                if (scheme == "http" || scheme == "https") return false
                                // 支付宝 / 微信等 scheme 跳转交给系统，App 未安装则忽略
                                GameLog.d("game: external scheme $u")
                                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                    .onFailure { GameLog.w("game: open external failed $it") }
                                return true
                            }

                            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                                GameLog.d("game: page started $url")
                                canGoBack = view.canGoBack()
                            }

                            override fun onPageFinished(view: WebView, url: String?) {
                                GameLog.d("game: page finished $url title='${view.title}'")
                                canGoBack = view.canGoBack()
                                progress = 100
                            }

                            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                                GameLog.e("game: load error main=${request.isForMainFrame} url=${request.url} code=${error.errorCode} desc=${error.description}")
                            }

                            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: android.webkit.WebResourceResponse) {
                                if (request.isForMainFrame) GameLog.e("game: http error ${errorResponse.statusCode} url=${request.url}")
                            }

                            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                                GameLog.e("game: render process gone crash=${detail.didCrash()}")
                                return super.onRenderProcessGone(view, detail)
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) {
                                progress = newProgress
                            }

                            override fun onReceivedTitle(view: WebView, t: String?) {
                                if (!t.isNullOrBlank() && !t.startsWith("http")) pageTitle = t
                            }

                            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                                GameLog.d("game: [H5 ${m.messageLevel()}] ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                                return true
                            }

                            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                                GameLog.d("game: enter web fullscreen")
                                if (fullscreenView != null) {
                                    callback.onCustomViewHidden()
                                    return
                                }
                                fullscreenView = view
                                fullscreenCallback = callback
                            }

                            override fun onHideCustomView() {
                                GameLog.d("game: exit web fullscreen")
                                exitFullscreen()
                            }
                        }
                        GameLog.d("game: webview created ua=${settings.userAgentString}")
                        loadUrl(url)
                        webView = this
                    }
                },
            )
        }

        // 横屏无顶栏：左上角浮动返回键（半透明圆底，避开刘海）
        if (landscape) {
            Box(
                modifier = Modifier
                    .displayCutoutPadding()
                    .padding(start = 10.dp, top = 10.dp)
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.45f))
                    .noRippleClick { goBack() },
                contentAlignment = Alignment.Center,
            ) {
                BackIcon(Color.White, 20.dp)
            }
        }

        // 网页全屏层：覆盖整个页面（含顶栏），返回键退出
        fullscreenView?.let { v ->
            key(v) {
                AndroidView(
                    modifier = Modifier.fillMaxSize().background(Color.Black),
                    factory = { ctx ->
                        FrameLayout(ctx).apply {
                            setBackgroundColor(0xFF000000.toInt())
                            (v.parent as? ViewGroup)?.removeView(v)
                            addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                        }
                    },
                    onRelease = { container -> container.removeAllViews() },
                )
            }
        }
    }

    // 切到后台暂停游戏（音频/定时器），回前台恢复
    @Suppress("DEPRECATION")
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, webView) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_PAUSE -> webView?.onPause()
                androidx.lifecycle.Lifecycle.Event.ON_RESUME -> webView?.onResume()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}
