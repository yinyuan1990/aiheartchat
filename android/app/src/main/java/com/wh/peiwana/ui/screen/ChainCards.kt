package com.wh.peiwana.ui.screen

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.MessagePayload
import com.wh.peiwana.net.WsClient
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.math.BigDecimal

/**
 * 链上钱包的聊天卡片：
 * - transfer：钱包转账成功后，服务端到链上核对过才发的转账卡片（POST /im/transfer），点开看区块浏览器；
 * - callout：喊单卡片（钱包代币页「喊单到聊天」），点开在钱包里打开这个币的页面，能直接买。
 * 和 Web web/src/components/ChainCards.tsx、iOS ChainCards.swift 同一套字段。
 */

@Serializable
data class ChainAddr(val evm: String? = null, val sol: String? = null, val trx: String? = null, val ton: String? = null) {
    /** 对方公开了的链：(钱包 chain 参数，null 是 EVM) → 地址 */
    fun options(): List<Pair<String?, String>> = listOfNotNull(evm?.let { null to it }, sol?.let { "sol" to it }, trx?.let { "trx" to it }, ton?.let { "ton" to it })
}

private val CHAIN_NAMES = mapOf("arc" to "Arc", "eth" to "Ethereum", "bsc" to "BNB Chain", "base" to "Base", "arb" to "Arbitrum", "polygon" to "Polygon", "sol" to "Solana", "trx" to "TRON", "ton" to "TON")
private val EXPLORERS = mapOf(
    "arc" to "https://arc-scan.org/tx/", "eth" to "https://etherscan.io/tx/", "bsc" to "https://bscscan.com/tx/", "base" to "https://basescan.org/tx/",
    "arb" to "https://arbiscan.io/tx/", "polygon" to "https://polygonscan.com/tx/", "sol" to "https://solscan.io/tx/", "trx" to "https://tronscan.org/#/transaction/",
    "ton" to "https://tonviewer.com/transaction/",
)
private val TransferOrange = Color(0xFFF59E0B)
private val TransferTint = Color(0xFFFFF4DE)

fun chainName(chain: String) = CHAIN_NAMES[chain] ?: chain

private fun obj(content: String) = runCatching { WsClient.json.parseToJsonElement(content).jsonObject }.getOrNull()
private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.contentOrNull
private fun JsonObject.num(k: String) = this[k]?.jsonPrimitive?.doubleOrNull

/** 最小单位 → 人看的数量（最多 6 位小数） */
fun tokenAmount(raw: String?, decimals: Int): String = runCatching {
    val v = BigDecimal(raw ?: "0").movePointLeft(decimals)
    (if (v.scale() > 6) v.setScale(6, java.math.RoundingMode.DOWN) else v).stripTrailingZeros().toPlainString()
}.getOrDefault("?")

private fun usd(v: Double?): String? = when {
    v == null -> null
    v >= 1e9 -> "$%.2fB".format(v / 1e9)
    v >= 1e6 -> "$%.2fM".format(v / 1e6)
    v >= 1e3 -> "$%.1fK".format(v / 1e3)
    v >= 1 -> "$%.2f".format(v)
    v > 0 -> "$" + BigDecimal(v).round(java.math.MathContext(4)).stripTrailingZeros().toPlainString()
    else -> null
}

/** 会话列表 / 引用里的一行预览 */
fun chainCardPreview(type: String, content: String): String? {
    val o = obj(content)
    return when (type) {
        "transfer" -> "[转账] ${tokenAmount(o?.str("amount"), o?.str("decimals")?.toIntOrNull() ?: 0)} ${o?.str("symbol") ?: ""}".trim()
        "callout" -> "[喊单] $${o?.str("symbol") ?: ""}"
        "perp" -> perpPreview(content)
        "payreq" -> o?.str("amount")?.let { "[收款] ${tokenAmount(it, o.str("decimals")?.toIntOrNull() ?: 0)} ${o.str("symbol").orEmpty()}".trim() } ?: "[收款] ${chainName(o?.str("chain").orEmpty())}"
        else -> null
    }
}

