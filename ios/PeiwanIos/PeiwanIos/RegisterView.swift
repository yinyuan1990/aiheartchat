import PhotosUI
import SwiftUI

/// 一机一号注册：头像+昵称+年纪+性别，账号(BNB地址)自动生成，无密码
struct RegisterView: View {
    @EnvironmentObject var state: AppState
    @State private var nickname = ""
    /// 年纪用滚轮选择而不是输入（与网页一致），nil = 未选择
    @State private var age: Int?
    @State private var showAgeSheet = false
    @State private var pendingAge = 22
    @State private var gender = 0
    @State private var loading = false
    @State private var error = ""
    @State private var avatarData: Data?
    @State private var showAgreement = false
    @State private var agreementIsPrivacy = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("心之音")
                .font(.system(size: 34, weight: .semibold))
                .tracking(8)
                .foregroundStyle(Theme.gold)
                .padding(.bottom, 8)

            CompatPhotoPicker(kind: .images, onPicked: { datas in
                avatarData = datas.first
            }) {
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
            .padding(.bottom, 8)

            field("昵称", text: $nickname)
            // 年纪：点击弹滚轮选择
            Button {
                pendingAge = age ?? 22
                showAgeSheet = true
            } label: {
                HStack {
                    Text(age.map { "\($0) 岁" } ?? "年纪（点击选择）")
                        .foregroundStyle(age == nil ? Theme.textSub : Theme.text)
                    Spacer()
                    Text("›").font(.system(size: 20)).foregroundStyle(Theme.textDim)
                }
                .padding(13)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
            }
            .buttonStyle(.plain)

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
        // 年纪滚轮：底部弹层，取消/确定（与编辑资料一致）
        .sheet(isPresented: $showAgeSheet) {
            VStack(spacing: 0) {
                HStack {
                    Button("取消") { showAgeSheet = false }
                        .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Spacer()
                    Text("选择年纪").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button("确定") { age = pendingAge; showAgeSheet = false }
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
                }
                .padding(16)
                Picker("", selection: $pendingAge) {
                    ForEach(18...70, id: \.self) {
                        Text("\($0)").foregroundStyle(Theme.text).tag($0)
                    }
                }
                .pickerStyle(.wheel)
            }
            .compatDetents(height: 300)
            .compatSheetBackground(Theme.bg2)
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(label).foregroundColor(Theme.textSub))
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
        guard !nickname.trimmingCharacters(in: .whitespaces).isEmpty, let age, gender != 0 else {
            error = "请填写昵称、选择年纪和性别"
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
                    "age": age,
                    "gender": gender,
                    "avatar": avatarUrl,
                ])
                Api.token = resp.token
                state.user = resp.user
                state.stage = .main
                // 通过 TA 的专属邀请页装的：主页出现后直接打开 TA 的个人主页（RootView 监听 openUserHome）
                if let inviter = resp.inviter {
                    try? await Task.sleep(nanoseconds: 600_000_000)
                    CallManager.shared.openUserHome = inviter.id
                }
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }
}
