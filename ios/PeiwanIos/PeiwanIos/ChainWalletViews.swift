import LocalAuthentication
import Security
import StoreKit
import SwiftUI
import WebKit

/**
 * 链上钱包（自托管网页钱包，页面在 Arm 网站 /wallet）+ DApp 浏览器。和 Android ChainWalletScreen.kt 同一套设计：
 * - 入口：App Store 所在国家不是中国（StoreKit 2 Storefront）+ 后台开关（/user/me features.wallet）；本机已有钱包的人即使开关关了也保留入口（导出 / 转出资产）。
 * - 钱包页面的原生桥 window.ArmWalletNative 只注入钱包源；消息处理里再核对一次来源（主框架 + 钱包源），别的网页调不动。
 * - 钱包数据本身已经被钱包密码加密；原生只把这份密文存进 Keychain（本机、解锁后可读、不进 iCloud 钥匙串）。
 * - iOS 没法禁止截屏：显示助记词时录屏会被遮住，截屏后提示删除；切到后台时盖住整个钱包，App 切换器里看不到内容。
 * - DApp 浏览器和钱包在同一个页面里：钱包 WebView 在下、DApp WebView 在上；DApp 发来连接 / 签名 / 交易请求时，
 *   钱包页弹确认框并调 dappShow(true)，这里把（背景透明的）钱包 WebView 提到最上面。私钥始终只在钱包 WebView 的内存里。
 */
enum ChainWallet {
    static let fallbackURL = URL(string: "https://arm.yyheart.com/wallet")!
    /// 钱包页 walletResult 交回的结果（userInfo["json"] 是 JSON 字符串，例如转账成功）；打开钱包的页面自己监听
    static let resultNotification = Notification.Name("ChainWalletResult")

    /// App Store 所在国家是中国时钱包整块不出现；拿不到（模拟器、没登录 App Store）时只有调试包放行
    static func storefrontAllowed() async -> Bool {
        if let cc = await Storefront.current?.countryCode { return cc.uppercased() != "CHN" }
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    static func visible(_ me: UserProfile?) async -> Bool {
        guard await storefrontAllowed() else { return false }
        return me?.features?.wallet == true || ChainWalletVault.exists
    }
}

/// 钱包代币页交来的喊单卡片（sheet(item:) 要 Identifiable）
struct ShareCard: Identifiable {
    let id = UUID()
    let card: [String: Any]
}

/// 钱包密文（网页已用钱包密码加密）存 Keychain。注意 Keychain 卸载 App 后仍在，重装后用原密码还能解锁。
enum ChainWalletVault {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.wh.peiwan.armwallet",
        kSecAttrAccount as String: "vault.v1",
    ]

    static var exists: Bool {
        var q = query
        q[kSecReturnAttributes as String] = true
        return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
    }

    static func read() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String) -> Bool {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}

/// 钱包 Face ID / 指纹解锁：钱包密码存进一条「必须用当前录入的生物识别才能读」的 Keychain 条目（本机、设了锁屏密码才可用）。
/// 重新录入指纹 / 换 Face ID 后条目失效，要重新用密码开启。
enum ChainWalletBio {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.wh.peiwan.armwallet",
        kSecAttrAccount as String: "bio.v1",
    ]

    static func status() -> [String: Any] {
        let ctx = LAContext()
        var err: NSError?
        let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        let kind = ctx.biometryType == .faceID ? "face" : ctx.biometryType == .touchID ? "fingerprint" : "biometric"
        return ["available": ok, "enabled": enabled, "kind": kind]
    }

    /// 只看条目在不在，不弹验证
    static var enabled: Bool {
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        var q = base
        q[kSecReturnAttributes as String] = true
        q[kSecUseAuthenticationContext as String] = ctx
        let s = SecItemCopyMatching(q as CFDictionary, nil)
        return s == errSecSuccess || s == errSecInteractionNotAllowed
    }

    static func clear() {
        SecItemDelete(base as CFDictionary)
    }

    private static func cancelled(_ e: Error?) -> Bool {
        guard let e = e as? LAError else { return false }
        return [.userCancel, .appCancel, .systemCancel, .userFallback].contains(e.code)
    }

    /// 结果：true 已开启，false 用户取消；先验一次生物识别确认是本人，再写入受保护的条目
    static func enable(_ password: String, done: @escaping (Result<Bool, Error>) -> Void) {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = ""
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: t("chainWallet.bioReason")) { ok, err in
            guard ok else { return done(cancelled(err) ? .success(false) : .failure(err ?? Failure(message: t("chainWallet.verifyFailed")))) }
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else {
                return done(.failure(Failure(message: "access control")))
            }
            clear()
            var add = base
            add[kSecValueData as String] = Data(password.utf8)
            add[kSecAttrAccessControl as String] = ac
            add[kSecUseAuthenticationContext as String] = ctx
            let s = SecItemAdd(add as CFDictionary, nil)
            done(s == errSecSuccess ? .success(true) : .failure(Failure(message: "keychain \(s)")))
        }
    }

    /// 结果：密码；nil 用户取消（改用密码）；失败 "invalidated" = 生物识别有变动，已自动关闭
    static func unlock(done: @escaping (Result<String?, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let ctx = LAContext()
            ctx.localizedReason = t("chainWallet.unlockReason")
            ctx.localizedCancelTitle = t("bio.usePassword")
            ctx.localizedFallbackTitle = ""
            var q = base
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            q[kSecUseAuthenticationContext as String] = ctx
            var item: CFTypeRef?
            let s = SecItemCopyMatching(q as CFDictionary, &item)
            switch s {
            case errSecSuccess:
                if let d = item as? Data, let pw = String(data: d, encoding: .utf8) { done(.success(pw)) } else { done(.failure(Failure(message: "bad item"))) }
            case errSecUserCanceled:
                done(.success(nil))
            case errSecItemNotFound:
                clear()
                done(.failure(Failure(message: "invalidated")))
            default:
                done(.failure(Failure(message: s == errSecAuthFailed ? t("chainWallet.verifyFailed") : "keychain \(s)")))
            }
        }
    }
}