/** 喊单卡片在钱包里打开的页面 */
fun calloutWalletPath(content: String): String? {
    val o = obj(content) ?: return null
    val chain = o.str("chain") ?: return null
    val addr = o.str("address") ?: return null
    return when (chain) {
        "sol" -> "/wallet/coin?mint=$addr"
        "arc" -> "/wallet/token?address=$addr"
        else -> "/wallet/market?chain=$chain&address=${addr.lowercase()}"
    }
}

/** 没有钱包入口的人点喊单卡片：去网页看 */
private fun calloutWebUrl(o: JsonObject): String {
    val addr = o.str("address").orEmpty()
    return when (val chain = o.str("chain")) {
        "sol" -> "https://pump.fun/coin/$addr"
        "arc" -> "https://arm.yyheart.com/token/$addr"
        else -> "https://dexscreener.com/${mapOf("eth" to "ethereum", "arb" to "arbitrum").getOrDefault(chain ?: "", chain ?: "")}/$addr"
    }
}

/** 钱包路由（ChainWalletScreen 的 startPath，要 URL 编码） */
fun chainWalletRoute(path: String) = "chain-wallet?path=" + Uri.encode(path)

/** 聊天里点「转账」：打开钱包转账页，收款人已填好，转完把结果交回聊天（ret=1） */
fun transferPath(address: String, chain: String?, name: String) =
    "/wallet/send?to=$address&name=${Uri.encode(name.take(24))}&ret=1" + if (chain != null) "&chain=$chain" else ""

/** 点收款消息的「转账」：钱包转账页填好收款地址 / 币 / 金额，转完交回结果（req = 收款消息 id，服务端据此把卡片发回原聊天） */
fun payreqPath(content: String, msgId: String, name: String): String? {
    val o = obj(content) ?: return null
    val chain = o.str("chain") ?: return null
    val to = o.str("address") ?: return null
    val token = o.str("token")
    val amount = o.str("amount")?.let { a -> runCatching { BigDecimal(a).movePointLeft(o.str("decimals")?.toIntOrNull() ?: 0).stripTrailingZeros().toPlainString() }.getOrNull() }
    return "/wallet/send?to=$to&chain=$chain&name=${Uri.encode(name.take(24))}&ret=1&req=$msgId" +
        (token?.let { "&token=$it" } ?: "") + (amount?.let { "&amount=$it" } ?: "")
}

/** 钱包交回的转账结果 → 服务端核对链上交易后发转账卡片，返回那条消息（付收款消息时 targetId 可以为空） */
suspend fun postTransferCard(targetId: String, resultJson: String): MsgItem? {
    val r = obj(resultJson) ?: return null
    if (r.str("kind") != "transfer") return null
    val body = buildJsonObject {
        if (targetId.isNotEmpty()) put("targetId", targetId)
        listOf("chain", "hash", "token", "amount", "symbol", "from", "to", "proof", "req").forEach { k -> r.str(k)?.let { put(k, it) } }
        r["decimals"]?.jsonPrimitive?.intOrNull?.let { put("decimals", it) }
    }
    val data = Api.request("/im/transfer", "POST", body) ?: return null
    val m = WsClient.json.decodeFromJsonElement(MessagePayload.serializer(), data)
    return MsgItem(m.id, m.conversationId, m.senderId, m.senderNickname, m.senderAvatar, m.receiverId, m.type, m.content, m.createdAt, m.senderIsBot, m.markup)
}

@Composable
fun TransferCard(content: String, mine: Boolean) {
    val ctx = LocalContext.current
    val o = remember(content) { obj(content) }
    val chain = o?.str("chain").orEmpty()
    val amount = tokenAmount(o?.str("amount"), o?.str("decimals")?.toIntOrNull() ?: 0)
    // 描边 + 浅橙底栏：白色聊天背景上卡片也有边界
    Column(
        Modifier.width(220.dp).clip(RoundedCornerShape(14.dp)).background(TransferOrange)
            .border(1.dp, TransferOrange, RoundedCornerShape(14.dp))
            .noRippleClick { o?.str("hash")?.let { h -> EXPLORERS[chain]?.let { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it + h)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } } } },
    ) {
        Row(Modifier.padding(14.dp, 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.22f)), contentAlignment = Alignment.Center) { TransferIcon(Color.White, 20.dp) }
            Spacer(Modifier.width(10.dp))
            Column {
                Text("$amount ${o?.str("symbol").orEmpty()}", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (mine) "已转账给对方" else "对方给你转账", color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp)
            }
        }
        Row(Modifier.fillMaxWidth().background(TransferTint).padding(14.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("链上转账 · ${chainName(chain)}", color = Color(0xFF9A5B00), fontSize = 11.sp, modifier = Modifier.weight(1f))
            if (o?.get("verified")?.jsonPrimitive?.booleanOrNull == true) Text("已到账 ✓", color = Color(0xFF16A34A), fontSize = 11.sp)
        }
    }
}

