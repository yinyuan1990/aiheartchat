package com.wh.peiwana.ui.screen

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.Session
import com.wh.peiwana.rtc.VoiceRoomManager
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.*
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 群聊语音房面板：成员席位 + 加入/退出/静音 */
@Composable
fun VoiceRoomDialog(groupId: String, groupName: String, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val joinedGid by VoiceRoomManager.joinedGroupId.collectAsState()
    val liveMembers by VoiceRoomManager.members.collectAsState()
    val preview by VoiceRoomManager.roomPreview.collectAsState()
    val max by VoiceRoomManager.maxMembers.collectAsState()
    val muted by VoiceRoomManager.muted.collectAsState()
    val joining by VoiceRoomManager.joining.collectAsState()
    val toast by VoiceRoomManager.toastMsg.collectAsState()

    val inRoom = joinedGid == groupId
    val roomMembers = if (inRoom) liveMembers else preview[groupId] ?: emptyList()
    val isFull = roomMembers.size >= max
    var showShare by remember { mutableStateOf(false) }
    if (showShare) {
        VoiceRoomShareDialog(groupId = groupId, groupName = groupName) { showShare = false }
    }

    LaunchedEffect(groupId) { VoiceRoomManager.refreshInfo(groupId) }
    LaunchedEffect(toast) {
        toast?.let {
            android.widget.Toast.makeText(ctx, it, android.widget.Toast.LENGTH_SHORT).show()
            VoiceRoomManager.toastMsg.value = null
        }
    }

    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) {
            VoiceRoomManager.join(groupId)
        } else {
            android.widget.Toast.makeText(ctx, "需要麦克风权限才能加入语音房", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Bg2).padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("语音房", color = TextMain, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text("$groupName · ${roomMembers.size}/$max 人", color = TextSub, fontSize = 12.sp)
            Spacer(Modifier.height(18.dp))

            // 席位：房内成员 + 空位占位（每行 3 个）
            val slots: List<Any?> = roomMembers + List((max - roomMembers.size).coerceAtLeast(0)) { null }
            slots.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth().padding(bottom = 14.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    row.forEach { slot ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(72.dp)) {
                            if (slot is com.wh.peiwana.rtc.VRMember) {
                                Box {
                                    Box(Modifier.size(52.dp).clip(CircleShape).background(Bg3)) {
                                        if (!slot.avatar.isNullOrEmpty()) {
                                            AsyncImage(
                                                model = Api.fullUrl(slot.avatar!!), contentDescription = null,
                                                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                                            )
                                        }
                                    }
                                    if (slot.id == Session.uid && muted) {
                                        Text(
                                            "静", color = Color.White, fontSize = 9.sp,
                                            modifier = Modifier.align(Alignment.BottomEnd)
                                                .clip(CircleShape).background(Danger).padding(3.dp),
                                        )
                                    }
                                }
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    if (slot.id == Session.uid) "我" else (slot.nickname ?: ""),
                                    color = if (slot.id == Session.uid) Accent else TextSub,
                                    fontSize = 11.sp, maxLines = 1, textAlign = TextAlign.Center,
                                )
                            } else {
                                Box(Modifier.size(52.dp).clip(CircleShape).background(Bg3), contentAlignment = Alignment.Center) {
                                    Text("+", color = TextDim, fontSize = 18.sp)
                                }
                                Spacer(Modifier.height(4.dp))
                                Text("空位", color = TextDim, fontSize = 11.sp)
                            }
                        }
                    }
                    repeat(3 - row.size) { Spacer(Modifier.width(72.dp)) }
                }
            }

            Spacer(Modifier.height(6.dp))

            if (inRoom) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        if (muted) "已静音" else "静音",
                        color = if (muted) Color.White else TextMain, fontSize = 14.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp))
                            .background(if (muted) Accent else Bg3)
                            .noRippleClick { VoiceRoomManager.toggleMute() }
                            .padding(vertical = 12.dp),
                    )
                    Text(
                        "退出语音房",
                        color = Color.White, fontSize = 14.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp))
                            .background(Danger)
                            .noRippleClick { VoiceRoomManager.leave() }
                            .padding(vertical = 12.dp),
                    )
                }
                // 分享：独立分享页（卡片 + 保存/发送）
                val token by VoiceRoomManager.qrToken.collectAsState()
                if (token.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "分享二维码邀请好友",
                        color = Accent, fontSize = 13.sp,
                        modifier = Modifier.noRippleClick { showShare = true },
                    )
                }
            } else {
                Text(
                    if (joining) "加入中…" else if (isFull) "房间已满" else if (roomMembers.isEmpty()) "开启语音房（仅群主）" else "加入语音房",
                    color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp))
                        .background(if (joining || isFull) Bg3 else Accent)
                        .noRippleClick { if (!joining && !isFull) micPerm.launch(Manifest.permission.RECORD_AUDIO) }
                        .padding(vertical = 12.dp),
                )
            }

            Spacer(Modifier.height(10.dp))
            Text(
                if (inRoom) "关闭面板不会退出，可回聊天页继续说话" else "加入后房内成员可实时语音",
                color = TextDim, fontSize = 11.sp,
            )
        }
    }
}

