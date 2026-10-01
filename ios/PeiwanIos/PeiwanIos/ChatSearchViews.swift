import SwiftUI

struct NoticeLast: Codable, Hashable {
    var title: String? = ""
    var body: String? = ""
    var createdAt: String? = ""
}

struct NoticeSummary: Codable, Hashable {
    var unread: Int? = 0
    var last: NoticeLast? = nil
}

/// GET /notifications/summary：评论 / 接单两个系统会话的未读数 + 最新一条
struct NoticeSummaryResp: Codable, Hashable {
    var comment: NoticeSummary? = nil
    var task: NoticeSummary? = nil

    func of(_ kind: String) -> NoticeSummary? { kind == "task" ? task : comment }
}

struct SearchMsgHit: Codable, Identifiable {
    var id: String
    var conversationId: String
    var convType: Int?
    var targetId: String?
    var title: String?
    var avatar: String?
    var senderNickname: String?
    var content: String?
    var createdAt: String?
}

struct SearchUserHit: Codable, Identifiable {
    var id: String
    var nickname: String?
    var avatar: String?
    var age: Int?
    var cityName: String?
}

struct SearchResp: Codable {
    var messages: [SearchMsgHit]?
    var users: [SearchUserHit]?
}

/// 最近搜索：conv / extra 只存 id（显示时取当前数据），user 把展示信息也存下
struct SearchRecent: Codable, Hashable {
    var kind: String
    var id: String
    var title: String = ""
    var avatar: String = ""
    var subtitle: String = ""
}

/// 消息页里不是会话的固定条目（AI 助手 / 音乐 / 评论通知 / 接单通知），也能被搜到
struct SearchExtra: Identifiable {
    let key: String
    let title: String
    let subtitle: String
    var unread: Int = 0
    let icon: (CGFloat) -> AnyView
    let onOpen: () -> Void
    var id: String { key }
}

extension Notification.Name {
    /// 通知列表页标记已读后发出，消息页据此刷新评论 / 接单未读数
    static let noticesRead = Notification.Name("noticesRead")
}

func noticeTitle(_ kind: String) -> String { kind == "task" ? "接单通知" : "评论通知" }

/// 评论 / 接单系统会话的圆形图标
struct NoticeIconView: View {
    let kind: String
    var size: CGFloat = 54
    var body: some View {
        let colors = kind == "task"
            ? [Color(red: 0.18, green: 0.71, blue: 1), Color(red: 0.3, green: 0.44, blue: 1)]
            : [Color(red: 1, green: 0.6, blue: 0.24), Theme.accent]
        Circle()
            .fill(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: kind == "task" ? "briefcase.fill" : "bubble.left.fill")
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            )
    }
}

struct AiIconView: View {
    var size: CGFloat = 54
    var body: some View {
        Circle().fill(Theme.accentGrad)
            .frame(width: size, height: size)
            .overlay(Text("AI").font(.system(size: size * 0.31, weight: .heavy)).foregroundStyle(.white))
    }
}

struct MusicIconView: View {
    var size: CGFloat = 54
    var body: some View {
        Circle()
            .fill(LinearGradient(colors: [Color(red: 0.48, green: 0.36, blue: 1), Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size, height: size)
            .overlay(Image(systemName: "music.note").font(.system(size: size * 0.44, weight: .semibold)).foregroundStyle(.white))
    }
}

private enum SearchRecentStore {
    static let key = "chat_search_recent"
    static let max = 20

    static func load() -> [SearchRecent] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([SearchRecent].self, from: data)) ?? []
    }

    static func save(_ list: [SearchRecent]) {
        let data = try? JSONEncoder().encode(Array(list.prefix(max)))
        UserDefaults.standard.set(data, forKey: key)
    }
}

/// 关键词高亮（不区分大小写）
private func highlighted(_ text: String, _ q: String) -> Text {
    let k = q.trimmingCharacters(in: .whitespaces)
    guard !k.isEmpty else { return Text(text) }
    var out = Text("")
    var rest = text[...]
    while let r = rest.range(of: k, options: .caseInsensitive) {
        out = out + Text(String(rest[rest.startIndex..<r.lowerBound]))
        out = out + Text(String(rest[r])).foregroundColor(Theme.accent).fontWeight(.semibold)
        rest = rest[r.upperBound...]
    }
    return out + Text(String(rest))
}

