package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.border
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.EmptyHint
import com.wh.peiwana.ui.NavBar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.timeAgo
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data class NewsItem(
    val id: String = "0",
    val title: String = "",
    val summary: String = "",
    val tag: String = "",
    val source: String = "",
    val sourceUrl: String = "",
    val createdAt: String = "",
)

@Serializable
data class NewsArticle(
    val id: String = "0",
    val title: String = "",
    val summary: String = "",
    val tag: String = "",
    val content: String = "",
    val source: String = "",
    val sourceUrl: String = "",
    val createdAt: String = "",
)

/** 每日一句励志（AI 生成，男女不同） */
@Serializable
data class DailyQuote(val id: String = "0", val day: String = "", val text: String = "")

private fun artDate(day: String): String {
    val p = day.split("-")
    return if (p.size == 3) "${p[0]} · ${p[1]} · ${p[2]}" else day
}

/** 竖排：每列最多 11 字，从右往左排（传统行款） */
private fun quoteColumns(text: String, perCol: Int = 11): List<String> {
    if (text.isEmpty()) return emptyList()
    return text.chunked(perCol)
}

/** 励志行：一页一句、竖排、左右翻页 */
@Composable
fun QuoteSection() {
    var list by remember { mutableStateOf<List<DailyQuote>?>(null) }
    var hasMore by remember { mutableStateOf(false) }

    suspend fun loadFirst() {
        val rows = runCatching { Api.getList<DailyQuote>("/news/quotes") }.getOrDefault(emptyList())
        hasMore = rows.size >= 30
        list = rows
    }
    suspend fun loadMore() {
        val last = list?.lastOrNull()?.id ?: return
        val rows = runCatching { Api.getList<DailyQuote>("/news/quotes?beforeId=$last") }.getOrDefault(emptyList())
        hasMore = rows.size >= 30
        list = (list ?: emptyList()) + rows
    }
    LaunchedEffect(Unit) { loadFirst() }

    val items = list ?: return
    if (items.isEmpty()) {
        EmptyHint("今天的励志话正在路上…")
        return
    }
    val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        .apply { timeZone = java.util.TimeZone.getTimeZone("GMT+8") }
        .format(java.util.Date())
    val pagerState = rememberPagerState(pageCount = { items.size })
    LaunchedEffect(pagerState.currentPage, items.size) {
        if (hasMore && pagerState.currentPage >= items.size - 3) loadMore()
    }

    HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
        QuotePage(items[page], page, items.size, hasMore, today)
    }
}

