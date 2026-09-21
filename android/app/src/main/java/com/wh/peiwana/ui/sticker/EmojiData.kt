package com.wh.peiwana.ui.sticker

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wh.peiwana.net.Api
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.text.BreakIterator

/** 一组 emoji：items 每项 [emoji, 中文名, 关键词] */
@Serializable
data class EmojiGroup(val key: String, val name: String, val icon: String, val items: List<List<String>> = emptyList())

@Serializable
private data class EmojiResp(val version: Int = 0, val notModified: Boolean = false, val groups: List<EmojiGroup> = emptyList())

/** Unicode emoji 分类数据（后端 /emojis，SharedPreferences 缓存按 version 增量）+ 最近使用 */
object EmojiStore {
    private val json = Json { ignoreUnknownKeys = true }
    private const val PREF = "peiwan_emojis"
    private const val RECENT_MAX = 32

    var groups by mutableStateOf<List<EmojiGroup>>(emptyList())
        private set
    var recent by mutableStateOf<List<String>>(emptyList())
        private set
    private var version = 0
    private var loaded = false
    private var fetching = false
    /** 本次进程已经问过一次后端（有缓存时每次进程只刷一次） */
    private var fetchedOnce = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    suspend fun ensureLoaded(ctx: Context) {
        if (!loaded) {
            loaded = true
            val p = prefs(ctx)
            version = p.getInt("version", 0)
            p.getString("groups", null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(EmojiGroup.serializer()), s) }.getOrNull()?.let { groups = it } }
            p.getString("recent", null)?.let { s -> runCatching { json.decodeFromString(ListSerializer(String.serializer()), s) }.getOrNull()?.let { recent = it } }
        }
        if (fetching || (groups.isNotEmpty() && version > 0 && fetchedOnce)) return
        fetching = true
        try {
            val data = Api.request(if (version > 0) "/emojis?ver=$version" else "/emojis") ?: return
            val r = json.decodeFromJsonElement(EmojiResp.serializer(), data)
            fetchedOnce = true
            if (!r.notModified && r.groups.isNotEmpty()) {
                version = r.version
                groups = r.groups
                prefs(ctx).edit().putInt("version", version).putString("groups", json.encodeToString(ListSerializer(EmojiGroup.serializer()), groups)).apply()
            }
        } catch (_: Exception) {
        } finally {
            fetching = false
        }
    }

    fun addRecent(ctx: Context, e: String) {
        recent = (listOf(e) + recent.filter { it != e }).take(RECENT_MAX)
        prefs(ctx).edit().putString("recent", json.encodeToString(ListSerializer(String.serializer()), recent)).apply()
    }

    /** 关键词搜索（中英文，空格分词全部命中） */
    fun search(q: String, limit: Int = 120): List<String> {
        val words = q.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val out = ArrayList<String>()
        for (g in groups) for (it in g.items) {
            val hay = ((it.getOrNull(1) ?: "") + " " + (it.getOrNull(2) ?: "")).lowercase()
            if (words.all { w -> hay.contains(w) || it[0] == w }) { out.add(it[0]); if (out.size >= limit) return out }
        }
        return out
    }
}

/** 删掉字符串末尾一个「用户看到的字符」（emoji 可能由多个码点 + ZWJ 组成） */
fun dropLastGrapheme(s: String): String {
    if (s.isEmpty()) return s
    val it = BreakIterator.getCharacterInstance()
    it.setText(s)
    it.last()
    val start = it.previous()
    return if (start == BreakIterator.DONE) "" else s.substring(0, start)
}
