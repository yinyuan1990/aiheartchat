import SwiftUI

// MARK: - 模型

struct TreeholeCommenter: Codable, Hashable {
    var avatar: String? = ""
}

/// 私密树洞帖子（匿名：无作者信息，只有 mine 标记自己）
struct TreeholePost: Codable, Identifiable, Hashable {
    var id: String = ""
    var content: String = ""
    /// 配图（最多 9 张）
    var images: [String]? = []
    /// 0=用户投稿 1=后台录入 2=Telegram 同步
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
    var sticker: StickerPayload? = nil
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
                // 频道式：最新在最底部、进入时停在底部。iOS15 没有 defaultScrollAnchor，
                // 用「整体上下翻转 + 每行再翻转回来」实现：数据仍是最新在前，index 0 显示在最底部
                ScrollView {
                    LazyVStack(spacing: 12) {
                        Color.clear.frame(height: 80)   // 翻转后在视觉底部，给「写树洞」按钮留位
                        ForEach(store.items) { p in
                            RouteLink(.treehole(p.id)) {
                                TreeholeCardView(post: p, clamp: true, showCommentsBar: true)
                            }
                            .buttonStyle(.plain)
                            .scaleEffect(x: 1, y: -1)
                            .onAppear {
                                // 滚到（视觉上的顶部）倒数第二条时加载更早的
                                if let idx = store.items.firstIndex(where: { $0.id == p.id }), idx >= store.items.count - 2 {
                                    Task { await store.loadMore() }
                                }
                            }
                        }
                        Color.clear.frame(height: 8)
                    }
                    .padding(.horizontal, 14)
                }
                .scaleEffect(x: 1, y: -1)
                // 翻转后系统下拉刷新控件会跑到视觉底部，去掉；改为每次进入 tab 时静默刷新
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
            // 每次进入 tab 静默刷新（有缓存时先显示旧内容）
            await store.refresh()
        }
    }
}

/// 帖子卡：频道名 + 正文 + 阅读/时间 + 评论条（clamp=列表折叠 10 行）
struct TreeholeCardView: View {
    let post: TreeholePost
    var clamp = false
    var showCommentsBar = false
    @State private var fullImage: String?

