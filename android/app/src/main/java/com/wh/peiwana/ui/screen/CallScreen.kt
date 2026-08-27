package com.wh.peiwana.ui.screen

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import com.wh.peiwana.rtc.CallManager
import com.wh.peiwana.rtc.CallState
import kotlinx.coroutines.launch
import com.wh.peiwana.ui.Avatar
import com.wh.peiwana.ui.noRippleClick
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

private val CallBg = Color(0xFF17191E)
private val HangupRed = Color(0xFFFA4545)
private val AnswerGreen = Color(0xFF0DC76B)

/** 通话全屏覆盖层（微信式）：呼出 / 来电 / 通话中 / 结束后评分 */
@Composable
fun CallOverlay() {
    val state by CallManager.state.collectAsState()
    val pendingRate by CallManager.pendingRate.collectAsState()
    // 通话结束后男方评分界面
    if (state is CallState.Idle && pendingRate != null) {
        RateOverlay(pendingRate!!)
        return
    }
    if (state is CallState.Idle) return
    val context = LocalContext.current
    val peerName by CallManager.peerName.collectAsState()
    val peerAvatar by CallManager.peerAvatar.collectAsState()

    Box(modifier = Modifier.fillMaxSize().zIndex(10f).background(CallBg)) {
        when (val s = state) {
            is CallState.Outgoing -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.height(110.dp))
                PeerHeader(peerName, peerAvatar, if (s.type == 2) "正在等待对方接受视频通话邀请…" else "正在等待对方接受语音通话邀请…")
                Spacer(Modifier.weight(1f))
                Row(Modifier.fillMaxWidth().padding(bottom = 70.dp), horizontalArrangement = Arrangement.Center) {
                    CircleAction("取消", HangupRed, "✕") { CallManager.hangup() }
                }
            }
            is CallState.Incoming -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.height(110.dp))
                PeerHeader(peerName, peerAvatar, if (s.type == 2) "邀请你进行视频通话" else "邀请你进行语音通话")
                Spacer(Modifier.weight(1f))
                Row(Modifier.fillMaxWidth().padding(bottom = 70.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    CircleAction("拒绝", HangupRed, "✕") { CallManager.reject() }
                    CircleAction("接听", AnswerGreen, "✓") {
                        CallManager.attachContext(context)
                        CallManager.accept(context)
                    }
                }
            }
            is CallState.Active -> ActiveCall(s, peerName, peerAvatar)
            else -> {}
        }
    }
}

