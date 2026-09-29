package com.wh.peiwana.ui.screen

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wh.peiwana.rtc.CallManager
import com.wh.peiwana.rtc.CallState
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

enum class AttachAction { Gift, Location, VoiceCall, VideoCall }

private const val MAX_PICK = 9

private data class MediaImage(val id: Long, val uri: Uri, val bucketId: String, val bucketName: String)
private data class MediaAlbum(val id: String?, val name: String)

private enum class MediaAccess { Full, Partial, Denied }

private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

private fun Context.granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

private fun mediaAccess(ctx: Context): MediaAccess = when {
    Build.VERSION.SDK_INT >= 33 && ctx.granted(Manifest.permission.READ_MEDIA_IMAGES) -> MediaAccess.Full
    Build.VERSION.SDK_INT < 33 && ctx.granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> MediaAccess.Full
    Build.VERSION.SDK_INT >= 34 && ctx.granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> MediaAccess.Partial
    else -> MediaAccess.Denied
}

private suspend fun queryImages(ctx: Context): List<MediaImage> = withContext(Dispatchers.IO) {
    val base = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val proj = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.BUCKET_ID, MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
    val out = ArrayList<MediaImage>()
    runCatching {
        ctx.contentResolver.query(base, proj, null, null, "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val iBucket = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val iName = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            while (c.moveToNext()) {
                val id = c.getLong(iId)
                out += MediaImage(id, ContentUris.withAppendedId(base, id), c.getString(iBucket) ?: "", c.getString(iName) ?: "其他")
            }
        }
    }
    out
}

/**
 * 聊天「+」弹框（Telegram 式）：从底部弹出，半屏起步，拖顶部或上滑网格展开到全屏，下拉收起。
 * 顶部 × / 相册切换；3 列相册网格（第一格相机，已授权时实时取景，点了拍照）；右上圆圈多选带序号；
 * 底部悬浮胶囊切 相册 / 礼物 / 位置 / 通话，选了图后换成「添加说明 + 发送」。
 */
