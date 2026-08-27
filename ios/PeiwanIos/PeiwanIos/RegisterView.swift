import PhotosUI
import SwiftUI

/// 一机一号注册：头像+昵称+年纪+性别，账号(BNB地址)自动生成，无密码
struct RegisterView: View {
    @Environment(AppState.self) var state
    @State private var nickname = ""
    @State private var age = ""
    @State private var gender = 0
    @State private var loading = false
    @State private var error = ""
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarData: Data?
    @State private var showAgreement = false
    @State private var agreementIsPrivacy = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("心之音")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.gold)
                .tracking(8)
                .padding(.bottom, 8)

            PhotosPicker(selection: $avatarItem, matching: .images) {
                ZStack {
                    Circle()
                        .fill(Theme.bg3)
                        .frame(width: 84, height: 84)
                        .overlay(Circle().stroke(Theme.goldDim, lineWidth: 1))
                    if let avatarData, let image = UIImage(data: avatarData) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 84, height: 84)
                            .clipShape(Circle())
                    } else {
                        Text("选择头像")
                            .font(.caption2)
                            .foregroundStyle(Theme.textSub)
                    }
                }
            }
            .onChange(of: avatarItem) { _, item in
                Task {
                    if let data = try? await item?.loadTransferable(type: Data.self),
                       let image = UIImage(data: data) {
                        avatarData = image.jpegData(compressionQuality: 0.8)
                    }
                }
            }
            .padding(.bottom, 8)

            field("昵称", text: $nickname)
            field("年纪", text: $age)
                .keyboardType(.numberPad)
                .onChange(of: age) { _, v in
                    age = String(v.filter(\.isNumber).prefix(2))
                }

            VStack(alignment: .leading, spacing: 8) {
                Text("性别（注册后不可修改）")
                    .font(.caption)
                    .foregroundStyle(Theme.textSub)
                HStack(spacing: 12) {
                    genderItem(1, "男")
                    genderItem(2, "女")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }

            Button(action: submit) {
                Text(loading ? "创建中…" : "进入")
                    .font(.system(size: 16, weight: .semibold))
                    .tracking(4)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(LinearGradient(colors: [Theme.gold, Theme.gold2], startPoint: .leading, endPoint: .trailing))
                    )
                    .foregroundStyle(Color.black.opacity(0.85))
            }
            .disabled(loading)
            .padding(.top, 8)

            Text("无需密码，账号与本机自动绑定\n卸载重装后自动恢复")
                .font(.caption)
                .foregroundStyle(Theme.textSub)
                .multilineTextAlignment(.center)
                .lineSpacing(4)

            // 18 岁限制 + 协议入口
            VStack(spacing: 3) {
                Text("本平台仅限年满 18 周岁用户使用")
                    .font(.caption2)
                    .foregroundStyle(Theme.textSub)
                HStack(spacing: 0) {
                    Text("注册即代表已满 18 周岁并同意")
                        .font(.caption2)
                        .foregroundStyle(Theme.textSub)
                    Text("《用户协议》")
                        .font(.caption2)
                        .foregroundStyle(Theme.accent)
                        .onTapGesture { agreementIsPrivacy = false; showAgreement = true }
                    Text("与")
                        .font(.caption2)
                        .foregroundStyle(Theme.textSub)
                    Text("《隐私政策》")
                        .font(.caption2)
                        .foregroundStyle(Theme.accent)
                        .onTapGesture { agreementIsPrivacy = true; showAgreement = true }
                }
            }
            .padding(.top, 2)

            Spacer()
        }
        .padding(24)
        .sheet(isPresented: $showAgreement) {
            AgreementSheet(isPrivacy: agreementIsPrivacy)
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(label).foregroundStyle(Theme.textSub))
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
            .foregroundStyle(Theme.text)
    }

    private func genderItem(_ value: Int, _ label: String) -> some View {
        Button {
            gender = value
        } label: {
            Text(label)
                .tracking(2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(gender == value ? Theme.gold : Color(white: 0.2), lineWidth: 1)
                )
                .foregroundStyle(gender == value ? Theme.gold : Theme.textSub)
        }
    }

    private func submit() {
        guard let avatarData else {
            error = "请选择头像"
            return
        }
        guard !nickname.trimmingCharacters(in: .whitespaces).isEmpty, !age.isEmpty, gender != 0 else {
            error = "请填写昵称、年纪并选择性别"
            return
        }
        loading = true
        error = ""
        Task {
            do {
                let avatarUrl = try await Api.uploadAvatar(avatarData)
                let resp: EnterResp = try await Api.request("/auth/register", method: "POST", body: [
                    "deviceId": Api.deviceId,
                    "nickname": nickname.trimmingCharacters(in: .whitespaces),
                    "age": Int(age) ?? 18,
                    "gender": gender,
                    "avatar": avatarUrl,
                ])
                Api.token = resp.token
                state.user = resp.user
                state.stage = .main
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }
}
