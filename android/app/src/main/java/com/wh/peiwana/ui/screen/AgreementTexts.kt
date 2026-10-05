package com.wh.peiwana.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.wh.peiwana.i18n.t
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.Bg2
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub

/** 用户协议 / 隐私政策 全文（与 Web / iOS 一致） */
val USER_AGREEMENT: String get() = t("agreement.userBody", "app" to t("app.name"))

val PRIVACY_POLICY: String get() = t("agreement.privacyBody", "app" to t("app.name"))

/** 协议全文弹层 */
@Composable
fun AgreementDialog(isPrivacy: Boolean, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.82f)
                .clip(RoundedCornerShape(16.dp))
                .background(Bg2)
                .padding(20.dp),
        ) {
            Row(modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Text(
                    if (isPrivacy) t("agreement.privacyTitle") else t("agreement.userTitle"),
                    color = TextMain,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Text(t("common.close"), color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick(onClose))
            }
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    if (isPrivacy) PRIVACY_POLICY else USER_AGREEMENT,
                    color = TextSub,
                    fontSize = 14.sp,
                    lineHeight = 24.sp,
                )
                Spacer(Modifier.padding(bottom = 16.dp))
            }
        }
    }
}