/// 钱包页的非机密数据（站点授权、DApp 最近浏览 / 收藏）；放原生是因为 DApp 和钱包同源时会共用 localStorage
private enum ChainWalletStore {
    private static func key(_ k: String) -> String { "arm.wallet.store." + k }
    static func get(_ k: String) -> String? { UserDefaults.standard.string(forKey: key(k)) }
    static func set(_ k: String, _ v: String?) {
        if let v { UserDefaults.standard.set(v, forKey: key(k)) } else { UserDefaults.standard.removeObject(forKey: key(k)) }
    }
}

// MARK: - 页面

struct ChainWalletView: View {
    /// 直接打开钱包里的某一页；只接受 /wallet 开头的站内路径
    var startPath: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = ChainWalletModel()
    @State private var phase: Phase = .loading
    @State private var captured = false

    enum Phase {
        case loading
        case blocked(String)
        case tooOld
        case ready(URL)
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.dappOpen { dappHeader } else { walletHeader }
            content
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationBarHidden(true)
        .overlay {
            if (model.secure && captured) || scenePhase != .active { privacyCover }
        }
        .overlay(alignment: .top) {
            if let t = model.toast {
                Text(t)
                    .font(.system(size: 13)).foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(Capsule().fill(Color.black.opacity(0.85)))
                    .padding(.top, 60).padding(.horizontal, 24)
                    .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { model.toast = nil } }
            }
        }
        .fullScreenCover(isPresented: Binding(get: { model.scanning }, set: { if !$0 { model.finishScan(nil) } })) {
            QrScanView(hint: t("chainWallet.scanHint")) { model.finishScan($0) }
        }
        .onAppear { captured = Self.screenCaptured() }
        .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
            captured = Self.screenCaptured()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            if model.secure { model.toast = t("chainWallet.screenshotWarn") }
        }
        .task { await load() }
        .onChange(of: model.closeRequested) { if $0 { dismiss() } }
        .sheet(item: $model.shareCard) { s in
            ShareCardSheet(card: s.card) { model.toast = $0 }
        }
        .routePush($model.chatRoute)
    }

    private func load() async {
        guard case .loading = phase else { return }
        let me: UserProfile? = try? await Api.request("/user/me")
        guard await ChainWallet.visible(me) else {
            phase = .blocked(t("chainWallet.notEnabled"))
            return
        }
        // 网站用 Tailwind v4，要 Safari 16.4+（WKWebView 跟系统版本走）
        guard #available(iOS 16.4, *) else {
            phase = .tooOld
            return
        }
        let custom = URL(string: me?.features?.walletUrl ?? "").flatMap { $0.scheme == "https" ? $0 : nil }
        phase = .ready(Self.startURL(custom ?? ChainWallet.fallbackURL, startPath))
    }

    private static func startURL(_ home: URL, _ path: String?) -> URL {
        guard let p = path, p.hasPrefix("/wallet"), !p.contains("//"), !p.contains("\\"), let scheme = home.scheme, let host = home.host else { return home }
        let port = home.port.map { ":\($0)" } ?? ""
        return URL(string: "\(scheme)://\(host)\(port)\(p)") ?? home
    }

    private func back() {
        if model.approving {
            model.cancel()
        } else if model.dappOpen {
            if model.dappCanGoBack { model.dappWeb?.goBack() } else { model.closeDapp() }
        } else if model.walletCanGoBack {
            model.walletWeb?.goBack()
        } else {
            dismiss()
        }
    }

    private var walletHeader: some View {
        HStack(spacing: 0) {
            Button(action: back) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 40, height: 40)
            }
            Text(t("me.chainWallet"))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity)
            Button { dismiss() } label: {
                Text(t("common.close")).font(.system(size: 14)).foregroundStyle(Theme.textSub).frame(width: 56, height: 40)
            }
        }
        .padding(.horizontal, 8)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { progressBar(model.walletProgress) }
    }

    private var dappHeader: some View {
        let host = model.dappURL?.host ?? ""
        let secure = model.dappURL?.scheme == "https"
        return HStack(spacing: 0) {
            Button(action: back) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 40, height: 40)
            }
            Button {
                if model.approving { model.cancel() } else { model.closeDapp() }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 36, height: 40)
            }
            VStack(spacing: 1) {
                Text(model.dappTitle.isEmpty ? host : model.dappTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                HStack(spacing: 3) {
                    Image(systemName: secure ? "lock.fill" : "exclamationmark.triangle.fill").font(.system(size: 9))
                    Text(secure ? host : t("chainWallet.insecure", ["host": host])).font(.system(size: 11)).lineLimit(1)
                }
                .foregroundStyle(secure ? Theme.textSub : Theme.warn)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 4)
            Menu {
                Button(t("chainWallet.toggleFavorite")) { model.favorite() }
                Button(t("chainWallet.copyLink")) {
                    UIPasteboard.general.string = model.dappURL?.absoluteString
                    model.toast = t("common.copied")
                }
                Button(t("chainWallet.refresh")) { model.dappWeb?.reload() }
                Button(t("chainWallet.openInBrowser")) { if let u = model.dappURL { UIApplication.shared.open(u) } }
                Button(t("common.share")) { if let u = model.dappURL { model.share(u.absoluteString) } }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 44, height: 40)
            }
            .disabled(model.approving)
        }
        .padding(.horizontal, 4)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { progressBar(model.dappProgress) }
    }

    @ViewBuilder
    private func progressBar(_ p: Double) -> some View {
        if p > 0 && p < 1 {
            GeometryReader { geo in
                Rectangle().fill(Theme.accent).frame(width: geo.size.width * p, height: 2)
            }
            .frame(height: 2)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            Color.clear
        case .blocked(let msg):
            notice(msg)
        case .tooOld:
            notice(t("chainWallet.tooOld"))
        case .ready(let url):
            ChainWalletContainer(model: model, url: url)
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(Theme.textSub)
            .multilineTextAlignment(.center)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var privacyCover: some View {
        ZStack {
            Theme.bg
            VStack(spacing: 10) {
                Image(systemName: "lock.shield.fill").font(.system(size: 40)).foregroundStyle(Theme.textSub)
                Text(t("chainWallet.hidden")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
            }
        }
        .ignoresSafeArea()
    }

    private static func screenCaptured() -> Bool {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.contains { $0.screen.isCaptured }
    }
}

private struct ChainWalletContainer: UIViewRepresentable {
    let model: ChainWalletModel
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> UIView {
        model.setup(walletURL: url)
        return model.container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.model.teardown()
    }

    final class Coordinator {
        let model: ChainWalletModel
        init(model: ChainWalletModel) { self.model = model }
    }
}

/// 两个 WebView 叠在一起，始终铺满
private final class StackView: UIView {
    override func layoutSubviews() {
        super.layoutSubviews()
        subviews.forEach { $0.frame = bounds }
    }
}

/// WKUserContentController 会强引用 handler，中间垫一层弱引用，页面关掉时模型能释放
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

// MARK: - 模型（两个 WebView + 请求转发）

final class ChainWalletModel: NSObject, ObservableObject {
    @Published var walletProgress: Double = 0
    @Published var walletCanGoBack = false
    @Published var dappOpen = false
    @Published var dappTitle = ""
    @Published var dappURL: URL?
    @Published var dappProgress: Double = 0
    @Published var dappCanGoBack = false
    @Published var approving = false {
        didSet { restack() }
    }
    @Published var secure = false
    @Published var toast: String?
    /// 钱包页调了 walletClose（例如聊天里的转账做完了）
    @Published var closeRequested = false
    /// 代币页「喊单到聊天」交来的卡片，弹会话选择
    @Published var shareCard: ShareCard?
    /// 代币页「讨论群」：进这个群聊
    @Published var chatRoute: Route?
    /// 钱包页调 scanQr 时弹扫码页；同一时间只有一个，新的进来先把旧的按取消回掉
    @Published var scanning = false
    private var scanReply: ((String?) -> Void)?

    func finishScan(_ text: String?) {
        scanning = false
        scanReply?(text)
        scanReply = nil
    }

    let container: UIView = StackView()
    private(set) var walletWeb: WKWebView?
    private(set) var dappWeb: WKWebView?
    private var walletOrigin = ""
    private var walletObservers: [NSKeyValueObservation] = []
    private var dappObservers: [NSKeyValueObservation] = []

    // 请求转发：DApp 网页的请求编号换成全局编号交给钱包页，钱包页回复后按编号还给发起请求的网页
    private var seq = 0
    private var pending: [Int: (providerId: Any, origin: String)] = [:]
    private var walletReady = false
    private var queue: [[String: Any]] = []
    private var dappOrigin: String?

    func setup(walletURL: URL) {
        guard walletWeb == nil, let origin = Self.origin(of: walletURL) else { return }
        walletOrigin = origin
        container.backgroundColor = UIColor(Theme.bg)
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "PeiwanApp/iOS ArmWallet/1"
        config.userContentController.add(WeakMessageHandler(self), name: "armWallet")
        config.userContentController.addUserScript(WKUserScript(
            source: walletBridgeJS.replacingOccurrences(of: "__WALLET_ORIGIN__", with: origin),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let web = WKWebView(frame: container.bounds, configuration: config)
        // 透明：钱包页弹 DApp 确认框时会把自己的背景去掉，露出下面的 DApp 网页
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.navigationDelegate = self
        web.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        container.addSubview(web)
        walletWeb = web
        walletObservers = [
            web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in self?.walletProgress = w.estimatedProgress },
            web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in self?.walletCanGoBack = w.canGoBack },
        ]
        web.load(URLRequest(url: walletURL))
    }

    func teardown() {
        closeDapp()
        walletObservers.forEach { $0.invalidate() }
        walletObservers = []
        if let web = walletWeb {
            web.stopLoading()
            web.configuration.userContentController.removeScriptMessageHandler(forName: "armWallet")
            web.removeFromSuperview()
        }
        walletWeb = nil
        walletReady = false
        secure = false
    }

    func openDapp(_ url: URL) {
        if let web = dappWeb {
            web.load(URLRequest(url: url))
            return
        }
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "PeiwanApp/iOS ArmWallet/1"
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(WeakMessageHandler(self), name: "armDapp")
        config.userContentController.addUserScript(WKUserScript(source: dappProviderJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: container.bounds, configuration: config)
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = self
        web.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        container.addSubview(web)
        dappWeb = web
        dappOpen = true
        dappURL = url
        dappObservers = [
            web.observe(\.title, options: [.new]) { [weak self] w, _ in
                let t = w.title ?? ""
                self?.dappTitle = t.hasPrefix("http") ? "" : t
            },
            web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in self?.dappProgress = w.estimatedProgress },
            web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in self?.dappCanGoBack = w.canGoBack },
            web.observe(\.url, options: [.new]) { [weak self] w, _ in if let u = w.url { self?.dappURL = u } },
        ]
        web.load(URLRequest(url: url))
        restack()
    }

    func closeDapp() {
        guard let web = dappWeb else { return }
        reset()
        approving = false
        dappObservers.forEach { $0.invalidate() }
        dappObservers = []
        web.stopLoading()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "armDapp")
        web.removeFromSuperview()
        dappWeb = nil
        dappOpen = false
        dappTitle = ""
        dappURL = nil
        dappProgress = 0
        dappCanGoBack = false
    }

    /// 用户在原生顶栏点了返回 / 关闭：钱包页按 4001 拒绝当前请求，再自己调 dappShow(false)
    func cancel() { push(["push": "dappCancel"]) }

    func favorite() {
        guard let u = dappURL else { return }
        var m: [String: Any] = ["push": "dappFavorite", "url": u.absoluteString]
        if !dappTitle.isEmpty { m["title"] = dappTitle }
        push(m)
    }

    func share(_ text: String) {
        let vc = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = container
        Self.topController()?.present(vc, animated: true)
    }

    private func restack() {
        guard let wallet = walletWeb else { return }
        if approving || dappWeb == nil {
            container.bringSubviewToFront(wallet)
        } else if let dapp = dappWeb {
            container.bringSubviewToFront(dapp)
        }
    }

    /// DApp 页面跳转或浏览器关闭：旧页面的请求都作废
    private func reset() {
        pending.removeAll()
        dappOrigin = nil
        push(["push": "dappReset"])
    }

    /// 钱包页刷新：旧的回复通道作废，正在等的请求全部拒绝
    private func walletGone() {
        walletReady = false
        for (_, p) in pending {
            evalDapp(["id": p.providerId, "error": ["code": 4001, "message": "Wallet reloaded"] as [String: Any]], origin: p.origin)
        }
        pending.removeAll()
        approving = false
    }

    // MARK: 和网页互发消息

    private static func json(_ obj: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(obj), let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else { return nil }
        if let port = url.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    private static func origin(of o: WKSecurityOrigin) -> String {
        let scheme = o.protocol.lowercased()
        if o.port == 0 || (scheme == "https" && o.port == 443) || (scheme == "http" && o.port == 80) {
            return "\(scheme)://\(o.host)"
        }
        return "\(scheme)://\(o.host):\(o.port)"
    }

    private func evalWallet(_ obj: [String: Any]) {
        guard let web = walletWeb, let u = web.url, Self.origin(of: u) == walletOrigin, let s = Self.json(obj) else { return }
        web.evaluateJavaScript("window.__armWalletReceive && window.__armWalletReceive(\(s))", completionHandler: nil)
    }

    /// 推给钱包页的消息；钱包页还没就绪（dappReady 之前）就先排队
    private func push(_ obj: [String: Any]) {
        if walletReady { evalWallet(obj) } else { queue.append(obj) }
    }

    private func evalDapp(_ obj: [String: Any], origin: String) {
        guard let web = dappWeb, let u = web.url, Self.origin(of: u) == origin, let s = Self.json(obj) else { return }
        web.evaluateJavaScript("window.__armDappReceive && window.__armDappReceive(\(s))", completionHandler: nil)
    }

    private func onDappMessage(_ req: [String: Any], origin: String, mainFrame: Bool) {
        guard let pid = req["id"], let method = req["method"] as? String else { return }
        guard mainFrame, origin.hasPrefix("https://") else {
            evalDapp(["id": pid, "error": ["code": 4100, "message": "Wallet is only available to https pages"] as [String: Any]], origin: origin)
            return
        }
        dappOrigin = origin
        seq += 1
        pending[seq] = (providerId: pid, origin: origin)
        let forward: [String: Any] = ["id": seq, "origin": origin, "method": method, "params": req["params"] ?? [Any]()]
        push(["push": "dappRequest", "req": forward])
    }

    private func handleWallet(_ req: [String: Any]) {
        guard let id = req["id"], let method = req["method"] as? String else { return }
        let arg = req["arg"]
        func send(_ result: Any? = nil, error: String? = nil) {
            var out: [String: Any] = ["id": id]
            if let error { out["error"] = error } else { out["result"] = result ?? NSNull() }
            evalWallet(out)
        }
        switch method {
        case "vaultGet":
            send(ChainWalletVault.read())
        case "vaultSet":
            guard let v = arg as? String else { return send(error: "empty vault") }
            if ChainWalletVault.write(v) { send(true) } else { send(error: "keychain write failed") }
        case "vaultClear":
            ChainWalletVault.clear()
            ChainWalletBio.clear()
            send(true)
        case "bioStatus":
            send(ChainWalletBio.status())
        case "bioDisable":
            ChainWalletBio.clear()
            send(true)
        case "bioEnable":
            guard let pw = arg as? String, !pw.isEmpty else { return send(error: "no password") }
            ChainWalletBio.enable(pw) { r in
                DispatchQueue.main.async {
                    switch r {
                    case .success(let on): send(on)
                    case .failure(let e): send(error: e.localizedDescription)
                    }
                }
            }
        case "bioUnlock":
            ChainWalletBio.unlock { r in
                DispatchQueue.main.async {
                    switch r {
                    case .success(let pw): send(pw)
                    case .failure(let e): send(error: e.localizedDescription)
                    }
                }
            }
        case "storeGet":
            send((arg as? String).flatMap { ChainWalletStore.get($0) })
        case "storeSet":
            guard let o = arg as? [String: Any], let key = o["key"] as? String else { return send(error: "bad arg") }
            ChainWalletStore.set(key, o["value"] as? String)
            send(true)
        case "setSecureScreen":
            secure = (arg as? Bool) == true
            send(true)
        case "share":
            share(arg as? String ?? "")
            send(true)
        case "toast":
            toast = arg as? String
            send(true)
        case "openDapp":
            if let s = arg as? String, let u = URL(string: s), ["https", "http"].contains(u.scheme?.lowercased() ?? "") { openDapp(u) }
            send(true)
        case "dappReady":
            walletReady = true
            let q = queue
            queue.removeAll()
            q.forEach { evalWallet($0) }
            send(true)
        case "dappRespond":
            if let o = arg as? [String: Any], let rid = o["id"] as? Int, let p = pending.removeValue(forKey: rid) {
                var out: [String: Any] = ["id": p.providerId]
                if let e = o["error"], !(e is NSNull) { out["error"] = e } else { out["result"] = o["result"] ?? NSNull() }
                evalDapp(out, origin: p.origin)
            }
            send(true)
        case "dappEmit":
            if let o = arg as? [String: Any], let origin = o["origin"] as? String, let ev = o["event"] as? String, origin == dappOrigin {
                evalDapp(["event": ev, "data": o["data"] ?? NSNull()], origin: origin)
            }
            send(true)
        case "dappShow":
            approving = (arg as? Bool) == true
            send(true)
        case "scanQr":
            scanReply?(nil)
            scanReply = { send($0) }
            scanning = true
        case "walletResult":
            if let o = arg as? [String: Any], let s = Self.json(o) {
                NotificationCenter.default.post(name: ChainWallet.resultNotification, object: nil, userInfo: ["json": s])
            }
            send(true)
        case "walletClose":
            closeRequested = true
            send(true)
        case "chainAddress":
            // 心之音账号的收款地址：用 App 自己的登录态调后端（钱包页拿不到 token）；arg 为空 = 读，否则 = 写（带签名）
            let body = arg as? [String: Any]
            Task { @MainActor in
                struct Resp: Codable { var userId: String; var evm: String?; var sol: String?; var trx: String?; var ton: String? }
                do {
                    let r: Resp = try await Api.request("/user/chain-address", method: body == nil ? "GET" : "PUT", body: body)
                    let out: [String: Any] = ["userId": r.userId, "evm": r.evm ?? NSNull(), "sol": r.sol ?? NSNull(), "trx": r.trx ?? NSNull(), "ton": r.ton ?? NSNull()]
                    send(out)
                } catch {
                    send(error: error.localizedDescription)
                }
            }
        case "shareCard":
            if let o = arg as? [String: Any] { shareCard = ShareCard(card: o) }
            send(true)
        case "openCoinGroup":
            // 币的讨论群：后端没有就建（系统账号当群主）再加入，然后进群聊
            if let o = arg as? [String: Any] {
                Task { @MainActor in
                    struct Resp: Codable { var groupId: String; var conversationId: String?; var name: String }
                    do {
                        let r: Resp = try await Api.request("/im/coin-group", method: "POST", body: o)
                        if let conv = r.conversationId { chatRoute = .chatRoom(conv, 2, r.groupId, r.name) }
                    } catch {
                        toast = error.localizedDescription
                    }
                }
            }
            send(true)
        case "perpCall":
            // 合约喊单：用 App 的登录态发到这个合约的群（后端 /im/perp-call 验钱包签名），成功后进那个群
            guard let o = arg as? [String: Any] else { send(error: "bad arg"); return }
            Task { @MainActor in
                struct Resp: Codable { var groupId: String; var conversationId: String?; var name: String }
                do {
                    let r: Resp = try await Api.request("/im/perp-call", method: "POST", body: o)
                    send(["groupId": r.groupId, "name": r.name])
                    if let conv = r.conversationId { chatRoute = .chatRoom(conv, 2, r.groupId, r.name) }
                } catch {
                    send(error: error.localizedDescription)
                }
            }
        default:
            send(error: "unknown method \(method)")
        }
    }

    fileprivate static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

extension ChainWalletModel: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let raw = message.body as? String, let data = raw.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let origin = Self.origin(of: message.frameInfo.securityOrigin)
        if message.name == "armWallet" {
            guard message.webView === walletWeb, message.frameInfo.isMainFrame, origin == walletOrigin else { return }
            handleWallet(obj)
        } else if message.name == "armDapp" {
            guard message.webView === dappWeb else { return }
            onDappMessage(obj, origin: origin, mainFrame: message.frameInfo.isMainFrame)
        }
    }
}

