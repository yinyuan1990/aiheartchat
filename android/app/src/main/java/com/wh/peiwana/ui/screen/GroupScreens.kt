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
import androidx.compose.ui.graphics.asImageBitmap
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
    var avatar by remember { mutableStateOf("") }
    var uploading by remember { mutableStateOf(false) }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { people = runCatching { Api.getList<Person>("/guide/discover") }.getOrDefault(emptyList()) }

    val pickAvatar = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri != null) scope.launch {
            uploading = true
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                avatar = Api.upload("image", b, "g.jpg", "image/jpeg")
            }
            uploading = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("创建群聊", onBack)
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // 群头像（可选，不设置默认用群主头像）
                Box(Modifier.size(56.dp).clip(CircleShape).background(Bg3).noRippleClick { pickAvatar.launch("image/*") }, contentAlignment = Alignment.Center) {
                    if (avatar.isNotEmpty()) Avatar(avatar, 56)
                    else Text(if (uploading) "…" else "头像", color = TextDim, fontSize = 11.sp)
                }
                OutlinedTextField(name, { name = it }, placeholder = { Text("群名称") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            Text("群头像可选，不设置默认显示群主头像 · 邀请成员（可选）", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
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
                            put("avatar", JsonPrimitive(avatar))
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
private data class GroupInfo(val id: String, val name: String, val avatar: String = "", val notice: String = "", val members: List<GroupMemberItem> = emptyList())

@Serializable
data class GroupShareInfo(val code: String = "", val hasPassword: Boolean = false, val password: String? = null, val canEdit: Boolean = false, val name: String = "")

@Composable
fun GroupInfoScreen(groupId: String, myUserId: String, onBack: () -> Unit, onExit: () -> Unit) {
    var info by remember { mutableStateOf<GroupInfo?>(null) }
    var showShare by remember { mutableStateOf(false) }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    fun load() { scope.launch { info = runCatching { Api.getObj<GroupInfo>("/im/group/$groupId") }.getOrNull() } }
    LaunchedEffect(groupId) { load() }

    // 群主/管理员点头像可换（选图 → 上传 → 更新群资料）
    val pickAvatar = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri != null) scope.launch {
            runCatching {
                val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                val url = Api.upload("image", b, "g.jpg", "image/jpeg")
                Api.request("/im/group/$groupId", "PUT", buildJsonObject { put("avatar", JsonPrimitive(url)) })
                load()
            }.onFailure { android.widget.Toast.makeText(ctx, it.message ?: "修改失败", android.widget.Toast.LENGTH_SHORT).show() }
        }
    }

    val g = info ?: return
    val myRole = g.members.find { it.id == myUserId }?.role ?: "member"
    val canEdit = myRole == "owner" || myRole == "admin"

    if (showShare) {
        GroupShareDialog(groupId = groupId, onClose = { showShare = false })
    }

    Column(Modifier.fillMaxSize()) {
        NavBar(g.name, onBack, action = {
            Text("分享", color = Accent, fontSize = 14.sp, modifier = Modifier.clickable { showShare = true })
        })
        // 群头像 + 人数
        Row(Modifier.padding(16.dp, 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.noRippleClick { if (canEdit) pickAvatar.launch("image/*") }) { Avatar(g.avatar, 56) }
            Column {
                Text("共 ${g.members.size} 人", color = TextSub, fontSize = 13.sp)
                if (canEdit) Text("点头像可修改", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 3.dp))
            }
        }
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

/** 群分享弹窗：二维码 + 邀请码 + 密码设置（群主/管理员） */
@Composable
private fun GroupShareDialog(groupId: String, onClose: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var share by remember { mutableStateOf<GroupShareInfo?>(null) }
    var mode by remember { mutableStateOf("none") } // none=无密码 pwd=有密码
    var pwd by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }

    LaunchedEffect(groupId) {
        val s = runCatching { Api.getObj<GroupShareInfo>("/im/group/$groupId/share") }.getOrNull()
        share = s
        if (s != null) { mode = if (s.hasPassword) "pwd" else "none"; pwd = s.password ?: "" }
    }

    androidx.compose.ui.window.Dialog(onDismissRequest = onClose) {
        Column(
            Modifier.clip(RoundedCornerShape(16.dp)).background(Bg2).padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val s = share
            if (s == null) {
                Text("加载中…", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(30.dp))
            } else {
                Text("群邀请", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    if (s.hasPassword) "扫码或输码后需输入密码才能加入" else "扫码或输入邀请码即可加入",
                    color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp),
                )
                // 二维码（白底）
                val qr = remember(s.code) { makeQrBitmap(groupQrContent(s.code)) }
                androidx.compose.foundation.Image(
                    bitmap = qr.asImageBitmap(), contentDescription = null,
                    modifier = Modifier.padding(top = 14.dp).size(200.dp).clip(RoundedCornerShape(10.dp)),
                )
                // 邀请码 + 复制
                Row(
                    Modifier.padding(top = 12.dp).clip(RoundedCornerShape(8.dp)).background(Bg3)
                        .clickable {
                            clipboard.setText(androidx.compose.ui.text.AnnotatedString(s.code))
                            android.widget.Toast.makeText(ctx, "邀请码已复制", android.widget.Toast.LENGTH_SHORT).show()
                        }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(s.code, color = TextMain, fontSize = 18.sp, fontWeight = FontWeight.Bold, letterSpacing = androidx.compose.ui.unit.TextUnit(3f, androidx.compose.ui.unit.TextUnitType.Sp))
                    Text("  复制", color = Accent, fontSize = 12.sp)
                }

                // 密码设置（仅群主/管理员）：模式切换 + 行内小保存按钮，不再用整行大按钮
                if (s.canEdit) {
                    fun save() {
                        if (saving) return
                        if (mode == "pwd" && pwd.isBlank()) {
                            android.widget.Toast.makeText(ctx, "请输入密码", android.widget.Toast.LENGTH_SHORT).show()
                            return
                        }
                        saving = true
                        scope.launch {
                            runCatching {
                                val data = Api.request("/im/group/$groupId/share", "POST", buildJsonObject {
                                    put("password", JsonPrimitive(if (mode == "pwd") pwd.trim() else ""))
                                })!!
                                share = Api.json.decodeFromJsonElement(GroupShareInfo.serializer(), data)
                                android.widget.Toast.makeText(ctx, "已保存", android.widget.Toast.LENGTH_SHORT).show()
                            }.onFailure {
                                android.widget.Toast.makeText(ctx, it.message ?: "保存失败", android.widget.Toast.LENGTH_SHORT).show()
                            }
                            saving = false
                        }
                    }
                    Row(
                        Modifier.padding(top = 16.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf("none" to "无密码", "pwd" to "有密码").forEach { (k, label) ->
                            Text(
                                label,
                                color = if (mode == k) Color.White else TextSub, fontSize = 12.sp,
                                modifier = Modifier.clip(RoundedCornerShape(13.dp))
                                    .background(if (mode == k) Accent else Bg3)
                                    .noRippleClick { mode = k }
                                    .padding(horizontal = 14.dp, vertical = 5.dp),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        Text(
                            if (saving) "保存中…" else "保存",
                            color = Color.White, fontSize = 12.sp,
                            modifier = Modifier.clip(RoundedCornerShape(13.dp)).background(Accent)
                                .noRippleClick { save() }
                                .padding(horizontal = 16.dp, vertical = 5.dp),
                        )
                    }
                    if (mode == "pwd") {
                        androidx.compose.foundation.text.BasicTextField(
                            value = pwd,
                            onValueChange = { if (it.length <= 20) pwd = it },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 14.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            singleLine = true,
                            modifier = Modifier.padding(top = 10.dp).fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp)).background(Bg3)
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            decorationBox = { inner ->
                                Box {
                                    if (pwd.isEmpty()) Text("设置入群密码", color = TextDim, fontSize = 14.sp)
                                    inner()
                                }
                            },
                        )
                    }
                }

                androidx.compose.material3.HorizontalDivider(Modifier.padding(top = 16.dp), color = Bg3)
                // 保存相册 / 系统分享 / 关闭
                Row(Modifier.padding(top = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    Text("保存相册", color = TextSub, fontSize = 13.sp, modifier = Modifier.noRippleClick {
                        val ok = saveQrToGallery(ctx, qr)
                        android.widget.Toast.makeText(ctx, if (ok) "已保存到相册" else "保存失败", android.widget.Toast.LENGTH_SHORT).show()
                    })
                    Text("分享图片", color = Accent, fontSize = 13.sp, modifier = Modifier.noRippleClick { shareQr(ctx, qr) })
                    Text("关闭", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick(onClose))
                }
            }
        }
    }
}

@Serializable
private data class GroupCodeInfo(
    val groupId: String = "",
    val name: String = "",
    val memberCount: Int = 0,
    val hasPassword: Boolean = false,
    val isMember: Boolean = false,
    val conversationId: String? = null,
)

@Serializable
private data class GroupListItem(
    val id: String = "",
    val name: String = "",
    val avatar: String = "",
    val memberCount: Int = 0,
    val hasPassword: Boolean = false,
    val isMember: Boolean = false,
    val conversationId: String? = null,
)

/** 加入群聊：群列表可直接加入，也可输邀请码/扫码；有密码的群需输入密码 */
@Composable
fun JoinGroupScreen(onBack: () -> Unit, onJoined: (convId: String, groupId: String, name: String) -> Unit, initialCode: String? = null) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var code by remember { mutableStateOf(initialCode ?: "") }
    var info by remember { mutableStateOf<GroupCodeInfo?>(null) }
    var pwd by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var groups by remember { mutableStateOf<List<GroupListItem>>(emptyList()) }
    var pwdTarget by remember { mutableStateOf<GroupListItem?>(null) } // 点了带密码的群，弹密码输入
    var pwdInput by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    fun toast(msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()

    fun check(c: String) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching { Api.getObj<GroupCodeInfo>("/im/group/code/$c") }
                .onSuccess { info = it; pwd = "" }
                .onFailure { toast(it.message ?: "邀请码无效") }
            busy = false
        }
    }

    /** 按群 id 加入（群列表入口），密码可空 */
    fun joinById(g: GroupListItem, password: String) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching {
                val data = Api.request("/im/group/${g.id}/join", "POST", buildJsonObject {
                    put("password", JsonPrimitive(password.trim()))
                })!!
                val obj = data.jsonObject
                val convId = obj["conversationId"]?.jsonPrimitive?.content ?: ""
                onJoined(convId, g.id, obj["name"]?.jsonPrimitive?.content ?: g.name)
            }.onFailure { toast(it.message ?: "加入失败") }
            busy = false
        }
    }

    LaunchedEffect(Unit) {
        if (!initialCode.isNullOrBlank()) check(initialCode)
        groups = runCatching { Api.getList<GroupListItem>("/im/group/list") }.getOrDefault(emptyList())
    }

    // 带密码的群：弹窗输入密码
    pwdTarget?.let { g ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { pwdTarget = null }) {
            Column(
                Modifier.clip(RoundedCornerShape(16.dp)).background(Bg2).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(g.name, color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("该群需要密码", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                OutlinedTextField(
                    pwdInput, { if (it.length <= 20) pwdInput = it },
                    placeholder = { Text("输入入群密码", fontSize = 13.sp) },
                    singleLine = true,
                    modifier = Modifier.padding(top = 12.dp).fillMaxWidth(),
                )
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    Text("取消", color = TextDim, fontSize = 14.sp, modifier = Modifier.noRippleClick { pwdTarget = null })
                    Text("加入", color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick {
                        if (pwdInput.isBlank()) { toast("请输入密码"); return@noRippleClick }
                        val t = g; pwdTarget = null
                        joinById(t, pwdInput)
                    })
                }
            }
        }
    }

    val scanLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        com.journeyapps.barcodescanner.ScanContract(),
    ) { result ->
        result.contents?.let { text ->
            parseGroupCode(text)?.let { code = it; check(it) } ?: toast("无法识别的群二维码")
        }
    }

    Column(Modifier.fillMaxSize()) {
        NavBar("加入群聊", onBack)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    code, { code = it.uppercase().take(12); info = null },
                    placeholder = { Text("输入群邀请码", fontSize = 14.sp) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Text("扫码", color = Accent, fontSize = 14.sp, modifier = Modifier.clickable {
                    scanLauncher.launch(
                        com.journeyapps.barcodescanner.ScanOptions()
                            .setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                            .setPrompt("对准群邀请二维码")
                            .setBeepEnabled(false)
                            .setOrientationLocked(true)
                            .setCaptureActivity(PortraitCaptureActivity::class.java),
                    )
                })
            }
            val g = info
            if (g == null) {
                if (code.isNotBlank()) {
                    AccentButton(if (busy) "查询中…" else "查找群聊") {
                        if (code.length < 6) { toast("请输入完整邀请码"); return@AccentButton }
                        check(code)
                    }
                }
            } else {
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(g.name, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text("共 ${g.memberCount} 人${if (g.hasPassword) " · 需要密码" else ""}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    if (g.isMember) {
                        Text("你已在群里", color = Success, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                    } else if (g.hasPassword) {
                        OutlinedTextField(
                            pwd, { if (it.length <= 20) pwd = it },
                            placeholder = { Text("输入入群密码", fontSize = 13.sp) },
                            singleLine = true,
                            modifier = Modifier.padding(top = 10.dp).fillMaxWidth(),
                        )
                    }
                }
                AccentButton(
                    when {
                        g.isMember -> "进入群聊"
                        busy -> "加入中…"
                        else -> "加入群聊"
                    },
                ) {
                    if (busy) return@AccentButton
                    if (g.isMember && g.conversationId != null) {
                        onJoined(g.conversationId, g.groupId, g.name)
                        return@AccentButton
                    }
                    if (g.hasPassword && pwd.isBlank()) { toast("请输入入群密码"); return@AccentButton }
                    busy = true
                    scope.launch {
                        runCatching {
                            val data = Api.request("/im/group/join-by-code", "POST", buildJsonObject {
                                put("code", JsonPrimitive(g.let { code.trim().uppercase() }))
                                put("password", JsonPrimitive(pwd.trim()))
                            })!!
                            val obj = data.jsonObject
                            val convId = obj["conversationId"]?.jsonPrimitive?.content ?: ""
                            val gid = obj["id"]?.jsonPrimitive?.content ?: g.groupId
                            val name = obj["name"]?.jsonPrimitive?.content ?: g.name
                            onJoined(convId, gid, name)
                        }.onFailure { toast(it.message ?: "加入失败") }
                        busy = false
                    }
                }
            }
        }

        // 群列表：直接浏览加入
        Text("群列表", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 4.dp))
        if (groups.isEmpty()) {
            Text("暂无群聊", color = TextDim, fontSize = 13.sp, modifier = Modifier.padding(16.dp, 12.dp))
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 16.dp)) {
            items(groups, key = { it.id }) { g ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(g.avatar, 44)
                    Column(Modifier.weight(1f)) {
                        Text(g.name, color = TextMain, fontSize = 15.sp, maxLines = 1)
                        Text(
                            "共 ${g.memberCount} 人${if (g.hasPassword) " · 需要密码" else ""}",
                            color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    Text(
                        if (g.isMember) "进入" else "加入",
                        color = if (g.isMember) TextSub else Color.White, fontSize = 12.sp,
                        modifier = Modifier.clip(RoundedCornerShape(14.dp))
                            .background(if (g.isMember) Bg3 else Accent)
                            .noRippleClick {
                                when {
                                    g.isMember && g.conversationId != null -> onJoined(g.conversationId, g.id, g.name)
                                    g.hasPassword -> { pwdInput = ""; pwdTarget = g }
                                    else -> joinById(g, "")
                                }
                            }
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
                androidx.compose.material3.HorizontalDivider(color = Bg3.copy(alpha = 0.5f))
            }
        }
    }
}
