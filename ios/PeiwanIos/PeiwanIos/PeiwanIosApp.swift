import CoreLocation
import SwiftUI

@main
struct PeiwanIosApp: App {
    init() {
        // 图片/资源 HTTP 缓存：内存 64MB + 磁盘 512MB（AsyncImage 走 URLSession.shared 命中此缓存）
        URLCache.shared = URLCache(
            memoryCapacity: 64 * 1024 * 1024,
            diskCapacity: 512 * 1024 * 1024
        )
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

enum AppStage {
    case boot
    case register
    case main
}

// 显式 @MainActor：工程开了默认 MainActor 隔离（SWIFT_DEFAULT_ACTOR_ISOLATION），
// 部分 Xcode 26.x 版本对隐式推断的类型会误报 "does not conform to ObservableObject"
@MainActor
final class AppState: ObservableObject {
    @Published var stage: AppStage = .boot
    @Published var user: UserProfile?
}

struct RootView: View {
    @StateObject private var state = AppState()
    @ObservedObject private var callManager = CallManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            switch state.stage {
            case .boot: BootView()
            case .register: RegisterView()
            case .main: MainTabView()
            }
            // 通话界面由 CallWindow（独立 UIWindow）承载，可盖住任何弹层
        }
        // 评分完成后留在/进入女方个人主页
        .fullScreenCover(isPresented: Binding(
            get: { callManager.openUserHome != nil },
            set: { if !$0 { callManager.openUserHome = nil } }
        )) {
            NavigationStack {
                UserHomeView(userId: callManager.openUserHome ?? "")
                    .withRoutes()
            }
            .environmentObject(state)
        }
        .environmentObject(state)
        .onChange(of: state.stage) { stage in
            // 登录后初始化通话信令监听 + 无声音频保活
            if stage == .main, let user = state.user {
                WsClient.shared.connect()
                CallManager.shared.start(userId: user.id, gender: user.gender)
                SilentAudioKeeper.shared.start()
            }
        }
        .onChange(of: scenePhase) { phase in
            // 回前台立即重连 IM（后台 socket 可能被系统挂起断开）
            if phase == .active, state.stage == .main {
                WsClient.shared.connect()
            }
        }
        .task {
            // GPS 每分钟上报一次（用于距离展示）
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard state.stage == .main else { continue }
                CityLocator.shared.detectWithLocation { _, loc in
                    guard let loc else { return }
                    Task {
                        struct OkResp: Codable { var ok: Bool? }
                        let _: OkResp? = try? await Api.request("/user/location", method: "POST", body: [
                            "latitude": loc.coordinate.latitude,
                            "longitude": loc.coordinate.longitude,
                        ])
                    }
                }
            }
        }
    }
}
