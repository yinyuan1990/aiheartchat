package com.wh.peiwana.ui.screen

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.wh.peiwana.BuildConfig
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.UserProfile
import com.wh.peiwana.ui.BackIcon
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.serialization.json.*
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 链上钱包（自托管网页钱包，页面在 Arm 网站 /wallet）+ DApp 浏览器。
 * - 入口：官网渠道包（BuildConfig.WALLET_ALLOWED）+ 后台开关（/user/me features.wallet）；本机已有钱包的人即使开关关了也保留入口（导出 / 转出资产）。
 * - 原生桥 window.ArmWalletNative 只注入到钱包页面的源（addWebMessageListener + addDocumentStartJavaScript 都按源限制），别的网页拿不到。
 * - 钱包数据本身已经被钱包密码加密；落盘前再用 Android Keystore 的硬件密钥加密一层，存 App 私有目录。
 * - 显示 / 导出助记词时网页调 setSecureScreen(true) → FLAG_SECURE，禁止截屏录屏。
 * - DApp 浏览器和钱包在同一个页面里：钱包 WebView 在下、DApp WebView 在上；DApp 发来连接 / 签名 / 交易请求时，
 *   钱包页弹确认框并调 dappShow(true)，这里把（背景透明的）钱包 WebView 提到最上面，确认框后面看到的是 DApp 网页。
 *   私钥始终只在钱包 WebView 的内存里，DApp WebView 只拿到注入的 window.ethereum。
 */
object ChainWalletVault {
    private const val KEY_ALIAS = "arm_wallet_vault_v1"
    private const val FILE = "arm_wallet_vault.bin"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)

    fun exists(ctx: Context) = file(ctx).exists()

    fun read(ctx: Context): String? {
        val f = file(ctx)
        if (!f.exists()) return null
        val raw = Base64.decode(f.readText(), Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return String(c.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8)
    }

    fun write(ctx: Context, value: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8))
        val tmp = File(ctx.filesDir, "$FILE.tmp")
        tmp.writeText(Base64.encodeToString(out, Base64.NO_WRAP))
        tmp.renameTo(file(ctx))
    }

    fun clear(ctx: Context) {
        file(ctx).delete()
    }
}