@Composable
fun CalloutCard(content: String, canWallet: Boolean, onOpenWallet: (String) -> Unit) {
    val ctx = LocalContext.current
    val o = remember(content) { obj(content) } ?: return
    val symbol = o.str("symbol").orEmpty()
    Column(
        Modifier.width(230.dp).clip(RoundedCornerShape(14.dp)).background(Color(0xFF0F1115)).noRippleClick {
            val path = calloutWalletPath(content)
            if (canWallet && path != null) onOpenWallet(path)
            else runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(calloutWebUrl(o))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }.padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).clip(RoundedCornerShape(10.dp)).background(Color(0xFF2A2E37)), contentAlignment = Alignment.Center) {
                Text(symbol.take(2).uppercase(), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                o.str("image")?.let { AsyncImage(model = it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize()) }
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("$$symbol", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(o.str("name").orEmpty(), color = Color.White.copy(alpha = 0.55f), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.End) {
                usd(o.num("priceUsd"))?.let { Text(it, color = Color.White, fontSize = 12.sp) }
                usd(o.num("mcapUsd"))?.let { Text("市值 $it", color = Color.White.copy(alpha = 0.55f), fontSize = 10.sp) }
            }
        }
        o.str("note")?.takeIf { it.isNotBlank() }?.let { Text(it, color = Color.White, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 8.dp)) }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            MegaphoneIcon(Color(0xFF4ADE80), 13.dp)
            Text(" 喊单 · ${chainName(o.str("chain").orEmpty())}", color = Color.White.copy(alpha = 0.55f), fontSize = 11.sp, modifier = Modifier.weight(1f))
            Box(Modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xFF4ADE80)).padding(10.dp, 4.dp)) {
                Text(if (canWallet) "去看看" else "看行情", color = Color.Black, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** 收款消息：二维码 + 地址（可复制）+ 可选的币和金额；别人点「转账」直接进钱包转账页 */
@Composable
fun PayreqCard(content: String, mine: Boolean, onPay: (() -> Unit)?) {
    val ctx = LocalContext.current
    val o = remember(content) { obj(content) } ?: return
    val address = o.str("address").orEmpty()
    val chain = o.str("chain").orEmpty()
    val qr = remember(address) { runCatching { makeQrBitmap(address, 360).asImageBitmap() }.getOrNull() }
    val amount = o.str("amount")?.let { "${tokenAmount(it, o.str("decimals")?.toIntOrNull() ?: 0)} ${o.str("symbol").orEmpty()}" }
    Column(Modifier.width(230.dp).clip(RoundedCornerShape(14.dp)).background(Color.White).border(1.dp, TransferOrange, RoundedCornerShape(14.dp))) {
        Row(Modifier.fillMaxWidth().background(TransferOrange).padding(12.dp, 9.dp), verticalAlignment = Alignment.CenterVertically) {
            TransferIcon(Color.White, 16.dp)
            Text(" 收款 · ${chainName(chain)}", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        }
        Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(amount ?: o.str("symbol")?.let { "收 $it" } ?: "金额由付款人填写", color = Color(0xFF111111), fontSize = if (amount != null) 20.sp else 14.sp, fontWeight = FontWeight.SemiBold)
            o.str("note")?.takeIf { it.isNotBlank() }?.let { Text(it, color = Color(0xFF555555), fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp)) }
            qr?.let { androidx.compose.foundation.Image(it, contentDescription = "收款二维码", modifier = Modifier.padding(top = 8.dp).size(140.dp)) }
            Text(
                address, color = Color(0xFF333333), fontSize = 11.sp, lineHeight = 15.sp,
                modifier = Modifier.padding(top = 6.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFF4F4F5)).noRippleClick {
                    val cm = ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("address", address))
                    android.widget.Toast.makeText(ctx, "地址已复制", android.widget.Toast.LENGTH_SHORT).show()
                }.padding(8.dp, 6.dp),
            )
            Text("点地址复制 · 只收 ${chainName(chain)} 上的币", color = Color(0xFF888888), fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp))
            if (!mine && onPay != null) Box(
                Modifier.padding(top = 10.dp).fillMaxWidth().height(36.dp).clip(RoundedCornerShape(18.dp)).background(TransferOrange).noRippleClick(onPay),
                contentAlignment = Alignment.Center,
            ) { Text("转账", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
        }
    }
}

