package com.wh.peiwana.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.composed
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.theme.Accent
import com.wh.peiwana.ui.theme.Accent2
import com.wh.peiwana.ui.theme.Bg3
import com.wh.peiwana.ui.theme.Line
import com.wh.peiwana.ui.theme.TextDim
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub

val AccentBrush = Brush.horizontalGradient(listOf(Accent, Accent2))

/** 内部网页全屏预览（共用：AI 生成的 HTML 或新闻原文 url） */
@Composable
fun WebPreviewDialog(html: String? = null, url: String? = null, title: String = "网页预览", onClose: () -> Unit) {
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(Modifier.fillMaxSize().background(com.wh.peiwana.ui.theme.Bg)) {
            Row(
                Modifier.fillMaxWidth()
                    .statusBarsPadding()
                    .padding(14.dp, 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, color = TextMain, fontSize = 14.sp, maxLines = 1, modifier = Modifier.weight(1f))
                Text("关闭", color = Accent, fontSize = 14.sp, modifier = Modifier.noRippleClick(onClose))
            }
            androidx.compose.ui.viewinterop.AndroidView(
                factory = { c ->
                    android.webkit.WebView(c).apply {
                        settings.javaScriptEnabled = true
                        webViewClient = android.webkit.WebViewClient()
                        if (html != null) loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                        else if (url != null) loadUrl(url)
                    }
                },
                modifier = Modifier.weight(1f).fillMaxWidth().navigationBarsPadding(),
            )
        }
    }
}

/** 无水波纹点击（去掉矩形高亮），用于文字 tab 等 */
fun Modifier.noRippleClick(onClick: () -> Unit): Modifier = composed {
    val src = remember { MutableInteractionSource() }
    this.clickable(interactionSource = src, indication = null, onClick = onClick)
}

@Composable
fun PageTitle(text: String, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp, 14.dp, 16.dp, 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = TextMain, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

@Composable
fun NavBar(title: String, onBack: () -> Unit, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) {
            BackIcon(TextMain, 24.dp)
        }
        Text(title, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
        Box(modifier = Modifier.size(56.dp, 40.dp), contentAlignment = Alignment.Center) { action?.invoke() }
    }
}

/** 返回箭头（线性） */
@Composable
fun BackIcon(tint: Color, size: androidx.compose.ui.unit.Dp = 24.dp) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        drawLine(tint, androidx.compose.ui.geometry.Offset(w * 0.62f, w * 0.22f), androidx.compose.ui.geometry.Offset(w * 0.36f, w * 0.5f), strokeWidth = w * 0.09f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(tint, androidx.compose.ui.geometry.Offset(w * 0.36f, w * 0.5f), androidx.compose.ui.geometry.Offset(w * 0.62f, w * 0.78f), strokeWidth = w * 0.09f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

/** 扫一扫图标（四角取景框 + 中线） */
@Composable
fun ScanIcon(tint: Color, size: androidx.compose.ui.unit.Dp = 20.dp) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val c = w * 0.3f
        val sw = w * 0.1f
        val cap = androidx.compose.ui.graphics.StrokeCap.Round
        fun p(x: Float, y: Float) = androidx.compose.ui.geometry.Offset(x, y)
        drawLine(tint, p(0f, c), p(0f, 0f), sw, cap); drawLine(tint, p(0f, 0f), p(c, 0f), sw, cap)
        drawLine(tint, p(w - c, 0f), p(w, 0f), sw, cap); drawLine(tint, p(w, 0f), p(w, c), sw, cap)
        drawLine(tint, p(0f, h - c), p(0f, h), sw, cap); drawLine(tint, p(0f, h), p(c, h), sw, cap)
        drawLine(tint, p(w - c, h), p(w, h), sw, cap); drawLine(tint, p(w, h), p(w, h - c), sw, cap)
        drawLine(tint, p(w * 0.2f, h * 0.5f), p(w * 0.8f, h * 0.5f), sw, cap)
    }
}

/** 全屏图片查看器（Telephoto）：双指/双击缩放 + 平移，横滑切换，单击关闭 */
@Composable
fun ImageViewer(urls: List<String>, startIndex: Int = 0, onClose: () -> Unit) {
    if (urls.isEmpty()) return
    val pager = rememberPagerState(initialPage = startIndex.coerceIn(0, urls.size - 1)) { urls.size }

    androidx.compose.foundation.layout.Box(
        modifier = Modifier.fillMaxSize().background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
            me.saket.telephoto.zoomable.coil.ZoomableAsyncImage(
                model = Api.fullUrl(urls[page]),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                onClick = { onClose() },
            )
        }
        if (urls.size > 1) {
            Text("${pager.currentPage + 1}/${urls.size}", color = Color.White, modifier = Modifier.align(Alignment.TopCenter).padding(top = 40.dp))
        }
        Box(
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 36.dp, end = 16.dp).size(36.dp)
                .clip(CircleShape).background(Color.White.copy(alpha = 0.18f)).noRippleClick(onClose),
            contentAlignment = Alignment.Center,
        ) { Text("×", color = Color.White, fontSize = 22.sp) }
    }
}

@Composable
fun EmptyHint(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, color = TextSub, textAlign = TextAlign.Center, fontSize = 14.sp, lineHeight = 26.sp)
    }
}

@Composable
fun Avatar(url: String?, size: Int = 44) {
    Box(
        modifier = Modifier.size(size.dp).clip(CircleShape).background(Bg3),
        contentAlignment = Alignment.Center,
    ) {
        if (!url.isNullOrEmpty()) {
            AsyncImage(model = Api.fullUrl(url), contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
        }
    }
}

/** 玫红胶囊主按钮 */
@Composable
fun AccentButton(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(RoundedCornerShape(23.dp))
            .background(if (enabled) AccentBrush else Brush.horizontalGradient(listOf(Bg3, Bg3)))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = androidx.compose.ui.graphics.Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun PillTab(text: String, active: Boolean, badge: Int = 0, onClick: () -> Unit) {
    Box(contentAlignment = Alignment.TopEnd) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(14.dp))
                .background(if (active) AccentBrush else Brush.horizontalGradient(listOf(Bg3, Bg3)))
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 5.dp),
        ) {
            Text(text, color = if (active) androidx.compose.ui.graphics.Color.White else TextSub, fontSize = 13.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
        }
        RoundBadge(badge)
    }
}

/** 正圆未读徽标（两位数以上自动变胶囊），微信式 */
@Composable
fun RoundBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(
        modifier = modifier
            .height(16.dp)
            .defaultMinSize(minWidth = 16.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(Accent)
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (count > 99) "99+" else "$count",
            color = androidx.compose.ui.graphics.Color.White,
            fontSize = 9.sp,
            // 去掉字体内边距，保证数字在 16dp 圆内垂直居中不撑高
            style = androidx.compose.ui.text.TextStyle(
                platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
            ),
        )
    }
}

fun timeAgo(iso: String): String {
    if (iso.isEmpty()) return ""
    return try {
        val t = java.time.Instant.parse(iso).toEpochMilli()
        val diff = System.currentTimeMillis() - t
        val min = diff / 60000
        when {
            min < 1 -> "刚刚"
            min < 60 -> "$min 分钟前"
            min < 1440 -> "${min / 60} 小时前"
            else -> "${min / 1440} 天前"
        }
    } catch (_: Exception) { "" }
}
