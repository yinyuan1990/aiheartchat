package com.wh.peiwana.ui.screen

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.ui.*
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

@Composable
fun PublishScreen(onBack: () -> Unit, onDone: () -> Unit) {
    var mode by remember { mutableStateOf("photo") }
    var content by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("") }
    var images by remember { mutableStateOf<List<String>>(emptyList()) }
    var videoUrl by remember { mutableStateOf("") }
    var coverUrl by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    // 进入发布页自动定位填充城市（并刷新经纬度缓存）
    LaunchedEffect(Unit) {
        if (city.isEmpty()) {
            detectCity(ctx)?.let { if (city.isEmpty()) city = it }
        }
    }

    val pickImages = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        scope.launch {
            busy = true
            progress = 0f
            val picked = uris.take(9 - images.size)
            picked.forEachIndexed { idx, uri ->
                runCatching {
                    val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    val url = Api.upload("image", bytes, "img.jpg", "image/jpeg") { p ->
                        progress = (idx + p) / picked.size
                    }
                    images = images + url
                }
            }
            busy = false
            progress = 0f
        }
    }
    val pickVideo = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            busy = true
            progress = 0f
            runCatching {
                val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                videoUrl = Api.upload("video", bytes, "v.mp4", "video/mp4") { p -> progress = p }
                // 首帧作为封面上传，供广场卡片显示
                val retriever = android.media.MediaMetadataRetriever()
                retriever.setDataSource(ctx, uri)
                retriever.frameAtTime?.let { frame ->
                    val out = java.io.ByteArrayOutputStream()
                    frame.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
                    coverUrl = Api.upload("image", out.toByteArray(), "cover.jpg", "image/jpeg")
                }
                retriever.release()
            }
            busy = false
            progress = 0f
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp, 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(40.dp).noRippleClick(onBack), contentAlignment = Alignment.Center) { Text("×", color = TextSub, fontSize = 26.sp) }
            Text("发布动态", color = TextMain, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.weight(1f))
            Text(if (busy) "上传中" else "", color = TextSub, fontSize = 12.sp)
        }
        Column(modifier = Modifier.weight(1f).padding(horizontal = 16.dp)) {
            Row(modifier = Modifier.padding(bottom = 14.dp).clip(RoundedCornerShape(11.dp)).background(Bg3).padding(3.dp)) {
                listOf("photo" to "图文", "video" to "视频").forEach { (k, label) ->
                    Box(modifier = Modifier.weight(1f).clip(RoundedCornerShape(9.dp)).background(if (mode == k) Bg else Color.Transparent).clickable { mode = k }.padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(label, color = if (mode == k) TextMain else TextSub, fontSize = 13.sp)
                    }
                }
            }
            if (mode == "photo") {
                LazyVerticalGrid(columns = GridCells.Fixed(3), modifier = Modifier.height(((images.size + 1 + 2) / 3 * 120).dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), userScrollEnabled = false) {
                    items(images) { url ->
                        AsyncImage(model = Api.fullUrl(url), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).clickable { images = images - url })
                    }
                    if (images.size < 9) item {
                        Box(modifier = Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(Bg2).clickable { pickImages.launch("image/*") }, contentAlignment = Alignment.Center) {
                            Text("+", color = TextDim, fontSize = 24.sp)
                        }
                    }
                }
            } else {
                if (videoUrl.isEmpty()) {
                    Box(modifier = Modifier.fillMaxWidth().aspectRatio(16 / 9f).clip(RoundedCornerShape(12.dp)).background(Bg2).clickable { pickVideo.launch("video/*") }, contentAlignment = Alignment.Center) {
                        Text("+ 选择视频", color = TextDim, fontSize = 13.sp)
                    }
                } else {
                    Box(modifier = Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black).clickable { pickVideo.launch("video/*") }, contentAlignment = Alignment.Center) {
                        AsyncImage(
                            model = coil.request.ImageRequest.Builder(ctx)
                                .data(Api.fullUrl(videoUrl))
                                .decoderFactory(coil.decode.VideoFrameDecoder.Factory())
                                .build(),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize(),
                        )
                        Text("▶", color = Color.White, fontSize = 40.sp)
                        Text("重选", color = Color.White, fontSize = 12.sp, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.5f)).padding(horizontal = 8.dp, vertical = 3.dp))
                    }
                }
            }
            OutlinedTextField(value = content, onValueChange = { content = it }, placeholder = { Text("添加作品描述…") }, modifier = Modifier.fillMaxWidth().padding(top = 14.dp).height(120.dp))
            OutlinedTextField(value = city, onValueChange = { city = it }, placeholder = { Text("所在城市（可选）") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
        }
        Column(modifier = Modifier.padding(16.dp)) {
            if (busy) {
                androidx.compose.material3.LinearProgressIndicator(
                    progress = { progress },
                    color = Accent, trackColor = Bg3,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                )
                Text("上传中 ${(progress * 100).toInt()}%", color = TextSub, fontSize = 12.sp, modifier = Modifier.padding(bottom = 8.dp))
            }
            AccentButton("发布", enabled = !busy) {
                scope.launch {
                    val body = buildJsonObject {
                        put("type", JsonPrimitive(if (mode == "video") 2 else 1))
                        put("content", JsonPrimitive(content.trim()))
                        put("images", JsonArray(images.map { JsonPrimitive(it) }))
                        if (mode == "video") {
                            put("videoUrl", JsonPrimitive(videoUrl))
                            if (coverUrl.isNotEmpty()) put("coverUrl", JsonPrimitive(coverUrl))
                        }
                        if (city.isNotEmpty()) put("cityName", JsonPrimitive(city))
                        LocationCache.lat?.let { put("latitude", JsonPrimitive(it)) }
                        LocationCache.lng?.let { put("longitude", JsonPrimitive(it)) }
                    }
                    runCatching { Api.request("/moments", "POST", body) }.onSuccess { onDone() }
                }
            }
        }
    }
}