/** 钱包页的非机密数据（站点授权、DApp 最近浏览 / 收藏）；放原生是因为 DApp WebView 和钱包同源时会共用 localStorage */
private object ChainWalletStore {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("arm_wallet_store", Context.MODE_PRIVATE)
    fun get(ctx: Context, key: String): String? = prefs(ctx).getString(key, null)
    fun set(ctx: Context, key: String, value: String?) {
        prefs(ctx).edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

/** 官网包里才有钱包；开关关了但本机已有钱包的人仍显示入口 */
fun chainWalletVisible(ctx: Context, me: UserProfile?): Boolean =
    BuildConfig.WALLET_ALLOWED && (me?.features?.wallet == true || ChainWalletVault.exists(ctx))

private const val MIN_WEBVIEW_MAJOR = 99
private const val FALLBACK_URL = "https://arm.yyheart.com/wallet"

private val BRIDGE_JS = """
(function(){
  if (window.ArmWalletNative || !window.ArmWalletBridge) return;
  var bridge = window.ArmWalletBridge, seq = 0, pending = {};
  bridge.onmessage = function(e){
    var m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.push) { window.dispatchEvent(new CustomEvent('armwallet:native', { detail: m })); return; }
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result === undefined ? null : m.result);
  };
  function call(method, arg){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      bridge.postMessage(JSON.stringify({ id: id, method: method, arg: arg === undefined ? null : arg }));
    });
  }
  window.ArmWalletNative = {
    platform: 'android',
    features: ['dapp', 'store'],
    vaultGet: function(){ return call('vaultGet'); },
    vaultSet: function(v){ return call('vaultSet', String(v)); },
    vaultClear: function(){ return call('vaultClear'); },
    storeGet: function(k){ return call('storeGet', String(k)); },
    storeSet: function(k, v){ return call('storeSet', { key: String(k), value: v == null ? null : String(v) }); },
    setSecureScreen: function(on){ call('setSecureScreen', !!on); },
    share: function(t){ call('share', String(t)); },
    toast: function(t){ call('toast', String(t)); },
    openDapp: function(u){ call('openDapp', String(u)); },
    dappReady: function(){ call('dappReady'); },
    dappRespond: function(r){ call('dappRespond', r); },
    dappEmit: function(e){ call('dappEmit', e); },
    dappShow: function(on){ call('dappShow', !!on); },
  };
})();
""".trimIndent()

/**
 * 内核真实的 Chromium 主版本：从默认 UA 的 "Chrome/xxx" 取。不能用 WebView 包的 versionName——
 * 华为等厂商自带的 WebView 包（com.huawei.webview 等）版本号是自己的编号（如 14.x），和 Chromium 版本无关。
 * 取不到返回 0（不拦）。
 */
private fun chromiumMajor(ctx: Context): Int {
    val ua = runCatching { android.webkit.WebSettings.getDefaultUserAgent(ctx) }.getOrNull().orEmpty()
    Regex("""Chrome/(\d+)""").find(ua)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
    return WebViewCompat.getCurrentWebViewPackage(ctx)?.takeIf { it.packageName.contains("google") || it.packageName == "com.android.webview" || it.packageName == "com.android.chrome" }
        ?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
}

private fun originOf(url: String): String? = runCatching {
    val u = Uri.parse(url)
    if (u.scheme != "https" || u.host.isNullOrBlank()) null else "https://${u.host}"
}.getOrNull()

private fun originOf(u: Uri): String? {
    val scheme = u.scheme ?: return null
    val host = u.host?.takeIf { it.isNotBlank() } ?: return null
    return if (u.port == -1) "$scheme://$host" else "$scheme://$host:${u.port}"
}

@SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
@Composable
fun ChainWalletScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    val activity = remember(ctx) { generateSequence(ctx) { (it as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull() }
    var me by remember { mutableStateOf<UserProfile?>(null) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull()
        loaded = true
    }
    val webMajor = remember { chromiumMajor(ctx) }
    val bridgeOk = remember { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) }
    val url = me?.features?.walletUrl?.takeIf { it.isNotBlank() } ?: FALLBACK_URL
    val origin = originOf(url)

    var walletView by remember { mutableStateOf<WebView?>(null) }
    var dappView by remember { mutableStateOf<WebView?>(null) }
    var container by remember { mutableStateOf<FrameLayout?>(null) }
    var progress by remember { mutableIntStateOf(0) }
    // DApp 浏览器状态：dappUrl 非空 = 正在浏览
    var dappUrl by remember { mutableStateOf<String?>(null) }
    var dappTitle by remember { mutableStateOf("") }
    var dappCurrent by remember { mutableStateOf("") }
    var dappProgress by remember { mutableIntStateOf(0) }
    var approving by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val hub = remember { DappHub(onShow = { approving = it }) }

    // 确认框弹出时钱包 WebView 盖在 DApp 上面，收起时 DApp 回到上面
    LaunchedEffect(approving, dappView, walletView) {
        val top = if (approving || dappView == null) walletView else dappView
        top?.bringToFront()
    }

    fun closeDapp() {
        hub.reset()
        approving = false
        dappView?.apply {
            stopLoading()
            loadUrl("about:blank")
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        dappView = null
        dappUrl = null
        dappTitle = ""
        dappCurrent = ""
    }

    fun openDapp(target: String) {
        val u = Uri.parse(target)
        if (u.scheme != "https" && u.scheme != "http") return
        val box = container ?: return
        if (dappView != null) {
            dappView?.loadUrl(target)
            dappUrl = target
            return
        }
        val v = WebView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(android.graphics.Color.WHITE)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                setSupportMultipleWindows(false)
                userAgentString = "$userAgentString PeiwanApp/Android ArmWallet/1"
            }
            // 任何源都能拿到 window.ethereum，但只有 https 主框架的请求会被转给钱包（DappHub.onDappMessage 里判断）
            val sync = if (bridgeOk) {
                WebViewCompat.addWebMessageListener(this, "ArmDappBridge", setOf("*")) { _, message, sourceOrigin, isMainFrame, reply ->
                    hub.onDappMessage(originOf(sourceOrigin), isMainFrame, message.data) { s -> reply.postMessage(s) }
                }
                WebViewCompat.addDocumentStartJavaScript(this, DAPP_PROVIDER_JS, setOf("*"))
                null
            } else {
                DappSyncBridge(this, hub).also { addJavascriptInterface(it, "ArmDappBridge") }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val s = request.url?.scheme?.lowercase() ?: return false
                    if (s == "http" || s == "https" || s == "about" || s == "data" || s == "blob") return false
                    // intent:// 可以指定任意组件，不交给系统
                    if (s != "intent") runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    return true
                }

                override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) {
                    hub.reset()
                    dappCurrent = pageUrl.orEmpty()
                    sync?.newPage()
                    sync?.inject()
                }

                override fun onPageFinished(view: WebView, pageUrl: String?) {
                    sync?.inject()
                    val p = pageUrl.orEmpty()
                    dappCurrent = p
                    if (p.startsWith("https://") || p.startsWith("http://")) hub.visited(p, view.title?.takeIf { it.isNotBlank() && !it.startsWith("http") })
                }
            }
            webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    dappProgress = newProgress
                    sync?.inject()
                }

