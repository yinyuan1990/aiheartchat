package com.wh.peiwana.rtc

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.WsClient
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

@Serializable
data class CallConfig(
    val width: Int = 640,
    val height: Int = 480,
    val fps: Int = 30,
    val bitrate: Int = 800,
    val srsServer: String = "",
    val whipUrl: String = "",
    val whepUrl: String = "",
)

@Serializable
data class CallerBrief(val id: String, val nickname: String, val avatar: String = "")

/** 通话状态机 */
sealed class CallState {
    data object Idle : CallState()
    /** 主叫等待接听 */
    data class Outgoing(val callId: String, val peerId: String, val type: Int, val config: CallConfig) : CallState()
    /** 被叫收到邀请 */
    data class Incoming(val callId: String, val caller: CallerBrief, val type: Int, val config: CallConfig) : CallState()
    /** 通话中 */
    data class Active(val callId: String, val peerId: String, val type: Int, val config: CallConfig) : CallState()
}

/**
 * 一对一通话管理：信令走后端 REST + IM WS，媒体走 SRS WebRTC。
 * 双方各推一路流（WHIP）拉对方一路流（WHEP），流名 live/{callId}_{userId}。
 */
object CallManager {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow<CallState>(CallState.Idle)
    val state: StateFlow<CallState> = _state

    val eglBase: EglBase by lazy { EglBase.create() }
    private var factory: PeerConnectionFactory? = null
    private var pushPc: PeerConnection? = null
    private var pullPc: PeerConnection? = null
    private var capturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var surfaceHelper: SurfaceTextureHelper? = null

    // 可观察的视频轨道：track 到达时（onTrack 回调）触发界面重组绑定渲染器
    val localVideoTrack = MutableStateFlow<VideoTrack?>(null)
    val remoteVideoTrack = MutableStateFlow<VideoTrack?>(null)
    private var localAudioTrack: AudioTrack? = null
    private var myUserId: String = ""

    // 对方信息（微信式界面展示）
    val peerName = MutableStateFlow("")
    val peerAvatar = MutableStateFlow("")

    /** 视频通话结束后男方待评分信息（挂断后弹评分界面） */
    data class PendingRate(val callId: String, val peerId: String, val peerName: String, val peerAvatar: String)
    val pendingRate = MutableStateFlow<PendingRate?>(null)

    /** 评分完成后要打开的女方主页 userId（MainActivity 收到后导航并清空） */
    val openUserHome = MutableStateFlow<String?>(null)

    /** 对方已完成推流（published 信令）：收到后才订阅，保证订阅晚于发布 */
    private val peerPublished = MutableStateFlow(false)
    // 通话控制状态
    val muted = MutableStateFlow(false)
    val speakerOn = MutableStateFlow(false)
    val cameraOff = MutableStateFlow(false)
    val callSeconds = MutableStateFlow(0)
    private var timerJob: kotlinx.coroutines.Job? = null

    fun toggleMute() {
        muted.value = !muted.value
        localAudioTrack?.setEnabled(!muted.value)
    }

    fun toggleSpeaker() {
        speakerOn.value = !speakerOn.value
        (appContextRef?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager)
            ?.isSpeakerphoneOn = speakerOn.value
    }

    fun switchCamera() {
        capturer?.switchCamera(null)
    }

    /** 关闭/打开自己的画面（声音不受影响，对方看到黑屏） */
    fun toggleCameraOff() {
        cameraOff.value = !cameraOff.value
        localVideoTrack.value?.setEnabled(!cameraOff.value)
    }

    private fun startTimer() {
        callSeconds.value = 0
        timerJob?.cancel()
        timerJob = scope.launch {
            while (true) {
                kotlinx.coroutines.delay(1000)
                callSeconds.value += 1
                // 每 5 秒上报 RTP 统计：定位"无画面"是发送端没出帧还是接收端没收到帧
                if (callSeconds.value % 5 == 0) logStats()
            }
        }
    }

