package com.wh.peiwana.ui.screen

import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.serialization.json.*
import java.security.SecureRandom

/**
 * DApp 浏览器的钱包接口（EIP-1193 + EIP-6963），只在主框架生效。
 * 网页的请求 → 原生 → 钱包 WebView（/wallet 页面里的 DappApprover）决定静默回答还是弹确认框 → 结果原路回到网页。
 * 两种注入方式：支持 androidx.webkit 新接口时文档开始注入 + addWebMessageListener；
 * 厂商 WebView（华为等）退回 addJavascriptInterface + evaluateJavascript 注入，见 DappSyncBridge。
 * iOS 的 ChainWalletViews.swift 里有一份一模一样的脚本，改的时候两边一起改。
 */
const val DAPP_PROVIDER_JS = """
(function () {
  var tok = window.__armDappTok;
  try { delete window.__armDappTok; } catch (e) {}
  if (window.top !== window || window.__armDapp) return;
  var A = window.ArmDappBridge;
  var W = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.armDapp;
  if (!A && !W) return;
  Object.defineProperty(window, '__armDapp', { value: true });
  var seq = 0, pending = {}, listeners = {};
  var state = { chainId: null, accounts: [] };
  function post(m) { if (tok) m.tok = tok; var s = JSON.stringify(m); if (A) A.postMessage(s); else W.postMessage(s); }
  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { setTimeout(function () { throw e; }); } });
  }
  function rpcError(e) {
    var err = new Error((e && e.message) || 'Internal error');
    err.code = e && typeof e.code === 'number' ? e.code : -32603;
    if (e && e.data !== undefined) err.data = e.data;
    return err;
  }
  function setChain(c) {
    if (typeof c !== 'string' || c === state.chainId) return;
    var first = state.chainId === null;
    state.chainId = c;
    provider.chainId = c;
    provider.networkVersion = String(parseInt(c, 16));
    if (first) emit('connect', { chainId: c }); else emit('chainChanged', c);
  }
  function setAccounts(a) {
    if (!Array.isArray(a)) return;
    var same = a.length === state.accounts.length && a.every(function (x, i) { return x === state.accounts[i]; });
    state.accounts = a;
    provider.selectedAddress = a[0] || null;
    if (!same) emit('accountsChanged', a);
  }
  function receive(raw) {
    var m;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!m) return;
    if (m.event) {
      if (m.event === 'chainChanged') setChain(m.data);
      else if (m.event === 'accountsChanged') setAccounts(m.data || []);
      else emit(m.event, m.data);
      return;
    }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.error) { p.reject(rpcError(m.error)); return; }
    if (p.method === 'eth_chainId') setChain(m.result);
    if (p.method === 'eth_accounts' || p.method === 'eth_requestAccounts') setAccounts(m.result);
    p.resolve(m.result === undefined ? null : m.result);
  }
  Object.defineProperty(window, '__armDappReceive', { value: receive });
  if (A) { try { A.onmessage = function (e) { receive(e.data); }; } catch (e) {} }
  function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') return Promise.reject(rpcError({ code: -32600, message: 'Invalid request' }));
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject, method: args.method };
      post({ id: id, method: args.method, params: args.params === undefined ? [] : args.params });
    });
  }
  function reply(a, cb) {
    request(a).then(function (r) { cb(null, { id: a.id, jsonrpc: '2.0', result: r }); }, function (e) { cb(e, null); });
  }
  var provider = {
    isArmWallet: true,
    chainId: null,
    networkVersion: null,
    selectedAddress: null,
    request: request,
    isConnected: function () { return true; },
    enable: function () { return request({ method: 'eth_requestAccounts' }); },
    on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    addListener: function (ev, f) { return provider.on(ev, f); },
    once: function (ev, f) { function g(d) { provider.removeListener(ev, g); f(d); } return provider.on(ev, g); },
    removeListener: function (ev, f) { var l = listeners[ev]; if (l) { var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } return provider; },
    off: function (ev, f) { return provider.removeListener(ev, f); },
    removeAllListeners: function (ev) { if (ev) delete listeners[ev]; else listeners = {}; return provider; },
    send: function (a, b) {
      if (typeof a === 'string') return request({ method: a, params: b });
      if (typeof b === 'function') return reply(a, b);
      throw new Error('Synchronous send is not supported');
    },
    sendAsync: reply
  };
  if (!window.ethereum) window.ethereum = provider;
  var icon = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='#111'/><rect x='13' y='20' width='38' height='26' rx='6' fill='none' stroke='#fff' stroke-width='4'/><circle cx='41' cy='33' r='3.5' fill='#fff'/></svg>");
  var uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
  var info = Object.freeze({ uuid: uuid, name: '心之音钱包', icon: icon, rdns: 'com.yyheart.wallet' });
  function announce() { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: provider }) })); }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));
  request({ method: 'eth_chainId' }).catch(function () {});
  request({ method: 'eth_accounts' }).catch(function () {});
})();
"""

/**
 * 原生这一层只转发、不做决定：DApp 网页的请求编号换成全局编号交给钱包页，钱包页回复后按编号还给发起请求的网页。
 * 所有方法都在主线程调用，不用加锁。回复通道是一个「发字符串」的函数，两种桥各自实现。
 */
class DappHub(private val onShow: (Boolean) -> Unit) {
    private class Pending(val reply: (String) -> Unit, val providerId: JsonElement)

    private var seq = 0
    private val pending = HashMap<Int, Pending>()
    private var walletReply: ((String) -> Unit)? = null
    private val queue = ArrayList<String>()
    private var dappReply: ((String) -> Unit)? = null
    private var dappOrigin: String? = null