                override fun onReceivedTitle(view: WebView, title: String?) {
                    dappTitle = title?.takeIf { !it.startsWith("http") }.orEmpty()
                }
            }
            loadUrl(target)
        }
        box.addView(v)
        dappView = v
        dappUrl = target
        dappCurrent = target
    }

    val shell = remember {
        WalletShell(
            ctx = ctx,
            activity = { activity },
            hub = hub,
            onOpenDapp = { openDapp(it) },
        )
    }

    // 离开页面一定撤掉 FLAG_SECURE，免得影响 App 其它页面截图
    DisposableEffect(activity) {
        onDispose { activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    DisposableEffect(Unit) {
        onDispose {
            listOfNotNull(dappView, walletView).forEach {
                it.stopLoading()
                it.loadUrl("about:blank")
                (it.parent as? ViewGroup)?.removeView(it)
                it.destroy()
            }
            dappView = null
            walletView = null
        }
    }

    fun back() {
        when {
            approving -> hub.cancel()
            dappView != null -> if (dappView?.canGoBack() == true) dappView?.goBack() else closeDapp()
            walletView?.canGoBack() == true -> walletView?.goBack()
            else -> onBack()
        }
    }
    BackHandler { back() }

    Column(Modifier.fillMaxSize().background(Bg).statusBarsPadding()) {
        if (dappUrl == null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).noRippleClick { back() }, contentAlignment = Alignment.Center) {
                    BackIcon(TextMain, 24.dp)
                }
                Text("链上钱包", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                Box(Modifier.size(56.dp, 40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) {
                    Text("关闭", color = TextSub, fontSize = 14.sp)
                }
            }
            if (progress in 1..99) {
                LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth().height(2.dp), color = Accent, trackColor = Color.Transparent)
            }
        } else {
            val cur = Uri.parse(dappCurrent.ifBlank { dappUrl!! })
            val secure = cur.scheme == "https"
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).noRippleClick { back() }, contentAlignment = Alignment.Center) {
                    BackIcon(TextMain, 24.dp)
                }
                Box(Modifier.size(40.dp).noRippleClick { if (approving) hub.cancel() else closeDapp() }, contentAlignment = Alignment.Center) {
                    Text("✕", color = TextMain, fontSize = 18.sp)
                }
                Column(Modifier.weight(1f).padding(horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        dappTitle.ifBlank { cur.host.orEmpty() },
                        color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        (if (secure) "🔒 " else "⚠ 不安全 · ") + cur.host.orEmpty(),
                        color = if (secure) TextSub else Color(0xFFD48806), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Box {
                    Box(Modifier.size(44.dp, 40.dp).noRippleClick { if (!approving) menu = true }, contentAlignment = Alignment.Center) {
                        Text("⋯", color = TextMain, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        val page = dappCurrent.ifBlank { dappUrl!! }
                        DropdownMenuItem(text = { Text("收藏 / 取消收藏") }, onClick = { menu = false; hub.favorite(page, dappTitle.ifBlank { null }) })
                        DropdownMenuItem(text = { Text("复制链接") }, onClick = {
                            menu = false
                            (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("url", page))
                            Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show()
                        })
                        DropdownMenuItem(text = { Text("刷新") }, onClick = { menu = false; dappView?.reload() })
                        DropdownMenuItem(text = { Text("在浏览器打开") }, onClick = {
                            menu = false
                            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        })
                        DropdownMenuItem(text = { Text("分享") }, onClick = {
                            menu = false
                            val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, page)
                            runCatching { ctx.startActivity(Intent.createChooser(i, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        })
                    }
                }
            }
            if (dappProgress in 1..99) {
                LinearProgressIndicator(progress = { dappProgress / 100f }, modifier = Modifier.fillMaxWidth().height(2.dp), color = Accent, trackColor = Color.Transparent)
            }
        }

        when {
            !BuildConfig.WALLET_ALLOWED -> Notice("当前版本不提供钱包功能")
            !loaded -> Box(Modifier.fillMaxSize())
            !chainWalletVisible(ctx, me) -> Notice("钱包功能暂未对你开放")
            webMajor in 1 until MIN_WEBVIEW_MAJOR || origin == null -> WebViewTooOld(webMajor)
            else -> AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth().navigationBarsPadding(),
                factory = { c ->
                    val box = FrameLayout(c)
                    val wallet = WebView(c).apply {
                        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        // 透明：钱包页弹 DApp 确认框时会把自己的背景去掉，露出下面的 DApp 网页
                        setBackgroundColor(android.graphics.Color.TRANSPARENT)
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            allowFileAccess = false
                            allowContentAccess = false
                            setSupportMultipleWindows(false)
                            userAgentString = "$userAgentString PeiwanApp/Android ArmWallet/1"
                        }
                        val rules = setOf(origin!!)
                        val pageOrigin = java.util.concurrent.atomic.AtomicReference<String?>(null)
                        if (bridgeOk) {
                            WebViewCompat.addWebMessageListener(this, "ArmWalletBridge", rules) { view, message, _, isMainFrame, reply ->
                                if (isMainFrame) shell.handle(view, message, reply)
                            }
                            WebViewCompat.addDocumentStartJavaScript(this, BRIDGE_JS, rules)
                        } else {
                            // 厂商 WebView（华为 / 荣耀等）常不支持上面两个 androidx.webkit 特性：退回同步 JS 接口，每次调用都核对当前页面的源
                            addJavascriptInterface(SyncBridge(c, activity, this, origin, pageOrigin, hub) { openDapp(it) }, "ArmWalletNative")
                        }
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val u = request.url ?: return false
                                // 钱包只在自己的源里跳；其它网址（Arm 主站、区块浏览器）交给系统浏览器，桥接不会带过去
                                if (originOf(u.toString()) == origin && u.path?.startsWith("/wallet") == true) return false
                                runCatching { c.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                return true
                            }

                            override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) {
                                pageOrigin.set(pageUrl?.let(::originOf))
                                hub.walletGone()
                            }
                        }
                        webChromeClient = object : android.webkit.WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) {
                                progress = newProgress
                            }
                        }
                        loadUrl(url)
                    }
                    box.addView(wallet)
                    walletView = wallet
                    container = box
                    box
                },
            )
        }
    }
}