/** 语音房分享页：卡片预览 + 保存图片 / 分享发送 */
@Composable
fun VoiceRoomShareDialog(groupId: String, groupName: String, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val token by VoiceRoomManager.qrToken.collectAsState()
    var cardBmp by remember { mutableStateOf<android.graphics.Bitmap?>(null) }

    LaunchedEffect(groupId, token) {
        if (token.isEmpty()) return@LaunchedEffect
        // 群信息：头像 + 群主昵称
        var avatar = ""
        var owner = ""
        runCatching {
            val g = com.wh.peiwana.net.Api.request("/im/group/$groupId")!!.jsonObject
            avatar = g["avatar"]?.jsonPrimitive?.contentOrNull ?: ""
            owner = g["members"]?.jsonArray
                ?.map { it.jsonObject }
                ?.firstOrNull { it["role"]?.jsonPrimitive?.contentOrNull == "owner" }
                ?.get("nickname")?.jsonPrimitive?.contentOrNull ?: ""
        }
        val listeners = VoiceRoomManager.memberCount(groupId).coerceAtLeast(1)
        cardBmp = buildVroomShareBitmap(ctx, groupName, owner, avatar, listeners, vroomQrContent(groupId, token))
    }

    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Bg).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val bmp = cardBmp
            if (bmp != null) {
                androidx.compose.foundation.Image(
                    bitmap = bmp.asImageBitmap(), contentDescription = null,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)),
                )
            } else {
                Box(Modifier.fillMaxWidth().height(320.dp), contentAlignment = Alignment.Center) {
                    Text("生成中…", color = TextSub, fontSize = 13.sp)
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "保存图片",
                    color = TextMain, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp)).background(Bg3)
                        .noRippleClick {
                            cardBmp?.let {
                                val ok = saveQrToGallery(ctx, it, "语音房邀请")
                                android.widget.Toast.makeText(ctx, if (ok) "已保存到相册" else "保存失败", android.widget.Toast.LENGTH_SHORT).show()
                            }
                        }
                        .padding(vertical = 12.dp),
                )
                Text(
                    "分享发送",
                    color = Color.White, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).clip(RoundedCornerShape(22.dp)).background(Accent)
                        .noRippleClick { cardBmp?.let { shareQr(ctx, it, "分享语音房") } }
                        .padding(vertical = 12.dp),
                )
            }
            Spacer(Modifier.height(8.dp))
            Text("关闭", color = TextDim, fontSize = 13.sp, modifier = Modifier.noRippleClick(onDismiss).padding(6.dp))
        }
    }
}

/**
 * 语音房分享卡片（Canvas 绘制成图，预览/保存/分享共用同一张图保证一致）：
 * 绿色徽标 + 大标题 + 群主行 + 加入条件/收听人数 + 品牌与二维码。
 */