/** 钱包里「喊单到聊天」/「收款发到聊天」：选会话（最多 10 个），每个发一张卡片（card.kind = "payreq" 是收款，否则喊单） */
@Composable
fun ShareCardDialog(card: JsonObject, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    val payreq = card["kind"]?.jsonPrimitive?.contentOrNull == "payreq"
    val scope = rememberCoroutineScope()
    var convs by remember { mutableStateOf<List<ConversationItem>>(emptyList()) }
    var q by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(Unit) {
        convs = runCatching { Api.getList<ConversationItem>("/im/conversations") }.getOrDefault(emptyList()).filter { (it.peer != null && it.peer.isBot != true) || it.group != null }
        WsClient.connect()
    }
    fun name(c: ConversationItem) = c.peer?.nickname ?: c.group?.name ?: ""
    val shown = convs.filter { q.isBlank() || name(it).contains(q.trim(), ignoreCase = true) }
    fun send() {
        val content = JsonObject(card - "kind").toString()
        picked.mapNotNull { id -> convs.find { it.id == id } }.forEach { c ->
            WsClient.send(if (c.type == 1) 1 else 2, if (c.type == 1) c.peer!!.id else c.group!!.id, if (payreq) "payreq" else "callout", content, null)
        }
        scope.launch { onDone(if (payreq) "收款已发到 ${picked.size} 个聊天" else "已喊单到 ${picked.size} 个聊天") }
    }
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).clip(RoundedCornerShape(16.dp)).background(Bg2).padding(16.dp)) {
            Text(if (payreq) "把收款发到…" else "喊单 $${card["symbol"]?.jsonPrimitive?.contentOrNull.orEmpty()} 到…", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.CenterHorizontally))
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp, 9.dp)) {
                if (q.isEmpty()) Text("搜索", color = TextDim, fontSize = 14.sp)
                androidx.compose.foundation.text.BasicTextField(q, { q = it }, singleLine = true, textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 14.sp), modifier = Modifier.fillMaxWidth())
            }
            LazyColumn(Modifier.weight(1f, fill = false).padding(top = 6.dp)) {
                items(shown, key = { it.id }) { c ->
                    val on = c.id in picked
                    Row(
                        Modifier.fillMaxWidth().noRippleClick { picked = if (on) picked - c.id else if (picked.size >= 10) picked else picked + c.id }.padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(c.peer?.avatar ?: c.group?.avatar, 38)
                        Spacer(Modifier.width(10.dp))
                        Text(name(c), color = TextMain, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (c.group != null) Text(if (c.group.kind == 2) " · 频道" else " · 群", color = TextSub, fontSize = 12.sp)
                        Spacer(Modifier.weight(1f))
                        SelectCircle(on)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Box(
                Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(22.dp)).background(if (picked.isEmpty()) Bg3 else Accent).noRippleClick { if (picked.isNotEmpty()) send() },
                contentAlignment = Alignment.Center,
            ) { Text("发送${if (picked.isNotEmpty()) "（${picked.size}）" else ""}", color = if (picked.isEmpty()) TextDim else Color.White, fontSize = 15.sp) }
        }
    }
}

