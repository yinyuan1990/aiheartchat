package com.wh.peiwana.rtc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * SRS WHIP/WHEP 信令：POST offer SDP，返回 answer SDP。
 * WHIP 推流: {whipUrl}?app=live&stream={callId}_{myId}
 * WHEP 拉流: {whepUrl}?app=live&stream={callId}_{peerId}
 */
object WhipClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
    private val sdpMedia = "application/sdp".toMediaType()

    suspend fun exchangeSdp(endpoint: String, stream: String, offerSdp: String): String =
        withContext(Dispatchers.IO) {
            val url = "$endpoint?app=live&stream=$stream"
            val req = Request.Builder().url(url).post(offerSdp.toRequestBody(sdpMedia)).build()
            val resp = http.newCall(req).execute()
            val body = resp.body?.string() ?: ""
            if (!resp.isSuccessful || body.isEmpty()) {
                throw IllegalStateException("SRS 信令失败: HTTP ${resp.code}")
            }
            // SRS 在流未就绪等情况下会返回 200 + JSON 错误体，必须校验是合法 SDP
            if (!body.trimStart().startsWith("v=0")) {
                throw IllegalStateException("SRS 返回非 SDP 应答: ${body.take(120)}")
            }
            body
        }
}

suspend fun PeerConnection.awaitCreateOffer(constraints: MediaConstraints): SessionDescription =
    suspendCoroutine { cont ->
        createOffer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) = cont.resume(desc)
            override fun onCreateFailure(error: String?) =
                cont.resumeWithException(IllegalStateException(error ?: "createOffer 失败"))
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, constraints)
    }

suspend fun PeerConnection.awaitSetLocalDescription(desc: SessionDescription): Unit =
    suspendCoroutine { cont ->
        setLocalDescription(object : SdpObserver {
            override fun onSetSuccess() = cont.resume(Unit)
            override fun onSetFailure(error: String?) =
                cont.resumeWithException(IllegalStateException(error ?: "setLocal 失败"))
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, desc)
    }

suspend fun PeerConnection.awaitSetRemoteDescription(desc: SessionDescription): Unit =
    suspendCoroutine { cont ->
        setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() = cont.resume(Unit)
            override fun onSetFailure(error: String?) =
                cont.resumeWithException(IllegalStateException(error ?: "setRemote 失败"))
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, desc)
    }
