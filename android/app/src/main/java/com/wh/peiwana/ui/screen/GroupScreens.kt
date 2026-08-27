package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
private data class GroupCreated(val id: String, val name: String, val conversationId: String)

@Composable
fun CreateGroupScreen(onBack: () -> Unit, onCreated: (convId: String, groupId: String, name: String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { people = runCatching { Api.getList<Person>("/guide/discover") }.getOrDefault(emptyList()) }

    Column(Modifier.fillMaxSize()) {
        NavBar("创建群聊", onBack)
        Column(Modifier.padding(16.dp)) {
            OutlinedTextField(name, { name = it }, placeholder = { Text("群名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("邀请成员（可选）", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
        }
        LazyColumn(modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(people, key = { it.id }) { p ->
                Row(modifier = Modifier.fillMaxWidth().clickable { selected = if (selected.contains(p.id)) selected - p.id else selected + p.id }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(p.avatar, 36)
                    Text("  ${p.nickname}", color = TextMain, modifier = Modifier.weight(1f))
                    Text(if (selected.contains(p.id)) "已选" else "选择", color = if (selected.contains(p.id)) Accent else TextDim, fontSize = 13.sp)
                }
            }
        }
        Box(Modifier.padding(16.dp)) {
            AccentButton("创建（${selected.size} 人）") {
                if (name.isBlank()) return@AccentButton
                scope.launch {
                    runCatching {
                        val data = Api.request("/im/group", "POST", buildJsonObject {
                            put("name", JsonPrimitive(name.trim()))
                            put("memberIds", JsonArray(selected.map { JsonPrimitive(it) }))
                        })!!
                        val g = Api.json.decodeFromJsonElement(GroupCreated.serializer(), data)
                        onCreated(g.conversationId, g.id, g.name)
                    }
                }
            }
        }
    }
}

@Serializable
private data class GroupMemberItem(val id: String, val nickname: String = "", val avatar: String = "", val role: String = "member")

@Serializable
private data class GroupInfo(val id: String, val name: String, val notice: String = "", val members: List<GroupMemberItem> = emptyList())

@Composable
fun GroupInfoScreen(groupId: String, myUserId: String, onBack: () -> Unit, onExit: () -> Unit) {
    var info by remember { mutableStateOf<GroupInfo?>(null) }
    val scope = rememberCoroutineScope()
    fun load() { scope.launch { info = runCatching { Api.getObj<GroupInfo>("/im/group/$groupId") }.getOrNull() } }
    LaunchedEffect(groupId) { load() }
    val g = info ?: return
    val myRole = g.members.find { it.id == myUserId }?.role ?: "member"

    Column(Modifier.fillMaxSize()) {
        NavBar(g.name, onBack)
        Text("共 ${g.members.size} 人", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 0.dp))
        LazyVerticalGrid(columns = GridCells.Fixed(5), contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.weight(1f)) {
            items(g.members, key = { it.id }) { m ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Avatar(m.avatar, 48)
                    Text(m.nickname + (if (m.role == "owner") " 主" else ""), color = TextSub, fontSize = 11.sp, maxLines = 1)
                }
            }
        }
        Box(Modifier.padding(16.dp)) {
            AccentButton(if (myRole == "owner") "解散群聊" else "退出群聊") {
                scope.launch { runCatching { Api.request("/im/group/$groupId/${if (myRole == "owner") "dissolve" else "leave"}", "POST") }.onSuccess { onExit() } }
            }
        }
    }
}