/** 选好友收款地址的链（对方开了不止一种链时问一下） */
@Composable
fun TransferChainDialog(addr: ChainAddr, onPick: (address: String, chain: String?) -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Bg2).padding(16.dp)) {
            Text("转账到哪条链", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.CenterHorizontally))
            Spacer(Modifier.height(12.dp))
            addr.evm?.let { a -> ChainChoice("EVM 链", "Arc / Ethereum / BNB / Base / Arbitrum / Polygon", a) { onPick(a, null) } }
            addr.sol?.let { a -> ChainChoice("Solana", "SOL、USDC、pump 币等", a) { onPick(a, "sol") } }
            addr.trx?.let { a -> ChainChoice("TRON 波场", "TRX、USDT（TRC20）", a) { onPick(a, "trx") } }
            addr.ton?.let { a -> ChainChoice("TON", "GRAM（原 Toncoin）、USDT 等", a) { onPick(a, "ton") } }
            Text("转账页里可以选币种和网络；转完会在聊天里发一张转账卡片。", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun ChainChoice(title: String, sub: String, address: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(Bg3).noRippleClick(onClick).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(sub, color = TextSub, fontSize = 11.sp)
        }
        Text("${address.take(6)}…${address.takeLast(4)}", color = TextSub, fontSize = 12.sp)
    }
}

/**
 * 合约喊单（msgType perp，后端 perp-call.service.ts）的实时状态：聊天页打开时 WsClient.perpWatch 告诉服务端在看哪些卡片，
 * 服务端每 3 秒推 perpTick（行情价 + 变了的卡片状态，见 perp-watch.service.ts），这里存着给卡片读。
 */
object PerpLive {
    val statuses = mutableStateMapOf<String, JsonObject>()
    val marks = mutableStateMapOf<String, Double>()

    fun onFrame(frame: JsonObject) {
        if (frame.str("op") != "perpTick") return
        (frame["marks"] as? JsonObject)?.forEach { (coin, v) -> v.jsonPrimitive.doubleOrNull?.let { marks[coin] = it } }
        (frame["statuses"] as? JsonObject)?.forEach { (id, v) -> (v as? JsonObject)?.let { statuses[id] = it } }
    }
}

private val PerpUp = Color(0xFF22C55E)
private val PerpDown = Color(0xFFEF4444)

