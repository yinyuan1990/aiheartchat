package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wh.peiwana.net.*
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun MeScreen(modifier: Modifier = Modifier, initialUser: UserProfile?, onNav: (String) -> Unit) {
    var me by remember { mutableStateOf(initialUser) }
    LaunchedEffect(Unit) { me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() ?: me }
    val u = me ?: return

    LazyColumn(modifier = modifier.fillMaxSize()) {
        item {
            Column(modifier = Modifier.background(Brush.verticalGradient(listOf(Accent.copy(alpha = 0.14f), Bg))).padding(20.dp, 28.dp, 20.dp, 16.dp)) {
                Row(verticalAlignment = Alignment.Top) {
                    Avatar(u.avatar, 76)
                    Column(modifier = Modifier.weight(1f).padding(start = 16.dp, top = 4.dp)) {
                        Text(u.nickname, color = TextMain, fontSize = 21.sp, fontWeight = FontWeight.Bold)
                        Row(modifier = Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                "${if (u.gender == 1) "男" else "女"} ${u.age}",
                                color = if (u.gender == 1) Color(0xFF6DB3FF) else Color(0xFFFF7A95), fontSize = 11.sp,
                                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Bg3).padding(horizontal = 10.dp, vertical = 2.dp),
                            )
                            if (u.isGuide) Text("认证", color = Accent, fontSize = 11.sp, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Bg3).padding(horizontal = 8.dp, vertical = 2.dp))
                        }
                        if (u.shortId != null) Text("ID：${u.shortId}", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                    }
                }
                Text(if (u.signature.isNotEmpty()) u.signature else "还没有签名", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 14.dp))
                // 点击进关注/粉丝列表
                Row(modifier = Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(26.dp)) {
                    Row(Modifier.noRippleClick { onNav("follows/following") }, verticalAlignment = Alignment.CenterVertically) {
                        Text("${u.following}", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text(" 关注", color = TextSub, fontSize = 13.sp)
                    }
                    Row(Modifier.noRippleClick { onNav("follows/fans") }, verticalAlignment = Alignment.CenterVertically) {
                        Text("${u.fans}", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        Text(" 粉丝", color = TextSub, fontSize = 13.sp)
                    }
                }
                // 积分余额：融合进头部（玻璃质感行，点击进钱包）
                Row(
                    Modifier.padding(top = 16.dp).fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(Color.White.copy(alpha = 0.05f))
                        .border(1.dp, Accent.copy(alpha = 0.25f), RoundedCornerShape(14.dp))
                        .clickable { onNav("wallet") }
                        .padding(16.dp, 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("积分余额", color = TextSub, fontSize = 11.sp)
                        Text(fmtPoints(u.balance), color = Accent, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("冻结 ${fmtPoints(u.frozen)}", color = TextSub, fontSize = 11.sp)
                        Text("明细 ›", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
        }
        val rows = buildList {
            add("编辑资料" to "edit-profile")
            add("我的动态" to "my-moments")
            // 关注的人动态（原主页「关注」tab 移到这里）
            add("关注动态" to "follow-moments")
            add((if (u.gender == 2) "我的接单" else "我的约单") to "task/mine")
            add("收到的礼物" to "gifts-received")
            // 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名）
            if (!u.isGuide) add("搭子认证" to "guide-apply")
        }
        items(rows) { (label, route) ->
            Row(modifier = Modifier.fillMaxWidth().clickable { onNav(route) }.padding(16.dp, 15.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = TextMain, fontSize = 15.sp, modifier = Modifier.weight(1f))
                Text("›", color = TextDim, fontSize = 18.sp)
            }
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
        }
        // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
        if (u.gender == 1) {
            item {
                var camOn by remember { mutableStateOf(Api.camDefaultOn) }
                Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("视频通话开启我的画面", color = TextMain, fontSize = 15.sp)
                        Text("默认关闭，通话中可随时手动开启", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                    androidx.compose.material3.Switch(
                        checked = camOn,
                        onCheckedChange = { camOn = it; Api.camDefaultOn = it },
                        colors = androidx.compose.material3.SwitchDefaults.colors(checkedTrackColor = Accent),
                    )
                }
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
            }
        }
    }
}

/** 关注/粉丝列表（我的页面点击数字进入） */
@Composable
fun FollowListScreen(type: String, onBack: () -> Unit, onOpenUser: (String) -> Unit) {
    val title = if (type == "fans") "粉丝" else "关注"
    var list by remember { mutableStateOf<List<FollowUser>?>(null) }
    LaunchedEffect(type) {
        list = runCatching { Api.getList<FollowUser>("/user/follows/list?type=$type") }.getOrDefault(emptyList())
    }
    Column(Modifier.fillMaxSize()) {
        NavBar(title, onBack)
        val items = list
        when {
            items == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                Text("加载中…", color = TextDim, fontSize = 13.sp)
            }
            items.isEmpty() -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(if (type == "fans") "还没有粉丝" else "还没有关注的人", color = TextDim, fontSize = 13.sp)
            }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { u ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpenUser(u.id) }.padding(16.dp, 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(u.avatar, 46)
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(u.nickname, color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                                if (u.isGuide) {
                                    Text(
                                        "认证", color = Accent, fontSize = 10.sp,
                                        modifier = Modifier.padding(start = 6.dp)
                                            .clip(RoundedCornerShape(3.dp))
                                            .background(Accent.copy(alpha = 0.12f))
                                            .padding(horizontal = 5.dp, vertical = 1.dp),
                                    )
                                }
                            }
                            val sub = u.signature.ifEmpty { u.cityName }
                            if (sub.isNotEmpty()) {
                                Text(sub, color = TextSub, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
                            }
                        }
                        Text("›", color = TextDim, fontSize = 18.sp)
                    }
                    Box(Modifier.fillMaxWidth().padding(start = 74.dp).height(0.5.dp).background(Line))
                }
            }
        }
    }
}

