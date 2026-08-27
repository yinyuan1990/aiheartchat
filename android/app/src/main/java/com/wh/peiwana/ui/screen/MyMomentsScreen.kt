package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.Moment
import com.wh.peiwana.ui.NavBar
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun MyMomentsScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    var items by remember { mutableStateOf<List<Moment>>(emptyList()) }
    var deleting by remember { mutableStateOf<Moment?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { items = runCatching { Api.getList<Moment>("/moments/mine") }.getOrDefault(emptyList()) }
    Column(Modifier.fillMaxSize()) {
        NavBar("我的动态", onBack)
        LazyVerticalGrid(columns = GridCells.Fixed(2), contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(items, key = { it.id }) { m ->
                val cover = if (m.type == 2) m.coverUrl else m.images.firstOrNull() ?: ""
                Box {
                    Column(modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Bg2).clickable { onOpen(m.id) }) {
                        if (cover.isNotEmpty()) AsyncImage(model = Api.fullUrl(cover), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(150.dp))
                        else Box(Modifier.fillMaxWidth().height(110.dp).background(Bg3).padding(14.dp)) { Text(m.content, color = TextMain, fontSize = 14.sp, maxLines = 4) }
                        Column(Modifier.padding(10.dp)) {
                            if (cover.isNotEmpty() && m.content.isNotEmpty()) Text(m.content, color = TextMain, fontSize = 13.sp, maxLines = 2)
                            Text("赞 ${m.likeCount} · 评 ${m.commentCount}", color = TextDim, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                    Box(
                        modifier = Modifier.align(Alignment.TopEnd).padding(6.dp).size(26.dp).clip(RoundedCornerShape(13.dp))
                            .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.55f)).noRippleClick { deleting = m },
                        contentAlignment = Alignment.Center,
                    ) { Text("×", color = androidx.compose.ui.graphics.Color.White, fontSize = 16.sp) }
                }
            }
            if (items.isEmpty()) item { Text("还没发布过动态", color = TextSub, modifier = Modifier.padding(40.dp)) }
        }
    }
    deleting?.let { m ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { deleting = null },
            containerColor = Bg2,
            title = { Text("删除动态", color = TextMain) },
            text = { Text("删除后不可恢复，确定删除这条动态吗？", color = TextSub) },
            confirmButton = {
                Text("删除", color = Danger, modifier = Modifier.noRippleClick {
                    scope.launch {
                        runCatching { Api.request("/moments/${m.id}", "DELETE") }
                            .onSuccess { items = items - m }
                        deleting = null
                    }
                }.padding(8.dp))
            },
            dismissButton = { Text("取消", color = TextSub, modifier = Modifier.noRippleClick { deleting = null }.padding(8.dp)) },
        )
    }
}