private fun perpPx(v: Double): String = when {
    v >= 1000 -> "%,.1f".format(v).removeSuffix(".0")
    v >= 1 -> BigDecimal(v).setScale(4, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
    else -> BigDecimal(v).round(java.math.MathContext(4)).stripTrailingZeros().toPlainString()
}

/** 保证金收益率（%）：价格变动 × 杠杆，空单反过来 */
private fun perpRoe(entry: Double, price: Double, lev: Double, long: Boolean) = (price / entry - 1) * lev * (if (long) 100 else -100)
private fun pct(v: Double) = (if (v >= 0) "+" else "") + "%.1f".format(v) + "%"

fun perpPreview(content: String): String {
    val o = obj(content)
    return "[合约喊单] ${if (o?.str("side") == "short") "做空" else "做多"} ${o?.str("coin").orEmpty()} ${o?.num("lev")?.toInt() ?: 0}x"
}

/** 卡片上的「跟单」：钱包合约页按喊单填好方向、杠杆、止盈止损，保证金自己定 */
fun perpFollowPath(content: String, name: String): String? {
    val o = obj(content) ?: return null
    val coin = o.str("coin") ?: return null
    val side = o.str("side") ?: return null
    val follow = buildJsonObject {
        put("coin", coin)
        put("side", side)
        o.num("lev")?.let { put("lev", it) }
        o.num("entry")?.let { put("entry", it) }
        o.num("tp")?.let { put("tp", it) }
        o.num("sl")?.let { put("sl", it) }
        put("name", name.take(24))
    }
    return "/wallet/perp?follow=" + Uri.encode(follow.toString())
}

@Composable
fun PerpCard(msgId: String, content: String, canWallet: Boolean, onFollow: () -> Unit) {
    val o = remember(content) { obj(content) } ?: return
    val coin = o.str("coin").orEmpty()
    val long = o.str("side") != "short"
    val lev = o.num("lev") ?: 1.0
    val entry = o.num("entry") ?: 0.0
    val st = PerpLive.statuses[msgId] ?: JsonObject(emptyMap())
    val mark = PerpLive.marks[coin]
    val state = st.str("state")
    val sideColor = if (long) PerpUp else PerpDown
    Column(Modifier.width(240.dp).clip(RoundedCornerShape(14.dp)).background(Color(0xFF0F1115)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("$coin-USD", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(6.dp))
            Box(Modifier.clip(RoundedCornerShape(6.dp)).background(sideColor.copy(alpha = 0.18f)).padding(6.dp, 2.dp)) {
                Text("${if (long) "做多" else "做空"} ${lev.toInt()}x", color = sideColor, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.weight(1f))
            mark?.let { Text(perpPx(it), color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp) }
        }
        Row(Modifier.padding(top = 8.dp)) {
            PerpCell("${if (o.str("orderType") == "limit") "挂单" else "开仓"}", if (entry > 0) perpPx(entry) else "—", Modifier.weight(1f))
            PerpCell("止盈", o.num("tp")?.let { perpPx(it) } ?: "—", Modifier.weight(1f))
            PerpCell("止损", o.num("sl")?.let { perpPx(it) } ?: "—", Modifier.weight(1f))
        }
        // 实时状态：持仓中用最新价算收益率；结束了显示怎么结束的、最终收益率
        val (label, value, color) = when (state) {
            "open" -> {
                val e = st.num("entry") ?: entry
                val l = st.num("lev") ?: lev
                val roe = if (mark != null && e > 0) perpRoe(e, mark, l, long) else st.num("roe") ?: 0.0
                Triple("持仓中", pct(roe), if (roe >= 0) PerpUp else PerpDown)
            }
            "closed" -> {
                val exit = st.num("exit") ?: 0.0
                val roe = if (entry > 0 && exit > 0) perpRoe(entry, exit, lev, long) else 0.0
                val why = when (st.str("reason")) { "tp" -> "止盈出局"; "sl" -> "止损出局"; "liq" -> "已强平"; else -> "已平仓" }
                Triple(why, if (st.str("reason") == "liq") "-100%" else pct(roe), if (roe >= 0 && st.str("reason") != "liq") PerpUp else PerpDown)
            }
            "pending" -> Triple("挂单中", st.num("px")?.let { "@ ${perpPx(it)}" } ?: "", Color.White.copy(alpha = 0.7f))
            "none" -> Triple("未成交 / 已撤单", "", Color.White.copy(alpha = 0.5f))
            else -> Triple("读取实时状态…", "", Color.White.copy(alpha = 0.5f))
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(10.dp)).background(Color(0xFF1B1F27)).padding(10.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(value, color = color, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        o.str("note")?.takeIf { it.isNotBlank() }?.let { Text(it, color = Color.White, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 8.dp)) }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            MegaphoneIcon(Color(0xFF4ADE80), 13.dp)
            Text(" 合约喊单 · 收益率实时", color = Color.White.copy(alpha = 0.55f), fontSize = 11.sp, modifier = Modifier.weight(1f))
            if (canWallet && state != "closed") Box(Modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xFF4ADE80)).noRippleClick(onFollow).padding(12.dp, 4.dp)) {
                Text("跟单", color = Color.Black, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun PerpCell(k: String, v: String, modifier: Modifier) {
    Column(modifier) {
        Text(k, color = Color.White.copy(alpha = 0.5f), fontSize = 10.sp)
        Text(v, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

/** 转账图标：两个反向箭头 */
@Composable
fun TransferIcon(tint: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val s = w * 0.08f
        drawLine(tint, Offset(w * 0.2f, w * 0.36f), Offset(w * 0.8f, w * 0.36f), strokeWidth = s)
        drawLine(tint, Offset(w * 0.8f, w * 0.36f), Offset(w * 0.64f, w * 0.2f), strokeWidth = s)
        drawLine(tint, Offset(w * 0.2f, w * 0.64f), Offset(w * 0.8f, w * 0.64f), strokeWidth = s)
        drawLine(tint, Offset(w * 0.2f, w * 0.64f), Offset(w * 0.36f, w * 0.8f), strokeWidth = s)
    }
}

/** 喊单图标：喇叭 */
@Composable
fun MegaphoneIcon(tint: Color, size: Dp = 16.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(w * 0.12f, w * 0.38f); lineTo(w * 0.36f, w * 0.38f); lineTo(w * 0.82f, w * 0.14f)
            lineTo(w * 0.82f, w * 0.86f); lineTo(w * 0.36f, w * 0.62f); lineTo(w * 0.12f, w * 0.62f); close()
        }
        drawPath(path, tint)
        drawRoundRect(tint, topLeft = Offset(w * 0.3f, w * 0.6f), size = Size(w * 0.12f, w * 0.26f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.04f), style = Stroke(w * 0.08f))
    }
}
