import SwiftUI
import WebKit

/**
 * 大厅：App 内嵌 H5（WebView），业务模块在网页端热更、无需发版。
 * 地址后台可配（GET /modules/hall，env HALL_H5_URL），默认加载 Web 端的 /site/#/hall-embed，
 * URL 携带 token 免登录（用 App 的身份），页面内自行导航，其它 tab 保持原生。
 */
struct HallView: View {
    @State private var hallUrl: URL?

    var body: some View {
        Group {
            if let hallUrl {
                HallWebView(url: hallUrl)
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        .task {
            guard hallUrl == nil else { return }
            struct HallCfg: Codable { var url: String? = "" }
            let cfg: HallCfg? = try? await Api.request("/modules/hall")
            var base = cfg?.url ?? ""
            if base.isEmpty { base = "\(Api.baseURL)/site/#/hall-embed" }
            let sep = base.contains("?") ? "&" : "?"
            hallUrl = URL(string: "\(base)\(sep)token=\(Api.token ?? "")&embed=1")
        }
    }
}

/// 大厅 WebView 容器：深色底避免加载白闪，支持侧滑返回 H5 内页
private struct HallWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.bg)
        web.scrollView.backgroundColor = UIColor(Theme.bg)
        web.allowsBackForwardNavigationGestures = true
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
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
