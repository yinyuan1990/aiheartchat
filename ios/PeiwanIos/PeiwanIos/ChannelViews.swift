import CoreLocation
import Photos
import SwiftUI

// 频道（kind=2 的群）：频道主发帖，订阅者看帖 + 表情回应 + 评论。帖子就是这个群会话里的消息。

let channelReactions = ["❤️", "👍", "🔥", "😂", "😮", "😢", "🎉", "👎"]

struct ChannelOwner: Codable, Hashable {
    var id: String? = ""
    var nickname: String? = ""
    var avatar: String? = ""
}

struct ChannelInfo: Codable {
    var id: String = ""
    var name: String? = ""
    var avatar: String? = ""
    var description: String? = ""
    var ownerId: String? = ""
    var owner: ChannelOwner? = nil
    var subscribers: Int? = 0
    var conversationId: String? = nil
    var isMember: Bool? = false
    var role: String? = nil
    /// 频道主 / 管理员
    var canPost: Bool? = false
    /// 订阅者也能发帖
    var memberPost: Bool? = false
    /// 我能不能发帖（老后端没有这个字段时按 canPost）
    var canSend: Bool? = nil
    var muted: Bool? = false

    var sendable: Bool { canSend ?? (canPost == true) }
}

struct ChannelReaction: Codable, Hashable {
    var emoji: String = ""
    var count: Int? = 0
}

struct ChannelPost: Codable {
    var id: String = ""
    var senderId: String? = ""
    var type: String? = "text"
    var content: String? = ""
    var createdAt: String? = ""
    var views: Int? = 0
    var reactions: [ChannelReaction]? = []
    var myReaction: String? = nil
    var commentCount: Int? = 0
    /// 本地发出的帖子：ack 前 pending，tempId 一直留着当列表 key
    var tempId: String? = nil
    var pending: Bool? = false
    /// 机器人发的帖子可能带按钮
    var markup: InlineMarkup? = nil
    var senderNickname: String? = nil
    var senderAvatar: String? = nil
    var senderIsBot: Bool? = nil

    var key: String { tempId ?? id }
}

private struct ChannelListItem: Codable, Identifiable {
    var id: String = ""
    var name: String? = ""
    var avatar: String? = ""
    var description: String? = ""
    var ownerNickname: String? = ""
    var subscribers: Int? = 0
    var isMember: Bool? = false
}

private struct ChannelOkResp: Codable { var ok: Bool? }

