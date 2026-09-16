import SwiftUI

/// 版本检查结果（GET /app/version）
struct VersionCheck: Codable {
    var hasUpdate: Bool? = false
    var force: Bool? = false
    var latest: String? = ""
    var url: String? = ""
    /// testflight / appstore
    var channel: String? = ""
    var notes: String? = ""
}

/**
 * 启动时检查更新（后台「App 版本 / 强制更新」配置）。
 * - 有新版：弹框，按钮跳后台配置的链接（前期 TestFlight 公开链接，上架后换 App Store 链接，客户端不用改）
 * - force：弹框不可关闭、没有「以后再说」
 * - 非强制：同一版本每天最多提醒一次
 */
@MainActor
final class UpdateChecker: ObservableObject {
    static let shared = UpdateChecker()
    @Published var pending: VersionCheck?

    static var currentVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
    }

    func check() async {
        let cur = Self.currentVersion
        guard let r: VersionCheck = try? await Api.request("/app/version?platform=ios&version=\(cur)") else { return }
        guard r.hasUpdate == true, let url = r.url, !url.isEmpty else { return }
        if r.force != true {
            let key = "upd_skip_\(r.latest ?? "")"
            let last = UserDefaults.standard.double(forKey: key)
            if Date().timeIntervalSince1970 - last < 86_400 { return }
        }
        pending = r
    }

    func later() {
        if let v = pending?.latest {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "upd_skip_\(v)")
        }
        pending = nil
    }

    func go() {
        guard let s = pending?.url, let url = URL(string: s) else { return }
        UIApplication.shared.open(url)
        // 强制更新不关弹框（回到 App 仍然只能去更新）；非强制点了就收起
        if pending?.force != true { later() }
    }
}

/// 更新弹框（盖在 RootView 最上层，强制时无法关闭）
struct UpdateOverlay: View {
    @ObservedObject private var checker = UpdateChecker.shared

    var body: some View {
        if let info = checker.pending {
            let force = info.force == true
            let isTF = (info.channel ?? "").lowercased() == "testflight"
            ZStack {
                Color.black.opacity(0.72).ignoresSafeArea()
                VStack(spacing: 0) {
                    Text(force ? "需要更新后才能继续使用" : "发现新版本")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(Theme.text)
                        .padding(.top, 22)
                    Text("最新版本 \(info.latest ?? "")　当前 \(UpdateChecker.currentVersion)")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSub)
                        .padding(.top, 6)
                    if let notes = info.notes, !notes.isEmpty {
                        ScrollView {
                            Text(notes)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.text.opacity(0.9))
                                .lineSpacing(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 180)
                        .padding(.horizontal, 22)
                        .padding(.top, 16)
                    }
                    Text(isTF ? "将跳转到 TestFlight 安装最新测试版" : "将跳转到 App Store 更新")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSub)
                        .padding(.top, 14)
                    Button { checker.go() } label: {
                        Text(isTF ? "打开 TestFlight 更新" : "前往 App Store 更新")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .background(Capsule().fill(Theme.accentGrad))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 22)
                    .padding(.top, 16)
                    if !force {
                        Button { checker.later() } label: {
                            Text("以后再说")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.textSub)
                                .frame(maxWidth: .infinity)
                                .frame(height: 40)
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                        .padding(.bottom, 10)
                    } else {
                        Spacer().frame(height: 22)
                    }
                }
                .frame(width: 300)
                .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bg2))
            }
            .transition(.opacity)
        }
    }
}
