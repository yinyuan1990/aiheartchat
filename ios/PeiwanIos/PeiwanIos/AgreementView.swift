import SwiftUI

/// 用户协议 / 隐私政策 全文（与 Web 端一致）
enum AgreementTexts {
    static var userAgreement: String { t("agreement.userBody", ["app": t("app.name")]) }

    static var privacyPolicy: String { t("agreement.privacyBody", ["app": t("app.name")]) }
}

/// 协议全文弹层
struct AgreementSheet: View {
    let isPrivacy: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isPrivacy ? t("agreement.privacyTitle") : t("agreement.userTitle"))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                Button(t("common.close")) { dismiss() }
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSub)
            }
            .padding(.horizontal, 20).padding(.vertical, 16)

            ScrollView {
                Text(isPrivacy ? AgreementTexts.privacyPolicy : AgreementTexts.userAgreement)
                    .font(.system(size: 14))
                    .lineSpacing(7)
                    .foregroundStyle(Theme.textSub)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 32)
            }
        }
        .fullBg()
    }
}