@Composable
fun AttachSheet(
    isSingle: Boolean,
    canVideoCall: Boolean,
    onDismiss: () -> Unit,
    onSend: (List<Uri>, String) -> Unit,
    onAction: (AttachAction) -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    var access by remember { mutableStateOf(mediaAccess(ctx)) }
    var images by remember { mutableStateOf<List<MediaImage>>(emptyList()) }
    var album by remember { mutableStateOf(MediaAlbum(null, "最近项目")) }
    var selection by remember { mutableStateOf(listOf<Uri>()) }
    var caption by remember { mutableStateOf("") }
    var askedMedia by remember { mutableStateOf(false) }
    var camGranted by remember { mutableStateOf(ctx.granted(Manifest.permission.CAMERA)) }
    var capturing by remember { mutableStateOf(false) }
    var captureUri by remember { mutableStateOf<Uri?>(null) }
    val callState by CallManager.state.collectAsState()

    fun reload() {
        access = mediaAccess(ctx)
        if (access != MediaAccess.Denied) scope.launch { images = queryImages(ctx) }
    }

    val mediaPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        askedMedia = true
        reload()
    }
    LaunchedEffect(Unit) {
        if (access == MediaAccess.Denied) mediaPerm.launch(mediaPermissions()) else reload()
    }

    // 收起动画由 exit() 驱动，返回键也走它
    var exitRequest by remember { mutableStateOf(false) }
    Dialog(
        onDismissRequest = { exitRequest = true },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        // 遮罩自己画（跟着弹框位置渐变），关掉系统的 dim
        val dialogWindow = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { dialogWindow?.setDimAmount(0f) }

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val fullH = constraints.maxHeight.toFloat()
            val topGap = WindowInsets.statusBars.getTop(density) + with(density) { 8.dp.toPx() }
            val sheetH = fullH - topGap
            val collapsedOff = sheetH - fullH * 0.64f
            val hiddenOff = sheetH
            var offset by remember { mutableFloatStateOf(hiddenOff) }
            var anim by remember { mutableStateOf<Job?>(null) }

            fun animateTo(target: Float, after: () -> Unit = {}) {
                anim?.cancel()
                anim = scope.launch {
                    animate(offset, target, animationSpec = tween(240)) { v, _ -> offset = v }
                    after()
                }
            }
            /** 收起动画走完再回调（关弹框 + 后续动作） */
            fun exit(after: () -> Unit = {}) = animateTo(hiddenOff) { onDismiss(); after() }
            fun settle(velocity: Float) {
                val dismissAt = collapsedOff + with(density) { 90.dp.toPx() }
                when {
                    offset > dismissAt || (velocity > 2500f && offset > collapsedOff) -> exit()
                    velocity < -1500f -> animateTo(0f)
                    velocity > 1500f -> animateTo(collapsedOff)
                    offset < collapsedOff / 2 -> animateTo(0f)
                    else -> animateTo(collapsedOff)
                }
            }

            // 弹框窗口第一次量出的尺寸可能不是最终全屏尺寸，按最终的半屏位置弹出
            LaunchedEffect(collapsedOff) { animateTo(collapsedOff) }

            val nested = remember(collapsedOff) {
                object : NestedScrollConnection {
                    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                        if (available.y < 0 && offset > 0f) {
                            anim?.cancel()
                            val c = maxOf(available.y, -offset)
                            offset += c
                            return Offset(0f, c)
                        }
                        return Offset.Zero
                    }

                    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                        @Suppress("DEPRECATION")
                        if (available.y > 0 && source == NestedScrollSource.Drag) {
                            anim?.cancel()
                            offset += available.y
                            return Offset(0f, available.y)
                        }
                        return Offset.Zero
                    }

                    override suspend fun onPreFling(available: Velocity): Velocity {
                        if (offset > 0f && offset != collapsedOff) {
                            settle(available.y)
                            return available
                        }
                        return Velocity.Zero
                    }
                }
            }

            LaunchedEffect(exitRequest) {
                if (exitRequest) { exitRequest = false; exit() }
            }

            // 相机
            val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
                capturing = false
                val uri = captureUri
                if (ok && uri != null) {
                    val c = caption
                    exit { onSend(listOf(uri), c) }
                }
            }
            fun launchCamera() {
                val f = File(ctx.cacheDir, "cam_${System.currentTimeMillis()}.jpg")
                val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", f)
                captureUri = uri
                capturing = true
                runCatching { takePicture.launch(uri) }.onFailure {
                    capturing = false
                    Toast.makeText(ctx, "无法打开相机", Toast.LENGTH_SHORT).show()
                }
            }
            val camPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
                camGranted = ok
                if (ok) launchCamera() else Toast.makeText(ctx, "请在系统设置中允许使用相机", Toast.LENGTH_SHORT).show()
            }
            val pickSystem = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
                if (uris.isNotEmpty()) {
                    val c = caption
                    exit { onSend(uris.take(MAX_PICK), c) }
                }
            }
            val inCall = callState !is CallState.Idle

            val progress = ((hiddenOff - offset) / (hiddenOff - collapsedOff)).coerceIn(0f, 1f)
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.4f * progress)).noRippleClick { exit() })

            // 弹框本体：固定为展开高度，靠 offset 露出上半部分
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(with(density) { sheetH.toDp() })
                    .offset { IntOffset(0, offset.roundToInt()) }
                    .clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp))
                    .background(Bg)
                    .noRippleClick { },
            ) {
                // 顶部：可拖动
                Column(
                    Modifier.fillMaxWidth().pointerInput(collapsedOff) {
                        detectVerticalDragGestures(
                            onDragStart = { anim?.cancel() },
                            onDragEnd = { settle(0f) },
                            onDragCancel = { settle(0f) },
                        ) { change, dy ->
                            change.consume()
                            offset = (offset + dy).coerceAtLeast(0f)
                        }
                    },
                ) {
                    Box(Modifier.padding(top = 6.dp).align(Alignment.CenterHorizontally).size(36.dp, 5.dp).clip(CircleShape).background(Color(0x26000000)))
                    Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).height(40.dp)) {
                        Box(
                            Modifier.align(Alignment.CenterStart).size(34.dp).clip(CircleShape).background(Bg3).noRippleClick { exit() },
                            contentAlignment = Alignment.Center,
                        ) { XMarkIcon(TextMain, 14.dp) }

                        var menu by remember { mutableStateOf(false) }
                        Box(Modifier.align(Alignment.Center)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.noRippleClick { if (access != MediaAccess.Denied) menu = true },
                            ) {
                                Text(album.name, color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.width(4.dp))
                                ChevronDownIcon(TextSub, 12.dp)
                            }
                            val albums = remember(images) {
                                listOf(MediaAlbum(null, "最近项目")) + images.groupBy { it.bucketId }
                                    .map { (id, list) -> MediaAlbum(id, list.first().bucketName) to list.size }
                                    .sortedByDescending { it.second }.map { it.first }
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                albums.forEach { a ->
                                    DropdownMenuItem(
                                        text = { Text(a.name, fontSize = 14.sp, color = if (a.id == album.id) Accent else TextMain) },
                                        onClick = { menu = false; album = a },
                                    )
                                }
                            }
                        }

                        if (access == MediaAccess.Partial) {
                            Text(
                                "管理", color = Accent, fontSize = 15.sp,
                                modifier = Modifier.align(Alignment.CenterEnd).noRippleClick { mediaPerm.launch(mediaPermissions()) },
                            )
                        }
                    }
                }

                val shown = remember(images, album) { if (album.id == null) images else images.filter { it.bucketId == album.id } }
                val bottomInset = with(density) { WindowInsets.navigationBars.getBottom(density).toDp() }
                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                    contentPadding = PaddingValues(bottom = 90.dp + bottomInset),
                    modifier = Modifier.fillMaxWidth().weight(1f).nestedScroll(nested),
                ) {
                    item(key = "camera") {
                        CameraCell(live = camGranted && !capturing && !inCall) {
                            when {
                                inCall -> Toast.makeText(ctx, "通话中无法拍照", Toast.LENGTH_SHORT).show()
                                camGranted -> launchCamera()
                                else -> camPerm.launch(Manifest.permission.CAMERA)
                            }
                        }
                    }
                    if (access == MediaAccess.Denied) {
                        item(key = "denied", span = { GridItemSpan(maxLineSpan) }) {
                            DeniedTip(
                                onGrant = {
                                    if (askedMedia) {
                                        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)))
                                    } else {
                                        mediaPerm.launch(mediaPermissions())
                                    }
                                },
                                onSystemPicker = { pickSystem.launch("image/*") },
                            )
                        }
                    }
                    items(shown, key = { it.id }) { m ->
                        val idx = selection.indexOf(m.uri)
                        PhotoCell(m.uri, if (idx >= 0) idx else null) {
                            selection = when {
                                idx >= 0 -> selection - m.uri
                                selection.size >= MAX_PICK -> {
                                    Toast.makeText(ctx, "最多选择 $MAX_PICK 张", Toast.LENGTH_SHORT).show()
                                    selection
                                }
                                else -> selection + m.uri
                            }
                        }
                    }
                }
            }

            // 底部悬浮条：跟着弹框一起滑入 / 滑出
            val barShift = (offset - collapsedOff).coerceAtLeast(0f)
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .offset { IntOffset(0, barShift.roundToInt()) }
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                    .padding(bottom = 8.dp),
            ) {
                if (selection.isEmpty()) {
                    AttachTabBar(isSingle, canVideoCall) { a -> exit { onAction(a) } }
                } else {
                    CaptionBar(caption, { caption = it }, selection.size) {
                        val picked = selection
                        val c = caption
                        exit { onSend(picked, c) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraCell(live: Boolean, onTap: () -> Unit) {
    Box(Modifier.aspectRatio(1f).clipToBounds().background(Color(0xFF1E1E22)).noRippleClick(onTap), contentAlignment = Alignment.Center) {
        if (live) CameraPreviewBox(Modifier.fillMaxSize())
        CameraIcon(Color.White, 26.dp)
    }
}

/** 相机格的实时取景（后置摄像头，只预览不拍） */
@Composable
private fun CameraPreviewBox(modifier: Modifier) {
    val ctx = LocalContext.current
    @Suppress("DEPRECATION")
    val owner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    val previewView = remember {
        PreviewView(ctx).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            // TextureView 才能被 Compose 正常裁剪 / 叠加
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }
    DisposableEffect(owner) {
        var disposed = false
        var provider: ProcessCameraProvider? = null
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            if (disposed) return@addListener
            runCatching {
                val p = future.get()
                provider = p
                p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview)
            }
        }, ContextCompat.getMainExecutor(ctx))
        onDispose {
            disposed = true
            runCatching { provider?.unbind(preview) }
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

@Composable
private fun PhotoCell(uri: Uri, order: Int?, onTap: () -> Unit) {
    val ctx = LocalContext.current
    val scale by animateFloatAsState(if (order != null) 0.88f else 1f, label = "pick")
    val req = remember(uri) { ImageRequest.Builder(ctx).data(uri).size(320).build() }
    Box(Modifier.aspectRatio(1f).clipToBounds().noRippleClick(onTap)) {
        Box(Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale }.background(Bg3)) {
            AsyncImage(model = req, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Box(
            Modifier.align(Alignment.TopEnd).padding(6.dp).size(24.dp)
                .shadow(2.dp, CircleShape)
                .clip(CircleShape)
                .background(if (order != null) Accent else Color.Black.copy(alpha = 0.18f))
                .border(1.5.dp, Color.White, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (order != null) Text("${order + 1}", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun DeniedTip(onGrant: () -> Unit, onSystemPicker: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ImageIcon(TextDim, 40.dp)
        Text("允许访问相册后，可以在这里直接选图发送", color = TextSub, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
        Row(Modifier.padding(top = 14.dp)) {
            Box(Modifier.height(36.dp).clip(CircleShape).background(Accent).noRippleClick(onGrant).padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
                Text("去授权", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.width(12.dp))
            Box(Modifier.height(36.dp).clip(CircleShape).background(Bg3).noRippleClick(onSystemPicker).padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
                Text("从系统相册选择", color = TextMain, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

private data class AttachTab(val label: String, val action: AttachAction?, val icon: @Composable (Color) -> Unit)

@Composable
private fun AttachTabBar(isSingle: Boolean, canVideoCall: Boolean, onAction: (AttachAction) -> Unit) {
    val tabs = buildList {
        add(AttachTab("相册", null) { ImageIcon(it, 24.dp) })
        if (isSingle) add(AttachTab("礼物", AttachAction.Gift) { GiftIcon(it, 24.dp) })
        add(AttachTab("位置", AttachAction.Location) { PinIcon(it, 22.dp) })
        if (isSingle) {
            add(AttachTab("语音通话", AttachAction.VoiceCall) { MicIcon(it, 24.dp) })
            if (canVideoCall) add(AttachTab("视频通话", AttachAction.VideoCall) { VideoIcon(it, 24.dp) })
        }
    }
    Row(
        Modifier
            .shadow(12.dp, CircleShape)
            .clip(CircleShape)
            .background(Color.White.copy(alpha = 0.97f))
            .padding(5.dp),
    ) {
        tabs.forEach { t ->
            val on = t.action == null
            val tint = if (on) Accent else TextMain
            Column(
                Modifier.width(64.dp).height(50.dp).clip(CircleShape)
                    .background(if (on) BubbleMine else Color.Transparent)
                    .noRippleClick { t.action?.let(onAction) },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                t.icon(tint)
                Text(t.label, color = tint, fontSize = 10.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, modifier = Modifier.padding(top = 1.dp))
            }
        }
    }
}

@Composable
private fun CaptionBar(caption: String, onCaption: (String) -> Unit, count: Int, onSend: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.weight(1f).height(44.dp).shadow(8.dp, CircleShape).clip(CircleShape).background(Color.White).padding(horizontal = 16.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (caption.isEmpty()) Text("添加说明…", color = TextDim, fontSize = 15.sp)
            BasicTextField(
                value = caption, onValueChange = onCaption, singleLine = true,
                textStyle = TextStyle(color = TextMain, fontSize = 15.sp),
                cursorBrush = SolidColor(Accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(52.dp)) {
            Box(
                Modifier.align(Alignment.BottomStart).size(44.dp).shadow(8.dp, CircleShape).clip(CircleShape).background(Accent).noRippleClick(onSend),
                contentAlignment = Alignment.Center,
            ) { ArrowUpIcon(Color.White, 20.dp) }
            Box(
                Modifier.align(Alignment.TopEnd).defaultMinSize(20.dp, 20.dp).clip(CircleShape).background(Color.White)
                    .border(1.5.dp, Accent, CircleShape).padding(horizontal = 5.dp),
                contentAlignment = Alignment.Center,
            ) { Text("$count", color = Accent, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        }
    }
}
