package com.wh.peiwana.ui.screen

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
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
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
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
 * 链上钱包（自托管网页钱包，页面在 Arm 网站 /wallet）。
 * - 入口：官网渠道包（BuildConfig.WALLET_ALLOWED）+ 后台开关（/user/me features.wallet）；本机已有钱包的人即使开关关了也保留入口（导出 / 转出资产）。
 * - 原生桥 window.ArmWalletNative 只注入到钱包页面的源（addWebMessageListener + addDocumentStartJavaScript 都按源限制），别的网页拿不到。
 * - 钱包数据本身已经被钱包密码加密；落盘前再用 Android Keystore 的硬件密钥加密一层，存 App 私有目录。
 * - 显示 / 导出助记词时网页调 setSecureScreen(true) → FLAG_SECURE，禁止截屏录屏。
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

/** 官网包里才有钱包；开关关了但本机已有钱包的人仍显示入口 */
fun chainWalletVisible(ctx: Context, me: UserProfile?): Boolean =
    BuildConfig.WALLET_ALLOWED && (me?.features?.wallet == true || ChainWalletVault.exists(ctx))

private const val MIN_WEBVIEW_MAJOR = 111
private const val FALLBACK_URL = "https://arm.yyheart.com/wallet"

private val BRIDGE_JS = """
(function(){
  if (window.ArmWalletNative || !window.ArmWalletBridge) return;
  var bridge = window.ArmWalletBridge, seq = 0, pending = {};
  bridge.onmessage = function(e){
    var m; try { m = JSON.parse(e.data); } catch (_) { return; }
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
    vaultGet: function(){ return call('vaultGet'); },
    vaultSet: function(v){ return call('vaultSet', String(v)); },
    vaultClear: function(){ return call('vaultClear'); },
    setSecureScreen: function(on){ call('setSecureScreen', !!on); },
    share: function(t){ call('share', String(t)); },
  };
})();
""".trimIndent()

private fun originOf(url: String): String? = runCatching {
    val u = Uri.parse(url)
    if (u.scheme != "https" || u.host.isNullOrBlank()) null else "https://${u.host}"
}.getOrNull()

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
    val webMajor = remember { WebViewCompat.getCurrentWebViewPackage(ctx)?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0 }
    val bridgeOk = remember { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) }
    val url = me?.features?.walletUrl?.takeIf { it.isNotBlank() } ?: FALLBACK_URL
    val origin = originOf(url)
    var webView by remember { mutableStateOf<WebView?>(null) }
    var progress by remember { mutableIntStateOf(0) }

    // 离开页面一定撤掉 FLAG_SECURE，免得影响 App 其它页面截图
    DisposableEffect(activity) {
        onDispose { activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                loadUrl("about:blank")
                (parent as? ViewGroup)?.removeView(this)
                destroy()
            }
            webView = null
        }
    }
    BackHandler {
        if (webView?.canGoBack() == true) webView?.goBack() else onBack()
    }

    Column(Modifier.fillMaxSize().background(Bg).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).noRippleClick { if (webView?.canGoBack() == true) webView?.goBack() else onBack() }, contentAlignment = Alignment.Center) {
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

        when {
            !BuildConfig.WALLET_ALLOWED -> Notice("当前版本不提供钱包功能")
            !loaded -> Box(Modifier.fillMaxSize())
            !chainWalletVisible(ctx, me) -> Notice("钱包功能暂未对你开放")
            webMajor in 1 until MIN_WEBVIEW_MAJOR || !bridgeOk || origin == null -> WebViewTooOld(webMajor)
            else -> AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth().navigationBarsPadding(),
                factory = { c ->
                    WebView(c).apply {
                        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            allowFileAccess = false
                            allowContentAccess = false
                            setSupportMultipleWindows(false)
                            userAgentString = "$userAgentString PeiwanApp/Android ArmWallet/1"
                        }
                        val rules = setOf(origin!!)
                        WebViewCompat.addWebMessageListener(this, "ArmWalletBridge", rules) { view, message, _, isMainFrame, reply ->
                            if (isMainFrame) handleBridge(c, activity, view, message, reply)
                        }
                        WebViewCompat.addDocumentStartJavaScript(this, BRIDGE_JS, rules)
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val u = request.url ?: return false
                                // 钱包只在自己的源里跳；其它网址（Arm 主站、区块浏览器）交给系统浏览器，桥接不会带过去
                                if (originOf(u.toString()) == origin && u.path?.startsWith("/wallet") == true) return false
                                runCatching { c.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                return true
                            }
                        }
                        webChromeClient = object : android.webkit.WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) {
                                progress = newProgress
                            }
                        }
                        loadUrl(url)
                        webView = this
                    }
                },
            )
        }
    }
}

private fun handleBridge(ctx: Context, activity: android.app.Activity?, view: WebView, message: WebMessageCompat, reply: JavaScriptReplyProxy) {
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
    try {
        when (method) {
            "vaultGet" -> send(ChainWalletVault.read(ctx)?.let { JsonPrimitive(it) } ?: JsonNull)
            "vaultSet" -> {
                val v = (arg as? JsonPrimitive)?.contentOrNull ?: return send(error = "empty vault")
                ChainWalletVault.write(ctx, v)
                send(JsonPrimitive(true))
            }
            "vaultClear" -> {
                ChainWalletVault.clear(ctx)
                send(JsonPrimitive(true))
            }
            "setSecureScreen" -> {
                val on = (arg as? JsonPrimitive)?.booleanOrNull == true
                view.post {
                    if (on) activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    else activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
                send(JsonPrimitive(true))
            }
            "share" -> {
                val text = (arg as? JsonPrimitive)?.contentOrNull.orEmpty()
                view.post {
                    val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                    runCatching { ctx.startActivity(Intent.createChooser(i, "分享").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
                send(JsonPrimitive(true))
            }
            else -> send(error = "unknown method $method")
        }
    } catch (e: Exception) {
        send(error = e.message ?: e.javaClass.simpleName)
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
            "钱包需要较新的系统网页组件（Android System WebView ${MIN_WEBVIEW_MAJOR}+${if (major > 0) "，当前 $major" else ""}）。请到应用商店更新「Android System WebView」或 Chrome 后再打开。",
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
