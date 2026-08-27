package com.wh.peiwana.ui.screen

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

@Composable
fun MomentDetailScreen(id: String, onBack: () -> Unit, onOpenChat: (String, String) -> Unit) {
    var m by remember { mutableStateOf<Moment?>(null) }
    var comments by remember { mutableStateOf<List<CommentItem>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun loadC() { scope.launch { comments = runCatching { Api.getList<CommentItem>("/moments/$id/comments") }.getOrDefault(emptyList()) } }
    LaunchedEffect(id) {
        m = runCatching { Api.getObj<Moment>("/moments/$id") }.getOrNull()
        loadC()
    }
    val moment = m ?: return
    var fullImage by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { BackIcon(TextMain, 24.dp) }
            Avatar(moment.user?.avatar, 34)
            Text("  ${moment.user?.nickname ?: ""}", color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
            // 自己的动态不显示私聊按钮
            if (moment.user?.id != com.wh.peiwana.net.Session.uid) {
                Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Bg3).clickable { moment.user?.let { onOpenChat(it.id, it.nickname) } }.padding(horizontal = 14.dp, vertical = 6.dp)) { Text("私聊", color = TextSub, fontSize = 13.sp) }
            }
        }
        LazyColumn(modifier = Modifier.weight(1f).padding(horizontal = 16.dp)) {
            item {
                if (moment.content.isNotEmpty()) Text(moment.content, color = TextMain, fontSize = 15.sp, lineHeight = 24.sp)
                if (moment.type == 2 && moment.videoUrl.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    VideoPlayerBox(Api.fullUrl(moment.videoUrl))
                }
                if (moment.images.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    // 普通布局九宫格（嵌套 LazyVerticalGrid 拖慢滚动）
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        moment.images.chunked(3).forEach { rowImages ->
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                                rowImages.forEach { url ->
                                    AsyncImage(model = Api.fullUrl(url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.weight(1f).height(112.dp).clip(RoundedCornerShape(8.dp)).noRippleClick { fullImage = url })
                                }
                                repeat(3 - rowImages.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                }
                Text("全部评论（${comments.size}）", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 14.dp))
            }
            items(comments, key = { it.id }) { c ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
                    Avatar(c.user?.avatar, 34)
                    Column(modifier = Modifier.padding(start = 10.dp)) {
                        Text(c.user?.nickname + (if (c.replyToNickname.isNotEmpty()) " 回复 @${c.replyToNickname}" else ""), color = TextSub, fontSize = 12.sp)
                        if (c.content.isNotEmpty()) Text(c.content, color = TextMain, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
                        if (c.imageUrl.isNotEmpty()) AsyncImage(model = Api.fullUrl(c.imageUrl), contentDescription = null, modifier = Modifier.padding(top = 4.dp).width(120.dp).clip(RoundedCornerShape(8.dp)))
                    }
                }
            }
        }
        Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(input, { input = it }, placeholder = { Text("说点什么…") }, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Box(modifier = Modifier.clip(RoundedCornerShape(15.dp)).background(Accent).clickable {
                if (input.isBlank()) return@clickable
                scope.launch { runCatching { Api.request("/moments/$id/comments", "POST", buildJsonObject { put("content", JsonPrimitive(input.trim())) }) }.onSuccess { input = ""; loadC() } }
            }.padding(horizontal = 16.dp, vertical = 10.dp)) { Text("发送", color = Color.White, fontSize = 13.sp) }
        }
        fullImage?.let { u ->
            androidx.compose.ui.window.Dialog(onDismissRequest = { fullImage = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
                ImageViewer(moment.images, moment.images.indexOf(u).coerceAtLeast(0)) { fullImage = null }
            }
        }
    }
}

@Composable
fun GiftsReceivedScreen(onBack: () -> Unit) {
    var items by remember { mutableStateOf<List<GiftDef>>(emptyList()) }
    LaunchedEffect(Unit) { items = runCatching { Api.getList<GiftDef>("/gifts/received") }.getOrDefault(emptyList()) }
    Column(Modifier.fillMaxSize()) {
        NavBar("礼物墙", onBack)
        LazyVerticalGrid(columns = GridCells.Fixed(3), contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(items, key = { it.id }) { g ->
                Column(modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Bg2).alpha(if (g.count > 0) 1f else 0.35f).padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    AsyncImage(model = Api.fullUrl(g.icon), contentDescription = null, modifier = Modifier.size(52.dp))
                    Text(g.name, color = TextMain, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                    Text("${fmtPoints(g.price)} 积分", color = TextSub, fontSize = 11.sp)
                    Text("× ${g.count}", color = if (g.count > 0) Accent else TextDim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
    }
}

@Composable
fun GuideApplyScreen(onBack: () -> Unit) {
    var realName by remember { mutableStateOf("") }
    var idCard by remember { mutableStateOf("") }
    var intro by remember { mutableStateOf("") }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize()) {
        NavBar("搭子认证", onBack)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("认证需提交真实姓名与身份证号，审核通过即同时完成实名认证", color = TextDim, fontSize = 12.sp)
            OutlinedTextField(realName, { realName = it }, placeholder = { Text("真实姓名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(idCard, { idCard = it }, placeholder = { Text("身份证号") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(intro, { intro = it }, placeholder = { Text("介绍自己的城市、兴趣爱好") }, modifier = Modifier.fillMaxWidth().height(100.dp))
            Spacer(Modifier.height(6.dp))
            AccentButton("提交认证") {
                if (realName.isEmpty() || idCard.isEmpty() || intro.isEmpty()) { toast = "请填写完整"; return@AccentButton }
                scope.launch { runCatching { Api.request("/guide/apply", "POST", buildJsonObject { put("realName", JsonPrimitive(realName)); put("idCardNo", JsonPrimitive(idCard)); put("intro", JsonPrimitive(intro)) }) }.onSuccess { toast = "已提交，等待审核"; onBack() }.onFailure { toast = it.message ?: "失败" } }
            }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp)
        }
    }
}

@Composable
fun EditProfileScreen(onBack: () -> Unit) {
    var u by remember { mutableStateOf<UserProfile?>(null) }
    var nickname by remember { mutableStateOf("") }
    var age by remember { mutableStateOf("18") }
    var city by remember { mutableStateOf("") }
    var signature by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf("") }
    var videoPrice by remember { mutableStateOf("") }
    // 平台手续费（分/分钟）= 流量成本 x 平台倍率，定价必须高于手续费
    var feeCut by remember { mutableIntStateOf(4) }
    var photos by remember { mutableStateOf<List<String>>(emptyList()) }
    var uploadingPhoto by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        u = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull()
        u?.let {
            nickname = it.nickname; age = it.age.toString(); city = it.cityName; signature = it.signature; avatar = it.avatar
            if (it.videoPriceFen > 0) videoPrice = fmtPoints(it.videoPriceFen.toString())
            photos = it.albums.filter { a -> a.type == 1 }.map { a -> a.url }
        }
        val cfg = runCatching { Api.getObj<CallConfigData>("/call/config") }.getOrNull()
        if (cfg != null) feeCut = cfg.videoBaseFenPerMin * cfg.videoPlatformX
        // 未设置时默认价 = 成本 x5
        if (videoPrice.isEmpty() && u?.gender == 2 && cfg != null) videoPrice = fmtPoints((cfg.videoBaseFenPerMin * 5).toString())
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { runCatching { val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }; avatar = Api.upload("image", b, "a.jpg", "image/jpeg") } }
    }
    // 照片墙多选：一次最多选剩余可加张数
    val pickWallPhotos = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val remain = 8 - photos.size
        if (uris.isNotEmpty() && remain > 0) {
            scope.launch {
                uploadingPhoto = true
                for (uri in uris.take(remain)) {
                    runCatching {
                        val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                        photos = photos + Api.upload("image", b, "w.jpg", "image/jpeg")
                    }
                }
                uploadingPhoto = false
            }
        }
    }
    var locating by remember { mutableStateOf(false) }
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { g ->
        if (g.values.any { it }) scope.launch {
            locating = true
            detectCity(ctx)?.let { city = it }
            locating = false
        }
    }
    val user = u ?: return
    var saving by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    // 年纪滚轮选择
    var showAgePicker by remember { mutableStateOf(false) }
    var pendingAge by remember { mutableIntStateOf(18) }

    Column(Modifier.fillMaxSize()) {
        NavBar("编辑资料", onBack) {
            Text(if (saving) "保存中" else "保存", color = Accent, fontSize = 14.sp, modifier = Modifier.noRippleClick {
                if (saving) return@noRippleClick
                if (nickname.isBlank()) { toast = "昵称不能为空"; return@noRippleClick }
                saving = true
                scope.launch {
                    val body = buildJsonObject {
                        put("nickname", JsonPrimitive(nickname.trim())); put("age", JsonPrimitive(age.toIntOrNull() ?: 18))
                        put("avatar", JsonPrimitive(avatar)); put("signature", JsonPrimitive(signature.trim()))
                        put("cityName", JsonPrimitive(city)); put("cityCode", JsonPrimitive(city))
                        if (user.gender == 2) put("videoPriceFen", JsonPrimitive(if (videoPrice.isEmpty()) 0 else ((videoPrice.toDoubleOrNull() ?: 0.0) * 100).toInt()))
                    }
                    runCatching {
                        Api.request("/user/me", "PUT", body)
                        // 照片墙整组保存
                        Api.request("/user/albums", "PUT", buildJsonObject {
                            put("photos", kotlinx.serialization.json.buildJsonArray { photos.forEach { add(JsonPrimitive(it)) } })
                        })
                    }
                        .onSuccess { toast = "保存成功"; onBack() }
                        .onFailure { toast = it.message ?: "保存失败"; saving = false }
                }
            })
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            if (toast.isNotEmpty()) {
                Text(toast, color = Danger, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
            }
            // ===== 头像 =====
            Column(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.noRippleClick { pickAvatar.launch("image/*") }) {
                    Avatar(avatar, 92)
                    Text(
                        "更换", color = Color.White, fontSize = 10.sp,
                        modifier = Modifier.align(Alignment.BottomCenter)
                            .clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f))
                            .padding(horizontal = 10.dp, vertical = 2.dp),
                    )
                }
                Text("点击更换头像", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp))
            }
            // ===== 基本信息 =====
            EditCard {
                EditRow("昵称") { EditField(nickname, { nickname = it.take(16) }, "填写昵称") }
                EditDivider()
                EditRow("年纪", onClick = { pendingAge = age.toIntOrNull() ?: 18; showAgePicker = true }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("$age 岁", color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
                        Text("›", color = TextDim, fontSize = 20.sp)
                    }
                }
                EditDivider()
                EditRow("城市") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        EditField(city, { city = it }, "填写或点右侧定位", Modifier.weight(1f))
                        Text(
                            if (locating) "定位中…" else "定位", color = Accent, fontSize = 13.sp,
                            modifier = Modifier.padding(start = 10.dp).noRippleClick {
                                locPerm.launch(arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION))
                            },
                        )
                    }
                }
            }
            // ===== 视频价格（仅女生） =====
            if (user.gender == 2) {
                EditCard {
                    EditRow("视频价格") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            EditField(videoPrice, { videoPrice = it.filter { c -> c.isDigit() || c == '.' } }, "0", Modifier.weight(1f), KeyboardType.Decimal)
                            Text("积分/分钟", color = TextDim, fontSize = 13.sp)
                        }
                    }
                    EditDivider()
                    // 手续费提示：价格须高于平台手续费，收入 = 价格 - 手续费
                    val priceFen = ((videoPrice.toDoubleOrNull() ?: 0.0) * 100).toInt()
                    val incomeFen = (priceFen - feeCut).coerceAtLeast(0)
                    Text(
                        "平台手续费 ${fmtPoints(feeCut.toString())} 积分/分钟，你的收入 ${fmtPoints(incomeFen.toString())} 积分/分钟（价格须高于手续费）",
                        color = if (priceFen > feeCut) TextDim else Danger, fontSize = 11.sp, lineHeight = 16.sp,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                    )
                }
            }
            // ===== 签名 =====
            EditCard {
                Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
                    Text("签名", color = TextSub, fontSize = 14.sp)
                    Box(Modifier.fillMaxWidth().padding(top = 10.dp)) {
                        if (signature.isEmpty()) Text("介绍一下自己…", color = TextDim, fontSize = 15.sp)
                        BasicTextField(
                            signature, { signature = it.take(80) },
                            textStyle = TextStyle(color = TextMain, fontSize = 15.sp, lineHeight = 22.sp),
                            cursorBrush = SolidColor(Accent),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                        )
                    }
                    Text("${signature.length}/80", color = TextDim, fontSize = 11.sp, modifier = Modifier.align(Alignment.End))
                }
            }
            // ===== 照片墙：最多 8 张，展示在他人主页 =====
            EditCard {
                Column(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("照片墙", color = TextSub, fontSize = 14.sp)
                        Spacer(Modifier.weight(1f))
                        Text("${photos.size}/8", color = if (photos.size >= 8) Accent else TextDim, fontSize = 12.sp)
                    }
                    Text(
                        if (photos.size >= 8) "已满 8 张，删除后可再添加 · 展示在你的个人主页"
                        else "还可选 ${8 - photos.size} 张（支持多选）· 展示在你的个人主页",
                        color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                    val cells = photos + if (photos.size < 8) listOf("+") else emptyList()
                    cells.chunked(4).forEach { rowItems ->
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            rowItems.forEach { cell ->
                                Box(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(Bg3)) {
                                    if (cell == "+") {
                                        Box(
                                            Modifier.fillMaxSize().noRippleClick { if (!uploadingPhoto) pickWallPhotos.launch("image/*") },
                                            contentAlignment = Alignment.Center,
                                        ) { Text(if (uploadingPhoto) "…" else "＋", color = TextDim, fontSize = 26.sp) }
                                    } else {
                                        coil.compose.AsyncImage(
                                            model = Api.fullUrl(cell), contentDescription = null,
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.fillMaxSize(),
                                        )
                                        // 右上角删除
                                        Text(
                                            "✕", color = Color.White, fontSize = 11.sp,
                                            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp)
                                                .clip(androidx.compose.foundation.shape.CircleShape)
                                                .background(Color.Black.copy(alpha = 0.55f))
                                                .noRippleClick { photos = photos - cell }
                                                .padding(horizontal = 6.dp, vertical = 3.dp),
                                        )
                                    }
                                }
                            }
                            // 补齐空位保持等宽
                            repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
            Spacer(Modifier.height(30.dp))
        }
    }
    // ===== 年纪滚轮选择（底部弹层） =====
    if (showAgePicker) {
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { showAgePicker = false },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxSize().noRippleClick { showAgePicker = false }, contentAlignment = Alignment.BottomCenter) {
                Column(
                    Modifier.fillMaxWidth().noRippleClick { }
                        .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)).background(Bg2)
                        .navigationBarsPadding(),
                ) {
                    Row(Modifier.fillMaxWidth().padding(16.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("取消", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { showAgePicker = false })
                        Text("选择年纪", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                        Text("确定", color = Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.noRippleClick { age = pendingAge.toString(); showAgePicker = false })
                    }
                    AgeWheel(initial = age.toIntOrNull() ?: 18, onCentered = { pendingAge = it })
                    Spacer(Modifier.height(12.dp))
                }
            }
        }
    }
}

