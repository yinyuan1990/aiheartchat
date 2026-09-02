import SwiftUI
import WebKit

/**
 * 大厅：App 内嵌 H5（WebView），业务模块在网页端热更、无需发版。
 * 地址后台可配（GET /modules/hall，env HALL_H5_URL），默认加载 Web 端的 /site/#/hall-embed，
 * URL 携带 token 免登录（用 App 的身份），页面内自行导航，其它 tab 保持原生。
 */
struct HallView: View {
    @State private var hallUrl: URL?
    @State private var chatTarget: ChatTarget?
    @State private var webTarget: WebTarget?

    var body: some View {
        Group {
            if let hallUrl {
                HallWebView(
                    url: hallUrl,
                    onOpenChat: { target in chatTarget = target },
                    onOpenWeb: { target in webTarget = target }
                )
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        // H5 里点「打招呼」等经 JS 桥唤起原生聊天页
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        // 小游戏等第三方 H5：独立原生 WebView 全屏打开，不污染大厅页
        .fullScreenCover(item: $webTarget) { t in
            GameWebSheet(url: t.url, title: t.title, landscape: t.landscape)
        }
        .onChange(of: webTarget?.id) { id in
            GameLog.log("hall: webTarget changed -> \(id == nil ? "nil(dismiss)" : "present \(webTarget?.url.absoluteString ?? "") landscape=\(webTarget?.landscape ?? false)")")
        }
        .task {
            guard hallUrl == nil else { return }
            struct HallCfg: Codable { var url: String? = "" }
            let cfg: HallCfg? = try? await Api.request("/modules/hall")
            var base = cfg?.url ?? ""
            if base.isEmpty { base = "\(Api.baseURL)/site/#/hall-embed" }
            let sep = base.contains("?") ? "&" : "?"
            hallUrl = URL(string: "\(base)\(sep)token=\(Api.token ?? "")&embed=1")
            GameLog.log("hall: load url=\(base) (cfg='\(cfg?.url ?? "")')")
        }
    }
}

/// 原生全屏网页目标（小游戏等）；landscape 为横屏游戏（仅该页旋转）
struct WebTarget: Identifiable {
    let id = UUID()
    let url: URL
    let title: String
    var landscape: Bool = false
}

/**
 * 小游戏/大厅 WebView 调试日志：Xcode 控制台或 Console.app 搜索 "[Game]"。
 * 同时把 H5 的 console.log/error、window.onerror 通过 JS 桥转成原生日志（见 consoleForwardScript）。
 */
enum GameLog {
    static func log(_ msg: String) { NSLog("[Game] %@", msg) }

    /// 注入到 H5：console.* 与 JS 报错转发到 messageHandlers.peiwan（type=log）
    static let consoleForwardScript = WKUserScript(source: """
    (function(){
      if (window.__peiwanLogHooked) return; window.__peiwanLogHooked = true;
      function fmt(args){ return Array.prototype.map.call(args, function(a){
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message + ' ' + (a.stack || '');
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' '); }
      function send(level, args){
        try { window.webkit.messageHandlers.peiwan.postMessage({ type: 'log', level: level, msg: fmt(args) }); } catch (e) {}
      }
      ['log','info','warn','error'].forEach(function(k){
        var orig = console[k];
        console[k] = function(){ send(k, arguments); try { orig.apply(console, arguments); } catch (e) {} };
      });
      window.addEventListener('error', function(e){ send('error', ['onerror', e.message, (e.filename||'') + ':' + e.lineno]); });
      window.addEventListener('unhandledrejection', function(e){ send('error', ['unhandledrejection', String(e.reason && (e.reason.stack || e.reason))]); });
      send('log', ['bridge ready: webkit=' + !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.peiwan)]);
    })();
    """, injectionTime: .atDocumentStart, forMainFrameOnly: true)

    /// 处理 H5 转发过来的 log 消息，返回 true 表示已消费
    static func handleLogMessage(_ body: [String: Any], scope: String) -> Bool {
        guard body["type"] as? String == "log" else { return false }
        let level = body["level"] as? String ?? "log"
        let msg = body["msg"] as? String ?? ""
        log("\(scope): [H5 \(level)] \(msg)")
        return true
    }
}

/// 页面加载 / 失败 / 进程崩溃日志（大厅与游戏页共用）
final class WebNavLogger: NSObject, WKNavigationDelegate {
    let scope: String
    init(scope: String) { self.scope = scope }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        GameLog.log("\(scope): page started \(webView.url?.absoluteString.components(separatedBy: "token=").first ?? "")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        GameLog.log("\(scope): page finished title='\(webView.title ?? "")'")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        GameLog.log("\(scope): load failed \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        GameLog.log("\(scope): provisional load failed \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        GameLog.log("\(scope): web content process terminated (crash), reloading")
        webView.reload()
    }
}

/// 大厅 WebView 容器：深色底避免加载白闪，支持侧滑返回 H5 内页；
/// 注册 JS 桥（window.webkit.messageHandlers.peiwan）：openChat 唤起原生聊天页，openWeb 唤起原生全屏网页
private struct HallWebView: UIViewRepresentable {
    let url: URL
    let onOpenChat: (ChatTarget) -> Void
    let onOpenWeb: (WebTarget) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onOpenChat: onOpenChat, onOpenWeb: onOpenWeb) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "peiwan")
        // H5 console / JS 报错转原生日志（[Game] hall: [H5 ...]）
        config.userContentController.addUserScript(GameLog.consoleForwardScript)
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.bg)
        web.scrollView.backgroundColor = UIColor(Theme.bg)
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator.navLogger
        GameLog.log("hall: webview created, bridge peiwan registered")
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onOpenChat: (ChatTarget) -> Void
        let onOpenWeb: (WebTarget) -> Void
        let navLogger = WebNavLogger(scope: "hall")
        init(onOpenChat: @escaping (ChatTarget) -> Void, onOpenWeb: @escaping (WebTarget) -> Void) {
            self.onOpenChat = onOpenChat
            self.onOpenWeb = onOpenWeb
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "peiwan" else { return }
            guard let body = message.body as? [String: Any] else {
                GameLog.log("hall: bridge message with non-dict body: \(String(describing: message.body))")
                return
            }
            if GameLog.handleLogMessage(body, scope: "hall") { return }
            GameLog.log("hall: bridge message \(body)")
            switch body["type"] as? String {
            case "openChat":
                guard let convId = body["convId"] as? String, !convId.isEmpty else { return }
                let convType = (body["convType"] as? NSNumber)?.intValue ?? Int(body["convType"] as? String ?? "") ?? 1
                let targetId = body["targetId"] as? String ?? ""
                let title = body["title"] as? String ?? ""
                let onOpenChat = onOpenChat
                DispatchQueue.main.async {
                    onOpenChat(ChatTarget(convId: convId, convType: convType, targetId: targetId, title: title))
                }
            case "openWeb":
                guard let raw = body["url"] as? String,
                      let url = URL(string: raw),
                      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
                else {
                    GameLog.log("hall: openWeb rejected, url invalid or not http(s): \(String(describing: body["url"]))")
                    return
                }
                let title = body["title"] as? String ?? ""
                let landscape = (body["orientation"] as? String) == "landscape"
                let onOpenWeb = onOpenWeb
                DispatchQueue.main.async {
                    GameLog.log("hall: openWeb -> present GameWebSheet url=\(url.absoluteString) landscape=\(landscape)")
                    onOpenWeb(WebTarget(url: url, title: title, landscape: landscape))
                }
            default:
                GameLog.log("hall: unknown bridge type \(String(describing: body["type"]))")
                return
            }
        }
    }
}

