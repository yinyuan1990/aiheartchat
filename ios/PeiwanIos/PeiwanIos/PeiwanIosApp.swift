import Combine
import CoreLocation
import SwiftUI

/// 屏幕方向控制：全 App 默认锁竖屏（工程 Info 虽列了横屏，实际以此处返回值为准），
/// 仅横屏小游戏页临时放开为横屏（离开还原）
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orientationMask: UIInterfaceOrientationMask = .portrait

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        AppDelegate.orientationMask
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        KeyboardDismisser.shared.start()
        return true
    }
}

/**
 * 全局「点空白处收起键盘」：给 App 自己的每个 UIWindow（主窗口、通话/语音房悬浮窗）挂一个不拦截触摸的 tap 手势，
 * 点到的位置不是文本输入（UITextField / UITextView / WKWebView 内容）时 endEditing。
 * 所有 SwiftUI 页面（含 sheet / fullScreenCover）都在同一个 window 里，一处生效全 App 生效。
 */
@MainActor
final class KeyboardDismisser: NSObject, UIGestureRecognizerDelegate {
    static let shared = KeyboardDismisser()
    private let attached = NSHashTable<UIWindow>.weakObjects()

    func start() {
        NotificationCenter.default.addObserver(self, selector: #selector(onWindowVisible(_:)), name: UIWindow.didBecomeVisibleNotification, object: nil)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .forEach(attach)
    }

    @objc private func onWindowVisible(_ n: Notification) {
        guard let w = n.object as? UIWindow else { return }
        attach(w)
    }

    private func attach(_ window: UIWindow) {
        // 系统键盘 / 文本特效窗口绝不能挂（否则点键盘本身就把键盘收了）
        let cls = NSStringFromClass(type(of: window))
        guard !cls.hasPrefix("UIRemoteKeyboard"), !cls.hasPrefix("UITextEffects"), !cls.hasPrefix("_") else { return }
        guard !attached.contains(window) else { return }
        attached.add(window)
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        guard g.state == .ended, let window = g.view as? UIWindow else { return }
        var v = window.hitTest(g.location(in: window), with: nil)
        while let cur = v {
            // 点在输入框自己（或 WKWebView 网页内容，其内部 view 也实现 UIKeyInput）上：不处理，交给系统
            if cur is UIKeyInput { return }
            v = cur.superview
        }
        window.endEditing(true)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

@MainActor
enum OrientationLock {
    /// 切换允许的方向并立即请求系统旋转到目标方向
    static func set(_ mask: UIInterfaceOrientationMask) {
        AppDelegate.orientationMask = mask
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        NSLog("[Game] orientation: set mask=%@ scenes=%d", mask == .portrait ? "portrait" : "landscape", scenes.count)
        if #available(iOS 16.0, *) {
            for scene in scenes {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
                scene.windows.forEach { window in
                    var top = window.rootViewController
                    while let presented = top?.presentedViewController { top = presented }
                    top?.setNeedsUpdateOfSupportedInterfaceOrientations()
                    window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
                }
            }
        } else {
            let target: UIInterfaceOrientation = mask == .portrait ? .portrait : .landscapeRight
            UIDevice.current.setValue(target.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}

@main
struct PeiwanIosApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // 图片/资源 HTTP 缓存：内存 64MB + 磁盘 512MB（AsyncImage 走 URLSession.shared 命中此缓存）
        URLCache.shared = URLCache(
            memoryCapacity: 64 * 1024 * 1024,
            diskCapacity: 512 * 1024 * 1024
        )
        // iOS15 没有 toolbarBackground，用全局导航栏外观兜底
        setupCompatNavBarAppearance()
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
            // 版本更新弹框（强制时不可关闭）
            UpdateOverlay().zIndex(99)
        }
        .task { await UpdateChecker.shared.check() }
        // 评分完成后留在/进入女方个人主页
        .fullScreenCover(isPresented: Binding(
            get: { callManager.openUserHome != nil },
            set: { if !$0 { callManager.openUserHome = nil } }
        )) {
            NavStack {
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
                VoiceRoomManager.shared.start(userId: user.id)
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
