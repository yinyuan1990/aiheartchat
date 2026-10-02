package com.wh.peiwana.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

@Serializable
data class MessagePayload(
    val id: String,
    val conversationId: String,
    val convType: Int,
    val groupId: String? = null,
    val senderId: String,
    val senderNickname: String = "",
    val senderAvatar: String = "",
    val receiverId: String? = null,
    val type: String,
    val content: String,
    val createdAt: String,
    /** 机器人发的消息才有 */
    val senderIsBot: Boolean = false,
    val markup: InlineMarkup? = null,
    val replyTo: ReplyPreview? = null,
    val fwdFrom: String? = null,
    val reactions: List<MsgReaction> = emptyList(),
    /** 频道里订阅者发的：当普通聊天消息显示 */
    val memberMsg: Boolean = false,
)

/** 被回复的消息预览：文字取前 100 字、图片是 url；deleted=原消息已删除 */
@Serializable
data class ReplyPreview(
    val id: String,
    val senderId: String = "",
    val senderNickname: String = "",
    val type: String = "",
    val content: String = "",
    val deleted: Boolean = false,
)

@Serializable
data class MsgReaction(val emoji: String, val count: Int, val userIds: List<String> = emptyList())

/** IM WebSocket：自动重连 + 心跳 + 帧分发（协议见后端 im.types.ts） */
object WsClient {
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    /** OkHttp 回调在后台线程，统一切到主线程分发，listener 里可直接做 UI 操作（如 Toast） */
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    private var ws: WebSocket? = null
    private var manualClose = false
    private val listeners = CopyOnWriteArraySet<(JsonObject) -> Unit>()
    val json = Json { ignoreUnknownKeys = true }

    fun connect() {
        val token = Api.token ?: return
        if (ws != null) return
        manualClose = false
        val url = Api.BASE_URL.replaceFirst("http", "ws") + "/ws?token=$token"
        ws = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = try {
                        json.parseToJsonElement(text) as? JsonObject
                    } catch (_: Exception) {
                        null
                    } ?: return
                    mainHandler.post { listeners.forEach { l -> runCatching { l(frame) } } }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ws = null
                    if (!manualClose) reconnectLater()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    ws = null
                    if (!manualClose) reconnectLater()
                }
            },
        )
    }

    private fun reconnectLater() {
        Thread {
            Thread.sleep(3000)
            connect()
        }.start()
    }

    fun close() {
        manualClose = true
        ws?.close(1000, null)
        ws = null
    }

    fun addListener(listener: (JsonObject) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** 发送消息，返回 tempId */
    fun send(convType: Int, targetId: String, msgType: String, content: String, replyToId: String? = null): String {
        val tempId = "t_${System.currentTimeMillis()}_${(1000..9999).random()}"
        val frame = buildJsonObject {
            put("op", "send")
            put("tempId", tempId)
            put("convType", convType)
            put("targetId", targetId)
            put("msgType", msgType)
            put("content", content)
            if (replyToId != null) put("replyToId", replyToId)
        }
        ws?.send(frame.toString())
        return tempId
    }

    fun markRead(conversationId: String, msgId: String) {
        val frame = buildJsonObject {
            put("op", "read")
            put("conversationId", conversationId)
            put("msgId", msgId)
        }
        ws?.send(frame.toString())
    }
}