/**
 * 小游戏 / 第三方 H5 全屏容器：独立于大厅 WebView，游戏内跳转不影响大厅页。
 * - landscape=true：仅本页旋转为横屏（App 其余页面锁竖屏，见 OrientationLock），无顶栏、隐藏状态栏，左上角浮动返回键
 * - 竖屏顶栏：返回（优先网页后退）、标题（跟随网页 title）、关闭
 * - WKWebView 按游戏场景配置：内联播放、媒体免手势自动播放、侧滑后退、弹窗（alert/confirm）转原生
 * - 非 http(s) 链接（weixin:// alipays:// 等）交给系统打开
 */
struct GameWebSheet: View {
    let url: URL
    let title: String
    var landscape: Bool = false
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = GameWebModel()

    var body: some View {
        Group {
            if landscape {
                GameWebView(url: url, model: model)
                    .ignoresSafeArea()
                    .overlay(alignment: .topLeading) {
                        Button {
                            if model.canGoBack { model.goBack() } else { dismiss() }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.black.opacity(0.45), in: Circle())
                        }
                        .padding(.leading, 10)
                        .padding(.top, 10)
                    }
                    .statusBarHidden(true)
            } else {
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Button {
                            if model.canGoBack { model.goBack() } else { dismiss() }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Theme.text)
                                .frame(width: 40, height: 40)
                        }
                        Text(model.pageTitle.isEmpty ? title : model.pageTitle)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                        Button("关闭") { dismiss() }
                            .font(.system(size: 14))
                            .foregroundStyle(model.canGoBack ? Theme.textSub : .clear)
                            .frame(width: 56, height: 40)
                            .disabled(!model.canGoBack)
                    }
                    .padding(.horizontal, 8)
                    .background(Theme.bg)
                    .overlay(alignment: .bottom) {
                        if model.progress > 0 && model.progress < 1 {
                            GeometryReader { geo in
                                Rectangle().fill(Theme.accent)
                                    .frame(width: geo.size.width * model.progress, height: 2)
                            }
                            .frame(height: 2)
                        }
                    }
                    GameWebView(url: url, model: model)
                        .ignoresSafeArea(edges: .bottom)
                }
            }
        }
        .background(Color.black.ignoresSafeArea())
        // 进入横屏游戏时旋转屏幕，离开还原竖屏（fullScreenCover 关闭即触发）
        .onAppear {
            GameLog.log("game: sheet appear url=\(url.absoluteString) title=\(title) landscape=\(landscape)")
            if landscape { OrientationLock.set(.landscape) }
        }
        .onDisappear {
            GameLog.log("game: sheet disappear")
            if landscape { OrientationLock.set(.portrait) }
        }
    }
}