@Composable
private fun QuotePage(q: DailyQuote, index: Int, total: Int, hasMore: Boolean, today: String) {
    val cols = quoteColumns(q.text)
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier.align(Alignment.Center).fillMaxWidth(0.64f).fillMaxHeight(0.58f)
                .background(Brush.radialGradient(listOf(Accent.copy(alpha = 0.10f), Color.Transparent))),
        )
        Box(
            Modifier.align(Alignment.CenterEnd).padding(end = 56.dp)
                .width(1.dp).fillMaxHeight(0.48f)
                .background(Brush.verticalGradient(listOf(Color.Transparent, Accent.copy(alpha = 0.35f), Color.Transparent))),
        )
        Text(
            "「", color = Accent.copy(alpha = 0.38f), fontSize = 42.sp, fontFamily = FontFamily.Serif,
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 36.dp, end = 36.dp),
        )
        Text(
            "」", color = Accent.copy(alpha = 0.38f), fontSize = 42.sp, fontFamily = FontFamily.Serif,
            modifier = Modifier.align(Alignment.BottomStart).padding(bottom = 88.dp, start = 36.dp),
        )
        Row(
            Modifier.align(Alignment.Center),
            horizontalArrangement = Arrangement.spacedBy(22.dp),
            verticalAlignment = Alignment.Top,
        ) {
            cols.reversed().forEach { col ->
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    col.forEach { ch ->
                        Text(
                            ch.toString(),
                            color = TextMain.copy(alpha = 0.92f),
                            fontSize = 22.sp,
                            fontFamily = FontFamily.Serif,
                            lineHeight = 28.sp,
                        )
                    }
                }
            }
        }
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(artDate(q.day), color = TextSub, fontSize = 12.sp, fontFamily = FontFamily.Serif, letterSpacing = 2.sp)
                if (q.day == today) {
                    Text("今日", color = Accent, fontSize = 11.sp, fontFamily = FontFamily.Serif, letterSpacing = 2.sp)
                }
            }
            Text(
                "${index + 1} / $total${if (hasMore) "+" else ""}",
                color = TextDim, fontSize = 11.sp, letterSpacing = 2.sp,
                modifier = Modifier.padding(top = 8.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** 花边新闻列表页（消息页入口） */
@Composable
fun NewsListScreen(onOpenNews: (String) -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        NavBar("花边新闻", onBack)
        NewsSection(onOpenNews = onOpenNews)
    }
}

/** 花边新闻列表（按性别分流，后端每小时采集更新），支持下拉刷新与翻页 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun NewsSection(onOpenNews: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<NewsItem>?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    // 有原文链接直接内部网页打开（与 AI 网页预览共用组件），AI 兜底文（无链接）才走解析详情页
    var preview by remember { mutableStateOf<NewsItem?>(null) }

    suspend fun loadFirst() {
        val rows = runCatching { Api.getList<NewsItem>("/news") }.getOrDefault(emptyList())
        hasMore = rows.size >= 20
        list = rows
    }
    suspend fun loadMore() {
        val last = list?.lastOrNull()?.id ?: return
        val rows = runCatching { Api.getList<NewsItem>("/news?beforeId=$last") }.getOrDefault(emptyList())
        hasMore = rows.size >= 20
        list = (list ?: emptyList()) + rows
    }
    LaunchedEffect(Unit) { loadFirst() }

    preview?.let { p ->
        com.wh.peiwana.ui.WebPreviewDialog(url = p.sourceUrl, title = p.title, onClose = { preview = null })
    }
    val items = list ?: return
    androidx.compose.material3.pulltorefresh.PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { scope.launch { refreshing = true; loadFirst(); refreshing = false } },
        modifier = Modifier.fillMaxSize(),
    ) {
    LazyColumn(Modifier.fillMaxSize()) {
        if (items.isEmpty()) {
            item(key = "empty") { EmptyHint("暂无内容，稍后再来看看") }
        }
        items(items, key = { it.id }) { n ->
            Column(
                Modifier.fillMaxWidth()
                    .noRippleClick { if (n.sourceUrl.isNotEmpty()) preview = n else onOpenNews(n.id) }
                    .padding(16.dp, 14.dp, 16.dp, 0.dp),
            ) {
                Text(n.title, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp)
                if (n.summary.isNotEmpty()) {
                    Text(
                        n.summary, color = TextSub, fontSize = 13.sp, lineHeight = 21.sp,
                        maxLines = 2, modifier = Modifier.padding(top = 5.dp),
                    )
                }
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (n.tag.isNotEmpty()) {
                        Text(
                            n.tag, color = Accent, fontSize = 10.sp,
                            modifier = Modifier.clip(RoundedCornerShape(4.dp))
                                .border(1.dp, Accent.copy(alpha = 0.45f), RoundedCornerShape(4.dp))
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        )
                    }
                    if (n.source.isNotEmpty()) Text(n.source, color = TextDim, fontSize = 11.sp)
                    Text(timeAgo(n.createdAt), color = TextDim, fontSize = 11.sp)
                }
                Box(Modifier.fillMaxWidth().padding(top = 14.dp).height(1.dp).background(Line))
            }
        }
        if (hasMore) {
            item(key = "more") {
                LaunchedEffect(Unit) { loadMore() }
                Text(
                    "加载中…", color = TextDim, fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().padding(14.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
    }
}

/** 热点文章详情 */
@Composable
fun NewsDetailScreen(newsId: String, onBack: () -> Unit) {
    var article by remember { mutableStateOf<NewsArticle?>(null) }
    LaunchedEffect(newsId) {
        article = runCatching { Api.getObj<NewsArticle>("/news/$newsId") }.getOrNull()
    }
    Column(Modifier.fillMaxSize()) {
        NavBar("热点", onBack)
        val a = article
        if (a == null) {
            EmptyHint("加载中…")
        } else {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp, 10.dp, 16.dp, 40.dp)) {
                Text(a.title, color = TextMain, fontSize = 21.sp, fontWeight = FontWeight.Bold, lineHeight = 30.sp)
                Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (a.tag.isNotEmpty()) {
                        Text(
                            a.tag, color = Accent, fontSize = 10.sp,
                            modifier = Modifier.clip(RoundedCornerShape(4.dp))
                                .border(1.dp, Accent.copy(alpha = 0.45f), RoundedCornerShape(4.dp))
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        )
                    }
                    if (a.source.isNotEmpty()) Text(a.source, color = TextDim, fontSize = 11.sp)
                    Text(timeAgo(a.createdAt), color = TextDim, fontSize = 11.sp)
                }
                a.content.split(Regex("\\n+")).filter { it.isNotBlank() }.forEach { p ->
                    Text(
                        p.trim(), color = TextMain, fontSize = 15.5.sp, lineHeight = 28.sp,
                        modifier = Modifier.padding(top = 14.dp),
                    )
                }
                if (a.sourceUrl.isNotEmpty()) {
                    val ctx = androidx.compose.ui.platform.LocalContext.current
                    Text(
                        "查看原文 ›", color = Accent, fontSize = 13.sp,
                        modifier = Modifier.padding(top = 10.dp).noRippleClick {
                            runCatching {
                                ctx.startActivity(
                                    android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(a.sourceUrl)),
                                )
                            }
                        },
                    )
                }
            }
        }
    }
}
