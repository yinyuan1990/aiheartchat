import SwiftUI

/// 审核模式登录页（后台开关 review_mode_ios 打开时启动显示）：
/// 账号 + 密码 → POST /auth/demo-login。审核员用 11111111111 / 123456 进入演示账号；
/// 页面底部保留「注册新账号」入口走原一机一号注册。
struct LoginView: View {
    @EnvironmentObject var state: AppState
    @State private var username = ""
    @State private var password = ""
    @State private var loading = false
    @State private var error = ""
    @FocusState private var focus: Field?
    private enum Field { case user, pass }

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Text("心之音")
                .font(.system(size: 34, weight: .semibold))
                .tracking(8)
                .foregroundStyle(Theme.gold)
            Text("爱情和金钱无关 · 与内心相连")
                .font(.system(size: 13))
                .tracking(2)
                .foregroundStyle(Theme.textSub)
                .padding(.bottom, 14)

            TextField("", text: $username, prompt: Text("账号").foregroundColor(Theme.textSub))
                .keyboardType(.numberPad)
                .textContentType(.username)
                .focused($focus, equals: .user)
                .padding(13)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
                .foregroundStyle(Theme.text)
            SecureField("", text: $password, prompt: Text("密码").foregroundColor(Theme.textSub))
                .textContentType(.password)
                .focused($focus, equals: .pass)
                .padding(13)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
                .foregroundStyle(Theme.text)

            if !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(Theme.danger)
            }

            Button(action: submit) {
                Text(loading ? "登录中…" : "登录")
                    .font(.system(size: 16, weight: .semibold))
                    .tracking(4)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.accentGrad))
                    .foregroundStyle(.white)
            }
            .disabled(loading)
            .padding(.top, 8)

            Button {
                state.stage = .register
            } label: {
                Text("没有账号？注册新账号")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSub)
            }
            .padding(.top, 4)

            Spacer()

            Text("本平台仅限年满 18 周岁用户使用")
                .font(.caption2)
                .foregroundStyle(Theme.textSub)
        }
        .padding(24)
        .onAppear { focus = .user }
    }

    private func submit() {
        let u = username.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty else { error = "请输入账号"; return }
        guard !password.isEmpty else { error = "请输入密码"; return }
        loading = true
        error = ""
        Task {
            do {
                let resp: EnterResp = try await Api.request("/auth/demo-login", method: "POST", body: ["username": u, "password": password])
                Api.token = resp.token
                state.user = resp.user
                state.stage = .main
            } catch {
                self.error = (error as? ApiError)?.msg ?? "账号或密码错误"
            }
            loading = false
        }
    }
}
