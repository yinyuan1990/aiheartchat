import SwiftUI

// MARK: - 模型

struct TreeholeCommenter: Codable, Hashable {
    var avatar: String? = ""
}

/// 私密树洞帖子（匿名：无作者信息，只有 mine 标记自己）
struct TreeholePost: Codable, Identifiable, Hashable {
    var id: String = ""
    var content: String = ""
    /// 0=用户投稿 1=后台录入
    var source: Int? = 0
    var viewCount: Int? = 0
    var commentCount: Int? = 0
    var commenters: [TreeholeCommenter]? = []
    var mine: Bool? = false
    var createdAt: String? = ""
}

struct TreeholeComment: Codable, Identifiable, Hashable {
    var id: String = ""
    var user: MomentUser? = nil
    var content: String = ""
    var replyToId: String? = nil
    var replyToNickname: String? = ""
    var createdAt: String? = ""
}

/// 树洞列表共享状态：切 tab / 返回不重拉；发布、评论、删除后主动同步
@MainActor
final class TreeholeStore: ObservableObject {
    static let shared = TreeholeStore()
    @Published var items: [TreeholePost] = []
    @Published var loaded = false
    @Published var hasMore = true

    func refresh() async {
        if let list: [TreeholePost] = try? await Api.request("/treehole") {
            items = list
            hasMore = list.count >= 20
        }
        loaded = true
    }

    func loadMore() async {
        guard hasMore, let last = items.last else { return }
        guard let more: [TreeholePost] = try? await Api.request("/treehole?beforeId=\(last.id)") else { return }
        items += more
        hasMore = more.count >= 20
    }

    func bumpComment(_ id: String) {
        if let i = items.firstIndex(where: { $0.id == id }) {
            items[i].commentCount = (items[i].commentCount ?? 0) + 1
        }
    }

    func remove(_ id: String) {
        items.removeAll { $0.id == id }
    }
}

// MARK: - 工具

private let channelName = "私密树洞"
private let channelColor = Color(red: 0.706, green: 0.549, blue: 1.0)   // #B48CFF
private let linkBlue = Color(red: 0.353, green: 0.663, blue: 1.0)       // #5AA9FF
private let nameColors: [Color] = [
    Color(red: 0.898, green: 0.451, blue: 0.451), Color(red: 0.392, green: 0.710, blue: 0.965),
    Color(red: 0.506, green: 0.780, blue: 0.518), Color(red: 1.0, green: 0.718, blue: 0.302),
    Color(red: 0.729, green: 0.408, blue: 0.784), Color(red: 0.302, green: 0.816, blue: 0.882),
    Color(red: 0.941, green: 0.384, blue: 0.573), Color(red: 0.682, green: 0.835, blue: 0.506),
]

/// 阅读数：1234 → 1.2K，12345 → 1.2万
func fmtCount(_ n: Int) -> String {
    if n >= 100_000 { return "\(n / 10_000)万" }
    if n >= 10_000 { return String(format: "%.1f万", Double(n) / 10_000) }
    if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
    return "\(n)"
}

/// 今天只显示 HH:mm，今年 M月d日 HH:mm，更早带年份
func fmtTreeholeTime(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let cal = Calendar.current
    let df = DateFormatter()
    df.locale = Locale(identifier: "zh_CN")
    if cal.isDateInToday(d) {
        df.dateFormat = "HH:mm"
    } else if cal.component(.year, from: d) == cal.component(.year, from: Date()) {
        df.dateFormat = "M月d日 HH:mm"
    } else {
        df.dateFormat = "yyyy/M/d HH:mm"
    }
    return df.string(from: d)
}

private func nameColor(_ id: String) -> Color {
    var h: UInt32 = 0
    for u in id.unicodeScalars { h = h &* 31 &+ u.value }
    return nameColors[Int(h % UInt32(nameColors.count))]
}

// MARK: - 广场「私密树洞」tab

/// 信息流：Telegram 频道式卡片 + 右下角「写树洞」
struct TreeholeSectionView: View {
    @ObservedObject private var store = TreeholeStore.shared

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if store.items.isEmpty {
                ScrollView {
                    EmptyHint(text: store.loaded ? "树洞还是空的\n说点只想让陌生人听见的话吧" : "加载中…")
                        .frame(height: 360)
                }
                .refreshable { await store.refresh() }
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(store.items) { p in
                            RouteLink(.treehole(p.id)) {
                                TreeholeCardView(post: p, clamp: true, showCommentsBar: true)
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                // 滚到倒数第二条时加载更多
                                if let idx = store.items.firstIndex(where: { $0.id == p.id }), idx >= store.items.count - 2 {
                                    Task { await store.loadMore() }
                                }
                            }
                        }
                        Color.clear.frame(height: 80)
                    }
                    .padding(.horizontal, 14).padding(.top, 2)
                }
                .refreshable { await store.refresh() }
            }

            RouteLink(.treeholePublish) {
                Text("✎ 写树洞")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(Capsule().fill(Theme.accentGrad))
                    .shadow(color: Theme.accent.opacity(0.35), radius: 9, y: 4)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16).padding(.bottom, 20)
        }
        .task {
            if !store.loaded { await store.refresh() }
        }
    }
}

