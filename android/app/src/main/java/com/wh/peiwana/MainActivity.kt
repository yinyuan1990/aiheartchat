package com.wh.peiwana

import android.net.Uri
import android.os.Bundle
import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.UserProfile
import com.wh.peiwana.net.WsClient
import com.wh.peiwana.rtc.CallManager
import com.wh.peiwana.ui.screen.*
import com.wh.peiwana.ui.theme.PeiwanATheme
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Api.init(applicationContext)
        // 全局图片缓存：内存 25% + 磁盘 512MB，忽略服务端缓存头（资源为 UUID 文件名不会变）
        coil.Coil.setImageLoader(
            coil.ImageLoader.Builder(applicationContext)
                .memoryCache { coil.memory.MemoryCache.Builder(applicationContext).maxSizePercent(0.25).build() }
                .diskCache {
                    coil.disk.DiskCache.Builder()
                        .directory(applicationContext.cacheDir.resolve("image_cache"))
                        .maxSizeBytes(512L * 1024 * 1024)
                        .build()
                }
                .respectCacheHeaders(false)
                .components { add(coil.decode.VideoFrameDecoder.Factory()) }
                .crossfade(true)
                .build(),
        )
        // 深色状态栏/导航栏背景 → 浅色（白色）图标文字
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
        )
        setContent { PeiwanATheme { Surface(Modifier.fillMaxSize()) { AppRoot() } } }
        // Android 13+ 通知权限（来电提醒需要）
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    override fun onResume() {
        super.onResume()
        com.wh.peiwana.net.Session.foreground = true
    }

    override fun onPause() {
        super.onPause()
        com.wh.peiwana.net.Session.foreground = false
    }
}

/** 子页面路由：统一加不透明背景，覆盖在常驻主页之上（主页不销毁，返回即恢复） */
private fun androidx.navigation.NavGraphBuilder.page(
    route: String,
    arguments: List<androidx.navigation.NamedNavArgument> = emptyList(),
    content: @Composable (androidx.navigation.NavBackStackEntry) -> Unit,
) {
    composable(route, arguments) { entry ->
        Box(
            Modifier
                .fillMaxSize()
                .background(com.wh.peiwana.ui.theme.Bg),
        ) { content(entry) }
    }
}