/** 钱包页原生桥的实现（方法名和 BRIDGE_JS 里的一一对应） */
private class WalletShell(
    private val ctx: Context,
    private val activity: () -> android.app.Activity?,
    private val hub: DappHub,
    private val onOpenDapp: (String) -> Unit,
) {
    fun handle(view: WebView, message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val req = runCatching { Json.parseToJsonElement(message.data ?: "").jsonObject }.getOrNull() ?: return
        val id = req["id"]?.jsonPrimitive?.intOrNull ?: return
        val method = req["method"]?.jsonPrimitive?.contentOrNull ?: return
        val arg = req["arg"]
        fun send(result: JsonElement = JsonNull, error: String? = null) {
            val out = buildJsonObject {
                put("id", id)
                if (error != null) put("error", error) else put("result", result)
            }
            view.post { reply.postMessage(out.toString()) }
        }
        val str = (arg as? JsonPrimitive)?.contentOrNull
        try {
            when (method) {
                "vaultGet" -> send(ChainWalletVault.read(ctx)?.let { JsonPrimitive(it) } ?: JsonNull)
                "vaultSet" -> {
                    val v = str ?: return send(error = "empty vault")
                    ChainWalletVault.write(ctx, v)
                    send(JsonPrimitive(true))
                }
                "vaultClear" -> {
                    ChainWalletVault.clear(ctx)
                    send(JsonPrimitive(true))
                }
                "storeGet" -> send(str?.let { ChainWalletStore.get(ctx, it) }?.let { JsonPrimitive(it) } ?: JsonNull)
                "storeSet" -> {
                    val o = arg as? JsonObject ?: return send(error = "bad arg")
                    val key = o["key"]?.jsonPrimitive?.contentOrNull ?: return send(error = "no key")
                    ChainWalletStore.set(ctx, key, o["value"]?.jsonPrimitive?.contentOrNull)
                    send(JsonPrimitive(true))
                }
                "setSecureScreen" -> {
                    val on = (arg as? JsonPrimitive)?.booleanOrNull == true
                    view.post {
                        if (on) activity()?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        else activity()?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                    send(JsonPrimitive(true))
                }
                "share" -> {
                    view.post {
                        val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, str.orEmpty())
                        runCatching { ctx.startActivity(Intent.createChooser(i, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                    send(JsonPrimitive(true))
                }
                "toast" -> {
                    view.post { Toast.makeText(ctx, str.orEmpty(), Toast.LENGTH_SHORT).show() }
                    send(JsonPrimitive(true))
                }
                "openDapp" -> {
                    val u = str ?: return send(error = "no url")
                    view.post { onOpenDapp(u) }
                    send(JsonPrimitive(true))
                }
                "dappReady" -> {
                    hub.walletReady { s -> reply.postMessage(s) }
                    send(JsonPrimitive(true))
                }
                "dappRespond" -> {
                    (arg as? JsonObject)?.let { hub.respond(it) }
                    send(JsonPrimitive(true))
                }
                "dappEmit" -> {
                    (arg as? JsonObject)?.let { hub.emit(it) }
                    send(JsonPrimitive(true))
                }
                "dappShow" -> {
                    hub.show((arg as? JsonPrimitive)?.booleanOrNull == true)
                    send(JsonPrimitive(true))
                }
                else -> send(error = "unknown method $method")
            }
        } catch (e: Exception) {
            send(error = e.message ?: e.javaClass.simpleName)
        }
    }
}

/**
 * 兜底桥（同步）：方法跑在 WebView 的 JS 线程，返回值直接给网页；页面源不是钱包源一律拒绝。
 * 没有 BRIDGE_JS 包装，网页通过 bridgeInfo() 认出这条桥（对象参数要先 JSON.stringify，见 native.ts）；
 * 原生推给钱包页的消息用 evaluateJavascript 派发 armwallet:native 事件。
 */
private class SyncBridge(
    private val ctx: Context,
    private val activity: android.app.Activity?,
    private val view: WebView,
    private val allowed: String,
    private val pageOrigin: java.util.concurrent.atomic.AtomicReference<String?>,
    private val hub: DappHub,
    private val onOpenDapp: (String) -> Unit,
) {
    private fun ok() = pageOrigin.get() == allowed

    private fun obj(s: String?) = runCatching { Json.parseToJsonElement(s ?: "").jsonObject }.getOrNull()

    @android.webkit.JavascriptInterface
    fun bridgeInfo(): String = if (ok()) """{"platform":"android","features":["dapp","store"]}""" else "{}"

    @android.webkit.JavascriptInterface
    fun vaultGet(): String? = if (ok()) runCatching { ChainWalletVault.read(ctx) }.getOrNull() else null

    @android.webkit.JavascriptInterface
    fun vaultSet(v: String): Boolean = ok() && runCatching { ChainWalletVault.write(ctx, v) }.isSuccess

    @android.webkit.JavascriptInterface
    fun vaultClear(): Boolean = ok() && runCatching { ChainWalletVault.clear(ctx) }.isSuccess

    @android.webkit.JavascriptInterface
    fun storeGet(key: String?): String? = if (ok() && key != null) ChainWalletStore.get(ctx, key) else null

    @android.webkit.JavascriptInterface
    fun storeSet(key: String?, value: String?): Boolean = ok() && key != null && runCatching { ChainWalletStore.set(ctx, key, value) }.isSuccess

    @android.webkit.JavascriptInterface
    fun setSecureScreen(on: Boolean) {
        if (!ok()) return
        view.post {
            if (on) activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    @android.webkit.JavascriptInterface
    fun share(text: String) {
        if (!ok()) return
        view.post {
            val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            runCatching { ctx.startActivity(Intent.createChooser(i, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }

    @android.webkit.JavascriptInterface
    fun toast(text: String?) {
        if (ok()) view.post { Toast.makeText(ctx, text.orEmpty(), Toast.LENGTH_SHORT).show() }
    }

    @android.webkit.JavascriptInterface
    fun openDapp(url: String?) {
        if (ok() && url != null) view.post { onOpenDapp(url) }
    }

    @android.webkit.JavascriptInterface
    fun dappReady() {
        if (!ok()) return
        view.post {
            hub.walletReady { s ->
                if (ok()) view.evaluateJavascript("window.dispatchEvent(new CustomEvent('armwallet:native',{detail:$s}))", null)
            }
        }
    }

    @android.webkit.JavascriptInterface
    fun dappRespond(json: String?) {
        val o = obj(json) ?: return
        if (ok()) view.post { hub.respond(o) }
    }

    @android.webkit.JavascriptInterface
    fun dappEmit(json: String?) {
        val o = obj(json) ?: return
        if (ok()) view.post { hub.emit(o) }
    }

    @android.webkit.JavascriptInterface
    fun dappShow(on: Boolean) {
        if (ok()) view.post { hub.show(on) }
    }
}

@Composable
private fun Notice(text: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, color = TextSub, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun WebViewTooOld(major: Int) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("系统 WebView 版本太旧", color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(
            "钱包需要较新的系统网页内核（Chromium ${MIN_WEBVIEW_MAJOR}+${if (major > 0) "，当前 $major" else ""}）。请到应用商店更新「Android System WebView」或 Chrome 后再打开。",
            color = TextSub, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp),
        )
        Box(
            Modifier.padding(top = 24.dp).clip(RoundedCornerShape(14.dp)).background(Accent)
                .noRippleClick {
                    val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.webview")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { ctx.startActivity(market) }.onFailure {
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                }
                .padding(horizontal = 24.dp, vertical = 12.dp),
        ) { Text("去更新", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
    }
}
