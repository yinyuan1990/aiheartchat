package com.wh.peiwana.i18n

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale

/**
 * 界面文字多语言：assets/i18n/<语言>.json（仓库根目录 i18n/ 里维护，node i18n/sync.mjs 复制过来）。
 * `choice` 是 Compose 状态：组合里调用 t() 的界面在切换语言后自动重组，不用重启。缺的 key 显示中文。
 */
object I18n {
    const val SYSTEM = "system"
    private const val FALLBACK = "zh"

    private var tables: Map<String, Map<String, String>> = emptyMap()
    private lateinit var prefs: android.content.SharedPreferences

    /** "system" 或语言代码 */
    var choice by mutableStateOf(SYSTEM)
        private set

    /** 打包进来的语言：代码 → 本语言里的名字（"简体中文"、"English"），中文排第一 */
    val languages: List<Pair<String, String>>
        get() = tables.map { (code, t) -> code to (t["lang.name"] ?: code) }.sortedWith(compareBy({ it.first != FALLBACK }, { it.first }))

    /** 当前生效的语言代码 */
    val lang: String
        get() = choice.takeIf { it != SYSTEM && it in tables } ?: systemLang()

    fun init(context: Context) {
        prefs = context.getSharedPreferences("peiwan", Context.MODE_PRIVATE)
        val assets = context.assets
        tables = (assets.list("i18n") ?: emptyArray()).filter { it.endsWith(".json") }.associate { f ->
            val obj = Json.parseToJsonElement(assets.open("i18n/$f").bufferedReader().use { it.readText() }) as JsonObject
            f.removeSuffix(".json") to obj.mapValues { it.value.jsonPrimitive.content }
        }
        choice = prefs.getString("lang", SYSTEM) ?: SYSTEM
    }

    fun select(code: String) {
        choice = code
        prefs.edit().putString("lang", code).apply()
    }

    /** 系统是中文（含繁体）就用中文，有对应语言包就用它，其它一律英文 */
    private fun systemLang(): String {
        val sys = Locale.getDefault().language
        return when {
            sys == "zh" -> "zh"
            sys in tables -> sys
            else -> "en"
        }
    }

    /** 服务端生成、全群共用的中文（币群名 / 群公告 / 系统昵称）：按 zh.json 里的模板匹配，换成当前语言 */
    private val SERVER_KEYS = listOf("coinGroup.name", "coinGroup.perpName", "coinGroup.perpNotice", "coinGroup.notice", "coinGroup.bot")
    private val serverPatterns by lazy {
        SERVER_KEYS.mapNotNull { k ->
            val zh = tables[FALLBACK]?.get(k) ?: return@mapNotNull null
            val names = Regex("\\{(\\w+)\\}").findAll(zh).map { it.groupValues[1] }.toList()
            val re = zh.split(Regex("\\{\\w+\\}")).joinToString("(.+?)") { Regex.escape(it) }
            Triple(k, Regex(re), names)
        }
    }

    fun server(s: String): String {
        if (lang == FALLBACK || '群' !in s) return s
        for ((k, re, names) in serverPatterns) {
            val m = re.matchEntire(s) ?: continue
            return text(k, names.zip(m.groupValues.drop(1)).toTypedArray())
        }
        return s
    }

    fun localizeServer(el: kotlinx.serialization.json.JsonElement): kotlinx.serialization.json.JsonElement = when (el) {
        is kotlinx.serialization.json.JsonObject -> kotlinx.serialization.json.JsonObject(el.mapValues { localizeServer(it.value) })
        is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(el.map { localizeServer(it) })
        is kotlinx.serialization.json.JsonPrimitive -> if (el.isString && el.content.length in 3..400) server(el.content).let { if (it === el.content) el else kotlinx.serialization.json.JsonPrimitive(it) } else el
        else -> el
    }

    fun text(key: String, args: Array<out Pair<String, Any?>>): String {
        val l = lang
        var s = tables[l]?.get(key) ?: tables[FALLBACK]?.get(key) ?: key
        for ((k, v) in args) s = s.replace("{$k}", v.toString())
        // 英文「1 comments」→「1 comment」：紧跟在单独的 1 后面的词，-ies → -y，去掉 -s（-ss 不动）
        if (l == "en" && args.any { it.second?.toString() == "1" }) s = SINGULAR.replace(s) { m -> "1 " + m.groupValues[1] + if (m.groupValues[2] == "ies") "y" else "" }
        return s
    }

    private val SINGULAR = Regex("\\b1 ([A-Za-z]*?[a-rt-zA-RT-Z])(ies|s)\\b")
}

/** t("me.frozen", "n" to 12) */
fun t(key: String, vararg args: Pair<String, Any?>): String = I18n.text(key, args)