    /** 双端 RTP 统计打点：push 看编码/发送，pull 看接收/解码 */
    private fun logStats() {
        pushPc?.getStats { report ->
            val parts = report.statsMap.values.filter { it.type == "outbound-rtp" }.map { s ->
                val m = s.members
                "${m["kind"]}: bytesSent=${m["bytesSent"]} pktsSent=${m["packetsSent"]} framesEncoded=${m["framesEncoded"]} fps=${m["framesPerSecond"]}"
            }
            if (parts.isNotEmpty()) clog("stats push ${parts.joinToString(" | ")}")
        }
        pullPc?.getStats { report ->
            val parts = report.statsMap.values.filter { it.type == "inbound-rtp" }.map { s ->
                val m = s.members
                "${m["kind"]}: bytesRecv=${m["bytesReceived"]} pktsRecv=${m["packetsReceived"]} framesRecv=${m["framesReceived"]} framesDecoded=${m["framesDecoded"]} fps=${m["framesPerSecond"]}"
            }
            if (parts.isNotEmpty()) clog("stats pull ${parts.joinToString(" | ")}")
        }
    }

    /** App 启动后调用一次：初始化工厂并监听 WS 通话信令 */
    fun init(context: Context, userId: String) {
        myUserId = userId
        if (factory == null) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
            )
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
                .createPeerConnectionFactory()
        }

        WsClient.addListener { frame ->
            if (frame["op"]?.jsonPrimitive?.content != "call") return@addListener
            val event = frame["event"]?.jsonPrimitive?.content ?: return@addListener
            val data = frame["data"]?.jsonObject ?: return@addListener
            scope.launch { onSignal(event, data) }
        }
    }

    private suspend fun onSignal(event: String, data: kotlinx.serialization.json.JsonObject) {
        when (event) {
            "invite" -> {
                if (_state.value !is CallState.Idle) return
                val callId = data["callId"]!!.jsonPrimitive.content
                val type = data["type"]!!.jsonPrimitive.content.toInt()
                val caller = Api.json.decodeFromJsonElement(CallerBrief.serializer(), data["caller"]!!)
                val config = Api.json.decodeFromJsonElement(CallConfig.serializer(), data["config"]!!)
                peerName.value = caller.nickname
                peerAvatar.value = caller.avatar
                peerPublished.value = false
                bindLogCall(callId)
                clog("signal invite received type=$type callId=$callId")
                _state.value = CallState.Incoming(callId, caller, type, config)
                // App 在后台：来电悬浮窗（微信式，头像+昵称+接听/拒绝）+ 通知兜底（无悬浮窗权限或锁屏时）
                if (!com.wh.peiwana.net.Session.foreground) {
                    appContextRef?.let { CallFloatWindow.show(it, caller.nickname, caller.avatar, type) }
                    showIncomingCallNotification(caller.nickname, type)
                }
            }
            "accept" -> {
                val cur = _state.value
                if (cur is CallState.Outgoing) {
                    _state.value = CallState.Active(cur.callId, cur.peerId, cur.type, cur.config)
                    startTimer()
                    startMedia(cur.callId, cur.peerId, cur.type, cur.config)
                }
            }
            "published" -> {
                if (data["callId"]?.jsonPrimitive?.content == logCallId) {
                    clog("signal peer published")
                    peerPublished.value = true
                }
            }
            "reject", "cancel", "end" -> {
                // 服务端强制挂断（积分不足/连接中断）会带 reason，Toast 提示用户
                val reason = data["reason"]?.jsonPrimitive?.contentOrNull
                if (!reason.isNullOrEmpty()) {
                    clog("call force-ended by server: $reason")
                    appContextRef?.let { ctx ->
                        android.os.Handler(android.os.Looper.getMainLooper()).post {
                            android.widget.Toast.makeText(ctx, reason, android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                }
                teardown()
            }
        }
    }

    /** 主叫发起 */
    fun startCall(context: Context, calleeId: String, type: Int, name: String = "", avatar: String = "") {
        peerName.value = name
        peerAvatar.value = avatar
        scope.launch {
            // 头像缺失时补拉对方资料（微信式界面需要展示）
            if (avatar.isEmpty()) {
                runCatching {
                    val d = Api.request("/user/$calleeId") as? kotlinx.serialization.json.JsonObject
                    peerAvatar.value = d?.get("avatar")?.jsonPrimitive?.content ?: ""
                    if (name.isEmpty()) peerName.value = d?.get("nickname")?.jsonPrimitive?.content ?: ""
                }
            }
            // 视频通话本地预检：余额不够 1 分钟直接提示，不发起呼叫（服务端 invite 仍有权威校验兜底）
            if (type == 2) {
                val insufficientMsg = runCatching {
                    val wallet = Api.request("/wallet") as? kotlinx.serialization.json.JsonObject
                    val balance = wallet?.get("balance")?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                    val peer = Api.request("/user/$calleeId") as? kotlinx.serialization.json.JsonObject
                    val priceFen = peer?.get("videoPriceActualFen")?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                    if (balance != null && priceFen != null && priceFen > 0 && balance < priceFen) {
                        "视频通话需 ${"%.2f".format(priceFen / 100.0).trimEnd('0').trimEnd('.')} 积分/分钟\n当前积分不足，无法发起"
                    } else {
                        null
                    }
                }.getOrNull()
                if (insufficientMsg != null) {
                    clog("local precheck insufficient balance for video call")
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        // 独立提示弹框（不用 toast）；context 异常时降级 Toast 兜底
                        runCatching {
                            android.app.AlertDialog.Builder(context)
                                .setTitle("提示")
                                .setMessage(insufficientMsg)
                                .setPositiveButton("知道了", null)
                                .show()
                        }.onFailure {
                            android.widget.Toast.makeText(context, insufficientMsg, android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                    return@launch
                }
            }
            try {
                val data = Api.request(
                    "/call/invite", "POST",
                    buildJsonObject {
                        put("calleeId", calleeId)
                        put("type", type)
                    },
                )!!.jsonObject
                val callId = data["callId"]!!.jsonPrimitive.content
                val config = Api.json.decodeFromJsonElement(CallConfig.serializer(), data["config"]!!)
                peerPublished.value = false
                bindLogCall(callId)
                clog("invite sent type=$type callId=$callId")
                _state.value = CallState.Outgoing(callId, calleeId, type, config)
            } catch (e: Exception) {
                android.widget.Toast.makeText(context, e.message ?: "呼叫失败", android.widget.Toast.LENGTH_SHORT).show()
                teardown()
            }
        }
    }

    /** 被叫接听 */
    fun accept(context: Context) {
        val cur = _state.value as? CallState.Incoming ?: return
        cancelCallNotification()
        CallFloatWindow.hide()
        scope.launch {
            try {
                Api.request("/call/${cur.callId}/accept", "POST")
                _state.value = CallState.Active(cur.callId, cur.caller.id, cur.type, cur.config)
                startTimer()
                startMedia(cur.callId, cur.caller.id, cur.type, cur.config)
            } catch (e: Exception) {
                android.widget.Toast.makeText(context, e.message ?: "接听失败", android.widget.Toast.LENGTH_SHORT).show()
                teardown()
            }
        }
    }

    fun reject() {
        val cur = _state.value as? CallState.Incoming ?: return
        scope.launch {
            runCatching { Api.request("/call/${cur.callId}/reject", "POST") }
            teardown()
        }
    }

    fun hangup() {
        val callId = when (val cur = _state.value) {
            is CallState.Outgoing -> cur.callId
            is CallState.Active -> cur.callId
            else -> null
        }
        scope.launch {
            callId?.let {
                val path = if (_state.value is CallState.Outgoing) "/call/$it/cancel" else "/call/$it/end"
                runCatching { Api.request(path, "POST") }
            }
            teardown()
        }
    }

    // ---------- 媒体 ----------

    // ---- 通话日志：本地打印（adb logcat -s PeiwanCall）+ 缓冲上报服务器（后台按 callId 汇总排查） ----
    private val logBuf = ArrayDeque<String>()
    private var logCallId: String? = null
    private var logFlushJob: kotlinx.coroutines.Job? = null
    private val logTimeFmt = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)

    fun clog(s: String) {
        android.util.Log.d("PeiwanCall", s)
        synchronized(logBuf) {
            logBuf.addLast("${logTimeFmt.format(java.util.Date())} $s")
            while (logBuf.size > 500) logBuf.removeFirst()
        }
        scheduleLogFlush()
    }

    /** 关联当前 callId（callId 已知后才能上报，之前的日志一并带上） */
    private fun bindLogCall(callId: String) {
        logCallId = callId
        scheduleLogFlush()
    }

    private fun scheduleLogFlush() {
        if (logFlushJob?.isActive == true) return
        logFlushJob = scope.launch {
            kotlinx.coroutines.delay(3000)
            flushLogs()
            // 还有余量继续排队
            if (synchronized(logBuf) { logBuf.isNotEmpty() } && logCallId != null) scheduleLogFlush()
        }
    }

    private suspend fun flushLogs() {
        val callId = logCallId ?: return
        val lines = synchronized(logBuf) {
            if (logBuf.isEmpty()) return
            val l = logBuf.toList()
            logBuf.clear()
            l
        }
        runCatching {
            Api.request("/call/log", "POST", buildJsonObject {
                put("callId", callId)
                put("platform", "android")
                put("lines", kotlinx.serialization.json.buildJsonArray { lines.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            })
        }
    }

    private suspend fun startMedia(callId: String, peerId: String, type: Int, config: CallConfig) {
        val f = factory ?: return
        try {
            clog("startMedia begin type=$type callId=$callId peerId=$peerId")
            // 微信习惯：语音默认听筒，视频默认免提
            (appContextRef?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager)?.apply {
                mode = android.media.AudioManager.MODE_IN_COMMUNICATION
                isSpeakerphoneOn = type == 2
                speakerOn.value = type == 2
            }
            // 推流：本地音频 + (视频通话时)摄像头，参数用后台下发值
            val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }
            pushPc = f.createPeerConnection(rtcConfig, object : PcObserver() {
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    clog("push ICE state=$state")
                }
            })

            localAudioTrack = f.createAudioTrack("audio0", f.createAudioSource(MediaConstraints()))
            pushPc!!.addTransceiver(
                localAudioTrack,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY),
            )

            if (type == 2) {
                val appContext = appContextRef ?: return
                val enumerator = Camera2Enumerator(appContext)
                val front = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
                    ?: enumerator.deviceNames.firstOrNull() ?: return
                // 摄像头事件日志：打开失败/断开/冻结/首帧，定位发送端不出帧
                capturer = enumerator.createCapturer(front, object : CameraVideoCapturer.CameraEventsHandler {
                    override fun onCameraError(msg: String?) { clog("camera ERROR: $msg") }
                    override fun onCameraDisconnected() { clog("camera disconnected") }
                    override fun onCameraFreezed(msg: String?) { clog("camera freezed: $msg") }
                    override fun onCameraOpening(name: String?) { clog("camera opening $name") }
                    override fun onFirstFrameAvailable() { clog("camera first frame available") }
                    override fun onCameraClosed() { clog("camera closed") }
                })
                videoSource = f.createVideoSource(false)
                surfaceHelper = SurfaceTextureHelper.create("capture", eglBase.eglBaseContext)
                capturer!!.initialize(surfaceHelper, appContext, videoSource!!.capturerObserver)
                capturer!!.startCapture(config.width, config.height, config.fps)
                clog("capture start ${config.width}x${config.height}@${config.fps}")
                localVideoTrack.value = f.createVideoTrack("video0", videoSource)
                // 男方默认关闭自己画面（我的页可改默认），女方始终默认开启
                if (com.wh.peiwana.net.Session.gender == 1 && !Api.camDefaultOn) {
                    cameraOff.value = true
                    localVideoTrack.value?.setEnabled(false)
                    clog("male camera default OFF")
                }
                val sender = pushPc!!.addTransceiver(
                    localVideoTrack.value,
                    RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY),
                ).sender
                // 码率后台可调
                sender.parameters = sender.parameters.apply {
                    encodings.forEach { it.maxBitrateBps = config.bitrate * 1000 }
                }
            }

            val offer = pushPc!!.awaitCreateOffer(MediaConstraints())
            pushPc!!.awaitSetLocalDescription(offer)
            // 推流带重试（网络抖动/SRS 短暂不可用）
            var pushAnswer: String? = null
            for (attempt in 0 until 3) {
                val result = runCatching { WhipClient.exchangeSdp(config.whipUrl, "${callId}_$myUserId", offer.description) }
                pushAnswer = result.getOrNull()
                if (pushAnswer != null) {
                    clog("push whip ok attempt=$attempt")
                    break
                }
                clog("push whip FAIL attempt=$attempt: ${result.exceptionOrNull()?.message}")
                if (attempt < 2) kotlinx.coroutines.delay(1000)
            }
            val pushAnswerSdp = pushAnswer ?: throw IllegalStateException("推流失败")
            pushPc!!.awaitSetRemoteDescription(SessionDescription(SessionDescription.Type.ANSWER, pushAnswerSdp))
            clog("push setRemote ok")

            // 通知对方"我已推流"（经信令长连接），对方收到后才订阅我的流
            runCatching { Api.request("/call/$callId/published", "POST") }
                .onFailure { clog("published notify FAIL: ${it.message}") }

            // 等对方推流完成再订阅（超时兜底直接订阅，配合零流量看门狗）
            val gotPeer = kotlinx.coroutines.withTimeoutOrNull(10_000) {
                peerPublished.first { it }
            } != null
            clog("peer published=$gotPeer, subscribing")

            // 拉流：对方的音视频
            setupPull(callId, peerId, type, config)
            clog("media setup complete")
            // SRS 会接受"发布者还没推流"时的 WHEP 订阅（ICE 也能通）但之后永远不给这个订阅者转发 RTP，
            // 导致概率性无画面/无声音（谁先订阅谁黑屏）。看门狗检测零流量并重新订阅。
            startPullWatchdog(callId, peerId, type, config)
        } catch (e: Exception) {
            clog("startMedia ERROR: ${e.message}")
            hangup()
        }
    }

    /** 建立（或重建）拉流连接并完成 WHEP 订阅 */
    private suspend fun setupPull(callId: String, peerId: String, type: Int, config: CallConfig) {
        val f = factory ?: return
        pullPc?.close()
        remoteVideoTrack.value = null
        val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        pullPc = f.createPeerConnection(rtcConfig, object : PcObserver() {
            override fun onTrack(transceiver: RtpTransceiver?) {
                val track = transceiver?.receiver?.track()
                clog("pull onTrack kind=${track?.kind()}")
                if (track is VideoTrack) {
                    remoteVideoTrack.value = track
                }
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                clog("pull ICE state=$state")
            }
        })
        pullPc!!.addTransceiver(
            org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
            RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY),
        )
        if (type == 2) {
            pullPc!!.addTransceiver(
                org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY),
            )
        }
        val pullOffer = pullPc!!.awaitCreateOffer(MediaConstraints())
        pullPc!!.awaitSetLocalDescription(pullOffer)
        // 对方可能尚未推流完成（accept 后双方并行建流），拉流失败时重试
        var pullAnswer: String? = null
        for (attempt in 0 until 10) {
            val result = runCatching { WhipClient.exchangeSdp(config.whepUrl, "${callId}_$peerId", pullOffer.description) }
            pullAnswer = result.getOrNull()
            if (pullAnswer != null) {
                clog("pull whep ok attempt=$attempt")
                break
            }
            clog("pull whep FAIL attempt=$attempt: ${result.exceptionOrNull()?.message}")
            if (attempt < 9) kotlinx.coroutines.delay(1500)
        }
        val pullAnswerSdp = pullAnswer ?: throw IllegalStateException("拉流失败")
        pullPc!!.awaitSetRemoteDescription(SessionDescription(SessionDescription.Type.ANSWER, pullAnswerSdp))
        clog("pull setRemote ok")
    }

    private var pullWatchJob: kotlinx.coroutines.Job? = null

    /** 拉流零流量看门狗：订阅后 4 秒仍一个字节没收到则重新 WHEP 订阅（最多 4 次） */
    private fun startPullWatchdog(callId: String, peerId: String, type: Int, config: CallConfig) {
        pullWatchJob?.cancel()
        pullWatchJob = scope.launch {
            var resubs = 0
            while (resubs < 4) {
                kotlinx.coroutines.delay(4000)
                if (_state.value !is CallState.Active) return@launch
                val pc = pullPc ?: return@launch
                val bytes = pullBytesReceived(pc)
                if (bytes > 0L) {
                    clog("pull media flowing bytes=$bytes")
                    return@launch
                }
                resubs += 1
                clog("pull NO media, resubscribe #$resubs")
                runCatching { setupPull(callId, peerId, type, config) }
                    .onFailure { clog("resubscribe FAIL: ${it.message}") }
            }
        }
    }

    private suspend fun pullBytesReceived(pc: PeerConnection): Long =
        kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            pc.getStats { report ->
                val total = report.statsMap.values.filter { it.type == "inbound-rtp" }
                    .sumOf { ((it.members["bytesReceived"] as? Number)?.toLong()) ?: 0L }
                cont.resume(total) {}
            }
        }

    private var appContextRef: Context? = null

    fun attachContext(context: Context) {
        appContextRef = context.applicationContext
    }

    private const val CALL_NOTIFY_ID = 2

    /** 全屏来电通知（微信式）：高优先级 + 铃声 + fullScreenIntent */
    private fun showIncomingCallNotification(callerName: String, type: Int) {
        val ctx = appContextRef ?: return
        runCatching {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                val channel = android.app.NotificationChannel("peiwan_call", "来电提醒", android.app.NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(
                        android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .build(),
                    )
                    enableVibration(true)
                }
                nm.createNotificationChannel(channel)
            }
            val intent = android.content.Intent(ctx, Class.forName("com.wh.peiwana.MainActivity")).apply {
                flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pending = android.app.PendingIntent.getActivity(
                ctx, 1, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = androidx.core.app.NotificationCompat.Builder(ctx, "peiwan_call")
                .setSmallIcon(com.wh.peiwana.R.mipmap.ic_launcher)
                .setContentTitle(callerName.ifEmpty { "来电" })
                .setContentText(if (type == 2) "邀请你进行视频通话" else "邀请你进行语音通话")
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MAX)
                .setCategory(androidx.core.app.NotificationCompat.CATEGORY_CALL)
                .setContentIntent(pending)
                .setFullScreenIntent(pending, true)
                .setAutoCancel(true)
                .setOngoing(true)
                .build()
            nm.notify(CALL_NOTIFY_ID, notification)
        }
    }

    private fun cancelCallNotification() {
        val ctx = appContextRef ?: return
        runCatching {
            (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager).cancel(CALL_NOTIFY_ID)
        }
    }

    private fun teardown() {
        // 男方视频通话接通后挂断 → 弹评分界面（在状态重置前捕获）
        val cur = _state.value
        if (cur is CallState.Active && cur.type == 2 &&
            com.wh.peiwana.net.Session.gender == 1 && callSeconds.value > 0
        ) {
            pendingRate.value = PendingRate(cur.callId, cur.peerId, peerName.value, peerAvatar.value)
        }
        cancelCallNotification()
        CallFloatWindow.hide()
        pullWatchJob?.cancel()
        pullWatchJob = null
        timerJob?.cancel()
        timerJob = null
        callSeconds.value = 0
        muted.value = false
        speakerOn.value = false
        cameraOff.value = false
        (appContextRef?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager)?.apply {
            mode = android.media.AudioManager.MODE_NORMAL
            isSpeakerphoneOn = false
        }
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        capturer = null
        surfaceHelper?.dispose()
        surfaceHelper = null
        videoSource?.dispose()
        videoSource = null
        pushPc?.close()
        pushPc = null
        pullPc?.close()
        pullPc = null
        localVideoTrack.value = null
        remoteVideoTrack.value = null
        localAudioTrack = null
        peerPublished.value = false
        _state.value = CallState.Idle
        // 挂断后把剩余日志立即冲刷上报（保留 callId 直到冲刷完成）
        clog("teardown done")
        scope.launch { flushLogs() }
    }
}

/** 空实现 Observer，按需覆写 */
abstract class PcObserver : PeerConnection.Observer {
    override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(p0: Boolean) {}
    override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidate(p0: org.webrtc.IceCandidate?) {}
    override fun onIceCandidatesRemoved(p0: Array<out org.webrtc.IceCandidate>?) {}
    override fun onAddStream(p0: org.webrtc.MediaStream?) {}
    override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
    override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
    override fun onRenegotiationNeeded() {}
    override fun onTrack(transceiver: RtpTransceiver?) {}
}