suspend fun buildVroomShareBitmap(
    ctx: android.content.Context,
    groupName: String,
    ownerName: String,
    avatarUrl: String,
    listeners: Int,
    qrContent: String,
): android.graphics.Bitmap {
    // 头像预下载（拿不到就画占位圆）
    val avatarBmp: android.graphics.Bitmap? = if (avatarUrl.isEmpty()) null else runCatching {
        val loader = coil.ImageLoader(ctx)
        val req = coil.request.ImageRequest.Builder(ctx)
            .data(com.wh.peiwana.net.Api.fullUrl(avatarUrl)).allowHardware(false).build()
        (loader.execute(req).drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
    }.getOrNull()

    return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
        val w = 720
        val h = 900
        val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        c.drawColor(0xFF141418.toInt())

        // 白色圆角卡片
        val card = android.graphics.RectF(24f, 24f, w - 24f, h - 24f)
        c.drawRoundRect(card, 40f, 40f, android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE })
        val left = 68f
        val right = w - 68f

        fun paint(colorInt: Int, size: Float, bold: Boolean = false, alignRight: Boolean = false) =
            android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = colorInt
                textSize = size
                isFakeBoldText = bold
                textAlign = if (alignRight) android.graphics.Paint.Align.RIGHT else android.graphics.Paint.Align.LEFT
            }
        val black = 0xFF111111.toInt()
        val gray = 0xFF8A8A92.toInt()

        // 绿色徽标（含波形小竖条）
        val badgePaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF21B84F.toInt() }
        c.drawRoundRect(android.graphics.RectF(left, 76f, left + 196f, 138f), 31f, 31f, badgePaint)
        val barPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE }
        val barX = left + 28f
        val barH = floatArrayOf(14f, 26f, 18f)
        barH.forEachIndexed { i, bh ->
            c.drawRoundRect(android.graphics.RectF(barX + i * 12f, 107f - bh / 2, barX + i * 12f + 6f, 107f + bh / 2), 3f, 3f, barPaint)
        }
        c.drawText("语音房", barX + 44f, 118f, paint(android.graphics.Color.WHITE, 30f, bold = true))

        // 标题（超长省略）
        val title = android.text.TextUtils.ellipsize("$groupName 的语音房", paint(black, 46f, bold = true), right - left, android.text.TextUtils.TruncateAt.END).toString()
        c.drawText(title, left, 228f, paint(black, 46f, bold = true))

        // 群主行：头像 + 昵称 + 「群主」
        val avatarRect = android.graphics.RectF(left, 268f, left + 64f, 332f)
        if (avatarBmp != null) {
            val path = android.graphics.Path().apply { addOval(avatarRect, android.graphics.Path.Direction.CW) }
            c.save()
            c.clipPath(path)
            c.drawBitmap(avatarBmp, null, avatarRect, android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG or android.graphics.Paint.FILTER_BITMAP_FLAG))
            c.restore()
        } else {
            c.drawOval(avatarRect, android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFE5E5EA.toInt() })
        }
        val ownerText = android.text.TextUtils.ellipsize(ownerName.ifEmpty { groupName }, paint(black, 30f), right - left - 220f, android.text.TextUtils.TruncateAt.END).toString()
        c.drawText(ownerText, left + 84f, 312f, paint(black, 30f))
        c.drawText("群主", left + 84f + paint(black, 30f).measureText(ownerText) + 18f, 310f, paint(gray, 24f))

        // 加入条件（左）/ 收听人数（右）
        c.drawText("加入条件", left, 430f, paint(gray, 24f))
        c.drawText("扫码即入", left, 482f, paint(black, 36f, bold = true))
        c.drawText("语音房", right, 430f, paint(gray, 24f, alignRight = true))
        c.drawText("${listeners}人收听", right, 482f, paint(black, 36f, bold = true, alignRight = true))

        // 分隔线
        c.drawRect(left, 540f, right, 542f, android.graphics.Paint().apply { color = 0xFFEDEDF0.toInt() })

        // 品牌 + 二维码
        c.drawText("心之音", left, 668f, paint(black, 40f, bold = true))
        c.drawText("扫一扫，加入语音房", left, 720f, paint(gray, 24f))
        val qrBg = android.graphics.RectF(right - 224f, 596f, right, 820f)
        c.drawRoundRect(qrBg, 18f, 18f, android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF4F4F6.toInt() })
        val qr = makeQrBitmap(qrContent, 192)
        c.drawBitmap(qr, qrBg.left + 16f, qrBg.top + 16f, null)

        bmp
    }
}