private val txLabels = mapOf(
    "admin_grant" to "平台发放", "gift_send" to "送出礼物", "gift_recv" to "收到礼物",
    "task_freeze" to "约单托管", "task_settle" to "约单结算", "task_refund" to "约单退回",
    "msg_fee" to "发送消息", "msg_income" to "消息收入", "call_fee" to "视频通话", "call_income" to "通话收入",
    "transfer_out" to "转赠支出", "transfer_in" to "收到转赠", "adjust" to "调整",
)

@Composable
fun WalletScreen(onBack: () -> Unit, onNav: (String) -> Unit) {
    var wallet by remember { mutableStateOf<WalletData?>(null) }
    var txs by remember { mutableStateOf<List<WalletTx>>(emptyList()) }
    var hasMore by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf(0) } // 0=明细 1=榜单
    var rank by remember { mutableStateOf<ContribRankResp?>(null) }

    suspend fun loadMore() {
        if (loadingMore) return
        loadingMore = true
        val last = txs.lastOrNull()
        val list = runCatching {
            Api.getList<WalletTx>("/wallet/transactions${if (last != null) "?beforeId=${last.id}" else ""}")
        }.getOrDefault(emptyList())
        txs = txs + list
        hasMore = list.size >= 30
        loadingMore = false
    }

    LaunchedEffect(Unit) {
        wallet = runCatching { Api.getObj<WalletData>("/wallet") }.getOrNull()
        loadMore()
        rank = runCatching { Api.getObj<ContribRankResp>("/wallet/contrib-rank") }.getOrNull()
    }
    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("积分明细", onBack) { Text("转赠", color = Accent, fontSize = 14.sp, modifier = Modifier.clickable { onNav("transfer") }) }
        Column(modifier = Modifier.padding(16.dp)) {
            Column(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bg2).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("可用积分", color = TextSub, fontSize = 13.sp)
                Text(fmtPoints(wallet?.balance), color = TextMain, fontSize = 38.sp, fontWeight = FontWeight.Bold)
                Text("冻结中 ${fmtPoints(wallet?.frozen)}", color = TextDim, fontSize = 12.sp)
            }
        }
        // 明细 / 榜单切换
        Row(modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("明细", rank?.title ?: "贡献榜").forEachIndexed { idx, label ->
                Text(
                    label,
                    color = if (tab == idx) Color.White else TextSub,
                    fontSize = 13.sp,
                    fontWeight = if (tab == idx) FontWeight.SemiBold else FontWeight.Normal,
                    modifier = Modifier
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (tab == idx) Accent else Bg3)
                        .noRippleClick { tab = idx }
                        .padding(horizontal = 18.dp, vertical = 6.dp),
                )
            }
        }
        if (tab == 1) {
            LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
                val list = rank?.list ?: emptyList()
                if (list.isEmpty()) {
                    item {
                        Box(Modifier.fillMaxWidth().padding(30.dp), contentAlignment = Alignment.Center) {
                            Text("暂无数据", color = TextDim, fontSize = 13.sp)
                        }
                    }
                }
                itemsIndexed(list, key = { _, r -> r.userId }) { idx, r ->
                    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "${idx + 1}",
                            color = if (idx < 3) Accent else TextDim,
                            fontSize = if (idx < 3) 17.sp else 14.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.width(24.dp),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        Avatar(r.avatar, 40)
                        Column(modifier = Modifier.weight(1f)) {
                            Text(r.nickname, color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            Text(
                                "礼物 ${fmtPoints(r.giftFen)} · 通话 ${fmtPoints(r.callFen)} · 消息 ${fmtPoints(r.msgFen)}",
                                color = TextDim, fontSize = 11.sp,
                            )
                        }
                        Text(fmtPoints(r.totalFen), color = Accent, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    }
                    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
                }
            }
        } else {
        LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
            itemsIndexed(txs, key = { _, t -> t.id }) { idx, t ->
                // 滚动到最后一条时自动加载下一页
                if (idx == txs.lastIndex && hasMore) {
                    LaunchedEffect(t.id) { loadMore() }
                }
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(txLabels[t.type] ?: t.type, color = TextMain, fontSize = 14.sp)
                        Text(t.remark, color = TextDim, fontSize = 11.sp)
                    }
                    val neg = t.amount.startsWith("-")
                    Text((if (neg) "-" else "+") + fmtPoints(t.amount.removePrefix("-")), color = if (neg) TextMain else Success, fontWeight = FontWeight.SemiBold)
                }
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(Line))
            }
            if (loadingMore) {
                item {
                    Box(Modifier.fillMaxWidth().padding(14.dp), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.CircularProgressIndicator(color = Accent, modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
        }
    }
}

/** 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号 */
@Composable
fun RealnameScreen(onBack: () -> Unit) {
    var me by remember { mutableStateOf<UserProfile?>(null) }
    var name by remember { mutableStateOf("") }
    var idCard by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() }

    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("实名认证", onBack)
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (me?.realname == true) {
                Column(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(vertical = 40.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("已完成实名认证", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text("认证姓名：${me?.realNameMasked ?: ""}", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                }
            } else {
                Column(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("真实姓名", color = TextSub, fontSize = 13.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = name,
                            onValueChange = { name = it.take(20) },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 16.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            singleLine = true,
                            decorationBox = { inner ->
                                Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp)) {
                                    if (name.isEmpty()) Text("与身份证一致", color = TextDim, fontSize = 16.sp)
                                    inner()
                                }
                            },
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("身份证号", color = TextSub, fontSize = 13.sp)
                        androidx.compose.foundation.text.BasicTextField(
                            value = idCard,
                            onValueChange = { v -> idCard = v.uppercase().filter { it.isDigit() || it == 'X' }.take(18) },
                            textStyle = androidx.compose.ui.text.TextStyle(color = TextMain, fontSize = 16.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                            singleLine = true,
                            decorationBox = { inner ->
                                Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Bg3).padding(12.dp)) {
                                    if (idCard.isEmpty()) Text("18 位身份证号码", color = TextDim, fontSize = 16.sp)
                                    inner()
                                }
                            },
                        )
                    }
                    Text("信息仅用于身份核验，平台不对外展示。每个身份证号仅可认证一个账号。", color = TextDim, fontSize = 12.sp)
                }
                AccentButton(if (busy) "提交中…" else "提交认证", enabled = !busy && name.length >= 2 && idCard.length == 18) {
                    busy = true
                    scope.launch {
                        val body = kotlinx.serialization.json.buildJsonObject {
                            put("name", kotlinx.serialization.json.JsonPrimitive(name.trim()))
                            put("idCard", kotlinx.serialization.json.JsonPrimitive(idCard))
                        }
                        runCatching { Api.request("/user/realname", "POST", body) }
                            .onSuccess {
                                toast = "认证成功"
                                me = runCatching { Api.getObj<UserProfile>("/user/me") }.getOrNull() ?: me
                            }
                            .onFailure { toast = it.message ?: "认证失败" }
                        busy = false
                    }
                }
            }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
        }
    }
}

