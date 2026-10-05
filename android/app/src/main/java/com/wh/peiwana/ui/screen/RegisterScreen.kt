package com.wh.peiwana.ui.screen

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.wh.peiwana.i18n.t
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
    // 0 = 未选择；年纪用滚轮选择而不是输入（与网页一致）
    var age by rememberSaveable { mutableStateOf(0) }
    var showAgePicker by remember { mutableStateOf(false) }
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
            text = t("app.name"),
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
                    contentDescription = t("register.avatar"),
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(t("register.chooseAvatar"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(20.dp))

        OutlinedTextField(
            value = nickname,
            onValueChange = { if (it.length <= 30) nickname = it },
            label = { Text(t("register.nickname")) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))

        // 年纪：点击弹滚轮选择（外观对齐上面的 OutlinedTextField）
        Box(
            Modifier.fillMaxWidth().height(56.dp)
                .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(4.dp))
                .noRippleClick { showAgePicker = true }
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                if (age > 0) t("register.ageN", "n" to age) else t("register.agePick"),
                color = if (age > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
            )
            Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.titleMedium, modifier = Modifier.align(Alignment.CenterEnd))
        }
        Spacer(Modifier.height(16.dp))

        Text(t("register.genderHint"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(1 to t("me.male"), 2 to t("me.female")).forEach { (value, label) ->
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
                    error = t("register.needAvatar")
                    return@Button
                }
                if (nickname.isBlank() || age == 0 || gender == 0) {
                    error = t("register.errFields")
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
                                put("age", age)
                                put("gender", gender)
                                put("avatar", avatarUrl)
                            },
                        )
                        val resp = Api.json.decodeFromJsonElement(EnterResp.serializer(), data!!)
                        Api.token = resp.token
                        onDone(resp.user!!)
                        // 通过 TA 的专属邀请页装的：进主页后直接打开 TA 的个人主页（MainActivity 监听 openUserHome）
                        resp.inviter?.let { com.wh.peiwana.rtc.CallManager.openUserHome.value = it.id }
                    } catch (e: Exception) {
                        error = e.message ?: t("register.failed")
                    } finally {
                        loading = false
                    }
                }
            },
            enabled = !loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (loading) t("register.creating") else t("register.enter"))
        }

        Spacer(Modifier.height(16.dp))
        Text(
            t("register.noPassword"),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )

        Spacer(Modifier.height(8.dp))
        Text(
            t("register.adultsOnly"),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Row(modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text(t("register.agreePrefix"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                t("register.userAgreement"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.noRippleClick { agreementIsPrivacy = false; showAgreement = true },
            )
            Text(t("register.and"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                t("register.privacyPolicy"),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.noRippleClick { agreementIsPrivacy = true; showAgreement = true },
            )
        }
    }

    if (showAgreement) {
        AgreementDialog(isPrivacy = agreementIsPrivacy, onClose = { showAgreement = false })
    }
    if (showAgePicker) {
        AgePickerSheet(
            initial = if (age > 0) age else 22,
            onDismiss = { showAgePicker = false },
            onConfirm = { age = it; showAgePicker = false },
        )
    }
}