    var body: some View {
        let imgs = post.images ?? []
        VStack(alignment: .leading, spacing: 0) {
            Text(channelName).font(.system(size: 13, weight: .semibold)).foregroundStyle(channelColor)
                .padding(.horizontal, 14)
            // 配图：单图通栏（Telegram 式，左右出血），多图网格
            if imgs.count == 1 {
                RemoteImage(url: imgs[0])
                    .frame(maxWidth: .infinity).frame(height: 300)
                    .clipped()
                    .background(Theme.bg3)
                    .contentShape(Rectangle())
                    .onTapGesture { fullImage = imgs[0] }
                    .padding(.top, 6)
            } else if imgs.count > 1 {
                let cols = (imgs.count == 2 || imgs.count == 4) ? 2 : 3
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: cols), spacing: 3) {
                    ForEach(imgs, id: \.self) { u in
                        RemoteImage(url: u)
                            .aspectRatio(cols == 2 ? 4 / 3 : 1, contentMode: .fill)
                            .frame(maxWidth: .infinity)
                            .clipped()
                            .contentShape(Rectangle())
                            .onTapGesture { fullImage = u }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 14).padding(.top, 6)
            }
            if !post.content.isEmpty {
                Text(post.content)
                    .font(.system(size: 15)).lineSpacing(6).foregroundStyle(Theme.text)
                    .lineLimit(clamp ? 10 : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.top, imgs.isEmpty ? 6 : 8)
            }
            VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Spacer()
                // 系统线性眼睛图标替代 👁 emoji
                HStack(spacing: 3) {
                    Image(systemName: "eye").font(.system(size: 10))
                    Text(fmtCount(post.viewCount ?? 0))
                }
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
            } // 内边距区
            .padding(.horizontal, 14)
        }
        .padding(.top, 12).padding(.bottom, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .fullScreenCover(item: $fullImage) { img in
            ImageViewerView(images: imgs, initial: max(0, imgs.firstIndex(of: img) ?? 0)) { fullImage = nil }
        }
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
    /// 待发的贴纸：点贴纸先挂到输入栏，再点发送
    @State private var sticker: StickerPayload?
    @State private var showSticker = false
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
                                    .background(Capsule().fill(Color.black.opacity(0.05)))
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
                                    if !c.content.isEmpty || !(c.replyToNickname ?? "").isEmpty {
                                        (
                                            Text((c.replyToNickname ?? "").isEmpty ? "" : "@\(c.replyToNickname ?? "") ").foregroundColor(linkBlue)
                                            + Text(c.content).foregroundColor(Theme.text)
                                        )
                                        .font(.system(size: 15)).lineSpacing(3)
                                    }
                                    if let s = c.sticker {
                                        StickerImageView(p: s, size: s.isGif ? 160 : 96).padding(.top, 2)
                                    }
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

            if replyTo != nil || sticker != nil {
                HStack(spacing: 10) {
                    if let s = sticker { PendingStickerChip(p: s) { sticker = nil } }
                    if let r = replyTo {
                        Text("回复 @\(r.user?.nickname ?? "")").font(.system(size: 12)).foregroundStyle(Theme.accent)
                        Spacer()
                        Button("取消") { replyTo = nil }.font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    } else {
                        Spacer()
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
            }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Button {
                        inputFocused = false; showSticker.toggle()
                    } label: {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 18)).foregroundStyle(showSticker ? Theme.accent : Theme.textSub)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(showSticker ? Theme.bubbleMine : Theme.bg3))
                    }
                    .buttonStyle(.plain)
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
                if showSticker {
                    EmojiPanel(onPick: { sticker = $0 }, onEmoji: { input += $0 }, onDelete: { input = dropLastGrapheme(input) }, onKeyboard: { showSticker = false; inputFocused = true })
                }
            }
            .background(Theme.bg2)
            .onChange(of: inputFocused) { f in if f { showSticker = false } }
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
        !sending && (!input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sticker != nil)
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
        guard canSend else { return }
        sending = true
        let picked = sticker
        Task {
            struct IdResp: Codable { var id: String? }
            var body: [String: Any] = ["content": text]
            if let r = replyTo { body["replyToId"] = r.id }
            if let picked { body["stickerId"] = picked.id }
            do {
                let _: IdResp = try await Api.request("/treehole/\(postId)/comments", method: "POST", body: body)
                                input = ""
                replyTo = nil
                sticker = nil
                showSticker = false
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
    @State private var images: [String] = []
    @State private var uploading = false
    @State private var busy = false
    @State private var toastMsg: String?
    @FocusState private var focused: Bool
    private let maxLen = 3000

    private var canSubmit: Bool {
        !busy && !uploading && (content.trimmingCharacters(in: .whitespacesAndNewlines).count >= 5 || !images.isEmpty)
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
                    .frame(minHeight: 200)
                    .onChange(of: content) { v in
                        if v.count > maxLen { content = String(v.prefix(maxLen)) }
                    }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg3))

            // 配图（最多 9 张，点已选图片移除）
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(images, id: \.self) { u in
                    RemoteImage(url: u)
                        .aspectRatio(1, contentMode: .fill)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .contentShape(Rectangle())
                        .onTapGesture { images.removeAll { $0 == u } }
                }
                if images.count < 9 {
                    CompatPhotoPicker(kind: .images, maxCount: 9 - images.count, onPicked: { datas in
                        Task {
                            uploading = true
                            for data in datas where images.count < 9 {
                                if let url = try? await Api.upload("image", data: data, filename: "img.jpg", mime: "image/jpeg") {
                                    images.append(url)
                                }
                            }
                            uploading = false
                        }
                    }) {
                        RoundedRectangle(cornerRadius: 10).fill(Theme.bg3)
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(Text(uploading ? "…" : "+").font(.system(size: 26)).foregroundStyle(Theme.textDim))
                    }
                }
            }

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
        guard !busy, !uploading else { return }
        guard text.count >= 5 || !images.isEmpty else { toastMsg = "至少写 5 个字，或配一张图"; return }
        busy = true
        Task {
            struct IdResp: Codable { var id: String? }
            do {
                let _: IdResp = try await Api.request("/treehole", method: "POST", body: ["content": text, "images": images])
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
