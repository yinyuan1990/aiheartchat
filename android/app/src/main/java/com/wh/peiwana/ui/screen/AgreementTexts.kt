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
import com.wh.peiwana.ui.noRippleClick
import com.wh.peiwana.ui.theme.Bg2
import com.wh.peiwana.ui.theme.TextMain
import com.wh.peiwana.ui.theme.TextSub

/** 用户协议 / 隐私政策 全文（与 Web / iOS 一致） */
const val USER_AGREEMENT = """欢迎使用心之音（以下简称"本平台"）。请在使用前仔细阅读本协议，使用本平台即表示您同意以下条款。

一、年龄限制
本平台仅面向年满 18 周岁的成年人。注册或使用本平台即表示您确认已年满 18 周岁。若发现用户未满 18 周岁，平台有权立即终止服务并注销账号。

二、账号规则
1. 本平台采用一机一号制度，账号与设备自动绑定，无需密码。
2. 注册时选择的性别不可修改，请如实填写。
3. 账号仅限本人使用，不得出售、出租、转让。

三、行为规范
使用本平台时，您承诺不发布、传播以下内容：
1. 违反法律法规的内容；
2. 色情、赌博、暴力、恐怖内容；
3. 骚扰、辱骂、诽谤他人的内容；
4. 诈骗、虚假宣传或垃圾广告信息。
违反上述规范的，平台有权删除内容、限制功能或永久封禁账号。

四、积分说明
1. 平台积分为虚拟道具，仅用于平台内消费（消息、通话、礼物、约单等）。
2. 积分不可兑换为法定货币，平台不提供任何形式的兑现服务。
3. 因违规被封禁的账号，其积分不予退还。

五、线下活动安全
通过平台约单进行线下见面时，请注意自身安全，选择公共场所。平台仅提供信息撮合，对线下行为不承担责任，如遇纠纷可通过平台申请仲裁。

六、内容责任
您在平台发布的动态、评论、消息等内容由您本人负责。平台有权对违规内容进行处理并配合监管部门调查。

七、服务变更与终止
平台有权根据运营需要变更、暂停或终止部分或全部服务，重大变更将提前公告。

八、协议修改
平台可能不时修改本协议，修改后的协议在平台内公布后生效。继续使用即视为接受修改。"""

const val PRIVACY_POLICY = """心之音（以下简称"本平台"）非常重视您的隐私。本政策说明我们如何收集、使用和保护您的信息。

一、我们收集的信息
1. 注册信息：昵称、头像、年龄、性别；
2. 设备信息：设备标识符（用于一机一号账号绑定与找回）；
3. 位置信息：在您授权后，用于同城内容推荐和距离显示；
4. 实名信息：女性用户自愿提交的姓名与身份证号（仅用于实名核验）；
5. 使用记录：聊天消息、动态、通话记录、积分明细。

二、信息的使用
1. 提供核心功能：消息收发、音视频通话、动态发布、约单撮合；
2. 同城推荐与距离计算；
3. 账号安全与违规行为处置；
4. 积分结算与对账。

三、信息的存储与保护
1. 聊天消息采用加密方式存储与传输；
2. 实名信息与身份证号加密保存，员工无法查看完整信息；
3. 数据存储在中国境内的服务器。

四、信息共享
我们不会向任何第三方出售您的个人信息。仅在以下情况共享：
1. 获得您的明确同意；
2. 法律法规要求或监管部门依法调取。

五、您的权利
1. 您可以随时修改昵称、头像等资料；
2. 您可以删除自己发布的动态、清空聊天记录；
3. 如需注销账号，可联系平台客服处理。

六、未成年人保护
本平台不向未满 18 周岁的用户提供服务。如发现未成年人使用，我们将立即注销相关账号并删除其信息。

七、政策更新
本政策可能不时更新，更新后将在平台内公布。"""

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
                    if (isPrivacy) "隐私政策" else "用户协议",
                    color = TextMain,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Text("关闭", color = TextSub, fontSize = 14.sp, modifier = Modifier.noRippleClick(onClose))
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
