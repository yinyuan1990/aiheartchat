import SwiftUI

/// 启动进入：设备已注册直接恢复账号，否则去注册（无密码）
struct BootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 24) {
            Text("心之音")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.gold)
                .tracking(8)
            ProgressView()
                .tint(Theme.gold)
        }
        .task {
            do {
                let resp: EnterResp = try await Api.request("/auth/enter", method: "POST", body: ["deviceId": Api.deviceId])
                if resp.registered, let token = resp.token, let user = resp.user {
                    Api.token = token
                    state.user = user
                    state.stage = .main
                } else {
                    state.stage = .register
                }
            } catch {
                state.stage = .register
            }
        }
    }
}