/// WS 帧里的 id 可能是字符串也可能是数字
private func frameStr(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

private func parseJsonObject(_ s: String) -> [String: Any]? {
    guard let d = s.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}

// MARK: - 帖子卡片

/// 一条帖子：频道头 + 内容 + 表情回应 + 浏览数 / 时间 + 评论入口
private struct ChannelPostCard: View {
    let ch: ChannelInfo
    let p: ChannelPost
    let canDelete: Bool
    let onReact: (String) -> Void
    let onComments: () -> Void
    let onMedia: () -> Void
    let onDelete: () -> Void
    @State private var picker = false
    @State private var voicePlaying = false

    private var pending: Bool { p.pending == true }
    private var content: String { p.content ?? "" }
    /// 频道主 / 机器人发的算频道发帖；订阅者（和其他管理员）发的显示作者
    private var byAuthor: Bool {
        p.senderId != ch.ownerId && p.senderIsBot != true && !(p.senderNickname ?? "").isEmpty
    }

    /// 气泡最大宽度；文字类按内容收缩（Telegram 式），图片 / 视频 / 贴纸 / 带按钮的固定宽
    private var maxW: CGFloat { min(UIScreen.main.bounds.width * 0.85, 480) }
    private var innerW: CGFloat { maxW - 24 }
    private var fixedWidth: Bool {
        let t = p.type ?? "text"
        return t == "image" || t == "video" || t == "sticker" || !(p.markup?.inlineKeyboard ?? []).isEmpty
    }

    @ViewBuilder var body: some View {
        if fixedWidth {
            card.frame(width: maxW)
        } else {
            card.fixedSize(horizontal: true, vertical: false)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(width: 200, height: 0)
            HStack(spacing: 8) {
                AvatarView(url: byAuthor ? (p.senderAvatar ?? "") : (ch.avatar ?? ""), size: 26)
                Text(byAuthor ? (p.senderNickname ?? "") : (ch.name ?? "")).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    .frame(maxWidth: innerW - 80, alignment: .leading)
                Spacer(minLength: 8)
                if canDelete && !pending {
                    Button("删除", action: onDelete)
                        .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12).padding(.top, 10)

            postBody

            if !(p.markup?.inlineKeyboard ?? []).isEmpty {
                InlineKeyboardView(markup: p.markup, messageId: p.id).padding(.horizontal, 12)
            }

            HStack(alignment: .bottom, spacing: 8) {
                reactionRows
                Spacer(minLength: 0)
                if pending {
                    Text("发送中…").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "eye").font(.system(size: 10))
                        Text("\(fmtCount(p.views ?? 0)) · \(fmtTime(p.createdAt))")
                    }
                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    .fixedSize()
                }
            }
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)

            if picker {
                HStack(spacing: 0) {
                    ForEach(channelReactions, id: \.self) { e in
                        Button {
                            picker = false
                            onReact(e)
                        } label: {
                            Text(e).font(.system(size: 20))
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(p.myReaction == e ? Theme.bubbleMine : Color.clear))
                                .frame(minWidth: 30, maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(6)
                .background(Capsule().fill(Theme.bg2))
                .padding(.horizontal, 12).padding(.bottom, 8)
            }

            if !pending {
                Rectangle().fill(Theme.line).frame(height: 1)
                Button(action: onComments) {
                    HStack(spacing: 6) {
                        Image(systemName: "bubble.left").font(.system(size: 13))
                        Text((p.commentCount ?? 0) > 0 ? "\(p.commentCount ?? 0) 条评论" : "评论").font(.system(size: 13))
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.bg)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .opacity(pending ? 0.6 : 1)
    }

    @ViewBuilder private var postBody: some View {
        switch p.type ?? "text" {
        case "image":
            RemoteImage(url: content)
                .frame(maxWidth: .infinity).frame(height: 260)
                .clipped()
                .contentShape(Rectangle())
                .onTapGesture(perform: onMedia)
                .padding(.top, 8)
        case "video":
            ZStack {
                Color.black
                Image(systemName: "play.circle.fill").font(.system(size: 48)).foregroundStyle(.white.opacity(0.85))
            }
            .frame(maxWidth: .infinity).frame(height: 200)
            .contentShape(Rectangle())
            .onTapGesture(perform: onMedia)
            .padding(.top, 8)
        case "sticker":
            if let s = StickerPayload.parse(content) {
                StickerImageView(p: s, size: s.isGif ? 220 : 140).padding(.leading, 12).padding(.top, 10)
            } else {
                Text("[表情]").font(.system(size: 15)).foregroundStyle(Theme.text).padding(.horizontal, 12).padding(.top, 8)
            }
        case "audio":
            audioRow
        case "location":
            locationRow
        default:
            LinkText(text: content)
                .font(.system(size: 15)).foregroundStyle(Theme.text).lineSpacing(4)
                .textSelection(.enabled)
                .inAppLinks()
                .frame(maxWidth: innerW, alignment: .leading)
                .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    /// 表情回应 chip，每行最多 4 个，避免把气泡撑宽
    private var reactionRows: some View {
        let rs = p.reactions ?? []
        let rows = stride(from: 0, to: rs.count, by: 4).map { Array(rs[$0..<min($0 + 4, rs.count)]) }
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    ForEach(rows[i], id: \.emoji) { r in
                        chip("\(r.emoji) \(fmtCount(r.count ?? 0))", on: p.myReaction == r.emoji) { onReact(r.emoji) }
                    }
                    if i == rows.count - 1 && !pending { chip("☺+", on: false) { picker.toggle() } }
                }
            }
            if rows.isEmpty && !pending { chip("☺+", on: false) { picker.toggle() } }
        }
    }

    private var audioRow: some View {
        let obj = parseJsonObject(content)
        let url = obj?["url"] as? String ?? content
        let dur = obj?["duration"] as? Int ?? 1
        return Button {
            voicePlaying = true
            AudioPlayerBox.shared.play(url) { voicePlaying = false }
        } label: {
            HStack(spacing: 8) {
                VoiceBars(playing: voicePlaying, color: Theme.text)
                Text("\(dur)\"").font(.system(size: 14)).foregroundStyle(Theme.text)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(Capsule().fill(Theme.bg3))
        }
        .buttonStyle(.plain)
        .padding(.leading, 12).padding(.top, 10)
    }

    private var locationRow: some View {
        let obj = parseJsonObject(content)
        let name = obj?["name"] as? String ?? "位置"
        let lat = obj?["lat"] as? Double
        let lng = obj?["lng"] as? Double
        return Button {
            if let lat, let lng, let u = URL(string: "https://uri.amap.com/marker?position=\(lng),\(lat)") {
                UIApplication.shared.open(u)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "mappin.and.ellipse").font(.system(size: 14)).foregroundStyle(Theme.accent)
                Text(name).font(.system(size: 15)).foregroundStyle(Theme.text)
            }
        }
        .buttonStyle(.plain)
        .padding(.leading, 12).padding(.top, 10)
    }

    private func chip(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 13))
                .foregroundStyle(on ? Theme.accent : Theme.text)
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(Capsule().fill(on ? Theme.bubbleMine : Theme.bg3))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 频道页

/// 频道页：订阅前也能预览；频道主底部是发帖栏，订阅者是静音开关，没订阅是「订阅」
struct ChannelView: View {
    let groupId: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var ch: ChannelInfo?
    @State private var loadError = ""
    @State private var posts: [ChannelPost] = []
    @State private var hasMore = false
    @State private var stickBottom = true
    @State private var input = ""
    @State private var showSticker = false
    @State private var showAttach = false
    @State private var showInfo = false
    @State private var deleteTarget: ChannelPost?
    @State private var showDelete = false
    @State private var media: MediaTarget?
    @State private var toastMsg: String?
    @State private var route: Route?
    @State private var removeListener: (() -> Void)?
    @FocusState private var inputFocused: Bool

    var body: some View {
        Group {
            if let c = ch {
                content(c)
            } else {
                EmptyHint(text: loadError.isEmpty ? "加载中…" : loadError)
            }
        }
        .fullBg()
        .toast($toastMsg)
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .navigationBarTrailing) {
                if ch != nil {
                    Button { showInfo = true } label: {
                        Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    }
                }
            }
        }
        .sheet(isPresented: $showInfo) {
            if let c = ch {
                ChannelInfoSheet(ch: c, onChanged: { ch = $0 }, onExit: {
                    showInfo = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { dismiss() }
                })
            }
        }
        .sheet(isPresented: $showAttach) {
            AttachSheet(
                isSingle: false,
                canVideoCall: false,
                onClose: { showAttach = false },
                onSendAssets: sendAttachAssets,
                onSendDatas: sendAttachDatas,
                onAction: handleAttach
            )
            .attachSheetDetents()
            .compatSheetBackground(Theme.bg)
        }
        .fullScreenCover(item: $media) { t in
            MediaViewerView(groups: t.groups, initialGroup: t.group, initialIndex: t.index) { media = nil }
        }
        .alert("删除这条帖子？", isPresented: $showDelete) {
            Button("删除", role: .destructive) { if let p = deleteTarget { deletePost(p) } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("评论和表情回应会一起删除")
        }
        .routePush($route)
        .task { await load() }
        .onDisappear { removeListener?() }
    }

    private var header: some View {
        Button { if ch != nil { showInfo = true } } label: {
            HStack(spacing: 8) {
                AvatarView(url: ch?.avatar, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(ch?.name ?? "频道").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    if let c = ch {
                        Text("\(fmtCount(c.subscribers ?? 0)) 位订阅者").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func content(_ c: ChannelInfo) -> some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if hasMore && !posts.isEmpty {
                            Button { loadMore(proxy) } label: {
                                Text("查看更早的帖子").font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(10)
                            }
                            .buttonStyle(.plain)
                        }
                        if posts.isEmpty {
                            Text(c.sendable ? "发第一条帖子吧，订阅者都会收到" : "频道还没有发帖")
                                .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                                .padding(.top, 80)
                        }
                        ForEach(posts, id: \.key) { p in
                            ChannelPostCard(
                                ch: c, p: p, canDelete: c.canPost == true || p.senderId == state.user?.id,
                                onReact: { react(p, $0) },
                                onComments: { route = .channelComments(p.id, c.canPost == true) },
                                onMedia: { openMedia(p) },
                                onDelete: { deleteTarget = p; showDelete = true }
                            )
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(p.key)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .background(Theme.bg2)
                .onTapGesture { showSticker = false; inputFocused = false }
                .onChange(of: posts.count) { _ in
                    guard stickBottom, let last = posts.last else { return }
                    DispatchQueue.main.async { proxy.scrollTo(last.key, anchor: .bottom) }
                }
            }
            bottomBar(c)
        }
    }

    @ViewBuilder private func bottomBar(_ c: ChannelInfo) -> some View {
        if c.sendable {
            VStack(spacing: 0) {
                HStack(alignment: .bottom, spacing: 8) {
                    CompatVerticalTextField(text: $input, prompt: Text(c.canPost == true ? "发帖…" : "发消息…").foregroundColor(Theme.textDim), lineRange: 1...6)
                        .focused($inputFocused)
                        .foregroundStyle(Theme.text)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                    Button {
                        inputFocused = false; showSticker.toggle()
                    } label: {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 19)).foregroundStyle(showSticker ? Theme.accent : Theme.textSub)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(showSticker ? Theme.bubbleMine : Theme.bg3))
                    }
                    .buttonStyle(.plain)
                    Button {
                        inputFocused = false; showSticker = false; showAttach = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18)).foregroundStyle(Theme.textSub)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(Theme.bg3))
                    }
                    .buttonStyle(.plain)
                    if !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            sendRaw("text", input.trimmingCharacters(in: .whitespacesAndNewlines))
                            input = ""
                        } label: {
                            Text("发送").font(.system(size: 14)).foregroundStyle(.white)
                                .padding(.horizontal, 16).frame(height: 40)
                                .background(Capsule().fill(Theme.accent))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(8)
                if showSticker {
                    EmojiPanel(
                        onPick: { p in sendRaw("sticker", p.encoded()) },
                        onEmoji: { input += $0 },
                        onDelete: { input = dropLastGrapheme(input) },
                        onKeyboard: { showSticker = false; inputFocused = true }
                    )
                }
            }
            .background(Theme.bg2)
            .onChange(of: inputFocused) { f in if f { showSticker = false } }
        } else {
            Button {
                if c.isMember == true { toggleMute(c) } else { subscribe() }
            } label: {
                Group {
                    if c.isMember != true {
                        Text("订阅").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.accent)
                    } else {
                        Text(c.muted == true ? "取消静音" : "静音").font(.system(size: 15)).foregroundStyle(Theme.text)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Theme.bg2)
        }
    }

    // MARK: 数据

    private func load() async {
        removeListener?()
        do {
            let c: ChannelInfo = try await Api.request("/im/channel/\(groupId)")
            ch = c
            let list: [ChannelPost] = (try? await Api.request("/im/channel/\(groupId)/posts")) ?? []
            stickBottom = true
            posts = list + posts.filter { p in !list.contains { $0.id == p.id } }
            hasMore = list.count >= 30
            if c.isMember == true, let conv = c.conversationId, let last = list.last {
                WsClient.shared.markRead(conversationId: conv, msgId: last.id)
            }
        } catch {
            loadError = (error as? ApiError)?.msg ?? "频道不存在"
        }
        WsClient.shared.connect()
        removeListener = WsClient.shared.addListener { frame in handleFrame(frame) }
    }

    private func handleFrame(_ frame: [String: Any]) {
        guard let conv = ch?.conversationId else { return }
        let op = frame["op"] as? String
        let data = frame["data"] as? [String: Any]
        switch op {
        case "msg":
            guard let data,
                  let json = try? JSONSerialization.data(withJSONObject: data),
                  let m = try? JSONDecoder().decode(MessagePayload.self, from: json),
                  m.conversationId == conv else { return }
            if !posts.contains(where: { $0.id == m.id }) {
                stickBottom = true
                posts.append(ChannelPost(id: m.id, senderId: m.senderId, type: m.type, content: m.content, createdAt: m.createdAt, views: 1, markup: m.markup,
                                         senderNickname: m.senderNickname, senderAvatar: m.senderAvatar, senderIsBot: m.senderIsBot))
            }
            WsClient.shared.markRead(conversationId: conv, msgId: m.id)
        case "ack":
            guard let tempId = frameStr(frame["tempId"]), let msgId = frameStr(frame["msgId"]),
                  let idx = posts.firstIndex(where: { $0.tempId == tempId }) else { return }
            posts[idx].id = msgId
            posts[idx].pending = false
            if let at = frameStr(frame["createdAt"]) { posts[idx].createdAt = at }
        case "error":
            let tempId = frameStr(frame["tempId"])
            guard let idx = posts.firstIndex(where: { $0.pending == true && $0.tempId == tempId }) else { return }
            posts.remove(at: idx)
            toastMsg = frame["msg"] as? String ?? "发送失败"
        case "channel_stats":
            guard let data, frameStr(data["conversationId"]) == conv, let id = frameStr(data["msgId"]),
                  let idx = posts.firstIndex(where: { $0.id == id }) else { return }
            let raw = data["reactions"] as? [[String: Any]] ?? []
            posts[idx].reactions = raw.compactMap { r -> ChannelReaction? in
                guard let e = r["emoji"] as? String else { return nil }
                return ChannelReaction(emoji: e, count: r["count"] as? Int ?? 0)
            }
            posts[idx].commentCount = data["commentCount"] as? Int ?? 0
        case "channel_post_deleted", "msg_delete":
            guard let data, frameStr(data["conversationId"]) == conv, let id = frameStr(data["msgId"]) else { return }
            posts.removeAll { $0.id == id }
        case "msg_edit":
            guard let data, frameStr(data["conversationId"]) == conv, let id = frameStr(data["msgId"]),
                  let idx = posts.firstIndex(where: { $0.id == id }) else { return }
            if let c = data["content"] as? String { posts[idx].content = c }
            posts[idx].markup = InlineMarkup.from(data["markup"])
        case "channel_info":
            // 频道主开关了「订阅者可发消息」：重新拉资料，输入框跟着出现 / 收起
            guard let data, frameStr(data["groupId"]) == groupId else { return }
            Task { @MainActor in
                if let c: ChannelInfo = try? await Api.request("/im/channel/\(groupId)") { ch = c }
            }
        default:
            break
        }
    }

    private func loadMore(_ proxy: ScrollViewProxy) {
        guard let first = posts.first(where: { $0.pending != true }) else { return }
        stickBottom = false
        Task {
            let older: [ChannelPost] = (try? await Api.request("/im/channel/\(groupId)/posts?beforeId=\(first.id)")) ?? []
            hasMore = older.count >= 30
            posts.insert(contentsOf: older, at: 0)
            DispatchQueue.main.async { proxy.scrollTo(first.key, anchor: .top) }
        }
    }

    private func sendRaw(_ type: String, _ content: String) {
        guard let c = ch else { return }
        stickBottom = true
        let tempId = WsClient.shared.send(convType: 2, targetId: c.id, msgType: type, content: content)
        posts.append(ChannelPost(
            id: tempId, senderId: state.user?.id ?? "", type: type, content: content,
            createdAt: ISO8601DateFormatter().string(from: Date()), views: 1, tempId: tempId, pending: true,
            senderNickname: state.user?.nickname, senderAvatar: state.user?.avatar
        ))
    }

    private func sendAttachAssets(_ assets: [PHAsset], caption: String) {
        showAttach = false
        Task {
            var datas: [Data] = []
            for a in assets {
                if let d = await AttachMedia.jpegData(a) { datas.append(d) }
            }
            await uploadAndSend(datas, caption: caption, expected: assets.count)
        }
    }

    private func sendAttachDatas(_ datas: [Data], caption: String) {
        showAttach = false
        Task { await uploadAndSend(datas, caption: caption, expected: datas.count) }
    }

    @MainActor
    private func uploadAndSend(_ datas: [Data], caption: String, expected: Int) async {
        var failed = expected - datas.count
        for data in datas {
            if let url = try? await Api.upload("image", data: data, filename: "img.jpg", mime: "image/jpeg") {
                sendRaw("image", url)
            } else {
                failed += 1
            }
        }
        let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { sendRaw("text", text) }
        if failed > 0 { toastMsg = "\(failed) 张图片发送失败" }
    }

    private func handleAttach(_ action: AttachAction) {
        showAttach = false
        guard case .location = action else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            CityLocator.shared.currentLocation { loc, addr in
                DispatchQueue.main.async {
                    let dict: [String: Any] = [
                        "name": addr ?? "我的位置",
                        "lat": loc?.coordinate.latitude ?? 0,
                        "lng": loc?.coordinate.longitude ?? 0,
                    ]
                    if let d = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: d, encoding: .utf8) {
                        sendRaw("location", s)
                    }
                }
            }
        }
    }

    private func react(_ p: ChannelPost, _ emoji: String) {
        Task {
            struct R: Codable { var reactions: [ChannelReaction]? = []; var myReaction: String? = nil }
            do {
                let r: R = try await Api.request("/im/channel/posts/\(p.id)/react", method: "POST", body: ["emoji": emoji])
                if let idx = posts.firstIndex(where: { $0.id == p.id }) {
                    posts[idx].reactions = r.reactions ?? []
                    posts[idx].myReaction = r.myReaction
                }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func subscribe() {
        Task {
            do {
                let n: ChannelInfo = try await Api.request("/im/channel/\(groupId)/subscribe", method: "POST")
                ch = n
                if let conv = n.conversationId, let last = posts.last(where: { $0.pending != true }) {
                    WsClient.shared.markRead(conversationId: conv, msgId: last.id)
                }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func toggleMute(_ c: ChannelInfo) {
        Task {
            struct R: Codable { var muted: Bool? }
            do {
                let r: R = try await Api.request("/im/channel/\(groupId)/mute", method: "POST", body: ["muted": !(c.muted ?? false)])
                ch?.muted = r.muted ?? false
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func deletePost(_ p: ChannelPost) {
        Task {
            do {
                let _: ChannelOkResp = try await Api.request("/im/channel/posts/\(p.id)/delete", method: "POST")
                posts.removeAll { $0.id == p.id }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func openMedia(_ p: ChannelPost) {
        let list = posts.filter { $0.pending != true && ($0.type == "image" || $0.type == "video") }
        let groups = list.map { [MediaItemModel(type: $0.type ?? "image", url: Api.fullUrl($0.content ?? ""), cover: nil)] }
        media = MediaTarget(groups: groups, group: list.firstIndex(where: { $0.id == p.id }) ?? 0, index: 0)
    }
}

// MARK: - 频道资料

/// 「订阅者可发消息」开关：创建页和频道资料里共用
private struct MemberPostToggle: View {
    let isOn: Bool
    let onChange: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: { onChange($0) })) {
            Text("订阅者可发消息").font(.system(size: 15)).foregroundStyle(Theme.text)
        }
        .tint(Theme.accent)
        .padding(.vertical, 8)
    }
}

/// 频道资料：头像 / 名称 / 简介（频道主可改）、订阅数、分享、静音、退订 / 删除
private struct ChannelInfoSheet: View {
    let ch: ChannelInfo
    var onChanged: (ChannelInfo) -> Void
    var onExit: () -> Void
    @State private var editing = false
    @State private var name = ""
    @State private var desc = ""
    @State private var showShare = false
    @State private var confirmLeave = false
    @State private var showBots = false
    @State private var toastMsg: String?

    private var owner: Bool { ch.role == "owner" }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if ch.canPost == true {
                    CompatPhotoPicker(kind: .images, onPicked: { datas in
                        guard let data = datas.first else { return }
                        Task {
                            if let url = try? await Api.upload("image", data: data, filename: "c.jpg", mime: "image/jpeg") {
                                save(["avatar": url])
                            } else {
                                toastMsg = "上传失败"
                            }
                        }
                    }) {
                        AvatarView(url: ch.avatar, size: 72)
                    }
                } else {
                    AvatarView(url: ch.avatar, size: 72)
                }

                if editing {
                    TextField("", text: $name, prompt: Text("频道名称").foregroundColor(Theme.textDim))
                        .foregroundStyle(Theme.text)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                        .padding(.top, 14)
                        .onChange(of: name) { v in if v.count > 50 { name = String(v.prefix(50)) } }
                    CompatVerticalTextField(text: $desc, prompt: Text("频道简介").foregroundColor(Theme.textDim), lineRange: 3...6)
                        .foregroundStyle(Theme.text)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                        .padding(.top, 8)
                        .onChange(of: desc) { v in if v.count > 500 { desc = String(v.prefix(500)) } }
                    HStack(spacing: 20) {
                        Spacer()
                        Button("取消") { editing = false }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
                        Button("保存") { save(["name": name, "description": desc]) }
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
                    }
                    .padding(.top, 14)
                } else {
                    Text(ch.name ?? "").font(.system(size: 18, weight: .bold)).foregroundStyle(Theme.text).padding(.top, 10)
                    Text("\(fmtCount(ch.subscribers ?? 0)) 位订阅者 · 频道主 \(ch.owner?.nickname ?? "")")
                        .font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.top, 4)
                    if let d = ch.description, !d.isEmpty {
                        Text(d).font(.system(size: 14)).foregroundStyle(Theme.text).lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 12)
                    }
                    Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 16)
                    if ch.canPost == true {
                        menuRow("编辑频道资料") { name = ch.name ?? ""; desc = ch.description ?? ""; editing = true }
                        MemberPostToggle(isOn: ch.memberPost == true) { save(["memberPost": $0]) }
                    }
                    if ch.isMember == true {
                        menuRow("分享频道（二维码 / 邀请码）") { showShare = true }
                    }
                    if owner {
                        menuRow("机器人（自动发帖）") { showBots = true }
                    }
                    if ch.isMember == true && !owner {
                        menuRow(ch.muted == true ? "取消静音" : "静音") { toggleMute() }
                    }
                    if ch.isMember == true {
                        menuRow(owner ? "删除频道" : "退订", color: Theme.danger) { confirmLeave = true }
                    }
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 24)
        }
        .background(Theme.bg)
        .toast($toastMsg)
        .sheet(isPresented: $showShare) {
            GroupShareSheet(groupId: ch.id, channel: true)
        }
        .sheet(isPresented: $showBots) {
            AddBotSheet(groupId: ch.id, channel: true)
        }
        .alert(owner ? "删除频道？" : "退订频道？", isPresented: $confirmLeave) {
            Button(owner ? "删除" : "退订", role: .destructive) { leave() }
            Button("取消", role: .cancel) {}
        } message: {
            Text(owner ? "删除后所有订阅者都看不到它" : "退订后不再收到这个频道的帖子")
        }
    }

    private func menuRow(_ label: String, color: Color = Theme.text, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 15)).foregroundStyle(color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func save(_ body: [String: Any]) {
        Task {
            do {
                let n: ChannelInfo = try await Api.request("/im/channel/\(ch.id)", method: "PUT", body: body)
                onChanged(n)
                editing = false
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func toggleMute() {
        Task {
            struct R: Codable { var muted: Bool? }
            if let r: R = try? await Api.request("/im/channel/\(ch.id)/mute", method: "POST", body: ["muted": !(ch.muted ?? false)]) {
                var n = ch
                n.muted = r.muted ?? false
                onChanged(n)
            }
        }
    }

    private func leave() {
        Task {
            do {
                let _: ChannelOkResp = try await Api.request("/im/channel/\(ch.id)/\(owner ? "delete" : "unsubscribe")", method: "POST")
                onExit()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

// MARK: - 评论

/// 帖子评论：任何登录用户都能评，可带贴纸、可回复某条
struct ChannelCommentsView: View {
    let msgId: String
    let canAdmin: Bool
    @EnvironmentObject var state: AppState
    @State private var list: [CommentItem]?
    @State private var input = ""
    @State private var replyTo: CommentItem?
    /// 待发的贴纸：点贴纸先挂到输入栏，再点发送
    @State private var sticker: StickerPayload?
    @State private var showSticker = false
    @State private var sending = false
    @State private var deleteTarget: CommentItem?
    @State private var showDelete = false
    @State private var toastMsg: String?
    @State private var route: Route?
    @FocusState private var inputFocused: Bool

    private var canSend: Bool {
        !sending && (!input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sticker != nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if let items = list {
                    if items.isEmpty {
                        EmptyHint(text: "还没有评论，来抢沙发")
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(items) { c in commentRow(c) }
                                Color.clear.frame(height: 12)
                            }
                            .padding(.horizontal, 14)
                        }
                    }
                } else {
                    EmptyHint(text: "加载中…")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { showSticker = false; inputFocused = false }

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
                        prompt: Text(replyTo != nil ? "回复 @\(replyTo?.user?.nickname ?? "")" : "说点什么…").foregroundColor(Theme.textSub),
                        lineRange: 1...4
                    )
                    .focused($inputFocused)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                    .foregroundStyle(Theme.text)
                    .onChange(of: input) { v in if v.count > 500 { input = String(v.prefix(500)) } }
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
        .navigationTitle(list.map { "\($0.count) 条评论" } ?? "评论")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .alert("删除这条评论？", isPresented: $showDelete) {
            Button("删除", role: .destructive) { if let c = deleteTarget { remove(c) } }
            Button("取消", role: .cancel) {}
        }
        .toast($toastMsg)
        .routePush($route)
        .task { await load() }
    }

    private func commentRow(_ c: CommentItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button { if let id = c.user?.id, !id.isEmpty { route = .userHome(id) } } label: {
                AvatarView(url: c.user?.avatar, size: 34)
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text(c.user?.nickname ?? "用户").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(fmtTime(c.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    Spacer(minLength: 0)
                    Button("回复") { replyTo = c; inputFocused = true }
                        .font(.system(size: 12)).foregroundStyle(Theme.accent)
                        .buttonStyle(.plain)
                    if c.user?.id == state.user?.id || canAdmin {
                        Button("删除") { deleteTarget = c; showDelete = true }
                            .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                            .buttonStyle(.plain)
                    }
                }
                let text = c.content ?? ""
                let reply = c.replyToNickname ?? ""
                if !text.isEmpty || !reply.isEmpty {
                    (
                        Text(reply.isEmpty ? "" : "@\(reply) ").foregroundColor(Theme.accent)
                        + Text(linkified(text)).foregroundColor(Theme.text)
                    )
                    .font(.system(size: 14)).lineSpacing(3)
                    .tint(botBlue)
                    .inAppLinks()
                    .padding(.top, 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let s = c.sticker {
                    StickerImageView(p: s, size: s.isGif ? 160 : 96).padding(.top, 6)
                }
                Divider().overlay(Theme.line).padding(.top, 12)
            }
        }
        .padding(.top, 12)
    }

    private func load() async {
        list = (try? await Api.request("/im/channel/posts/\(msgId)/comments")) ?? (list ?? [])
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
                let _: IdResp = try await Api.request("/im/channel/posts/\(msgId)/comments", method: "POST", body: body)
                input = ""
                replyTo = nil
                sticker = nil
                showSticker = false
                await load()
            } catch {
                toastMsg = error.localizedDescription
            }
            sending = false
        }
    }

    private func remove(_ c: CommentItem) {
        Task {
            do {
                let _: ChannelOkResp = try await Api.request("/im/channel/comments/\(c.id)/delete", method: "POST")
                list?.removeAll { $0.id == c.id }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

// MARK: - 创建

/// 创建频道
struct CreateChannelView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var desc = ""
    @State private var avatar = ""
    @State private var memberPost = false

    private var createHint: String {
        memberPost
            ? "所有订阅者都能在频道里发帖，大家都能看到；你可以删除任何人的帖子，之后也能在频道资料里关掉。"
            : "频道是一对多的广播：只有你能发帖，订阅的人可以看、点表情、评论。之后可以在频道资料里打开「订阅者可发消息」。"
    }
    @State private var busy = false
    @State private var toastMsg: String?
    @State private var route: Route?
    @State private var created = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                CompatPhotoPicker(kind: .images, onPicked: { datas in
                    guard let data = datas.first else { return }
                    busy = true
                    Task {
                        if let url = try? await Api.upload("image", data: data, filename: "c.jpg", mime: "image/jpeg") {
                            avatar = url
                        } else {
                            toastMsg = "上传失败"
                        }
                        busy = false
                    }
                }) {
                    if avatar.isEmpty {
                        Circle().fill(Theme.bg3)
                            .frame(width: 56, height: 56)
                            .overlay(Text(busy ? "…" : "头像").font(.system(size: 11)).foregroundStyle(Theme.textDim))
                    } else {
                        AvatarView(url: avatar, size: 56)
                    }
                }
                TextField("", text: $name, prompt: Text("频道名称").foregroundColor(Theme.textDim))
                    .foregroundStyle(Theme.text)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                    .onChange(of: name) { v in if v.count > 50 { name = String(v.prefix(50)) } }
            }
            CompatVerticalTextField(text: $desc, prompt: Text("频道简介（可选）：这个频道发什么").foregroundColor(Theme.textDim), lineRange: 3...6)
                .foregroundStyle(Theme.text)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                .onChange(of: desc) { v in if v.count > 500 { desc = String(v.prefix(500)) } }
            MemberPostToggle(isOn: memberPost) { memberPost = $0 }
            Text(createHint)
                .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(3)
            AccentButton(title: busy ? "请稍候…" : "创建", enabled: !busy && !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                create()
            }
            .padding(.top, 6)
            Spacer()
        }
        .padding(16)
        .fullBg()
        .navigationTitle("创建频道")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
        .routePush($route)
        // 从新频道返回时直接回到上一页，不停在已提交的表单
        .onChange(of: route) { r in if r == nil && created { dismiss() } }
    }

    private func create() {
        guard !busy else { return }
        busy = true
        Task {
            do {
                let c: ChannelInfo = try await Api.request("/im/channel", method: "POST", body: [
                    "name": name.trimmingCharacters(in: .whitespaces),
                    "description": desc.trimmingCharacters(in: .whitespacesAndNewlines),
                    "avatar": avatar,
                    "memberPost": memberPost,
                ])
                created = true
                route = .channel(c.id)
            } catch {
                toastMsg = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - 发现

/// 发现频道：按订阅数排，可搜索，右上角创建
struct ChannelsView: View {
    @State private var q = ""
    @State private var list: [ChannelListItem]?
    @State private var toastMsg: String?
    @State private var route: Route?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                TextField("", text: $q, prompt: Text("搜索频道").foregroundColor(Theme.textSub))
                    .font(.system(size: 14)).foregroundStyle(Theme.text)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 14).frame(height: 36)
            .background(Capsule().fill(Theme.bg3))
            .padding(.horizontal, 16).padding(.vertical, 6)

            if let items = list {
                if items.isEmpty {
                    EmptyHint(text: q.trimmingCharacters(in: .whitespaces).isEmpty ? "还没有频道，创建第一个吧" : "没有找到相关频道")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items) { c in row(c) }
                        }
                    }
                }
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        .navigationTitle("发现频道")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("创建") { route = .createChannel }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
        }
        .toast($toastMsg)
        .routePush($route)
        .task(id: q) {
            if !q.isEmpty { try? await Task.sleep(nanoseconds: 300_000_000) }
            if Task.isCancelled { return }
            await load()
        }
    }

    private func row(_ c: ChannelListItem) -> some View {
        Button { route = .channel(c.id) } label: {
            HStack(spacing: 12) {
                AvatarView(url: c.avatar, size: 54)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(c.name ?? "").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                        Text("\(fmtCount(c.subscribers ?? 0)) 订阅").font(.system(size: 11)).foregroundStyle(Theme.textDim).fixedSize()
                    }
                    let d = c.description ?? ""
                    Text(d.isEmpty ? "频道主 \(c.ownerNickname ?? "")" : d)
                        .font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    if c.isMember == true { route = .channel(c.id) } else { subscribe(c) }
                } label: {
                    Text(c.isMember == true ? "已订阅" : "订阅")
                        .font(.system(size: 12))
                        .foregroundStyle(c.isMember == true ? Theme.textSub : .white)
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(Capsule().fill(c.isMember == true ? Theme.bg3 : Theme.accent))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16).padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        let kw = q.trimmingCharacters(in: .whitespaces)
        let qs = kw.isEmpty ? "" : "?q=\(kw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
        list = (try? await Api.request("/im/channel/list\(qs)")) ?? []
    }

    private func subscribe(_ c: ChannelListItem) {
        Task {
            do {
                let _: ChannelInfo = try await Api.request("/im/channel/\(c.id)/subscribe", method: "POST")
                if let idx = list?.firstIndex(where: { $0.id == c.id }) {
                    list?[idx].isMember = true
                    list?[idx].subscribers = (c.subscribers ?? 0) + 1
                }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}
