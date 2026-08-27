package com.wh.peiwana.net

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import java.util.concurrent.TimeUnit

@Serializable
data class ApiResp(val code: Int, val msg: String, val data: JsonElement? = null)

@Serializable
data class UserProfile(
    val id: String,
    val shortId: String? = null,
    val address: String = "",
    val nickname: String,
    val avatar: String = "",
    val gender: Int,
    val age: Int = 0,
    val cityCode: String = "",
    val cityName: String = "",
    val signature: String = "",
    val isGuide: Boolean = false,
    val videoPriceFen: Int = 0,
    val realname: Boolean = false,
    val realNameMasked: String = "",
    val balance: String? = null,
    val frozen: String? = null,
    val following: Int = 0,
    val fans: Int = 0,
    /** 照片墙（最多 8 张） */
    val albums: List<AlbumItem> = emptyList(),
)

/** 分 → 积分 显示 */
fun fmtPoints(fen: String?): String {
    val n = (fen?.toDoubleOrNull() ?: 0.0) / 100.0
    var s = String.format("%.2f", n)
    if (s.contains(".")) s = s.trimEnd('0').trimEnd('.')
    return if (s.isEmpty()) "0" else s
}

@Serializable
data class EnterResp(val registered: Boolean, val token: String? = null, val user: UserProfile? = null)

@Serializable
data class AppModuleItem(val id: Int, val name: String, val icon: String, val type: String, val entry: String)

class ApiException(val code: Int, message: String) : Exception(message)

/** 包装 RequestBody 统计写出字节数，回调上传进度（主线程、按百分比节流） */
class ProgressRequestBody(
    private val delegate: okhttp3.RequestBody,
    private val onProgress: (Float) -> Unit,
) : okhttp3.RequestBody() {
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()
    override fun writeTo(sink: okio.BufferedSink) {
        val total = contentLength().coerceAtLeast(1)
        var written = 0L
        var lastPercent = -1
        val counting = object : okio.ForwardingSink(sink) {
            override fun write(source: okio.Buffer, byteCount: Long) {
                super.write(source, byteCount)
                // 每写一段立刻刷出，保证统计贴近真实网络进度
                sink.flush()
                written += byteCount
                val percent = (written * 100 / total).toInt()
                if (percent != lastPercent) {
                    lastPercent = percent
                    val p = (percent / 100f).coerceIn(0f, 1f)
                    mainHandler.post { onProgress(p) }
                }
            }
        }
        val buffered = counting.buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }
}

object Api {
    const val BASE_URL = "http://8.162.5.160:20080"

    val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private lateinit var prefs: android.content.SharedPreferences
    private var deviceIdCached: String? = null

    fun init(context: Context) {
        prefs = context.getSharedPreferences("peiwan", Context.MODE_PRIVATE)
        deviceIdCached = resolveDeviceId(context)
    }

    /** 一机一号：ANDROID_ID 同签名重装不变，凭此恢复账号 */
    @SuppressLint("HardwareIds")
    private fun resolveDeviceId(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        return "and_" + (androidId ?: java.util.UUID.randomUUID().toString().replace("-", ""))
    }

    val deviceId: String get() = deviceIdCached!!

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    /** 男方视频通话默认是否开启自己画面（默认关闭，仅男方"我的"页可设置） */
    var camDefaultOn: Boolean
        get() = prefs.getBoolean("cam_default_on", false)
        set(value) = prefs.edit().putBoolean("cam_default_on", value).apply()

    /** 注册头像上传（免登录），返回可访问的相对 URL */
    suspend fun uploadAvatar(bytes: ByteArray, mime: String = "image/jpeg"): String =
        withContext(Dispatchers.IO) {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "avatar.jpg", bytes.toRequestBody(mime.toMediaType()))
                .build()
            val req = Request.Builder().url("$BASE_URL/api/upload/avatar").post(body).build()
            val resp = client.newCall(req).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, "网络异常")
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
            (parsed.data as kotlinx.serialization.json.JsonObject)["url"]!!
                .let { (it as kotlinx.serialization.json.JsonPrimitive).content }
        }

    /** 登录后上传 kind=image|video|audio，返回相对 URL；onProgress 回调 0~1 */
    suspend fun upload(kind: String, bytes: ByteArray, filename: String, mime: String, onProgress: ((Float) -> Unit)? = null): String =
        withContext(Dispatchers.IO) {
            val raw = bytes.toRequestBody(mime.toMediaType())
            val fileBody = if (onProgress != null) ProgressRequestBody(raw, onProgress) else raw
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", filename, fileBody)
                .build()
            val builder = Request.Builder().url("$BASE_URL/api/upload/$kind").post(body)
            token?.let { builder.header("Authorization", "Bearer $it") }
            val resp = client.newCall(builder.build()).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, "网络异常")
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
            (parsed.data as kotlinx.serialization.json.JsonObject)["url"]!!
                .let { (it as kotlinx.serialization.json.JsonPrimitive).content }
        }

    /** 便捷：GET 并解析为列表 */
    suspend inline fun <reified T> getList(path: String): List<T> {
        val data = request(path) ?: return emptyList()
        return json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<T>()), data)
    }

    suspend inline fun <reified T> getObj(path: String): T {
        val data = request(path)!!
        return json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), data)
    }

    /** 相对资源路径转完整 URL */
    fun fullUrl(path: String): String =
        if (path.startsWith("http") || path.isEmpty()) path else BASE_URL + path

    suspend fun request(path: String, method: String = "GET", body: JsonObject? = null): JsonElement? =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$BASE_URL/api$path")
            token?.let { builder.header("Authorization", "Bearer $it") }
            when (method) {
                "GET" -> builder.get()
                else -> builder.method(method, (body?.toString() ?: "{}").toRequestBody(jsonMedia))
            }
            val resp = client.newCall(builder.build()).execute()
            val text = resp.body?.string() ?: throw ApiException(-1, "网络异常")
            val parsed = json.decodeFromString<ApiResp>(text)
            if (parsed.code != 0) throw ApiException(parsed.code, parsed.msg)
            parsed.data
        }
}