private func shortDate(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let cal = Calendar.current
    let df = DateFormatter()
    if cal.isDateInToday(d) { df.dateFormat = "HH:mm" }
    else if cal.component(.year, from: d) == cal.component(.year, from: Date()) { df.dateFormat = "M/d" }
    else { df.dateFormat = "yyyy/M/d" }
    return df.string(from: d)
}

private func convTitle(_ c: ConversationItem) -> String { c.type == 1 ? (c.peer?.nickname ?? "") : (c.group?.name ?? "") }
private func convAvatar(_ c: ConversationItem) -> String? { c.type == 1 ? c.peer?.avatar : c.group?.avatar }
private func convTarget(_ c: ConversationItem) -> String { c.type == 1 ? (c.peer?.id ?? "") : (c.group?.id ?? "") }

private struct UnreadBadge: View {
    let n: Int
    var body: some View {
        if n > 0 {
            Text(n > 99 ? "99+" : "\(n)").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                .background(Capsule().fill(Theme.accent))
        }
    }
}

/**
 * 消息页搜索弹框（Telegram 式，盖住整个消息页 + 底栏）：
 * 空搜索 = 常用联系人横排 + 最近搜索；有关键词 = 聊天（本地会话名 + 全局用户）/ 消息（内容匹配）两栏。
 */
struct ChatSearchView: View {
    let convs: [ConversationItem]
    let extras: [SearchExtra]
    let onClose: () -> Void
    let onOpenChat: (ChatTarget) -> Void
    let onOpenUser: (String) -> Void