/// 帖子卡：频道名 + 正文 + 阅读/时间 + 评论条（clamp=列表折叠 10 行）
struct TreeholeCardView: View {
    let post: TreeholePost
    var clamp = false
    var showCommentsBar = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(channelName).font(.system(size: 13, weight: .semibold)).foregroundStyle(channelColor)
            Text(post.content)
                .font(.system(size: 15)).lineSpacing(6).foregroundStyle(Theme.text)
                .lineLimit(clamp ? 10 : nil)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
            HStack(spacing: 6) {
                Spacer()
                Text("👁 \(fmtCount(post.viewCount ?? 0))")
                Text(fmtTreeholeTime(post.createdAt))
            }
            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
            .padding(.top, 6)

            if showCommentsBar {
                Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 10)
                HStack(spacing: 10) {
                    let avatars = post.commenters ?? []
                    if !avatars.isEmpty {
                        HStack(spacing: -8) {
                            ForEach(Array(avatars.enumerated()), id: \.offset) { _, c in
                                AvatarView(url: c.avatar, size: 26)
                                    .overlay(Circle().stroke(Theme.bg2, lineWidth: 2))
                            }
                        }
                    }
                    Text((post.commentCount ?? 0) > 0 ? "\(post.commentCount ?? 0) 条评论" : "发表评论")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(linkBlue)
                    Spacer()
                    Text("›").font(.system(size: 20)).foregroundStyle(linkBlue)
                }
                .padding(.top, 10)
            }
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
    }
}

// MARK: - 详情：帖子 + 讨论

struct TreeholeDetailView: View {
    let postId: String
    @Environment(\.dismiss) private var dismiss
    @State private var post: TreeholePost?
    @State private var comments: [TreeholeComment] = []
    @State private var input = ""
    @State private var replyTo: TreeholeComment?
    @State private var sending = false
    @State private var confirmDelete = false
    @State private var toastMsg: String?
    @FocusState private var inputFocused: Bool

