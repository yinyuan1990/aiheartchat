package com.wh.peiwana.rtc

import android.content.Context
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.WsClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.webrtc.AudioTrack
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Serializable
data class VRMember(val id: String, val nickname: String? = "", val avatar: String? = "")

/**
 * 群聊语音房：每人推一路音频（WHIP），拉房内其他成员音频（WHEP），流名 vr_{groupId}_{userId}。
 * 成员变化由服务端经 IM WS 广播（op=vroom）；30 秒心跳保活，杀进程 90 秒被服务端剔除。
 * 日志按房间场次上报服务器（管理端「通话日志-语音房」按场次汇总多端日志）。
 */
object VoiceRoomManager {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var myUserId = ""
    private var factory: PeerConnectionFactory? = null
    private var appContextRef: Context? = null

    /** 当前所在房间的群 id（null = 未在房内） */
    val joinedGroupId = MutableStateFlow<String?>(null)
    val members = MutableStateFlow<List<VRMember>>(emptyList())
    val maxMembers = MutableStateFlow(3)
    val muted = MutableStateFlow(false)
    val joining = MutableStateFlow(false)
    /** 各群房间成员预览（群聊页入口人数角标），WS vroom 帧实时刷新 */
    val roomPreview = MutableStateFlow<Map<String, List<VRMember>>>(emptyMap())
    val toastMsg = MutableStateFlow<String?>(null)
    /** 当前场次的二维码 token（房内成员可分享，扫码免密进房） */
    val qrToken = MutableStateFlow("")

    private var whipUrl = ""
    private var whepUrl = ""
    private var roomId = ""
    private var pushPc: PeerConnection? = null
    private var localAudioTrack: AudioTrack? = null
    private val pullPcs = mutableMapOf<String, PeerConnection>()
    private var heartbeatJob: Job? = null
    private var logJob: Job? = null

    // ---- 房间日志：本地打印（adb logcat -s PeiwanVRoom）+ 按场次上报服务器 ----
    private val logBuf = mutableListOf<String>()
    private val logFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun vlog(s: String) {
        android.util.Log.i("PeiwanVRoom", s)
        synchronized(logBuf) {
            logBuf.add("${logFmt.format(Date())} $s")
            while (logBuf.size > 500) logBuf.removeAt(0)
        }
    }

