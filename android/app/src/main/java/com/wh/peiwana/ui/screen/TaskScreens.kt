package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private val statusText = mapOf(0 to ("待接单" to Warn), 1 to ("进行中" to Success), 2 to ("已完成" to TextSub), 3 to ("已取消" to TextDim), 4 to ("仲裁中" to Accent))

@Composable
private fun StatusTag(status: Int) {
    val (t, c) = statusText[status] ?: ("未知" to TextSub)
    Text(t, color = c, fontSize = 11.sp, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Bg3).padding(horizontal = 8.dp, vertical = 2.dp))
}

@Composable
private fun TaskCard(t: TaskOrder, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clip(RoundedCornerShape(12.dp)).background(Bg2).clickable(onClick = onClick).padding(14.dp)) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Text(t.title, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold); Spacer(Modifier.width(8.dp)); StatusTag(t.status) }
            Text("${t.cityName} · ${t.address}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
            Text("${t.applyCount} 人已报名", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        }
        Text(fmtPoints(t.reward), color = Accent, fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun TaskHallScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    var items by remember { mutableStateOf<List<TaskOrder>>(emptyList()) }
    LaunchedEffect(Unit) { items = runCatching { Api.getList<TaskOrder>("/tasks/hall") }.getOrDefault(emptyList()) }
    Column(Modifier.fillMaxSize()) {
        NavBar("接单大厅", onBack)
        if (items.isEmpty()) EmptyHint("暂无可接约单") else LazyColumn { items(items, key = { it.id }) { TaskCard(it) { onOpen(it.id) } } }
    }
}

@Composable
fun TaskMineScreen(myGender: Int, onBack: () -> Unit, onOpen: (String) -> Unit) {
    var items by remember { mutableStateOf<List<TaskOrder>>(emptyList()) }
    LaunchedEffect(Unit) { items = runCatching { Api.getList<TaskOrder>(if (myGender == 2) "/tasks/taken" else "/tasks/mine") }.getOrDefault(emptyList()) }
    Column(Modifier.fillMaxSize()) {
        NavBar(if (myGender == 2) "我的接单" else "我的约单", onBack)
        if (items.isEmpty()) EmptyHint("暂无记录") else LazyColumn { items(items, key = { it.id }) { TaskCard(it) { onOpen(it.id) } } }
    }
}

@Composable
fun TaskPostScreen(onBack: () -> Unit, onDone: () -> Unit) {
    var title by remember { mutableStateOf("") }
    var meetAt by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var reward by remember { mutableStateOf("") }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        NavBar("发布约单", onBack)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, placeholder = { Text("做什么，如 周末陪逛展") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(meetAt, { meetAt = it }, placeholder = { Text("时间 2026-08-20 14:00") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(city, { city = it }, placeholder = { Text("城市") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(address, { address = it }, placeholder = { Text("地点") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(reward, { reward = it.filter { c -> c.isDigit() || c == '.' } }, placeholder = { Text("报酬（积分）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(6.dp))
            AccentButton("托管发布") {
                if (title.isEmpty() || meetAt.isEmpty() || city.isEmpty() || address.isEmpty() || reward.isEmpty()) { toast = "请填写完整"; return@AccentButton }
                scope.launch {
                    val iso = try { java.time.LocalDateTime.parse(meetAt.replace(" ", "T")).atZone(java.time.ZoneId.systemDefault()).toInstant().toString() } catch (_: Exception) { "" }
                    if (iso.isEmpty()) { toast = "时间格式：2026-08-20 14:00"; return@launch }
                    val fen = ((reward.toDoubleOrNull() ?: 0.0) * 100).toInt()
                    val body = buildJsonObject {
                        put("title", JsonPrimitive(title)); put("meetAt", JsonPrimitive(iso))
                        put("cityCode", JsonPrimitive(city)); put("cityName", JsonPrimitive(city))
                        put("address", JsonPrimitive(address)); put("reward", JsonPrimitive(fen.toString()))
                    }
                    runCatching { Api.request("/tasks", "POST", body) }.onSuccess { onDone() }.onFailure { toast = it.message ?: "失败" }
                }
            }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp)
            Text("报酬冻结托管，完成后打给对方；发布后自动推送给同城用户", color = TextSub, fontSize = 12.sp)
        }
    }
}

@Composable
fun TaskDetailScreen(id: String, myGender: Int, onBack: () -> Unit) {
    var d by remember { mutableStateOf<TaskDetail?>(null) }
    var msg by remember { mutableStateOf("") }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun load() { scope.launch { d = runCatching { Api.getObj<TaskDetail>("/tasks/$id") }.getOrNull() } }
    LaunchedEffect(id) { load() }
    val detail = d ?: return

    fun act(path: String) { scope.launch { runCatching { Api.request(path, "POST") }.onSuccess { load() }.onFailure { toast = it.message ?: "失败" } } }

    Column(Modifier.fillMaxSize()) {
        NavBar("约单详情", onBack)
        Column(Modifier.padding(16.dp)) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) { Text(detail.title, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold); Spacer(Modifier.width(8.dp)); StatusTag(detail.status) }
                Text("时间：${detail.meetAt.replace("T", " ").take(16)}", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
                Text("地点：${detail.cityName} · ${detail.address}", color = TextSub, fontSize = 13.sp)
                Text("报酬：${fmtPoints(detail.reward)} 积分（已托管）", color = Accent, fontSize = 13.sp)
            }
            Spacer(Modifier.height(12.dp))
            if (myGender == 2 && detail.status == 0) {
                OutlinedTextField(msg, { msg = it }, placeholder = { Text("报名留言（可选）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                AccentButton("报名接单") {
                    scope.launch { runCatching { Api.request("/tasks/$id/apply", "POST", buildJsonObject { put("message", JsonPrimitive(msg)) }) }.onSuccess { toast = "报名成功" }.onFailure { toast = it.message ?: "失败" } }
                }
            }
            if (detail.isOwner && detail.status == 0) {
                Text("报名列表（${detail.applies.size}）", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(vertical = 8.dp))
                detail.applies.forEach { a ->
                    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(a.user?.avatar, 42)
                        Column(modifier = Modifier.weight(1f).padding(start = 10.dp)) {
                            Text(a.user?.nickname ?: "", color = TextMain, fontSize = 14.sp)
                            if (a.message.isNotEmpty()) Text(a.message, color = TextSub, fontSize = 12.sp)
                        }
                        if (a.status == 0) Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable { act("/tasks/$id/choose/${a.id}") }.padding(horizontal = 14.dp, vertical = 6.dp)) { Text("选TA", color = Color.White, fontSize = 13.sp) }
                        else if (a.status == 1) Text("已选中", color = Success, fontSize = 12.sp)
                    }
                }
                Spacer(Modifier.height(10.dp)); AccentButton("取消约单") { act("/tasks/$id/cancel") }
            }
            if (detail.isOwner && detail.status == 1) { Spacer(Modifier.height(10.dp)); AccentButton("确认完成并结算") { act("/tasks/$id/finish") } }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
        }
    }
}