    @State private var q = ""
    @State private var tab = 0
    @State private var recent: [SearchRecent] = SearchRecentStore.load()
    @State private var resultQuery = ""
    @State private var result = SearchResp()
    @State private var loading = false
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    private var keyword: String { q.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !keyword.isEmpty { tabs }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if keyword.isEmpty { idleContent }
                    else if tab == 0 { chatsContent }
                    else { messagesContent }
                }
                .padding(.bottom, 20)
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .onAppear {
            TabBarVisibility.shared.depth += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { focused = true }
        }
        .onDisappear {
            TabBarVisibility.shared.depth -= 1
            searchTask?.cancel()
        }
        .onChange(of: q) { _ in schedule() }
    }

    private func schedule() {
        searchTask?.cancel()
        let k = keyword
        guard !k.isEmpty else { loading = false; resultQuery = ""; result = SearchResp(); return }
        loading = true
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            let enc = k.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? k
            let r: SearchResp = (try? await Api.request("/im/search?q=\(enc)")) ?? SearchResp()
            if Task.isCancelled { return }
            resultQuery = k
            result = r
            loading = false
        }
    }

    // MARK: 顶部

    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.textSub)
                TextField("搜索", text: $q)
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.text)
                    .tint(Theme.accent)
                    .focused($focused)
                    .submitLabel(.search)
                    .onSubmit { focused = false }
                    .disableAutocorrection(true)
                if !q.isEmpty {
                    Button { q = "" } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Capsule().fill(Theme.bg2).shadow(color: .black.opacity(0.06), radius: 8, y: 2))

            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 18, weight: .medium)).foregroundStyle(Theme.text)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Theme.bg2).shadow(color: .black.opacity(0.06), radius: 8, y: 2))
            }
            .buttonStyle(.plain)
        }
        .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 12))
    }

    private var tabs: some View {
        let msgCount = resultQuery == keyword ? (result.messages?.count ?? 0) : 0
        return HStack(spacing: 6) {
            tabPill("聊天", 0)
            tabPill(msgCount > 0 ? "消息 \(msgCount)" : "消息", 1)
            Spacer()
        }
        .padding(EdgeInsets(top: 2, leading: 16, bottom: 8, trailing: 16))
    }

    private func tabPill(_ label: String, _ idx: Int) -> some View {
        Button { tab = idx } label: {
            Text(label)
                .font(.system(size: 14, weight: tab == idx ? .semibold : .regular))
                .foregroundStyle(tab == idx ? Theme.text : Theme.textSub)
                .padding(.horizontal, 16).padding(.vertical, 6)
                .background(Capsule().fill(tab == idx ? Theme.bg3 : Color.clear))
        }
        .buttonStyle(.plain)
    }

    // MARK: 内容

    @ViewBuilder private var idleContent: some View {
        let top = Array(convs.prefix(12))
        if !top.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(top) { c in
                        Button { openConv(c) } label: {
                            VStack(spacing: 6) {
                                AvatarView(url: convAvatar(c), size: 56)
                                    .overlay(alignment: .topTrailing) { UnreadBadge(n: c.unread ?? 0).offset(x: 4, y: -2) }
                                Text(convTitle(c)).font(.system(size: 12)).foregroundStyle(Theme.text).lineLimit(1)
                            }
                            .frame(width: 72)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
            }
        }
        let rows = recentRows
        if rows.isEmpty {
            hint("搜索聊天、消息内容和用户")
        } else {
            sectionHead("最近", action: "清空") { recent = []; SearchRecentStore.save([]) }
            ForEach(rows, id: \.self) { r in recentRow(r) }
        }
    }

    private var recentRows: [SearchRecent] {
        let convIds = Set(convs.map(\.id))
        let extraKeys = Set(extras.map(\.key))
        return recent.filter { r in
            switch r.kind {
            case "conv": return convIds.contains(r.id)
            case "extra": return extraKeys.contains(r.id)
            default: return true
            }
        }
    }

    @ViewBuilder private func recentRow(_ r: SearchRecent) -> some View {
        switch r.kind {
        case "conv":
            if let c = convs.first(where: { $0.id == r.id }) { convRow(c) }
        case "extra":
            if let e = extras.first(where: { $0.key == r.id }) { extraRow(e) }
        default:
            userRow(r)
        }
    }

    @ViewBuilder private var chatsContent: some View {
        let lower = keyword.lowercased()
        let extraHits = extras.filter { $0.title.lowercased().contains(lower) }
        let chatHits = convs.filter { convTitle($0).lowercased().contains(lower) }
        let peerIds = Set(convs.filter { $0.type == 1 }.compactMap { $0.peer?.id })
        let userHits = resultQuery == keyword ? (result.users ?? []).filter { !peerIds.contains($0.id) } : []
        ForEach(extraHits) { extraRow($0) }
        ForEach(chatHits) { convRow($0) }
        if !userHits.isEmpty {
            sectionHead("全局搜索")
            ForEach(userHits) { u in
                let sub = [u.age.flatMap { $0 > 0 ? "\($0) 岁" : nil }, u.cityName.flatMap { $0.isEmpty ? nil : $0 }]
                    .compactMap { $0 }.joined(separator: " · ")
                userRow(SearchRecent(kind: "user", id: u.id, title: u.nickname ?? "", avatar: u.avatar ?? "", subtitle: sub.isEmpty ? "用户" : sub))
            }
        }
        if extraHits.isEmpty && chatHits.isEmpty && userHits.isEmpty {
            hint(loading ? "搜索中…" : "没有找到相关聊天")
        }
    }

    @ViewBuilder private var messagesContent: some View {
        let hits = resultQuery == keyword ? (result.messages ?? []) : []
        ForEach(hits) { m in messageRow(m) }
        if hits.isEmpty { hint(loading ? "搜索中…" : "没有找到相关消息") }
    }

    // MARK: 行

    private func addRecent(_ r: SearchRecent) {
        recent = [r] + recent.filter { !($0.kind == r.kind && $0.id == r.id) }
        SearchRecentStore.save(recent)
    }

    private func openConv(_ c: ConversationItem, focusMsgId: String? = nil) {
        addRecent(SearchRecent(kind: "conv", id: c.id))
        focused = false
        let title = c.type == 2 ? "\(convTitle(c))（群）" : convTitle(c)
        onOpenChat(ChatTarget(convId: c.id, convType: c.type, targetId: convTarget(c), title: title, focusMsgId: focusMsgId))
    }

    private func row<Leading: View, Main: View>(action: @escaping () -> Void, badge: Int = 0, @ViewBuilder leading: () -> Leading, @ViewBuilder main: () -> Main) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                leading()
                VStack(alignment: .leading, spacing: 2) { main() }
                    .frame(maxWidth: .infinity, alignment: .leading)
                UnreadBadge(n: badge)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func groupTag() -> some View {
        Text("群").font(.system(size: 10)).foregroundStyle(Theme.textSub)
            .padding(.horizontal, 4)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
    }

    private func convRow(_ c: ConversationItem) -> some View {
        row(action: { openConv(c) }, badge: c.unread ?? 0) {
            AvatarView(url: convAvatar(c), size: 44)
        } main: {
            HStack(spacing: 6) {
                highlighted(convTitle(c), keyword).font(.system(size: 16, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
                if c.type == 2 { groupTag() }
            }
            Text(previewOf(c.lastMsg)).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
        }
    }

    private func extraRow(_ e: SearchExtra) -> some View {
        row(action: {
            addRecent(SearchRecent(kind: "extra", id: e.key))
            focused = false
            e.onOpen()
        }, badge: e.unread) {
            e.icon(44)
        } main: {
            highlighted(e.title, keyword).font(.system(size: 16, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
            Text(e.subtitle).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
        }
    }

    private func userRow(_ r: SearchRecent) -> some View {
        row(action: {
            addRecent(r)
            focused = false
            onOpenUser(r.id)
        }) {
            AvatarView(url: r.avatar, size: 44)
        } main: {
            highlighted(r.title, keyword).font(.system(size: 16, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
            Text(r.subtitle).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
        }
    }

    private func messageRow(_ m: SearchMsgHit) -> some View {
        let isGroup = m.convType == 2
        let sender = m.senderNickname ?? ""
        return row(action: {
            if let c = convs.first(where: { $0.id == m.conversationId }) {
                openConv(c, focusMsgId: m.id)
            } else {
                focused = false
                let title = isGroup ? "\(m.title ?? "")（群）" : (m.title ?? "")
                onOpenChat(ChatTarget(convId: m.conversationId, convType: m.convType ?? 1, targetId: m.targetId ?? "", title: title, focusMsgId: m.id))
            }
        }) {
            AvatarView(url: m.avatar, size: 44)
        } main: {
            HStack(spacing: 6) {
                Text(m.title ?? "").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                if isGroup { groupTag() }
                Spacer(minLength: 8)
                Text(shortDate(m.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
            }
            ((isGroup || sender == "我" ? Text("\(sender)：").foregroundColor(Theme.text) : Text(""))
                + highlighted(m.content ?? "", keyword))
                .font(.system(size: 13)).foregroundColor(Theme.textSub).lineLimit(2)
        }
    }

    private func sectionHead(_ title: String, action: String? = nil, onAction: @escaping () -> Void = {}) -> some View {
        HStack {
            Text(title).font(.system(size: 13)).foregroundStyle(Theme.textSub)
            Spacer()
            if let action {
                Button(action: onAction) { Text(action).font(.system(size: 13)).foregroundStyle(Theme.textSub) }.buttonStyle(.plain)
            }
        }
        .padding(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(Theme.textDim)
            .frame(maxWidth: .infinity).padding(.vertical, 60)
    }
}

/// 评论 / 接单通知列表（消息页里的系统会话点进来），拉取即已读
struct NoticesView: View {
    let kind: String
    @State private var list: [NotificationItem]?

    var body: some View {
        Group {
            if let list {
                if list.isEmpty {
                    EmptyHint(text: kind == "task" ? "暂无接单消息" : "暂无评论消息")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) { ForEach(list) { row($0) } }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .fullBg()
        .navigationTitle(noticeTitle(kind))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let items: [NotificationItem] = (try? await Api.request("/notifications?kind=\(kind)")) ?? []
            list = items
            NotificationCenter.default.post(name: .noticesRead, object: nil)
        }
    }

    private func row(_ n: NotificationItem) -> some View {
        RouteLink(kind == "task" ? .task(n.refId ?? "0") : .moment(n.refId ?? "0")) {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(n.title ?? "")
                        .font(.system(size: 15, weight: (n.isRead ?? false) ? .regular : .semibold))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    Text(timeAgo(n.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                if let body = n.body, !body.isEmpty {
                    Text(body).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                }
                Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 9)
            }
            .padding(.horizontal, 16).padding(.top, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