    /** 诊断用：钱包页有没有调过 dappReady、积压 / 等回复的请求数 */
    val walletAttached get() = walletReply != null
    val queued get() = queue.size
    val inFlight get() = pending.size

    private fun toWallet(msg: JsonObject) {
        val s = msg.toString()
        val w = walletReply
        if (w == null) queue.add(s) else w(s)
    }

    /** 钱包页加载好（store 读完）后调 dappReady；之前积压的请求这时才交过去 */
    fun walletReady(reply: (String) -> Unit) {
        walletReply = reply
        queue.forEach(reply)
        queue.clear()
    }

    /** 钱包页刷新 / 关闭：旧的回复通道作废，正在等的请求全部拒绝 */
    fun walletGone() {
        walletReply = null
        pending.values.forEach { it.reply(errorJson(it.providerId, 4001, "Wallet reloaded").toString()) }
        pending.clear()
        onShow(false)
    }

    fun onDappMessage(origin: String?, isMainFrame: Boolean, data: String?, reply: (String) -> Unit) {
        val req = runCatching { Json.parseToJsonElement(data ?: "").jsonObject }.getOrNull() ?: return
        val pid = req["id"] ?: return
        val method = req["method"]?.jsonPrimitive?.contentOrNull ?: return
        if (!isMainFrame || origin == null || !origin.startsWith("https://")) {
            reply(errorJson(pid, 4100, "Wallet is only available to https pages").toString())
            return
        }
        dappReply = reply
        dappOrigin = origin
        val id = ++seq
        pending[id] = Pending(reply, pid)
        toWallet(buildJsonObject {
            put("push", "dappRequest")
            putJsonObject("req") {
                put("id", id)
                put("origin", origin)
                put("method", method)
                put("params", req["params"] ?: JsonArray(emptyList()))
            }
        })
    }

    fun respond(arg: JsonObject) {
        val id = arg["id"]?.jsonPrimitive?.intOrNull ?: return
        val p = pending.remove(id) ?: return
        val out = buildJsonObject {
            put("id", p.providerId)
            val err = arg["error"]
            if (err != null && err !is JsonNull) put("error", err) else put("result", arg["result"] ?: JsonNull)
        }
        p.reply(out.toString())
    }

    fun emit(arg: JsonObject) {
        val origin = arg["origin"]?.jsonPrimitive?.contentOrNull ?: return
        val event = arg["event"]?.jsonPrimitive?.contentOrNull ?: return
        if (origin != dappOrigin) return
        dappReply?.invoke(buildJsonObject { put("event", event); put("data", arg["data"] ?: JsonNull) }.toString())
    }

    fun show(on: Boolean) = onShow(on)

    /** 用户在原生顶栏点了返回 / 关闭：钱包页按 4001 拒绝当前请求，再自己调 dappShow(false) */
    fun cancel() = toWallet(buildJsonObject { put("push", "dappCancel") })

    /** DApp 页面跳转或浏览器关闭：旧页面的请求都作废 */
    fun reset() {
        pending.clear()
        dappReply = null
        dappOrigin = null
        toWallet(buildJsonObject { put("push", "dappReset") })
    }

    fun visited(url: String, title: String?) = toWallet(buildJsonObject {
        put("push", "dappVisited"); put("url", url); title?.let { put("title", it) }
    })

    fun favorite(url: String, title: String?) = toWallet(buildJsonObject {
        put("push", "dappFavorite"); put("url", url); title?.let { put("title", it) }
    })

    private fun errorJson(id: JsonElement, code: Int, message: String) = buildJsonObject {
        put("id", id)
        putJsonObject("error") { put("code", code); put("message", message) }
    }
}

/**
 * 兜底 DApp 桥：厂商 WebView 没有 WEB_MESSAGE_LISTENER / DOCUMENT_START_SCRIPT 时用。
 * addJavascriptInterface 会暴露给所有 iframe，且拿不到调用方的源，所以每个页面发一个随机令牌，
 * 只通过 evaluateJavascript（只在主框架执行）交给 provider，原生只认带对令牌的消息，源取 WebView 当前地址。
 */
class DappSyncBridge(private val view: WebView, private val hub: DappHub) {
    @Volatile private var token = ""
    private val rng = SecureRandom()

    /** 主线程：页面开始加载时换令牌，旧页面的消息从此作废 */
    fun newPage() {
        val b = ByteArray(16).also(rng::nextBytes)
        token = b.joinToString("") { "%02x".format(it) }
    }

    /** 主线程：开始加载 / 加载中 / 加载完都调一次；provider 自己防重复安装 */
    fun inject() {
        if (token.isEmpty()) return
        view.evaluateJavascript("window.__armDappTok='$token';$DAPP_PROVIDER_JS", null)
    }

    @JavascriptInterface
    fun postMessage(data: String?) {
        val tok = runCatching { Json.parseToJsonElement(data ?: "").jsonObject["tok"]?.jsonPrimitive?.contentOrNull }.getOrNull()
        if (tok == null || tok != token) return
        view.post {
            if (tok != token) return@post
            val origin = dappOriginOf(view.url)
            hub.onDappMessage(origin, true, data) { s ->
                if (tok == token && dappOriginOf(view.url) == origin) {
                    view.evaluateJavascript("window.__armDappReceive&&window.__armDappReceive($s)", null)
                }
            }
        }
    }
}

fun dappOriginOf(url: String?): String? = runCatching {
    val u = Uri.parse(url ?: return null)
    val host = u.host
    if (u.scheme != "https" || host.isNullOrBlank()) null
    else if (u.port == -1 || u.port == 443) "https://$host" else "https://$host:${u.port}"
}.getOrNull()