/// 游戏 WebView 状态（标题 / 进度 / 可后退），供顶栏展示与控制
final class GameWebModel: ObservableObject {
    @Published var pageTitle = ""
    @Published var progress: Double = 0
    @Published var canGoBack = false
    weak var webView: WKWebView?

    func goBack() { webView?.goBack() }
}

private struct GameWebView: UIViewRepresentable {
    let url: URL
    let model: GameWebModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // 游戏音效 / 背景音乐无需用户手势即可播放
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // 默认 UA 后追加 App 标识，游戏侧可据此识别 App 环境
        config.applicationNameForUserAgent = "PeiwanApp/iOS"
        // 游戏页 console / JS 报错转原生日志（[Game] game: [H5 ...]）
        config.userContentController.add(context.coordinator, name: "peiwan")
        config.userContentController.addUserScript(GameLog.consoleForwardScript)
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        model.webView = web
        context.coordinator.observe(web)
        GameLog.log("game: webview created, loading \(url.absoluteString)")
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        GameLog.log("game: webview dismantle")
        coordinator.stopObserving()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "peiwan")
        uiView.stopLoading()
        // 释放游戏音频 / 定时器
        uiView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: GameWebModel
        private var observers: [NSKeyValueObservation] = []
        init(model: GameWebModel) { self.model = model }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if GameLog.handleLogMessage(body, scope: "game") { return }
            GameLog.log("game: bridge message ignored \(body)")
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            GameLog.log("game: page started \(webView.url?.absoluteString ?? "")")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            GameLog.log("game: page finished title='\(webView.title ?? "")'")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            GameLog.log("game: load failed \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            GameLog.log("game: provisional load failed \(error.localizedDescription)")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            GameLog.log("game: web content process terminated (crash)")
        }

        func observe(_ web: WKWebView) {
            observers = [
                web.observe(\.title, options: [.new]) { [weak self] w, _ in
                    let t = w.title ?? ""
                    if !t.isEmpty, !t.hasPrefix("http") { self?.model.pageTitle = t }
                },
                web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
                    self?.model.progress = w.estimatedProgress
                },
                web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in
                    self?.model.canGoBack = w.canGoBack
                },
            ]
        }

        func stopObserving() {
            observers.forEach { $0.invalidate() }
            observers.removeAll()
        }

        // 非 http(s) scheme（微信 / 支付宝等）交给系统
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let u = navigationAction.request.url, let scheme = u.scheme?.lowercased() else {
                decisionHandler(.allow); return
            }
            if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
                decisionHandler(.allow)
            } else {
                GameLog.log("game: external scheme \(u.absoluteString)")
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
            }
        }

        // 游戏里 window.open / target=_blank：在当前 WebView 内打开
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let u = navigationAction.request.url {
                webView.load(URLRequest(url: u))
            }
            return nil
        }

        // alert / confirm / prompt 转原生弹窗（WKWebView 默认不显示）
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
                UIAlertAction(title: "好", style: .default) { _ in completionHandler() },
            ], onFail: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [
                UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) },
                UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) },
            ], onFail: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            present(alert, actions: [
                UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) },
                UIAlertAction(title: "确定", style: .default) { _ in completionHandler(alert.textFields?.first?.text) },
            ], onFail: { completionHandler(nil) })
        }

        private func present(_ alert: UIAlertController, actions: [UIAlertAction], onFail: @escaping () -> Void) {
            actions.forEach(alert.addAction)
            guard let top = Self.topController() else { onFail(); return }
            top.present(alert, animated: true)
        }

        private static func topController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
            var top = window?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }
    }
}