@Composable
fun TransferScreen(myShortId: String?, onBack: () -> Unit) {
    var sid by remember { mutableStateOf("") }
    var target by remember { mutableStateOf<LookupUser?>(null) }
    var amount by remember { mutableStateOf("") }
    var balance by remember { mutableStateOf("0") }
    var toast by remember { mutableStateOf("") }
    var showMyQr by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { balance = runCatching { Api.getObj<WalletData>("/wallet").balance }.getOrDefault("0") }

    fun applySid(s: String) {
        sid = s
        target = null
        scope.launch { target = runCatching { Api.getObj<LookupUser>("/wallet/lookup/$s") }.getOrNull() }
    }

    val scanLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        com.journeyapps.barcodescanner.ScanContract(),
    ) { result ->
        result.contents?.let { text ->
            parsePaySid(text)?.let { applySid(it) } ?: run { toast = "无法识别的二维码" }
        }
    }

    fun startScan() {
        scanLauncher.launch(
            com.journeyapps.barcodescanner.ScanOptions()
                .setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                .setPrompt("对准对方的收款二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(true)
                .setCaptureActivity(PortraitCaptureActivity::class.java),
        )
    }

    Column(modifier = Modifier.fillMaxSize()) {
        NavBar("积分转赠", onBack)
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            // 收款人卡：大号居中输入 6 位 ID
            Column(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("对方 ID", color = TextSub, fontSize = 13.sp)
                androidx.compose.foundation.text.BasicTextField(
                    value = sid,
                    onValueChange = {
                        sid = it.filter { c -> c.isDigit() }.take(6)
                        if (sid.length == 6) scope.launch { target = runCatching { Api.getObj<LookupUser>("/wallet/lookup/$sid") }.getOrNull() }
                        else target = null
                    },
                    textStyle = androidx.compose.ui.text.TextStyle(
                        color = TextMain, fontSize = 30.sp, fontWeight = FontWeight.SemiBold,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        letterSpacing = 6.sp,
                    ),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                    singleLine = true,
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                            if (sid.isEmpty()) Text("6 位数字", color = TextDim, fontSize = 22.sp)
                            inner()
                        }
                    },
                )
                Box(Modifier.fillMaxWidth().padding(horizontal = 40.dp).height(1.dp).background(Line))
                Spacer(Modifier.height(12.dp))
                when {
                    target != null -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Avatar(target!!.avatar, 40)
                        Text("  ${target!!.nickname}", color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                        Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(Success))
                        Text(" 已确认", color = Success, fontSize = 12.sp)
                    }
                    sid.length == 6 -> Text("正在查找…", color = TextDim, fontSize = 12.sp)
                    else -> Text("输入对方的 6 位 ID 自动确认收款人", color = TextDim, fontSize = 12.sp)
                }
                Spacer(Modifier.height(14.dp))
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "扫一扫", color = Accent, fontSize = 13.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.weight(1f).noRippleClick { startScan() },
                    )
                    Box(Modifier.width(1.dp).height(18.dp).background(Line))
                    Text(
                        "我的收款码", color = Accent, fontSize = 13.sp,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.weight(1f).noRippleClick { showMyQr = true },
                    )
                }
            }

            // 金额卡：大号居中金额
            Column(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Bg2).padding(18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("转赠积分", color = TextSub, fontSize = 13.sp)
                androidx.compose.foundation.text.BasicTextField(
                    value = amount,
                    onValueChange = { amount = it.filter { c -> c.isDigit() || c == '.' } },
                    textStyle = androidx.compose.ui.text.TextStyle(
                        color = Accent, fontSize = 40.sp, fontWeight = FontWeight.Bold,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    ),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                    singleLine = true,
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                            if (amount.isEmpty()) Text("0", color = TextDim, fontSize = 40.sp, fontWeight = FontWeight.Bold)
                            inner()
                        }
                    },
                )
                Box(Modifier.fillMaxWidth().padding(horizontal = 40.dp).height(1.dp).background(Line))
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("可用余额 ${fmtPoints(balance)}", color = TextSub, fontSize = 12.sp)
                    Text("  全部", color = Accent, fontSize = 12.sp, modifier = Modifier.noRippleClick { amount = fmtPoints(balance) })
                }
            }

            AccentButton("确认转赠", enabled = target != null && ((amount.toDoubleOrNull() ?: 0.0) > 0)) {
                scope.launch {
                    val fen = ((amount.toDoubleOrNull() ?: 0.0) * 100).toInt()
                    val body = kotlinx.serialization.json.buildJsonObject {
                        put("toShortId", kotlinx.serialization.json.JsonPrimitive(target!!.shortId))
                        put("amountFen", kotlinx.serialization.json.JsonPrimitive(fen.toString()))
                    }
                    runCatching { Api.request("/wallet/transfer", "POST", body) }
                        .onSuccess { toast = "转赠成功"; onBack() }
                        .onFailure { toast = it.message ?: "失败" }
                }
            }
            if (toast.isNotEmpty()) Text(toast, color = Accent, fontSize = 13.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            if (myShortId != null) {
                Text("我的 ID：$myShortId（告诉对方即可互转）", color = TextDim, fontSize = 12.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }

    if (showMyQr && myShortId != null) {
        androidx.compose.ui.window.Dialog(onDismissRequest = { showMyQr = false }) {
            Column(
                modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(Bg2).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("我的收款码", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("ID：$myShortId", color = TextSub, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                Spacer(Modifier.height(16.dp))
                val qr = remember(myShortId) { makeQrBitmap(payQrContent(myShortId)) }
                androidx.compose.foundation.Image(
                    bitmap = qr.asImageBitmap(),
                    contentDescription = "收款二维码",
                    modifier = Modifier.size(230.dp).clip(RoundedCornerShape(10.dp)).background(Color.White).padding(10.dp),
                )
                Spacer(Modifier.height(14.dp))
                Text("使用「积分转赠 - 扫一扫」扫码给我转积分", color = TextDim, fontSize = 12.sp)
                Spacer(Modifier.height(14.dp))
                val ctx = androidx.compose.ui.platform.LocalContext.current
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "保存", color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.width(100.dp).clip(RoundedCornerShape(percent = 50)).background(Bg3)
                            .noRippleClick {
                                val ok = saveQrToGallery(ctx, qr)
                                android.widget.Toast.makeText(ctx, if (ok) "已保存到相册" else "保存失败", android.widget.Toast.LENGTH_SHORT).show()
                            }
                            .padding(vertical = 10.dp),
                    )
                    Text(
                        "分享", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.width(100.dp).clip(RoundedCornerShape(percent = 50)).background(Accent)
                            .noRippleClick { shareQr(ctx, qr) }
                            .padding(vertical = 10.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                Text("关闭", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick { showMyQr = false }.padding(6.dp))
            }
        }
    }
}