    /** App 启动后调用一次（登录后）：监听 vroom 广播 */
    fun init(context: Context, userId: String) {
        myUserId = userId
        appContextRef = context.applicationContext
        if (factory == null) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
            )
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        }
        WsClient.addListener { frame ->
            if (frame["op"]?.jsonPrimitive?.content != "vroom") return@addListener
            val data = frame["data"]?.jsonObject ?: return@addListener
            val groupId = data["groupId"]?.jsonPrimitive?.content ?: return@addListener
            val mems = runCatching {
                Api.json.decodeFromJsonElement(ListSerializer(VRMember.serializer()), data["members"]!!)
            }.getOrNull() ?: return@addListener
            val max = data["max"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 3
            scope.launch { handleUpdate(groupId, mems, max) }
        }
    }

    /** 群聊页/面板打开时刷新一次房间状态 */
    suspend fun refreshInfo(groupId: String) {
        runCatching {
            val d = Api.request("/im/group/$groupId/voiceroom")!!.jsonObject
            val mems = Api.json.decodeFromJsonElement(ListSerializer(VRMember.serializer()), d["members"]!!)
            roomPreview.value = roomPreview.value + (groupId to mems)
            if (joinedGroupId.value == null) {
                maxMembers.value = d["max"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 3
            }
            if (joinedGroupId.value == null || joinedGroupId.value == groupId) {
                qrToken.value = d["qrToken"]?.jsonPrimitive?.contentOrNull ?: ""
            }
        }
    }

    data class VroomScanResult(val conversationId: String, val groupId: String, val groupName: String, val roomActive: Boolean)

    /** 扫语音房二维码：免密入群，返回群会话与房间状态（失败抛异常，message 可直接展示） */
    suspend fun scanJoin(groupId: String, token: String): VroomScanResult {
        val d = Api.request("/im/voiceroom/scan", "POST", buildJsonObject {
            put("groupId", groupId)
            put("token", token)
        })!!.jsonObject
        return VroomScanResult(
            conversationId = d["conversationId"]?.jsonPrimitive?.contentOrNull ?: "",
            groupId = d["groupId"]?.jsonPrimitive?.contentOrNull ?: groupId,
            groupName = d["groupName"]?.jsonPrimitive?.contentOrNull ?: "群聊",
            roomActive = d["roomActive"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: false,
        )
    }

    fun memberCount(groupId: String): Int =
        if (joinedGroupId.value == groupId) members.value.size else roomPreview.value[groupId]?.size ?: 0

    private fun handleUpdate(groupId: String, mems: List<VRMember>, max: Int) {
        roomPreview.value = roomPreview.value + (groupId to mems)
        if (groupId != joinedGroupId.value) return
        maxMembers.value = max
        val old = members.value.map { it.id }.toSet()
        val new = mems.map { it.id }.toSet()
        members.value = mems
        // 服务端已把我剔除（心跳超时等）→ 本地同步退房
        if (myUserId !in new) {
            vlog("kicked by server (not in member list)")
            teardown("语音房连接超时，已退出")
            return
        }
        (new - old).filter { it != myUserId }.forEach { subscribe(it) }
        (old - new).filter { it != myUserId }.forEach { unsubscribe(it) }
    }

    // ---------- 进出房 ----------

    fun join(groupId: String) {
        val cur = joinedGroupId.value
        if (cur != null) {
            if (cur != groupId) toastMsg.value = "请先退出当前语音房"
            return
        }
        if (joining.value) return
        joining.value = true
        scope.launch {
            try {
                val d = Api.request("/im/group/$groupId/voiceroom/join", "POST")!!.jsonObject
                joinedGroupId.value = groupId
                members.value = Api.json.decodeFromJsonElement(ListSerializer(VRMember.serializer()), d["members"]!!)
                maxMembers.value = d["max"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 3
                roomId = d["roomId"]?.jsonPrimitive?.contentOrNull ?: ""
                qrToken.value = d["qrToken"]?.jsonPrimitive?.contentOrNull ?: ""
                whipUrl = d["whipUrl"]?.jsonPrimitive?.contentOrNull ?: ""
                whepUrl = d["whepUrl"]?.jsonPrimitive?.contentOrNull ?: ""
                val stream = d["stream"]?.jsonPrimitive?.contentOrNull ?: "vr_${groupId}_$myUserId"
                roomPreview.value = roomPreview.value + (groupId to members.value)
                vlog("join ok room=$roomId me=$myUserId members=[${members.value.joinToString(",") { it.id }}] max=${maxMembers.value}")
                configureAudio()
                publish(stream)
                members.value.filter { it.id != myUserId }.forEach { subscribe(it.id) }
                startHeartbeat(groupId)
                startLogFlush(groupId)
            } catch (e: Exception) {
                vlog("join FAIL: ${e.message}")
                toastMsg.value = e.message ?: "加入失败"
                teardown(null)
            }
            joining.value = false
        }
    }

    fun leave() {
        val gid = joinedGroupId.value ?: return
        vlog("leave: user tapped")
        scope.launch { runCatching { Api.request("/im/group/$gid/voiceroom/leave", "POST") } }
        teardown(null)
    }

    fun toggleMute() {
        muted.value = !muted.value
        localAudioTrack?.setEnabled(!muted.value)
        vlog("mute=${muted.value}")
    }

    // ---------- 媒体 ----------

    private fun configureAudio() {
        (appContextRef?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager)?.apply {
            mode = android.media.AudioManager.MODE_IN_COMMUNICATION
            isSpeakerphoneOn = true
        }
        vlog("audio configured (speaker on)")
    }

    private suspend fun publish(stream: String) {
        val f = factory ?: throw IllegalStateException("factory 未初始化")
        val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val push = f.createPeerConnection(rtcConfig, object : PcObserver() {
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                vlog("push ICE state=$state")
            }
        }) ?: throw IllegalStateException("创建推流连接失败")
        localAudioTrack = f.createAudioTrack("audio0", f.createAudioSource(MediaConstraints()))
        localAudioTrack?.setEnabled(!muted.value)
        push.addTransceiver(localAudioTrack, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY))
        pushPc = push

        val offer = push.awaitCreateOffer(MediaConstraints())
        push.awaitSetLocalDescription(offer)
        var answer: String? = null
        for (attempt in 0 until 3) {
            val result = runCatching { WhipClient.exchangeSdp(whipUrl, stream, offer.description) }
            answer = result.getOrNull()
            if (answer != null) {
                vlog("push whip ok attempt=$attempt")
                break
            }
            vlog("push whip FAIL attempt=$attempt: ${result.exceptionOrNull()?.message}")
            if (attempt < 2) delay(1000)
        }
        val answerSdp = answer ?: throw IllegalStateException("语音推流失败")
        push.awaitSetRemoteDescription(SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
        vlog("push ready stream=$stream")
    }

    private fun subscribe(uid: String) {
        val gid = joinedGroupId.value ?: return
        if (pullPcs.containsKey(uid)) return
        val f = factory ?: return
        vlog("subscribe uid=$uid")
        val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pull = f.createPeerConnection(rtcConfig, object : PcObserver() {
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                vlog("pull ICE uid=$uid state=$state")
            }
        }) ?: run {
            vlog("subscribe ERROR uid=$uid: create pc failed")
            return
        }
        pull.addTransceiver(
            org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
            RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY),
        )
        pullPcs[uid] = pull

        scope.launch {
            try {
                val offer = pull.awaitCreateOffer(MediaConstraints())
                pull.awaitSetLocalDescription(offer)
                var answer: String? = null
                for (attempt in 0 until 8) {
                    // 对方可能刚进房还没推完流，失败重试
                    val result = runCatching { WhipClient.exchangeSdp(whepUrl, "vr_${gid}_$uid", offer.description) }
                    answer = result.getOrNull()
                    if (answer != null) {
                        vlog("pull whep ok uid=$uid attempt=$attempt")
                        break
                    }
                    vlog("pull whep FAIL uid=$uid attempt=$attempt: ${result.exceptionOrNull()?.message}")
                    if (attempt < 7) delay(1500)
                    if (pullPcs[uid] !== pull) return@launch // 已退订
                }
                val answerSdp = answer ?: run {
                    vlog("subscribe give up uid=$uid")
                    return@launch
                }
                pull.awaitSetRemoteDescription(SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
                vlog("subscribed uid=$uid")
            } catch (e: Exception) {
                vlog("subscribe ERROR uid=$uid: ${e.message}")
            }
        }
    }

    private fun unsubscribe(uid: String) {
        vlog("unsubscribe uid=$uid")
        pullPcs.remove(uid)?.close()
    }

    // ---------- 心跳 / 日志上报 ----------

    private fun startHeartbeat(groupId: String) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (true) {
                delay(30_000)
                if (joinedGroupId.value != groupId) return@launch
                val inRoom = runCatching {
                    Api.request("/im/group/$groupId/voiceroom/heartbeat", "POST")!!
                        .jsonObject["inRoom"]?.jsonPrimitive?.contentOrNull?.toBoolean()
                }.getOrNull()
                if (inRoom == false) {
                    vlog("heartbeat: server says not in room, teardown")
                    teardown("语音房连接超时，已退出")
                    return@launch
                }
            }
        }
    }

    private fun startLogFlush(groupId: String) {
        logJob?.cancel()
        logJob = scope.launch {
            while (true) {
                delay(5_000)
                flushLogs(groupId)
            }
        }
    }

    private suspend fun flushLogs(groupId: String) {
        val lines = synchronized(logBuf) {
            if (logBuf.isEmpty()) return
            val l = logBuf.toList()
            logBuf.clear()
            l
        }
        runCatching {
            Api.request("/im/group/$groupId/voiceroom/log", "POST", buildJsonObject {
                put("platform", "android")
                put("lines", buildJsonArray { lines.forEach { add(JsonPrimitive(it)) } })
            })
        }
    }

    private fun teardown(reason: String?) {
        val gid = joinedGroupId.value
        heartbeatJob?.cancel()
        logJob?.cancel()
        pushPc?.close()
        pushPc = null
        pullPcs.values.forEach { it.close() }
        pullPcs.clear()
        localAudioTrack = null
        joinedGroupId.value = null
        members.value = emptyList()
        muted.value = false
        roomId = ""
        if (reason != null) toastMsg.value = reason
        (appContextRef?.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager)?.apply {
            mode = android.media.AudioManager.MODE_NORMAL
            isSpeakerphoneOn = false
        }
        vlog("teardown done")
        // 退房后把剩余日志冲刷上报
        if (gid != null) scope.launch { flushLogs(gid) }
    }
}