@Composable
fun AppRoot() {
    val nav = rememberNavController()
    var user by remember { mutableStateOf<UserProfile?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(user?.id) {
        user?.let {
            com.wh.peiwana.net.Session.uid = it.id
            com.wh.peiwana.net.Session.gender = it.gender
            WsClient.connect()
            CallManager.attachContext(context)
            CallManager.init(context, it.id)
            com.wh.peiwana.rtc.VoiceRoomManager.init(context, it.id)
            // 保活：前台服务 + 请求忽略电池优化（保证熄屏收消息/来电）
            runCatching { KeepAliveService.start(context) }
            runCatching {
                val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                    val intent = android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:${context.packageName}")
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                }
            }
            // 来电悬浮窗权限（显示在其他应用上层）
            runCatching {
                if (!android.provider.Settings.canDrawOverlays(context)) {
                    android.widget.Toast.makeText(context, "请允许「显示在其他应用上层」以接收来电弹窗", android.widget.Toast.LENGTH_LONG).show()
                    val intent = android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                        data = android.net.Uri.parse("package:${context.packageName}")
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                }
            }
        }
    }

    // 路由跳转（进详情/抖音模式等）时停止列表内正在播放的视频
    LaunchedEffect(Unit) {
        nav.currentBackStackEntryFlow.collect {
            com.wh.peiwana.ui.screen.FeedVideoCenter.current?.pause()
        }
    }

    // 评分完成后跳转/留在女方个人主页
    LaunchedEffect(Unit) {
        com.wh.peiwana.rtc.CallManager.openUserHome.collect { uid ->
            if (uid != null) {
                com.wh.peiwana.rtc.CallManager.openUserHome.value = null
                // 已在该主页则不重复入栈
                if (nav.currentBackStackEntry?.destination?.route != "u/{id}" ||
                    nav.currentBackStackEntry?.arguments?.getString("id") != uid
                ) {
                    nav.navigate("u/$uid")
                }
            }
        }
    }

    // GPS 每分钟上报一次（用于距离展示）
    LaunchedEffect(user?.id) {
        if (user == null) return@LaunchedEffect
        while (true) {
            runCatching {
                detectCity(context) // 内部刷新 LocationCache
                val lat = LocationCache.lat
                val lng = LocationCache.lng
                if (lat != null && lng != null) {
                    Api.request("/user/location", "POST", kotlinx.serialization.json.buildJsonObject {
                        put("latitude", kotlinx.serialization.json.JsonPrimitive(lat))
                        put("longitude", kotlinx.serialization.json.JsonPrimitive(lng))
                    })
                }
            }
            kotlinx.coroutines.delay(60_000)
        }
    }

    // 通过用户 id 打开会话（不能和自己私聊）
    fun openChatWithUser(userId: String, nickname: String) {
        if (userId == user?.id || userId.isEmpty()) return
        scope.launch {
            runCatching {
                val data = Api.request("/im/conversations/open/$userId", "POST") as? JsonObject
                val convId = data?.get("conversationId")?.jsonPrimitive?.content ?: return@runCatching
                nav.navigate("chatroom/$convId?convType=1&targetId=$userId&title=${Uri.encode(nickname)}")
            }
        }
    }

    Box {
      Box(Modifier.fillMaxSize().statusBarsPadding()) {
        // 主页常驻底层（像老 Activity：被子页面覆盖时不销毁、返回时不重建）
        if (user != null) {
            MainScreen(
                initialUser = user,
                onOpenChat = { convId, convType, targetId, title ->
                    nav.navigate("chatroom/$convId?convType=$convType&targetId=$targetId&title=${Uri.encode(title)}")
                },
                onOpenChatWithUser = ::openChatWithUser,
                onNav = { nav.navigate(it) },
            )
        }
        NavHost(navController = nav, startDestination = "boot") {
            page("boot") {
                BootScreen(
                    onRegistered = { user = it; nav.navigate("main") { popUpTo("boot") { inclusive = true } } },
                    onNeedRegister = { nav.navigate("register") { popUpTo("boot") { inclusive = true } } },
                )
            }
            page("register") {
                RegisterScreen(onDone = { user = it; nav.navigate("main") { popUpTo("register") { inclusive = true } } })
            }
            composable("main") {
                // 空占位：主页由底层常驻渲染
                Box(Modifier.size(0.dp))
            }
            page(
                "chatroom/{convId}?convType={convType}&targetId={targetId}&title={title}",
                arguments = listOf(
                    navArgument("convId") { type = NavType.StringType },
                    navArgument("convType") { type = NavType.IntType; defaultValue = 1 },
                    navArgument("targetId") { type = NavType.StringType; defaultValue = "" },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { entry ->
                val a = entry.arguments!!
                val convType = a.getInt("convType")
                val targetId = a.getString("targetId") ?: ""
                val startCall = rememberStartCall(targetId, a.getString("title") ?: "")
                ChatRoomScreen(
                    convId = a.getString("convId")!!,
                    convType = convType,
                    targetId = targetId,
                    title = a.getString("title") ?: "",
                    myUserId = user?.id ?: "",
                    myAvatar = user?.avatar ?: "",
                    myNickname = user?.nickname ?: "",
                    onBack = { nav.popBackStack() },
                    onCall = { type -> startCall(type) },
                    onGroupInfo = { nav.navigate("group-info/$targetId") },
                )
            }
            page("group-info/{groupId}", listOf(navArgument("groupId") { type = NavType.StringType })) { entry ->
                GroupInfoScreen(entry.arguments!!.getString("groupId")!!, user?.id ?: "", onBack = { nav.popBackStack() }, onExit = { nav.popBackStack("main", false) })
            }
            page("tiktok") {
                TikTokScreen(onExit = { nav.popBackStack() })
            }
            page("aichat") {
                AiChatScreen(myAvatar = user?.avatar ?: "", onBack = { nav.popBackStack() })
            }
            page("create-group") {
                CreateGroupScreen(onBack = { nav.popBackStack() }, onCreated = { convId, groupId, name ->
                    nav.popBackStack()
                    nav.navigate("chatroom/$convId?convType=2&targetId=$groupId&title=${Uri.encode("$name（群）")}")
                })
            }
            page("join-group?code={code}", listOf(navArgument("code") { type = NavType.StringType; defaultValue = "" })) { entry ->
                JoinGroupScreen(
                    onBack = { nav.popBackStack() },
                    onJoined = { convId, groupId, name ->
                        nav.popBackStack()
                        nav.navigate("chatroom/$convId?convType=2&targetId=$groupId&title=${Uri.encode("$name（群）")}")
                    },
                    initialCode = entry.arguments?.getString("code")?.takeIf { it.isNotBlank() },
                )
            }
            page("moment/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                MomentDetailScreen(entry.arguments!!.getString("id")!!, onBack = { nav.popBackStack() }, onOpenChat = ::openChatWithUser)
            }
            page("news") {
                NewsListScreen(onOpenNews = { nav.navigate("news/$it") }, onBack = { nav.popBackStack() })
            }
            page("news/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                NewsDetailScreen(entry.arguments!!.getString("id")!!, onBack = { nav.popBackStack() })
            }
            page("project/guide") {
                GuideProjectScreen(user?.gender ?: 1, onBack = { nav.popBackStack() }, onNav = { nav.navigate(it) }, onOpenChat = ::openChatWithUser)
            }
            // 小游戏 / 第三方 H5 全屏容器（大厅 H5 经 JS 桥 openWeb 唤起）；landscape=true 该页横屏
            page(
                "web?url={url}&title={title}&landscape={landscape}",
                listOf(
                    navArgument("url") { type = NavType.StringType; defaultValue = "" },
                    navArgument("title") { type = NavType.StringType; defaultValue = "" },
                    navArgument("landscape") { type = NavType.BoolType; defaultValue = false },
                ),
            ) { entry ->
                val a = entry.arguments!!
                GameWebScreen(
                    url = a.getString("url") ?: "",
                    title = a.getString("title") ?: "",
                    landscape = a.getBoolean("landscape"),
                    onBack = { nav.popBackStack() },
                )
            }
            page("people/{mode}", listOf(navArgument("mode") { type = NavType.StringType })) { entry ->
                PeopleScreen(entry.arguments!!.getString("mode")!!, onBack = { nav.popBackStack() }, onOpenChat = ::openChatWithUser)
            }
            page("publish") { PublishScreen(onBack = { nav.popBackStack() }, onDone = { nav.popBackStack() }) }
            page("task/post") { TaskPostScreen(onBack = { nav.popBackStack() }, onDone = { nav.popBackStack() }) }
            page("task/hall") { TaskHallScreen(onBack = { nav.popBackStack() }, onOpen = { nav.navigate("task/$it") }) }
            page("task/mine") { TaskMineScreen(user?.gender ?: 1, onBack = { nav.popBackStack() }, onOpen = { nav.navigate("task/$it") }) }
            page("task/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                TaskDetailScreen(entry.arguments!!.getString("id")!!, user?.gender ?: 1, onBack = { nav.popBackStack() })
            }
            page("wallet") { WalletScreen(onBack = { nav.popBackStack() }, onNav = { nav.navigate(it) }) }
            page("transfer") { TransferScreen(user?.shortId, onBack = { nav.popBackStack() }) }
            page("edit-profile") { EditProfileScreen(onBack = { nav.popBackStack() }) }
            page("guide-apply") { GuideApplyScreen(onBack = { nav.popBackStack() }) }
            page("realname") { RealnameScreen(onBack = { nav.popBackStack() }) }
            page("gifts-received") { GiftsReceivedScreen(onBack = { nav.popBackStack() }) }
            page("my-moments") { MyMomentsScreen(onBack = { nav.popBackStack() }, onOpen = { nav.navigate("moment/$it") }) }
            page("follow-moments") {
                FollowMomentsScreen(
                    onBack = { nav.popBackStack() },
                    onOpenDetail = { nav.navigate("moment/$it") },
                    onOpenUser = { nav.navigate("u/$it") },
                )
            }
            page("follows/{type}", listOf(navArgument("type") { type = NavType.StringType })) { entry ->
                FollowListScreen(
                    type = entry.arguments!!.getString("type")!!,
                    onBack = { nav.popBackStack() },
                    onOpenUser = { nav.navigate("u/$it") },
                )
            }
            page("u/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                UserHomeScreen(
                    userId = entry.arguments!!.getString("id")!!,
                    onBack = { nav.popBackStack() },
                    onOpenChat = ::openChatWithUser,
                    onOpenMoment = { nav.navigate("moment/$it") },
                )
            }
        }
      }
        CallOverlay()
    }
}
