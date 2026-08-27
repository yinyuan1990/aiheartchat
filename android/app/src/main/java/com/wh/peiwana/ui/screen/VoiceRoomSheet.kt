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
            } else {
                Text(
                    if (joining) "加入中…" else if (isFull) "房间已满" else "加入语音房",
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
