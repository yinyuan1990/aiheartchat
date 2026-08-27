package com.wh.peiwana.ui.screen

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import com.wh.peiwana.ui.noRippleClick
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.wh.peiwana.net.Api
import com.wh.peiwana.net.EnterResp
import com.wh.peiwana.net.UserProfile
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 一机一号注册：头像+昵称+年纪+性别，账号(BNB地址)自动生成 */
@Composable
fun RegisterScreen(onDone: (UserProfile) -> Unit) {
    var nickname by rememberSaveable { mutableStateOf("") }
    var age by rememberSaveable { mutableStateOf("") }
    var gender by rememberSaveable { mutableStateOf(0) }
    var loading by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    var avatarUri by remember { mutableStateOf<Uri?>(null) }
    var showAgreement by remember { mutableStateOf(false) }
    var agreementIsPrivacy by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) avatarUri = uri
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "心之音",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Spacer(Modifier.height(24.dp))

        Surface(
            modifier = Modifier
                .size(84.dp)
                .align(Alignment.CenterHorizontally)
                .noRippleClick { pickImage.launch("image/*") },
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceVariant,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        ) {
            if (avatarUri != null) {
                AsyncImage(
                    model = avatarUri,
                    contentDescription = "头像",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("选择头像", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(20.dp))

        OutlinedTextField(
            value = nickname,
            onValueChange = { if (it.length <= 30) nickname = it },
            label = { Text("昵称") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = age,
            onValueChange = { age = it.filter { c -> c.isDigit() }.take(2) },
            label = { Text("年纪") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))

        Text("性别（注册后不可修改）", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(1 to "男", 2 to "女").forEach { (value, label) ->
                OutlinedButton(
                    onClick = { gender = value },
                    modifier = Modifier.weight(1f),
                    border = BorderStroke(
                        1.dp,
                        if (gender == value) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    ),
                ) {
                    Text(label, color = if (gender == value) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        if (error.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = {
                if (avatarUri == null) {
                    error = "请选择头像"
                    return@Button
                }
                if (nickname.isBlank() || age.isBlank() || gender == 0) {
                    error = "请填写昵称、年纪并选择性别"
                    return@Button
                }
                loading = true
                error = ""
                scope.launch {
                    try {
                        val bytes = context.contentResolver.openInputStream(avatarUri!!)!!.use { it.readBytes() }
                        val avatarUrl = Api.uploadAvatar(bytes)
                        val data = Api.request(
                            "/auth/register", "POST",
                            buildJsonObject {
                                put("deviceId", Api.deviceId)
                                put("nickname", nickname.trim())
                                put("age", age.toInt())
                                put("gender", gender)
                                put("avatar", avatarUrl)
                            },
                        )
                        val resp = Api.json.decodeFromJsonElement(EnterResp.serializer(), data!!)
                        Api.token = resp.token
                        onDone(resp.user!!)
                    } catch (e: Exception) {
                        error = e.message ?: "注册失败"
                    } finally {
                        loading = false
                    }
                }
            },
            enabled = !loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (loading) "创建中…" else "进入")
        }

        Spacer(Modifier.height(16.dp))
        Text(
            "无需密码，账号与本机自动绑定，卸载重装后自动恢复",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )

        Spacer(Modifier.height(8.dp))
        Text(
            "本平台仅限年满 18 周岁用户使用",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Row(modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("注册即代表已满 18 周岁并同意", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "《用户协议》",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.noRippleClick { agreementIsPrivacy = false; showAgreement = true },
            )
            Text("与", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "《隐私政策》",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.noRippleClick { agreementIsPrivacy = true; showAgreement = true },
            )
        }
    }

    if (showAgreement) {
        AgreementDialog(isPrivacy = agreementIsPrivacy, onClose = { showAgreement = false })
    }
}
