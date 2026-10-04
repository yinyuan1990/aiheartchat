package com.wh.peiwana.ui.screen

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.wh.peiwana.BuildConfig
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.Session
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 从扫码结果里提取邀请名片码（名片二维码内容 https://域名/t/?u=短号） */
fun parseInviteCode(text: String): String? {
    if (!text.contains("/t/")) return null
    return Regex("[?&]u=(\\d{1,19})").find(text)?.groupValues?.get(1)
}

private val WALLET_SCHEME = Regex("^(ethereum|solana|tron|ton|tonkeeper):", RegexOption.IGNORE_CASE)
private val EVM_ADDR = Regex("0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
private val BASE58_ADDR = Regex("^[1-9A-HJ-NP-Za-km-z]{32,44}$")
private val TON_FRIENDLY = Regex("^[A-Za-z0-9_+/-]{48}$")
private val TON_RAW = Regex("^-?[01]:[0-9a-fA-F]{64}$")

/**
 * 看起来像链上钱包地址或收款链接（0x / EIP-681、Solana、波场 T…、TON、solana: / tron: / ton:// 链接）。
 * 这里只粗判，真正的解析（哪条链、币种、金额、备注，格式不对就提示）在钱包网页 /wallet/send?scan= 里统一做。
 */
fun looksLikeWalletPayment(text: String): Boolean {
    val t = text.trim()
    return WALLET_SCHEME.containsMatchIn(t) || t.startsWith("https://app.tonkeeper.com/transfer/") || EVM_ADDR.containsMatchIn(t) ||
        BASE58_ADDR.matches(t) || TON_FRIENDLY.matches(t) || TON_RAW.matches(t)
}

/**
 * 扫到的二维码统一在这里处理（扫一扫、聊天图片「识别二维码」共用）：
 * 邀请名片 → 私聊；语音房邀请 → 免密入群进房；收款码 → 积分转赠页并填好；群邀请码 → 加群；
 * 钱包地址 / 收款链接 → 钱包转账页（自动选链并填好，0x 地址让用户选网络）。
 */
@Composable
fun rememberScanHandler(onNav: (String) -> Unit): (String) -> Unit {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    fun toast(msg: String) = Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()

    // 语音房扫码进房：入群后申请麦克风权限再进房
    var pendingVroomGid by remember { mutableStateOf<String?>(null) }
    val vroomMicPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pendingVroomGid?.let { gid ->
            if (ok) com.wh.peiwana.rtc.VoiceRoomManager.join(gid)
            else toast("需要麦克风权限才能加入语音房")
        }
        pendingVroomGid = null
    }

    fun joinVroomByQr(groupId: String, token: String) = scope.launch {
        runCatching { com.wh.peiwana.rtc.VoiceRoomManager.scanJoin(groupId, token) }
            .onSuccess { r ->
                if (r.conversationId.isEmpty()) { toast("群会话不存在"); return@onSuccess }
                if (r.roomActive) {
                    pendingVroomGid = r.groupId
                    vroomMicPerm.launch(android.Manifest.permission.RECORD_AUDIO)
                } else {
                    toast("已入群，语音房当前未开启")
                }
                onNav("chatroom/${r.conversationId}?convType=2&targetId=${r.groupId}&title=${Uri.encode("${r.groupName}（群）")}")
            }
            .onFailure { toast(it.message ?: "扫码失败") }
    }

    fun openByInvite(code: String) = scope.launch {
        runCatching {
            Api.request("/im/conversations/open-by-code", "POST", buildJsonObject { put("code", JsonPrimitive(code)) }) as JsonObject
        }.onSuccess { data ->
            val convId = data["conversationId"]?.jsonPrimitive?.content ?: return@onSuccess
            val peer = data["peer"]?.jsonObject
            val peerId = peer?.get("id")?.jsonPrimitive?.content ?: ""
            val nickname = peer?.get("nickname")?.jsonPrimitive?.content ?: ""
            onNav("chatroom/$convId?convType=1&targetId=$peerId&title=${Uri.encode(nickname)}")
        }.onFailure { toast(it.message ?: "打开聊天失败") }
    }

    return remember(onNav) {
        { raw: String ->
            val text = raw.trim()
            val invite = parseInviteCode(text)
            val vroom = parseVroomQr(text)
            val wallet = looksLikeWalletPayment(text)
            when {
                invite != null -> openByInvite(invite)
                vroom != null -> joinVroomByQr(vroom.first, vroom.second)
                text.contains("pay?sid=") -> parsePaySid(text)?.let { onNav("transfer?sid=$it") } ?: toast("收款码不完整")
                !wallet && parseGroupCode(text) != null -> onNav("join-group?code=${parseGroupCode(text)}")
                wallet ->
                    if (BuildConfig.WALLET_ALLOWED && (Session.walletFeature || ChainWalletVault.exists(ctx))) onNav(chainWalletRoute("/wallet/send?scan=" + Uri.encode(text)))
                    else toast("这是链上钱包地址，当前版本不能在 App 里转账")
                else -> toast("无法识别的二维码")
            }
        }
    }
}

/** 扫一扫（我的页 / 消息页「+」和搜索框共用），返回「打开扫码」的函数 */
@Composable
fun rememberQrScan(onNav: (String) -> Unit): () -> Unit {
    val handle = rememberScanHandler(onNav)
    val launcher = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(handle)
    }
    return {
        launcher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫名片、群码、收款码或钱包地址")
                .setBeepEnabled(false)
                .setOrientationLocked(true)
                .setCaptureActivity(PortraitCaptureActivity::class.java),
        )
    }
}