    private var title: String {
        if let c = post?.commentCount, c > 0 { return "\(c) 条评论" }
        return channelName
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let p = post {
                            TreeholeCardView(post: p, clamp: false)
                            HStack {
                                Spacer()
                                Text(comments.isEmpty ? "还没有人评论，来说第一句" : "讨论已开始")
                                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                    .padding(.horizontal, 12).padding(.vertical, 4)
                                    .background(Capsule().fill(Color.white.opacity(0.08)))
                                Spacer()
                            }
                            .padding(.vertical, 14)
                        } else {
                            Text("加载中…").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                .frame(maxWidth: .infinity).padding(.top, 60)
                        }
                        ForEach(comments) { c in
                            HStack(alignment: .bottom, spacing: 10) {
                                AvatarView(url: c.user?.avatar, size: 34)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.user?.nickname ?? "用户")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(nameColor(c.user?.id ?? c.id))
                                    (
                                        Text((c.replyToNickname ?? "").isEmpty ? "" : "@\(c.replyToNickname ?? "") ").foregroundColor(linkBlue)
                                        + Text(c.content).foregroundColor(Theme.text)
                                    )
                                    .font(.system(size: 15)).lineSpacing(3)
                                    HStack(spacing: 10) {
                                        Spacer()
                                        Button("回复") { replyTo = c; inputFocused = true }
                                            .font(.system(size: 11)).foregroundStyle(Theme.textSub)
                                        Text(fmtTreeholeTime(c.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                    }
                                    .padding(.top, 3)
                                }
                                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
                                .background(
                                    CompatUnevenRounded(topLeadingRadius: 14, bottomLeadingRadius: 4, bottomTrailingRadius: 14, topTrailingRadius: 14)
                                        .fill(Theme.bg2)
                                )
                                .frame(maxWidth: 300, alignment: .leading)
                                Spacer(minLength: 0)
                            }
                            .padding(.bottom, 12)
                            .id(c.id)
                        }
                        Color.clear.frame(height: 12)
                    }
                    .padding(.horizontal, 14)
                }
                .onChange(of: comments.count) { _ in
                    if let last = comments.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }

            if let r = replyTo {
                HStack {
                    Text("回复 @\(r.user?.nickname ?? "")").font(.system(size: 12)).foregroundStyle(Theme.accent)
                    Spacer()
                    Button("取消") { replyTo = nil }.font(.system(size: 12)).foregroundStyle(Theme.textSub)
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
            }

            HStack(spacing: 10) {
                CompatVerticalTextField(
                    text: $input,
                    prompt: Text(replyTo != nil ? "回复 @\(replyTo?.user?.nickname ?? "")" : "说点什么…（评论会显示你的昵称）").foregroundColor(Theme.textSub),
                    lineRange: 1...4
                )
                .focused($inputFocused)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                .foregroundStyle(Theme.text)
                Button(sending ? "发送中" : "发送") { send() }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(canSend ? Theme.accent : Theme.textDim)
                    .disabled(!canSend)
            }
            .padding(12)
            .background(Theme.bg2)
        }
        .fullBg()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                // 只有自己的投稿才能删
                if post?.mine == true {
                    Button("删除") { confirmDelete = true }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
                }
            }
        }
        .alert("删除这条树洞？", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) { remove() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("评论也会一起消失")
        }
        .toast($toastMsg)
        .task { await load() }
    }

    private var canSend: Bool {
        !sending && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func load() async {
        post = try? await Api.request("/treehole/\(postId)")
        if post == nil {
            toastMsg = "内容不存在"
            return
        }
        comments = (try? await Api.request("/treehole/\(postId)/comments")) ?? []
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            struct IdResp: Codable { var id: String? }
            var body: [String: Any] = ["content": text]
            if let r = replyTo { body["replyToId"] = r.id }
            do {
                let _: IdResp = try await Api.request("/treehole/\(postId)/comments", method: "POST", body: body)
                input = ""
                replyTo = nil
                comments = (try? await Api.request("/treehole/\(postId)/comments")) ?? []
                post?.commentCount = (post?.commentCount ?? 0) + 1
                TreeholeStore.shared.bumpComment(postId)
            } catch {
                toastMsg = error.localizedDescription
            }
            sending = false
        }
    }

    private func remove() {
        Task {
            struct OkResp: Codable { var ok: Bool? }
            do {
                let _: OkResp = try await Api.request("/treehole/\(postId)", method: "DELETE")
                TreeholeStore.shared.remove(postId)
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

// MARK: - 匿名发布

struct TreeholePublishView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var content = ""
    @State private var busy = false
    @State private var toastMsg: String?
    @FocusState private var focused: Bool
    private let maxLen = 3000

    private var canSubmit: Bool {
        !busy && content.trimmingCharacters(in: .whitespacesAndNewlines).count >= 5
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if content.isEmpty {
                    Text("把想说却无处说的话放进树洞…")
                        .font(.system(size: 15)).foregroundStyle(Theme.textSub)
                        .padding(.horizontal, 18).padding(.top, 22)
                }
                TextEditor(text: $content)
                    .focused($focused)
                    .font(.system(size: 15)).lineSpacing(6)
                    .foregroundStyle(Theme.text)
                    .scrollContentBackgroundHidden()
                    .padding(10)
                    .frame(minHeight: 260)
                    .onChange(of: content) { v in
                        if v.count > maxLen { content = String(v.prefix(maxLen)) }
                    }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg3))

            HStack {
                Text("匿名发布：其他人只能看到内容，不会显示你的昵称和头像")
                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                Spacer()
                Text("\(content.count) / \(maxLen)").font(.system(size: 11)).foregroundStyle(Theme.textDim)
            }
            Spacer()
        }
        .padding(16)
        .fullBg()
        .navigationTitle("写树洞")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(busy ? "发布中" : "发布") { submit() }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(canSubmit ? Theme.accent : Theme.accent.opacity(0.4))
            }
        }
        .toast($toastMsg)
        .onAppear { focused = true }
    }

    private func submit() {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy else { return }
        guard text.count >= 5 else { toastMsg = "至少写 5 个字"; return }
        busy = true
        Task {
            struct IdResp: Codable { var id: String? }
            do {
                let _: IdResp = try await Api.request("/treehole", method: "POST", body: ["content": text])
                await TreeholeStore.shared.refresh()
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
                busy = false
            }
        }
    }
}

private extension View {
    /// TextEditor 透明背景（iOS16+ 用 scrollContentBackground，iOS15 用 UITextView.appearance 兜底）
    @ViewBuilder
    func scrollContentBackgroundHidden() -> some View {
        if #available(iOS 16.0, *) {
            scrollContentBackground(.hidden)
        } else {
            onAppear { UITextView.appearance().backgroundColor = .clear }
        }
    }
}