/// 同城搭子项目主页
struct GuideProjectView: View {
    @EnvironmentObject var state: AppState
    @State private var guides: [Person] = []
    @State private var chatTarget: ChatTarget?

    private var isFemale: Bool { state.user?.gender == 2 }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        entryCard("找搭子", "按城市寻找认证搭子", Route.people("guide"))
                        entryCard("找人", "发现新朋友打招呼", Route.people("all"))
                    }
                    HStack(spacing: 10) {
                        if isFemale {
                            entryCard("接单大厅", "报名接单赚积分", Route.taskHall)
                        } else {
                            entryCard("发布约单", "时间地点报酬托管", Route.taskPost)
                        }
                        entryCard(isFemale ? "我的接单" : "我的约单", "查看进行中的约单", Route.taskMine)
                    }

                    Text("推荐搭子")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        .padding(.vertical, 16)

                    if guides.isEmpty {
                        Text("暂无认证搭子").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            .frame(maxWidth: .infinity).padding(40)
                    } else {
                        ForEach(guides) { p in
                            PersonRow(p: p) { greet(p) }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .fullBg()
        .navigationTitle("同城搭子")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .task {
            let all: [Person] = (try? await Api.request("/guide/list")) ?? []
            guides = Array(all.prefix(6))
        }
    }

    private func greet(_ p: Person) {
        Task {
            if let t = await openChatWith(userId: p.id, nickname: p.nickname ?? "") { chatTarget = t }
        }
    }

    private func entryCard(_ title: String, _ sub: String, _ route: Route) -> some View {
        RouteLink(route) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Text(sub).font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
        }
        .buttonStyle(.plain)
    }
}

/// 人员行（推荐搭子/找人通用）
struct PersonRow: View {
    let p: Person
    var showCity: Bool = false
    let onGreet: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(url: p.avatar, size: 52)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text("\(p.nickname ?? "") · \(p.age ?? 0)").font(.system(size: 15)).foregroundStyle(Theme.text)
                    if p.isGuide == true { Text("认证").font(.system(size: 11)).foregroundStyle(Theme.accent) }
                }
                Text((p.signature?.isEmpty == false) ? p.signature! : "这个人很神秘")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineLimit(1)
                if showCity, let city = p.cityName, !city.isEmpty {
                    Text(city).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
            }
            Spacer()
            Button(action: onGreet) {
                Text("打招呼").font(.system(size: 13)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(Capsule().fill(Theme.accent))
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 10)
    }
}

/// 找人 / 找搭子
struct PeopleView: View {
    let mode: String
    @State private var tab = "all"
    @State private var items: [Person] = []
    @State private var chatTarget: ChatTarget?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 20) {
                TextTab(text: "认证", selected: tab == "guide") { tab = "guide"; Task { await load() } }
                TextTab(text: "全部", selected: tab == "all") { tab = "all"; Task { await load() } }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 10)

            if items.isEmpty {
                EmptyHint(text: "暂无用户")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { p in
                            PersonRow(p: p, showCity: true) {
                                Task {
                                    if let t = await openChatWith(userId: p.id, nickname: p.nickname ?? "") { chatTarget = t }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
        .fullBg()
        .navigationTitle(tab == "guide" ? "找搭子" : "找人")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .task {
            tab = mode == "guide" ? "guide" : "all"
            await load()
        }
    }

    private func load() async {
        items = (try? await Api.request(tab == "guide" ? "/guide/list" : "/guide/discover")) ?? []
    }
}