/** 编辑资料分组卡片（Bg2 圆角） */
@Composable
private fun EditCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 14.dp)
            .clip(RoundedCornerShape(14.dp)).background(Bg2).padding(horizontal = 14.dp),
        content = content,
    )
}

/** 编辑资料行：左标签 + 右内容，可整行点击 */
@Composable
private fun EditRow(label: String, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Row(
        (if (onClick != null) Modifier.noRippleClick(onClick) else Modifier).fillMaxWidth().padding(vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = TextSub, fontSize = 14.sp, modifier = Modifier.width(76.dp))
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun EditDivider() {
    Box(Modifier.fillMaxWidth().height(0.5.dp).background(Line))
}

/** 无边框输入框（暗色行内样式） */
@Composable
private fun EditField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboard: KeyboardType = KeyboardType.Text,
) {
    Box(modifier) {
        if (value.isEmpty()) Text(placeholder, color = TextDim, fontSize = 15.sp)
        BasicTextField(
            value, onChange, singleLine = true,
            textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
            cursorBrush = SolidColor(Accent),
            keyboardOptions = KeyboardOptions(keyboardType = keyboard),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** 年纪滚轮：18-70，snap 对齐，中间高亮为选中值 */
@Composable
private fun AgeWheel(initial: Int, onCentered: (Int) -> Unit) {
    val ages = remember { (18..70).toList() }
    val itemH = 44.dp
    val itemPx = with(LocalDensity.current) { itemH.toPx() }
    val state = rememberLazyListState((initial - 18).coerceIn(0, ages.lastIndex))
    val fling = rememberSnapFlingBehavior(state)
    val centerIdx by remember {
        derivedStateOf {
            (state.firstVisibleItemIndex + if (state.firstVisibleItemScrollOffset > itemPx / 2) 1 else 0)
                .coerceIn(0, ages.lastIndex)
        }
    }
    LaunchedEffect(centerIdx) { onCentered(ages[centerIdx]) }
    Box(Modifier.fillMaxWidth().height(itemH * 5)) {
        LazyColumn(
            state = state, flingBehavior = fling,
            contentPadding = PaddingValues(vertical = itemH * 2),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(ages) { a ->
                val selected = ages[centerIdx] == a
                Box(Modifier.fillMaxWidth().height(itemH), contentAlignment = Alignment.Center) {
                    Text(
                        "$a", color = if (selected) Accent else TextSub,
                        fontSize = if (selected) 22.sp else 15.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
        // 中间选中区参考线
        Box(Modifier.align(Alignment.Center).fillMaxWidth().height(itemH)) {
            Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(0.5.dp).background(Line))
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(0.5.dp).background(Line))
        }
    }
}

/** 全局视频播放中心：保证同时只有一个视频出声 */
object FeedVideoCenter {
    var current: androidx.media3.exoplayer.ExoPlayer? = null

    fun register(player: androidx.media3.exoplayer.ExoPlayer) {
        if (current !== player) current?.pause()
        current = player
    }

    fun unregister(player: androidx.media3.exoplayer.ExoPlayer) {
        if (current === player) current = null
    }
}

/** 内嵌视频播放器（ExoPlayer），默认自动播放；接入全局互斥（播 A 停其他） */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun VideoPlayerBox(url: String, autoPlay: Boolean = true, height: androidx.compose.ui.unit.Dp = 240.dp) {
    val ctx = LocalContext.current
    val player = remember {
        androidx.media3.exoplayer.ExoPlayer.Builder(ctx).build().apply {
            setMediaItem(androidx.media3.common.MediaItem.fromUri(url))
            playWhenReady = autoPlay
            prepare()
            // 开始播放时暂停其它视频
            addListener(object : androidx.media3.common.Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) FeedVideoCenter.register(this@apply)
                }
            })
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            FeedVideoCenter.unregister(player)
            player.release()
        }
    }
    androidx.compose.ui.viewinterop.AndroidView(
        factory = {
            androidx.media3.ui.PlayerView(it).apply {
                this.player = player
                useController = true
                setShowNextButton(false)
                setShowPreviousButton(false)
            }
        },
        modifier = Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(10.dp)).background(Color.Black),
    )
}