extension ChainWalletModel: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = u.scheme?.lowercased() ?? ""
        if webView === walletWeb {
            // 钱包只在自己的源里跳；其它网址（Arm 主站、区块浏览器）交给 Safari，桥接不会带过去
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if !mainFrame || scheme == "about" || (Self.origin(of: u) == walletOrigin && u.path.hasPrefix("/wallet")) {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
            }
            return
        }
        if ["http", "https", "about", "blob", "data"].contains(scheme) {
            decisionHandler(.allow)
        } else {
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === walletWeb { walletGone() }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === dappWeb { reset() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === dappWeb, let u = webView.url, ["https", "http"].contains(u.scheme ?? "") else { return }
        var m: [String: Any] = ["push": "dappVisited", "url": u.absoluteString]
        if let t = webView.title, !t.isEmpty, !t.hasPrefix("http") { m["title"] = t }
        push(m)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // window.open / target=_blank：DApp 在当前页打开，钱包里的交给 Safari
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let u = navigationAction.request.url {
            if webView === dappWeb { webView.load(URLRequest(url: u)) } else { UIApplication.shared.open(u) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: t("bot.ok"), style: .default) { _ in completionHandler() })
        guard let top = Self.topController() else { return completionHandler() }
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: t("common.cancel"), style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: t("common.ok"), style: .default) { _ in completionHandler(true) })
        guard let top = Self.topController() else { return completionHandler(false) }
        top.present(alert, animated: true)
    }
}