/** 视频通话结束后男方评分界面：5 个维度各 0-100 分 */
@Composable
private fun RateOverlay(pending: CallManager.PendingRate) {
    val context = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val dims = listOf("真实度", "配合度", "腿型", "曲线", "肤质")
    val scores = remember { List(5) { androidx.compose.runtime.mutableFloatStateOf(80f) } }
    var busy by remember { androidx.compose.runtime.mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().zIndex(10f).background(CallBg)) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(70.dp))
            Avatar(pending.peerAvatar, 72)
            Spacer(Modifier.height(10.dp))
            Text(pending.peerName.ifEmpty { "对方" }, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text("本次视频通话体验如何？", color = Color.White.copy(alpha = 0.6f), fontSize = 13.sp)
            Spacer(Modifier.height(26.dp))

            dims.forEachIndexed { i, label ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 14.sp, modifier = Modifier.width(96.dp))
                    androidx.compose.material3.Slider(
                        value = scores[i].floatValue,
                        onValueChange = { scores[i].floatValue = it },
                        valueRange = 0f..100f,
                        modifier = Modifier.weight(1f),
                        colors = androidx.compose.material3.SliderDefaults.colors(
                            thumbColor = com.wh.peiwana.ui.theme.Accent,
                            activeTrackColor = com.wh.peiwana.ui.theme.Accent,
                            inactiveTrackColor = Color.White.copy(alpha = 0.15f),
                        ),
                    )
                    Text(
                        "${scores[i].floatValue.toInt()}",
                        color = com.wh.peiwana.ui.theme.Accent, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.width(34.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End,
                    )
                }
            }

            Spacer(Modifier.weight(1f))
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp))
                    .background(com.wh.peiwana.ui.theme.Accent)
                    .noRippleClick {
                        if (busy) return@noRippleClick
                        busy = true
                        scope.launch {
                            runCatching {
                                com.wh.peiwana.net.Api.request(
                                    "/call/rate", "POST",
                                    kotlinx.serialization.json.buildJsonObject {
                                        put("callId", kotlinx.serialization.json.JsonPrimitive(pending.callId))
                                        put("photo", kotlinx.serialization.json.JsonPrimitive(scores[0].floatValue.toInt()))
                                        put("obedience", kotlinx.serialization.json.JsonPrimitive(scores[1].floatValue.toInt()))
                                        put("legs", kotlinx.serialization.json.JsonPrimitive(scores[2].floatValue.toInt()))
                                        put("chest", kotlinx.serialization.json.JsonPrimitive(scores[3].floatValue.toInt()))
                                        put("skin", kotlinx.serialization.json.JsonPrimitive(scores[4].floatValue.toInt()))
                                    },
                                )
                            }.onFailure {
                                android.widget.Toast.makeText(context, it.message ?: "评分失败", android.widget.Toast.LENGTH_SHORT).show()
                            }
                            CallManager.pendingRate.value = null
                            // 评分完成后留在女方个人主页
                            CallManager.openUserHome.value = pending.peerId
                        }
                    }
                    .padding(vertical = 13.dp),
                contentAlignment = Alignment.Center,
            ) { Text(if (busy) "提交中…" else "提交评分", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
            Spacer(Modifier.height(12.dp))
            Text(
                "跳过",
                color = Color.White.copy(alpha = 0.5f), fontSize = 14.sp,
                modifier = Modifier.noRippleClick {
                    CallManager.pendingRate.value = null
                    // 跳过评分同样留在女方个人主页
                    CallManager.openUserHome.value = pending.peerId
                }.padding(8.dp),
            )
            Spacer(Modifier.height(30.dp))
        }
    }
}

@Composable
private fun PeerHeader(name: String, avatar: String, status: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Avatar(avatar, 96)
        Spacer(Modifier.height(14.dp))
        Text(if (name.isEmpty()) "对方" else name, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Text(status, color = Color.White.copy(alpha = 0.6f), fontSize = 14.sp)
    }
}

/** 圆形操作按钮 + 下方文字（微信式） */
@Composable
private fun CircleAction(
    label: String,
    bg: Color,
    symbol: String? = null,
    fg: Color = Color.White,
    icon: (@Composable (Color) -> Unit)? = null,
    onClick: () -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier.size(64.dp).clip(CircleShape).background(bg).noRippleClick(onClick),
            contentAlignment = Alignment.Center,
        ) {
            if (icon != null) icon(fg) else Text(symbol ?: "", color = fg, fontSize = 24.sp)
        }
        Spacer(Modifier.height(8.dp))
        Text(label, color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp)
    }
}

