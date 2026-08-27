import SwiftUI

func toFen(_ points: String) -> Int { Int(((Double(points) ?? 0) * 100).rounded()) }

func timeAgo(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "" }
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let f2 = ISO8601DateFormatter()
    let date = f1.date(from: iso) ?? f2.date(from: iso)
    guard let d = date else { return "" }
    let min = Int(Date().timeIntervalSince(d) / 60)
    if min < 1 { return "刚刚" }
    if min < 60 { return "\(min)分钟前" }
    if min < 1440 { return "\(min / 60)小时前" }
    if min < 43200 { return "\(min / 1440)天前" }
    return String(iso.prefix(10))
}

func parseIsoDate(_ iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f1.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
}

func fmtTime(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let df = DateFormatter()
    df.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "MM-dd HH:mm"
    return df.string(from: d)
}

/// 图片内存缓存
enum RemoteImageCache {
    static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 300
        return c
    }()
}

/**
 * 远程图片：内存缓存 + 失败/取消自动重试。
 * 替代 AsyncImage（它在列表滚动中请求被取消后不会重新加载，导致头像概率性空白）。
 */
struct RemoteImage: View {
    let url: String
    @State private var image: UIImage?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Theme.bg3
            }
        }
        // 视图出屏任务取消、回屏自动重新执行，天然解决“取消后不再加载”
        .task(id: "\(url)#\(attempt)") {
            await load()
        }
    }

    private func load() async {
        let full = Api.fullUrl(url)
        guard !full.isEmpty, let u = URL(string: full) else { return }
        if let cached = RemoteImageCache.cache.object(forKey: full as NSString) {
            if image == nil { image = cached }
            return
        }
        do {
            let (data, _) = try await URLSession.shared.data(from: u)
            if let img = UIImage(data: data) {
                RemoteImageCache.cache.setObject(img, forKey: full as NSString)
                image = img
            }
        } catch {
            // 失败（含被取消恢复后）延迟重试，最多 3 次
            if attempt < 3, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 800_000_000)
                if !Task.isCancelled { attempt += 1 }
            }
        }
    }
}

/// 圆形头像
struct AvatarView: View {
    let url: String?
    var size: CGFloat = 44
    var body: some View {
        Group {
            if let url, !url.isEmpty {
                RemoteImage(url: url)
            } else {
                Circle().fill(Theme.bg3)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

/// 玫红胶囊主按钮
struct AccentButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void
    var body: some View {
        Button(action: { if enabled { action() } }) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(enabled ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Theme.bg3))
                .foregroundStyle(.white)
                .clipShape(Capsule())
        }
        .disabled(!enabled)
    }
}

struct PageTitle: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 22, weight: .bold))
            .foregroundStyle(Theme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
    }
}

struct EmptyHint: View {
    let text: String
    var body: some View {
        VStack {
            Spacer()
            Text(text).font(.subheadline).foregroundStyle(Theme.textSub)
                .multilineTextAlignment(.center).lineSpacing(8)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 文字 Tab（无背景，选中高亮加粗）
struct TextTab: View {
    let text: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 16, weight: selected ? .bold : .regular))
                .foregroundStyle(selected ? Theme.text : Theme.textSub)
        }
        .buttonStyle(.plain)
    }
}

/// Toast 提示
struct ToastModifier: ViewModifier {
    @Binding var message: String?
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let msg = message {
                Text(msg)
                    .font(.system(size: 14))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(Capsule().fill(Color.black.opacity(0.8)))
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { message = nil }
                        }
                    }
            }
        }
    }
}

extension View {
    func toast(_ message: Binding<String?>) -> some View { modifier(ToastModifier(message: message)) }
}

/// 导航路由（各 Tab 根部注册 navigationDestination）
enum Route: Hashable {
    case moment(String)
    case project
    case people(String)
    case taskPost, taskHall, taskMine
    case task(String)
    case wallet, transfer, editProfile, guideApply, giftsReceived, myMoments, followMoments
    case createGroup
    /// 加入群聊（扫码/输邀请码），关联值为预填的邀请码
    case joinGroup(String?)
    case realname
    case userHome(String)
    /// 关注/粉丝列表：type = following | fans
    case followList(String)
    /// AI 助手（免费问答）
    case aiChat
    /// 花边新闻列表
    case newsList
    /// 花边新闻详情
    case newsDetail(String)
}

@ViewBuilder
func routeView(_ route: Route) -> some View {
    switch route {
    case .moment(let id): MomentDetailView(momentId: id)
    case .project: GuideProjectView()
    case .people(let mode): PeopleView(mode: mode)
    case .taskPost: TaskPostView()
    case .taskHall: TaskHallView()
    case .taskMine: TaskMineView()
    case .task(let id): TaskDetailView(taskId: id)
    case .wallet: WalletView()
    case .transfer: TransferView()
    case .editProfile: EditProfileView()
    case .guideApply: GuideApplyView()
    case .giftsReceived: GiftsReceivedView()
    case .myMoments: MyMomentsView()
    case .followMoments: FollowMomentsView()
    case .createGroup: CreateGroupView()
    case .joinGroup(let code): JoinGroupView(initialCode: code)
    case .realname: RealnameView()
    case .userHome(let id): UserHomeView(userId: id)
    case .followList(let type): FollowListView(type: type)
    case .aiChat: AiChatView()
    case .newsList: NewsListView()
    case .newsDetail(let id): NewsDetailView(newsId: id)
    }
}

/// 自定义底部 tab 栏的可见性：有子页面被 push 时隐藏（计数支持多级 push）
@MainActor
final class TabBarVisibility: ObservableObject {
    static let shared = TabBarVisibility()
    @Published var depth = 0
}

private struct HideTabBarModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .onAppear { withAnimation(.easeInOut(duration: 0.15)) { TabBarVisibility.shared.depth += 1 } }
            .onDisappear { withAnimation(.easeInOut(duration: 0.15)) { TabBarVisibility.shared.depth -= 1 } }
    }
}

extension View {
    /// 每个 NavigationStack 根部调用，注册统一路由（子页面自动隐藏底部 tab 栏）
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { routeView($0).modifier(HideTabBarModifier()) }
    }
}

/// 聊天全屏展示的目标（fullScreenCover）
struct ChatTarget: Identifiable {
    let id = UUID()
    let convId: String
    let convType: Int
    let targetId: String
    let title: String
}

/// 打开与某用户的单聊会话
func openChatWith(userId: String, nickname: String) async -> ChatTarget? {
    guard let r: OpenConvResp = try? await Api.request("/im/conversations/open/\(userId)", method: "POST") else { return nil }
    return ChatTarget(convId: r.conversationId, convType: 1, targetId: userId, title: nickname)
}