// MARK: - 注入脚本

/// 钱包页的原生桥；只在钱包源定义（消息处理里还会再核对一次来源）
private let walletBridgeJS = #"""
(function(){
  if (window.ArmWalletNative || location.origin !== '__WALLET_ORIGIN__') return;
  var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.armWallet;
  if (!h) return;
  var seq = 0, pending = {};
  Object.defineProperty(window, '__armWalletReceive', { value: function(m){
    if (!m) return;
    if (m.push) { window.dispatchEvent(new CustomEvent('armwallet:native', { detail: m })); return; }
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result === undefined ? null : m.result);
  }});
  function call(method, arg){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      h.postMessage(JSON.stringify({ id: id, method: method, arg: arg === undefined ? null : arg }));
    });
  }
  window.ArmWalletNative = {
    platform: 'ios',
    features: ['dapp', 'store', 'scan', 'bio', 'result', 'chat', 'payreq', 'perpcall'],
    walletResult: function(r){ call('walletResult', r); },
    walletClose: function(){ call('walletClose'); },
    chainAddress: function(a){ return call('chainAddress', a == null ? null : a); },
    shareCard: function(c){ call('shareCard', c); },
    openCoinGroup: function(c){ call('openCoinGroup', c); },
    perpCall: function(c){ return call('perpCall', c); },
    vaultGet: function(){ return call('vaultGet'); },
    vaultSet: function(v){ return call('vaultSet', String(v)); },
    vaultClear: function(){ return call('vaultClear'); },
    storeGet: function(k){ return call('storeGet', String(k)); },
    storeSet: function(k, v){ return call('storeSet', { key: String(k), value: v == null ? null : String(v) }); },
    setSecureScreen: function(on){ call('setSecureScreen', !!on); },
    share: function(t){ call('share', String(t)); },
    toast: function(t){ call('toast', String(t)); },
    openDapp: function(u){ call('openDapp', String(u)); },
    dappReady: function(){ call('dappReady'); },
    dappRespond: function(r){ call('dappRespond', r); },
    dappEmit: function(e){ call('dappEmit', e); },
    dappShow: function(on){ call('dappShow', !!on); },
    scanQr: function(){ return call('scanQr'); },
    bioStatus: function(){ return call('bioStatus'); },
    bioEnable: function(p){ return call('bioEnable', String(p)); },
    bioUnlock: function(){ return call('bioUnlock'); },
    bioDisable: function(){ return call('bioDisable'); }
  };
})();
"""#

/// DApp 网页的钱包接口（EIP-1193 + EIP-6963；Solana 走 Wallet Standard，方法名带 sol_ 前缀）。和 Android ChainWalletDapp.kt 里的 DAPP_PROVIDER_JS 一模一样，改的时候两边一起改。
private let dappProviderJS = #"""
(function () {
  var tok = window.__armDappTok;
  try { delete window.__armDappTok; } catch (e) {}
  if (window.top !== window || window.__armDapp) return;
  var A = window.ArmDappBridge;
  var W = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.armDapp;
  if (!A && !W) return;
  Object.defineProperty(window, '__armDapp', { value: true });
  var seq = 0, pending = {}, listeners = {};
  var state = { chainId: null, accounts: [] };
  function post(m) { if (tok) m.tok = tok; var s = JSON.stringify(m); if (A) A.postMessage(s); else W.postMessage(s); }
  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { setTimeout(function () { throw e; }); } });
  }
  function rpcError(e) {
    var err = new Error((e && e.message) || 'Internal error');
    err.code = e && typeof e.code === 'number' ? e.code : -32603;
    if (e && e.data !== undefined) err.data = e.data;
    return err;
  }
  function setChain(c) {
    if (typeof c !== 'string' || c === state.chainId) return;
    var first = state.chainId === null;
    state.chainId = c;
    provider.chainId = c;
    provider.networkVersion = String(parseInt(c, 16));
    if (first) emit('connect', { chainId: c }); else emit('chainChanged', c);
  }
  function setAccounts(a) {
    if (!Array.isArray(a)) return;
    var same = a.length === state.accounts.length && a.every(function (x, i) { return x === state.accounts[i]; });
    state.accounts = a;
    provider.selectedAddress = a[0] || null;
    if (!same) emit('accountsChanged', a);
  }
  function receive(raw) {
    var m;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!m) return;
    if (m.event) {
      if (m.event === 'chainChanged') setChain(m.data);
      else if (m.event === 'accountsChanged') setAccounts(m.data || []);
      else if (m.event === 'sol_accounts') solSet(m.data);
      else emit(m.event, m.data);
      return;
    }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.error) { p.reject(rpcError(m.error)); return; }
    if (p.method === 'eth_chainId') setChain(m.result);
    if (p.method === 'eth_accounts' || p.method === 'eth_requestAccounts') setAccounts(m.result);
    p.resolve(m.result === undefined ? null : m.result);
  }
  Object.defineProperty(window, '__armDappReceive', { value: receive });
  if (A) { try { A.onmessage = function (e) { receive(e.data); }; } catch (e) {} }
  function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') return Promise.reject(rpcError({ code: -32600, message: 'Invalid request' }));
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject, method: args.method };
      post({ id: id, method: args.method, params: args.params === undefined ? [] : args.params });
    });
  }
  function reply(a, cb) {
    request(a).then(function (r) { cb(null, { id: a.id, jsonrpc: '2.0', result: r }); }, function (e) { cb(e, null); });
  }
  var provider = {
    isArmWallet: true,
    chainId: null,
    networkVersion: null,
    selectedAddress: null,
    request: request,
    isConnected: function () { return true; },
    enable: function () { return request({ method: 'eth_requestAccounts' }); },
    on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    addListener: function (ev, f) { return provider.on(ev, f); },
    once: function (ev, f) { function g(d) { provider.removeListener(ev, g); f(d); } return provider.on(ev, g); },
    removeListener: function (ev, f) { var l = listeners[ev]; if (l) { var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } return provider; },
    off: function (ev, f) { return provider.removeListener(ev, f); },
    removeAllListeners: function (ev) { if (ev) delete listeners[ev]; else listeners = {}; return provider; },
    send: function (a, b) {
      if (typeof a === 'string') return request({ method: a, params: b });
      if (typeof b === 'function') return reply(a, b);
      throw new Error('Synchronous send is not supported');
    },
    sendAsync: reply
  };
  if (!window.ethereum) window.ethereum = provider;
  var iconSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='#111'/><rect x='13' y='20' width='38' height='26' rx='6' fill='none' stroke='#fff' stroke-width='4'/><circle cx='41' cy='33' r='3.5' fill='#fff'/></svg>";
  var icon = 'data:image/svg+xml,' + encodeURIComponent(iconSvg);
  var uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
  var info = Object.freeze({ uuid: uuid, name: '心之音钱包', icon: icon, rdns: 'com.yyheart.wallet' });
  function announce() { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: provider }) })); }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));
  request({ method: 'eth_chainId' }).catch(function () {});
  request({ method: 'eth_accounts' }).catch(function () {});

  // Solana: a Wallet Standard wallet whose features travel as sol_* requests on the same channel; bytes as base64
  var SOL_CHAINS = ['solana:mainnet'];
  var SOL_MAINNET_IDS = ['solana:mainnet', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
  var SOL_ACCOUNT_FEATURES = ['solana:signAndSendTransaction', 'solana:signTransaction', 'solana:signMessage'];
  var solAccounts = [], solListeners = [];
  function b64e(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function b64d(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function u8(x) {
    if (x instanceof Uint8Array) return x;
    if (x && x.buffer && typeof x.byteLength === 'number') return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    throw rpcError({ code: -32602, message: 'Expected a Uint8Array' });
  }
  function solSet(list) {
    list = Array.isArray(list) ? list : [];
    if (list.length === solAccounts.length && list.every(function (a, i) { return a && a.address === solAccounts[i].address; })) return;
    solAccounts = list.map(function (a) { return Object.freeze({ address: a.address, publicKey: b64d(a.publicKey), chains: SOL_CHAINS.slice(), features: SOL_ACCOUNT_FEATURES.slice() }); });
    var accounts = solAccounts.slice();
    solListeners.slice().forEach(function (f) { try { f({ accounts: accounts }); } catch (e) { setTimeout(function () { throw e; }); } });
  }
  function solAsync(f) {
    return function () { var args = arguments; return new Promise(function (resolve, reject) { try { resolve(f.apply(null, args)); } catch (e) { reject(e); } }); };
  }
  function solAddress(inputs) {
    var a = inputs[0] && inputs[0].account;
    if (!a || !solAccounts.some(function (s) { return s.address === a.address; })) throw rpcError({ code: 4100, message: 'Account is not connected' });
    inputs.forEach(function (x) {
      if (!x || !x.account || x.account.address !== a.address) throw rpcError({ code: 4100, message: 'Account is not connected' });
      if (x.chain && SOL_MAINNET_IDS.indexOf(x.chain) < 0) throw rpcError({ code: -32602, message: 'Unsupported chain ' + x.chain });
    });
    return a.address;
  }
  function solTxs(inputs) { return inputs.map(function (x) { return b64e(u8(x.transaction)); }); }
  var solFeatures = {
    'standard:connect': { version: '1.0.0', connect: solAsync(function (input) {
      return request({ method: 'sol_connect', params: { silent: !!(input && input.silent) } }).then(function (r) { solSet(r); return { accounts: solAccounts.slice() }; });
    }) },
    'standard:disconnect': { version: '1.0.0', disconnect: solAsync(function () {
      return request({ method: 'sol_disconnect', params: {} }).then(function () { solSet([]); });
    }) },
    'standard:events': { version: '1.0.0', on: function (ev, f) {
      if (ev !== 'change' || typeof f !== 'function') return function () {};
      solListeners.push(f);
      return function () { var i = solListeners.indexOf(f); if (i >= 0) solListeners.splice(i, 1); };
    } },
    'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: solAsync(function () {
      var inputs = [].slice.call(arguments);
      return request({ method: 'sol_signTransaction', params: { address: solAddress(inputs), txs: solTxs(inputs) } })
        .then(function (r) { return r.map(function (s) { return { signedTransaction: b64d(s) }; }); });
    }) },
    'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: solAsync(function () {
      var inputs = [].slice.call(arguments), o = (inputs[0] && inputs[0].options) || {};
      var opts = { skipPreflight: !!o.skipPreflight, preflightCommitment: o.preflightCommitment || null, mode: o.mode || null };
      return request({ method: 'sol_signAndSendTransaction', params: { address: solAddress(inputs), txs: solTxs(inputs), options: opts } })
        .then(function (r) { return r.map(function (s) { return { signature: b64d(s) }; }); });
    }) },
    'solana:signMessage': { version: '1.0.0', signMessage: solAsync(function () {
      var inputs = [].slice.call(arguments);
      var msgs = inputs.map(function (x) { return u8(x && x.message); });
      return request({ method: 'sol_signMessage', params: { address: solAddress(inputs), messages: msgs.map(b64e) } })
        .then(function (r) { return r.map(function (s, i) { return { signedMessage: msgs[i], signature: b64d(s), signatureType: 'ed25519' }; }); });
    }) }
  };
  var solWallet = Object.freeze({
    version: '1.0.0',
    name: '心之音钱包',
    icon: 'data:image/svg+xml;base64,' + btoa(iconSvg),
    chains: SOL_CHAINS.slice(),
    get accounts() { return solAccounts.slice(); },
    features: solFeatures
  });
  function solRegister(api) { try { api.register(solWallet); } catch (e) {} }
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: solRegister })); } catch (e) {}
  try { window.addEventListener('wallet-standard:app-ready', function (e) { solRegister(e.detail); }); } catch (e) {}
  request({ method: 'sol_accounts', params: {} }).then(solSet, function () {});
})();
"""#
