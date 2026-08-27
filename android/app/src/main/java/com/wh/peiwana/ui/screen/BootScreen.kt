package com.wh.peiwana.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.EnterResp
import com.wh.peiwana.net.UserProfile
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 启动进入：设备已注册直接恢复账号，否则去注册（无密码） */
@Composable
fun BootScreen(onRegistered: (UserProfile) -> Unit, onNeedRegister: () -> Unit) {
    LaunchedEffect(Unit) {
        try {
            val data = Api.request(
                "/auth/enter", "POST",
                buildJsonObject { put("deviceId", Api.deviceId) },
            )
            val resp = Api.json.decodeFromJsonElement(EnterResp.serializer(), data!!)
            if (resp.registered && resp.token != null && resp.user != null) {
                Api.token = resp.token
                onRegistered(resp.user)
            } else {
                onNeedRegister()
            }
        } catch (_: Exception) {
            onNeedRegister()
        }
    }

    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "心之音",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        CircularProgressIndicator(
            modifier = Modifier.padding(top = 24.dp),
            color = MaterialTheme.colorScheme.primary,
        )
    }
}