@Composable
private fun ActiveCall(state: CallState.Active, peerName: String, peerAvatar: String) {
    val seconds by CallManager.callSeconds.collectAsState()
    val muted by CallManager.muted.collectAsState()
    val speakerOn by CallManager.speakerOn.collectAsState()
    val cameraOff by CallManager.cameraOff.collectAsState()
    val timeText = "%02d:%02d".format(seconds / 60, seconds % 60)

    val remoteTrack by CallManager.remoteVideoTrack.collectAsState()
    val localTrack by CallManager.localVideoTrack.collectAsState()

    Box(Modifier.fillMaxSize()) {
        if (state.type == 2) {
            VideoView(track = remoteTrack, label = "remote", modifier = Modifier.fillMaxSize())
            Column(Modifier.fillMaxWidth().padding(top = 60.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    timeText, color = Color.White, fontSize = 14.sp,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.4f)).padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
            Box(modifier = Modifier.align(Alignment.TopEnd).padding(top = 100.dp, end = 12.dp)) {
                VideoView(
                    track = localTrack,
                    label = "local",
                    modifier = Modifier.width(110.dp).height(150.dp).clip(RoundedCornerShape(10.dp)),
                )
            }
        } else {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.height(110.dp))
                PeerHeader(peerName, peerAvatar, timeText)
            }
        }

        Row(
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = 70.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            CircleAction(
                "静音",
                if (muted) Color.White else Color.White.copy(alpha = 0.22f),
                fg = if (muted) Color.Black else Color.White,
                icon = { c -> com.wh.peiwana.ui.MicIcon(c, 26.dp) },
            ) { CallManager.toggleMute() }

            if (state.type == 2) {
                CircleAction(
                    "摄像头",
                    if (cameraOff) Color.White else Color.White.copy(alpha = 0.22f),
                    fg = if (cameraOff) Color.Black else Color.White,
                    icon = { c -> com.wh.peiwana.ui.VideoIcon(c, 26.dp) },
                ) { CallManager.toggleCameraOff() }
            }

            CircleAction("挂断", HangupRed, "✕") { CallManager.hangup() }

            if (state.type == 2) {
                CircleAction("翻转", Color.White.copy(alpha = 0.22f), "⟳") { CallManager.switchCamera() }
            } else {
                CircleAction(
                    "免提",
                    if (speakerOn) Color.White else Color.White.copy(alpha = 0.22f),
                    fg = if (speakerOn) Color.Black else Color.White,
                    icon = { c -> com.wh.peiwana.ui.VoiceIcon(c, 26.dp) },
                ) { CallManager.toggleSpeaker() }
            }
        }
    }
}

@Composable
private fun VideoView(track: VideoTrack?, label: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                // 首帧/分辨率回调打进通话日志：确认解码帧真正渲染出来了
                init(
                    CallManager.eglBase.eglBaseContext,
                    object : RendererCommon.RendererEvents {
                        override fun onFirstFrameRendered() { CallManager.clog("renderer[$label] first frame rendered") }
                        override fun onFrameResolutionChanged(w: Int, h: Int, rotation: Int) {
                            CallManager.clog("renderer[$label] resolution ${w}x${h} rot=$rotation")
                        }
                    },
                )
                setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            }
        },
        // track 变化（StateFlow）触发重组：先解绑旧轨道再绑定新轨道（标准做法）
        update = { view ->
            val previous = view.tag as? VideoTrack
            if (previous !== track) {
                runCatching { previous?.removeSink(view) }
                track?.addSink(view)
                view.tag = track
            }
        },
    )
}

/** 通用呼叫发起器（广场卡片/抖音模式等处使用）：请求权限后发起 */
@Composable
fun rememberStartCallAny(): (calleeId: String, name: String, avatar: String, type: Int) -> Unit {
    val context = LocalContext.current
    val pending = remember { androidx.compose.runtime.mutableStateOf<Triple<String, String, String>?>(null) }
    val pendingType = remember { mutableIntStateOf(2) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (grants.values.all { it }) {
            pending.value?.let { (id, name, avatar) ->
                CallManager.attachContext(context)
                CallManager.startCall(context, id, pendingType.intValue, name, avatar)
            }
        } else {
            android.widget.Toast.makeText(context, "需要麦克风/摄像头权限才能通话", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    return { id, name, avatar, type ->
        pending.value = Triple(id, name, avatar)
        pendingType.intValue = type
        launcher.launch(
            if (type == 2) arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
            else arrayOf(Manifest.permission.RECORD_AUDIO),
        )
    }
}

/** 聊天页通话按钮：请求权限后发起呼叫（type: 1=语音 2=视频） */
@Composable
fun rememberStartCall(calleeId: String, calleeName: String = "", calleeAvatar: String = ""): (Int) -> Unit {
    val context = LocalContext.current
    val pendingType = remember { mutableIntStateOf(1) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        if (grants.values.all { it }) {
            CallManager.attachContext(context)
            CallManager.startCall(context, calleeId, pendingType.intValue, calleeName, calleeAvatar)
        } else {
            android.widget.Toast.makeText(context, "需要麦克风/摄像头权限才能通话", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    return { type ->
        pendingType.intValue = type
        val perms = if (type == 2) {
            arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        } else {
            arrayOf(Manifest.permission.RECORD_AUDIO)
        }
        permissionLauncher.launch(perms)
    }
}
