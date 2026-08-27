package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.ProjectItem
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch

private val COVERS = listOf(
    Brush.horizontalGradient(listOf(Color(0xFF3D0F1F), Color(0xFFB32B53))),
    Brush.horizontalGradient(listOf(Color(0xFF101A2E), Color(0xFF2B5CB0))),
    Brush.horizontalGradient(listOf(Color(0xFF241436), Color(0xFF7A3FD1))),
)

@Composable
fun HallScreen(modifier: Modifier = Modifier, onOpenProject: (String) -> Unit) {
    var projects by remember { mutableStateOf<List<ProjectItem>>(emptyList()) }
    LaunchedEffect(Unit) { projects = runCatching { Api.getList<ProjectItem>("/modules") }.getOrDefault(emptyList()) }

    Column(modifier = modifier.fillMaxSize()) {
        PageTitle("大厅")
        LazyColumn(contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            items(projects, key = { it.id }) { p ->
                val idx = projects.indexOf(p)
                Box(
                    modifier = Modifier.fillMaxWidth().height(132.dp).clip(RoundedCornerShape(16.dp))
                        .background(COVERS[idx % COVERS.size]).clickable { onOpenProject(p.entry) },
                ) {
                    Column(modifier = Modifier.align(Alignment.BottomStart).padding(18.dp)) {
                        Text(p.name, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Text(p.desc, color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, modifier = Modifier.padding(top = 5.dp))
                    }
                    Box(
                        modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).clip(RoundedCornerShape(16.dp))
                            .background(Color.White.copy(alpha = 0.92f)).padding(horizontal = 20.dp, vertical = 7.dp),
                    ) { Text("进入", color = Color(0xFF111111), fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
}

/** 地陪项目主页 */
@Composable
fun GuideProjectScreen(myGender: Int, onBack: () -> Unit, onNav: (String) -> Unit, onOpenChat: (String, String) -> Unit) {
    val isFemale = myGender == 2
    var guides by remember { mutableStateOf<List<com.wh.peiwana.net.Person>>(emptyList()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { guides = runCatching { Api.getList<com.wh.peiwana.net.Person>("/guide/list") }.getOrDefault(emptyList()).take(6) }

    val entries = listOf(
        Triple("找搭子", "按城市寻找认证搭子", "people/guide"),
        Triple("找人", "发现新朋友打招呼", "people/all"),
        if (isFemale) Triple("接单大厅", "报名接单赚积分", "task/hall") else Triple("发布约单", "时间地点报酬托管", "task/post"),
        Triple(if (isFemale) "我的接单" else "我的约单", "查看进行中的约单", "task/mine"),
    )

    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("同城搭子", onBack)
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                entries.take(2).forEach { EntryCard(it, Modifier.weight(1f)) { onNav(it.third) } }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                entries.drop(2).forEach { EntryCard(it, Modifier.weight(1f)) { onNav(it.third) } }
            }
            Text("推荐搭子", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 16.dp))
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(guides, key = { it.id }) { p ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.avatar, 48)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("${p.nickname} · ${p.age}", color = TextMain, fontSize = 15.sp)
                        Text(if (p.signature.isNotEmpty()) p.signature else "这个人很神秘", color = TextSub, fontSize = 12.sp, maxLines = 1)
                    }
                    Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable { onOpenChat(p.id, p.nickname) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                        Text("打招呼", color = Color.White, fontSize = 13.sp)
                    }
                }
            }
            if (guides.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(40.dp), Alignment.Center) { Text("暂无认证搭子", color = TextSub) } }
        }
    }
}

@Composable
private fun EntryCard(e: Triple<String, String, String>, modifier: Modifier, onClick: () -> Unit) {
    Column(modifier = modifier.clip(RoundedCornerShape(14.dp)).background(Bg2).clickable(onClick = onClick).padding(16.dp)) {
        Text(e.first, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Text(e.second, color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 5.dp))
    }
}

/** 找人 / 找搭子 */
@Composable
fun PeopleScreen(mode: String, onBack: () -> Unit, onOpenChat: (String, String) -> Unit) {
    var tab by remember { mutableStateOf(if (mode == "guide") "guide" else "all") }
    var items by remember { mutableStateOf<List<com.wh.peiwana.net.Person>>(emptyList()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(tab) {
        items = runCatching { Api.getList<com.wh.peiwana.net.Person>(if (tab == "guide") "/guide/list" else "/guide/discover") }.getOrDefault(emptyList())
    }
    Column(modifier = Modifier.fillMaxSize()) {
        NavBar(if (tab == "guide") "找搭子" else "找人", onBack)
        Row(modifier = Modifier.padding(16.dp, 0.dp, 16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            listOf("guide" to "认证", "all" to "全部").forEach { (k, label) ->
                Text(label, color = if (tab == k) TextMain else TextSub, fontSize = if (tab == k) 17.sp else 16.sp, fontWeight = if (tab == k) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.noRippleClick { tab = k })
            }
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(items, key = { it.id }) { p ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.avatar, 56)
                    Column(modifier = Modifier.weight(1f).padding(start = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${p.nickname} · ${p.age}", color = TextMain, fontSize = 15.sp)
                            if (p.isGuide) Text(" 认证", color = Accent, fontSize = 11.sp)
                        }
                        Text(if (p.signature.isNotEmpty()) p.signature else "这个人很神秘", color = TextSub, fontSize = 12.sp, maxLines = 1)
                        if (p.cityName.isNotEmpty()) Text(p.cityName, color = TextDim, fontSize = 11.sp)
                    }
                    Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable { onOpenChat(p.id, p.nickname) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                        Text("打招呼", color = Color.White, fontSize = 13.sp)
                    }
                }
            }
            if (items.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(40.dp), Alignment.Center) { Text("暂无用户", color = TextSub) } }
        }
    }
}
