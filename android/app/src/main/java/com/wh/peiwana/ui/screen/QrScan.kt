package com.wh.peiwana.ui.screen

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
import com.wh.peiwana.net.Api
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

/**
 * 扫一扫（我的页 / 消息页搜索共用），返回「打开扫码」的函数：
 * 邀请名片 → 直接打开与对方的私聊；语音房邀请 → 免密入群进房；群邀请码 → 加入群聊；收款码 → 提示去转赠页
 */
@Composable
fun rememberQrScan(onNav: (String) -> Unit): () -> Unit {
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
                onNav("chatroom/${r.conversationId}?convType=2&targetId=${r.groupId}&title=${android.net.Uri.encode("${r.groupName}（群）")}")
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
            onNav("chatroom/$convId?convType=1&targetId=$peerId&title=${android.net.Uri.encode(nickname)}")
        }.onFailure { toast(it.message ?: "打开聊天失败") }
    }

    val launcher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@rememberLauncherForActivityResult
        val invite = parseInviteCode(text)
        val vroom = parseVroomQr(text)
        when {
            invite != null -> openByInvite(invite)
            vroom != null -> joinVroomByQr(vroom.first, vroom.second)
            text.contains("pay?sid=") -> Toast.makeText(ctx, "这是收款码，请到「积分明细 - 转赠」里扫码使用", Toast.LENGTH_LONG).show()
            parseGroupCode(text) != null -> onNav("join-group?code=${parseGroupCode(text)}")
            else -> toast("无法识别的二维码")
        }
    }

    return {
        launcher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫描邀请名片或群二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(true)
                .setCaptureActivity(PortraitCaptureActivity::class.java),
        )
    }
}
