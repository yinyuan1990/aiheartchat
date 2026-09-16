package com.wh.peiwana.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.theme.Bg2
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 后台「App 版本 / 强制更新」下发的检查结果 */
data class VersionInfo(val latest: String, val url: String, val notes: String, val force: Boolean)

fun currentVersionName(context: Context): String =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "1.0"

/**
 * 启动时检查更新：有新版弹框，按钮打开后台配置的 APK 直链（浏览器下载安装）。
 * force：不可关闭（返回键/点外部都无效）、没有「以后再说」；非强制：同一版本每天最多提醒一次。
 */
@Composable
fun UpdateChecker() {
    val context = LocalContext.current
    var info by remember { mutableStateOf<VersionInfo?>(null) }
    val prefs = remember { context.getSharedPreferences("update", Context.MODE_PRIVATE) }

    LaunchedEffect(Unit) {
        val cur = currentVersionName(context)
        val r = runCatching { Api.request("/app/version?platform=android&version=$cur")?.jsonObject }.getOrNull() ?: return@LaunchedEffect
        val hasUpdate = r["hasUpdate"]?.jsonPrimitive?.booleanOrNull == true
        val url = r["url"]?.jsonPrimitive?.contentOrNull ?: ""
        if (!hasUpdate || url.isEmpty()) return@LaunchedEffect
        val force = r["force"]?.jsonPrimitive?.booleanOrNull == true
        val latest = r["latest"]?.jsonPrimitive?.contentOrNull ?: ""
        if (!force && System.currentTimeMillis() - prefs.getLong("skip_$latest", 0) < 86_400_000L) return@LaunchedEffect
        info = VersionInfo(latest, url, r["notes"]?.jsonPrimitive?.contentOrNull ?: "", force)
    }

    val v = info ?: return
    fun later() {
        prefs.edit().putLong("skip_${v.latest}", System.currentTimeMillis()).apply()
        info = null
    }
    Dialog(
        onDismissRequest = { if (!v.force) later() },
        properties = DialogProperties(dismissOnBackPress = !v.force, dismissOnClickOutside = !v.force),
    ) {
        Column(
            Modifier.width(300.dp).clip(RoundedCornerShape(18.dp)).background(Bg2).padding(horizontal = 22.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(if (v.force) "需要更新后才能继续使用" else "发现新版本", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text("最新版本 ${v.latest}　当前 ${currentVersionName(context)}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
            if (v.notes.isNotEmpty()) {
                Text(
                    v.notes, color = TextMain.copy(alpha = 0.9f), fontSize = 14.sp, lineHeight = 22.sp,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp).verticalScroll(rememberScrollState()).padding(top = 16.dp),
                )
            }
            Text("点击后用浏览器下载安装包，下载完成后打开安装", color = TextSub, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 14.dp))
            Text(
                "立即更新", color = androidx.compose.ui.graphics.Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 16.dp).fillMaxWidth().clip(RoundedCornerShape(23.dp)).background(AccentBrush)
                    .noRippleClick {
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(v.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                        if (!v.force) later()
                    }
                    .padding(vertical = 13.dp),
            )
            if (!v.force) {
                Text(
                    "以后再说", color = TextSub, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 6.dp).fillMaxWidth().noRippleClick { later() }.padding(vertical = 10.dp),
                )
            } else {
                Spacer(Modifier.height(4.dp))
            }
        }
    }
}
