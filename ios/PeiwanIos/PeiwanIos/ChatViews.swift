import SwiftUI
import Photos
import PhotosUI
import AVFoundation
import Combine
import WebKit
import CoreImage

struct PeerBrief: Codable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
    var isBot: Bool? = false
}

struct GroupBrief: Codable, Hashable {
    var id: String = ""
    var name: String? = ""
    var avatar: String? = ""
    /// 2 = 频道
    var kind: Int? = 1
}

struct LastMsg: Codable, Hashable {
    var id: String = ""
    var senderId: String? = ""
    var type: String? = ""
    var content: String? = ""
    var createdAt: String? = ""
}

struct ConversationItem: Codable, Identifiable, Hashable {
    var id: String = ""
    var type: Int = 1
    var peer: PeerBrief? = nil
    var group: GroupBrief? = nil
    var lastMsg: LastMsg? = nil
    var unread: Int? = 0
    /// 频道静音：未读不计入底栏总数，角标显示灰色
    var muted: Bool? = false
    var lastMsgAt: String? = ""
}

struct MsgItem: Codable, Identifiable {
    var id: String = ""
    var conversationId: String = ""
    var senderId: String = ""
    var senderNickname: String? = ""
    var senderAvatar: String? = ""
    var receiverId: String? = nil
    var type: String = "text"
    var content: String = ""
    var createdAt: String? = ""
    var senderIsBot: Bool? = nil
    var markup: InlineMarkup? = nil
    var isRead: Bool? = nil
    var replyTo: ReplyPreview? = nil
    var fwdFrom: String? = nil
    var reactions: [MsgReaction]? = nil
    /// 本地刚选的图：上传任务的 key（预览图、进度、失败重试按它找）
    var upKey: String? = nil

    var pending: Bool { id.hasPrefix("t_") || id.hasPrefix("local_") }
}

func previewOf(_ msg: LastMsg?) -> String {
    guard let msg, let type = msg.type else { return "" }
    switch type {
    case "text": return String((msg.content ?? "").prefix(30))
    case "image": return t("chat.preview.image")
    case "video": return t("chat.preview.video")
    case "sticker": return (msg.content ?? "").contains("\"mp4\"") ? "[GIF]" : t("chat.preview.sticker")
    case "audio": return t("chat.preview.voice")
    case "location": return t("chat.preview.location")
    case "gift": return t("chat.preview.gift")
    case "transfer", "callout", "payreq", "perp": return ChainCards.preview(type, msg.content ?? "") ?? ""
    default: return type.hasPrefix("call") ? t("chat.preview.call") : ""
    }
}

/// 消息主页：标题 + 搜索 + 合并列表（AI 助手 / 音乐置顶，会话与评论 / 接单通知按最新时间排）
struct MessagesView: View {
    @State private var convs: [ConversationItem] = []
    @State private var summary = NoticeSummaryResp()
    @State private var chatTarget: ChatTarget?
    @State private var pushRoute: Route?
    @State private var removeListener: (() -> Void)?
    /// 音乐播放弹层（顶部「正在播放」栏 / 置顶入口打开）
    @State private var showMusic = false
    @State private var showSearch = false
    @State private var showScan = false

    private enum Entry: Identifiable {
        case conv(ConversationItem)
        case notice(String, NoticeSummary)

        var id: String {
            switch self {
            case .conv(let c): return "c-\(c.id)"
            case .notice(let k, _): return "n-\(k)"
            }
        }

        var at: Date {
            switch self {
            case .conv(let c): return parseIsoDate(c.lastMsgAt) ?? .distantPast
            case .notice(_, let s): return parseIsoDate(s.last?.createdAt) ?? .distantPast
            }
        }
    }

    private var entries: [Entry] {
        var list = convs.map { Entry.conv($0) }
        for k in ["comment", "task"] {
            if let s = summary.of(k), s.last != nil { list.append(.notice(k, s)) }
        }
        return list.sorted { $0.at > $1.at }
    }

    var body: some View {
        ZStack {
            NavStack {
                VStack(spacing: 0) {
                    // 播放中：固定在消息页最上面
                    NowPlayingBar { showMusic = true }
                    header
                    searchPill
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            aiEntryRow
                            newsEntryRow
                            ForEach(entries) { entryRow($0) }
                            if entries.isEmpty {
                                Text(t("chat.empty")).font(.subheadline).foregroundStyle(Theme.textSub)
                                    .multilineTextAlignment(.center).lineSpacing(8)
                                    .padding(.vertical, 70)
                            }
                        }
                    }
                }
                .fullBg()
                .withRoutes()
                .routePush($pushRoute)
                .scanFlow(isPresented: $showScan)
            }
            if showSearch {
                ChatSearchView(
                    convs: convs,
                    extras: searchExtras,
                    onClose: { showSearch = false },
                    onOpenChat: { t in
                        showSearch = false
                        if let g = convs.first(where: { $0.id == t.convId })?.group, g.kind == 2 {
                            pushRoute = .channel(g.id)
                        } else {
                            chatTarget = t
                        }
                    },
                    onOpenUser: { id, name in
                        showSearch = false
                        Task { if let t = await openChatWith(userId: id, nickname: name) { chatTarget = t } }
                    },
                    onScan: { showSearch = false; showScan = true }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: showSearch)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .sheet(isPresented: $showMusic) {
            MusicSheetView(onClose: { showMusic = false })
        }
        .task {
            await loadConvs(); await loadSummary()
            WsClient.shared.connect()
            removeListener = WsClient.shared.addListener { frame in
                let op = frame["op"] as? String
                // conv_refresh：入群/退群等成员变动（扫码入群后新群立即出现在列表）
                if op == "msg" || op == "conv_cleared" || op == "conv_refresh" { Task { await loadConvs() } }
                if op == "notify" { Task { await loadSummary() } }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .noticesRead)) { _ in Task { await loadSummary() } }
        .onDisappear { removeListener?() }
    }

    private var header: some View {
        HStack {
            Text(t("tab.messages")).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.text)
            Spacer()
            Menu {
                RouteLink(.createGroup) { Label(t("chat.createGroup"), systemImage: "person.2.badge.plus") }
                RouteLink(.joinGroup(nil)) { Label(t("chat.joinGroup"), systemImage: "qrcode.viewfinder") }
                RouteLink(.createChannel) { Label(t("chat.plus.createChannel"), systemImage: "megaphone") }
                RouteLink(.channels) { Label(t("chat.plus.discoverChannels"), systemImage: "magnifyingglass") }
                RouteLink(.bots) { Label(t("me.bots"), systemImage: "cpu") }
            } label: {
                Text("+").font(.system(size: 18)).foregroundStyle(Theme.text)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Theme.bg3))
            }
            .buttonStyle(.plain)
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 8, trailing: 16))
    }

    /// 搜索胶囊：点了弹全屏搜索框
    private var searchPill: some View {
        Button { showSearch = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium))
                Text(t("common.search")).font(.system(size: 15))
            }
            .foregroundStyle(Theme.textSub)
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .background(Capsule().fill(Theme.bg3))
        }
        .buttonStyle(.plain)
        // 右端扫一扫（邀请名片 → 私聊）
        .overlay(alignment: .trailing) {
            Button { showScan = true } label: {
                Image(systemName: "qrcode.viewfinder").font(.system(size: 16)).foregroundStyle(Theme.textSub)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 2)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    private var searchExtras: [SearchExtra] {
        var list = [
            SearchExtra(key: "ai", title: t("ai.title"), subtitle: t("ai.subtitle"), icon: { AnyView(AiIconView(size: $0)) },
                        onOpen: { showSearch = false; pushRoute = .aiChat }),
            SearchExtra(key: "music", title: t("music.title"), subtitle: t("chat.music.subtitle"), icon: { AnyView(MusicIconView(size: $0)) },
                        onOpen: { showSearch = false; showMusic = true }),
        ]
        for k in ["comment", "task"] {
            guard let s = summary.of(k), let last = s.last else { continue }
            list.append(SearchExtra(key: k, title: noticeTitle(k), subtitle: last.title ?? "", unread: s.unread ?? 0,
                                    icon: { AnyView(NoticeIconView(kind: k, size: $0)) },
                                    onOpen: { showSearch = false; pushRoute = .notices(k) }))
        }
        return list
    }

    /// 消息列表一行：左图标 54 + 标题 / 时间 + 预览 / 角标，分隔线和文字对齐
    private func listRow<Leading: View, Title: View>(
        time: String, sub: String, badge: Int, badgeMuted: Bool = false, pinned: Bool = false,
        @ViewBuilder leading: () -> Leading, @ViewBuilder title: () -> Title
    ) -> some View {
        HStack(spacing: 12) {
            leading()
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        title()
                        Spacer(minLength: 8)
                        if !time.isEmpty { Text(time).font(.system(size: 11)).foregroundStyle(Theme.textDim) }
                    }
                    HStack(spacing: 8) {
                        Text(sub).font(.system(size: 14)).foregroundStyle(Theme.textSub).lineLimit(1)
                        Spacer(minLength: 0)
                        if badge > 0 {
                            Text(badge > 99 ? "99+" : "\(badge)").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                                .background(Capsule().fill(badgeMuted ? Theme.textDim : Theme.accent))
                        }
                        if pinned {
                            Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(Theme.textDim).rotationEffect(.degrees(45))
                        }
                    }
                }
                .frame(maxHeight: .infinity)
                .padding(.trailing, 16)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
        }
        .padding(.leading, 16)
        .frame(height: 72)
        .contentShape(Rectangle())
    }

    private func tag(_ text: String) -> some View {
        Text(text).font(.system(size: 10)).foregroundStyle(Theme.accent)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.accent.opacity(0.12)))
    }

    private var aiEntryRow: some View {
        RouteLink(.aiChat) {
            listRow(time: "", sub: t("ai.subtitle"), badge: 0, pinned: true) {
                AiIconView()
            } title: {
                Text(t("ai.title")).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text)
                tag(t("ai.free"))
            }
        }
        .buttonStyle(.plain)
    }

    /// 音乐频道置顶入口（Telegram 频道同步，最多保留 100 首）：弹出播放弹层
    private var newsEntryRow: some View {
        Button { showMusic = true } label: {
            listRow(time: "", sub: t("chat.music.subtitle"), badge: 0, pinned: true) {
                MusicIconView()
            } title: {
                Text(t("music.title")).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text)
                tag(t("chat.music.tag"))
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func entryRow(_ e: Entry) -> some View {
        switch e {
        case .conv(let c):
            convRow(c)
        case .notice(let k, let s):
            RouteLink(.notices(k)) {
                listRow(time: fmtTime(s.last?.createdAt), sub: s.last?.title ?? "", badge: s.unread ?? 0) {
                    NoticeIconView(kind: k)
                } title: {
                    Text(noticeTitle(k)).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private func convRow(_ c: ConversationItem) -> some View {
        let name = c.type == 1 ? (c.peer?.nickname ?? "") : (c.group?.name ?? "")
        let title = c.type == 1 ? name : t("chat.groupTitle", ["name": name])
        let avatar = c.type == 1 ? c.peer?.avatar : c.group?.avatar
        let target = c.type == 1 ? (c.peer?.id ?? "") : (c.group?.id ?? "")
        let isChannel = c.type == 2 && c.group?.kind == 2
        return Button {
            if isChannel {
                pushRoute = .channel(target)
            } else {
                chatTarget = ChatTarget(convId: c.id, convType: c.type, targetId: target, title: title)
            }
        } label: {
            listRow(time: fmtTime(c.lastMsgAt), sub: previewOf(c.lastMsg), badge: c.unread ?? 0, badgeMuted: c.muted == true) {
                AvatarView(url: avatar, size: 54)
            } title: {
                Text(name).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                if c.type == 2 {
                    Text(isChannel ? t("channel.title") : t("chat.groupTag")).font(.system(size: 10)).foregroundStyle(Theme.textSub)
                        .padding(.horizontal, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
                }
                if c.peer?.isBot == true { BotTag() }
            }
        }
        .buttonStyle(.plain)
    }

    private func loadConvs() async { convs = (try? await Api.request("/im/conversations")) ?? convs }
    private func loadSummary() async { summary = (try? await Api.request("/notifications/summary")) ?? summary }
}

/// 聊天全屏容器（fullScreenCover 用，带关闭按钮）
struct ChatRoomSheet: View {
    let target: ChatTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavStack {
            ChatRoomView(convId: target.convId, convType: target.convType, targetId: target.targetId, title: target.title, focusMsgId: target.focusMsgId)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { dismiss() } label: {
                            Image(systemName: "chevron.left").foregroundStyle(Theme.text)
                        }
                    }
                }
        }
    }
}

/// 语音播放器（保持引用）
final class AudioPlayerBox {
    static let shared = AudioPlayerBox()
    var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private var onFinish: (() -> Void)?

    func play(_ url: String, onFinish: (() -> Void)? = nil) {
        guard let u = URL(string: Api.fullUrl(url)) else { onFinish?(); return }
        // 切换到新语音时，先通知上一个气泡停止动画
        self.onFinish?()
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        self.onFinish = onFinish

        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        player = AVPlayer(url: u)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player?.currentItem,
            queue: .main
        ) { [weak self] _ in
            self?.onFinish?()
            self?.onFinish = nil
        }
        player?.play()
    }
}

/// 录音器
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?
    private var startAt = Date()
    private(set) var fileUrl: URL?

    func start() {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            guard granted else { return }
            DispatchQueue.main.async { [weak self] in self?.beginRecord() }
        }
    }

    private func beginRecord() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default)
        try? session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rec_\(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        recorder = try? AVAudioRecorder(url: url, settings: settings)
        recorder?.isMeteringEnabled = true
        recorder?.record()
        fileUrl = url
        startAt = Date()
    }

    /// 当前录音音量 0~1，驱动录音动画
    func level() -> CGFloat {
        guard let r = recorder else { return 0 }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0) // -160(静音) ~ 0(最大)
        return CGFloat(max(0, min(1, (db + 50) / 50)))
    }

    var durationSeconds: Int { recorder == nil ? 0 : Int(Date().timeIntervalSince(startAt)) }

    /// 返回 (data, durationSec)；太短返回 nil
    func stop() -> (Data, Int)? {
        recorder?.stop()
        recorder = nil
        let dur = max(1, Int(Date().timeIntervalSince(startAt)))
        guard let url = fileUrl, let data = try? Data(contentsOf: url), data.count > 200 else { return nil }
        return (data, dur)
    }
}

/// 录音中悬浮提示：实时音量波形 + 计时（微信式），避免看起来像卡死
struct RecordingOverlay: View {
    let recorder: VoiceRecorder
    @State private var levels: [CGFloat] = Array(repeating: 0, count: 24)
    @State private var seconds = 0
    private let timer = Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .center, spacing: 3) {
                ForEach(levels.indices, id: \.self) { i in
                    Capsule()
                        .fill(.white)
                        .frame(width: 3, height: 5 + levels[i] * 30)
                }
            }
            .frame(height: 40)
            .animation(.linear(duration: 0.08), value: levels)

            Text(String(format: "%d:%02d", seconds / 60, seconds % 60))
                .font(.system(size: 14, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.white)

            Text(t("chat.releaseToSend"))
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 30).padding(.vertical, 22)
        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.accent.opacity(0.95)))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
        .onReceive(timer) { _ in
            levels.removeFirst()
            levels.append(recorder.level())
            seconds = recorder.durationSeconds
        }
    }
}

/// 聊天页：文字 / 图片 / 语音 / 位置 / 礼物 / 通话
struct ChatRoomView: View {
    let convId: String
    let convType: Int
    let targetId: String
    let title: String
    var focusMsgId: String? = nil

    @EnvironmentObject var state: AppState
    @State private var messages: [MsgItem] = []
    @State private var removePerpListener: (() -> Void)?
    @State private var loaded = false
    /// 对方是机器人时的公开资料（简介卡片 / 开始按钮 / 命令菜单）
    @State private var bot: BotPublic?
    @State private var showCmds = false
    // 从搜索结果进来：首屏定位到该消息并闪一下，之后照常滚到底
    @State private var focusPending = true
    @State private var flashId: String?
    @State private var input = ""
    @State private var voiceMode = false
    @State private var recording = false
    @State private var showAttach = false
    @State private var showSticker = false
    @State private var showGift = false
    @State private var fullImage: String?
    @State private var removeListener: (() -> Void)?
    @State private var toastMsg: String?
    @State private var showClearConfirm = false
    @State private var showVoiceRoom = false
    @ObservedObject private var vroom = VoiceRoomManager.shared
    private let recorderBox = VoiceRecorder()
    @FocusState private var inputFocused: Bool
    // 长按菜单及其衍生操作
    @State private var menuMsg: MsgItem?
    @State private var replyTo: MsgItem?
    @State private var pins: [PinItem] = []
    @State private var pinIdx = 0
    @State private var selecting: Set<String>?
    /// 正在播删除动画（灰飞烟灭）的消息 id
    @State private var dying: Set<String> = []
    @State private var deleteIds: [String]?
    @State private var forwardIds: IdList?
    @State private var reportId: String?
    @State private var myRole = "member"
    @State private var jumpReq: String?
    // 链上钱包：转账（对方公开了收款地址才能转）、喊单卡片点开
    @State private var walletOk = false
    @State private var walletRoute: Route?
    @State private var transferAddr: ChainAddr?
    @State private var transferPick: String?
    @State private var scannedQr: String?
    // 发图：本地预览、上传进度 / 失败、待传的原图（按 upKey）
    @State private var localImages: [String: UIImage] = [:]
    @State private var uploads: [String: UploadState] = [:]
    @State private var upSources: [String: UploadSource] = [:]

    private var myId: String { state.user?.id ?? "" }
    private var rows: [ChatRow] { groupAlbums(messages) }

    /// 滚动定位用的行 id（相册按第一张）
    private func anchorId(_ id: String) -> String {
        rows.first(where: { r in r.items.contains(where: { $0.id == id }) })?.first.id ?? id
    }
    private var isGroupAdmin: Bool { convType == 2 && (myRole == "owner" || myRole == "admin") }
    private var canPin: Bool { convType == 1 || isGroupAdmin }
    private var perpIds: [String] { messages.filter { $0.type == "perp" && !$0.pending }.map { $0.id } }

    // body 拆成几段，整块写在一起 Swift 类型检查会超时
    var body: some View {
        decorated(msgActionLayers(mainColumn))
            .task { await onLoad() }
            .task { walletOk = await ChainWallet.visible(state.user) }
            .onDisappear {
                removeListener?()
                removePerpListener?()
                WsClient.shared.perpUnwatch(conversationId: convId)
            }
            // 合约喊单卡片：告诉服务端这个聊天里在看哪些卡片，它每 3 秒推实时状态（PerpLive）
            .onChange(of: perpIds) { ids in
                if !ids.isEmpty { WsClient.shared.perpWatch(conversationId: convId, ids: ids) }
            }
            .onAppear {
                removePerpListener = WsClient.shared.addListener { frame in PerpLive.shared.onFrame(frame) }
                if !perpIds.isEmpty { WsClient.shared.perpWatch(conversationId: convId, ids: perpIds) }
            }
            .routePush($walletRoute)
            .onReceive(NotificationCenter.default.publisher(for: ChainWallet.resultNotification)) { n in
                if let s = n.userInfo?["json"] as? String { onWalletResult(s) }
            }
            .sheet(item: $transferAddr, onDismiss: {
                // sheet 收起动画中 push 会被吞掉，等收完再跳钱包
                if let p = transferPick {
                    transferPick = nil
                    walletRoute = .chainWalletPath(p)
                }
            }) { a in
                TransferChainSheet(addr: a) { addr, chain in
                    transferPick = ChainCards.transferPath(address: addr, chain: chain, name: title)
                }
                .compatDetents(height: 430)
            }
            .scanHandler($scannedQr)
    }

    /// 聊天里「转账」：先查对方公开的收款地址，两条链都有就让选，再打开钱包转账页（ret=1 转完交回结果）
    private func startTransfer() {
        Task { @MainActor in
            do {
                let a: ChainAddr = try await Api.request("/user/\(targetId)/chain-address")
                let opts = a.options
                if opts.isEmpty {
                    toastMsg = t("chat.transfer.disabled")
                } else if opts.count > 1 {
                    transferAddr = a
                } else {
                    walletRoute = .chainWalletPath(ChainCards.transferPath(address: opts[0].address, chain: opts[0].chain, name: title))
                }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    /// 钱包交回的转账结果：服务端核对链上交易后发转账卡片
    private func onWalletResult(_ json: String) {
        let r = ChainCards.obj(json)
        // 付收款消息（带 req）由服务端决定卡片发到哪：群里回到群，频道里私聊发给收款人
        guard r["kind"] as? String == "transfer", convType == 1 || r["req"] != nil else { return }
        toastMsg = t("chat.transfer.verifying")
        Task { @MainActor in
            do {
                if let m = try await ChainCards.postTransfer(targetId: convType == 1 ? targetId : "", resultJson: json), m.conversationId == convId, !messages.contains(where: { $0.id == m.id }) {
                    messages.append(m)
                }
            } catch {
                toastMsg = t("chat.transfer.cardFailed", ["msg": error.localizedDescription])
            }
        }
    }

    private var mainColumn: some View {
        VStack(spacing: 0) {
            pinBarView
            ScrollViewReader { proxy in messageScroll(proxy) }
            bottomArea
        }
    }

    @ViewBuilder
    private var pinBarView: some View {
        if !pins.isEmpty && selecting == nil {
            PinBar(pins: pins, index: pinIdx, canUnpin: canPin, onJump: {
                let p = pins[pinIdx % pins.count]
                pinIdx += 1
                jumpTo(p.id)
            }, onUnpin: {
                togglePin(pins[pinIdx % pins.count].id, pin: false)
            })
        }
    }

    private var messageStack: some View {
        LazyVStack(spacing: 0) {
            if botFresh, let b = bot { botIntro(b) }
            ForEach(rows) { row in
                rowView(row)
            }
            Color.clear.frame(height: 1).id(Self.bottomId)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private static let bottomId = "chat-bottom"

    /// 一行：时间分隔条（与上一条间隔超 5 分钟）+ 气泡（相册一行多张）
    private func rowView(_ row: ChatRow) -> some View {
        let m = row.first
        let ids = row.items.map(\.id)
        let flashOn = flashId.map { ids.contains($0) } ?? false
        let allDying = ids.allSatisfy { dying.contains($0) }
        return VStack(spacing: 0) {
            if shouldShowTime(row.start) {
                Text(fmtTime(m.createdAt))
                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            DustOut(dying: allDying, onGone: { for id in ids { msgGone(id) } }) {
                messageRow(row)
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(flashOn ? Theme.accent.opacity(0.14) : Color.clear))
        }
        .id(m.id)
    }

    /// 滚到底。LazyVStack 里没量过的行只是估算高度，图片 / 卡片随后才撑开，滚一次常常停在半路：
    /// 刚进聊天时隔几下再滚，直到布局稳定
    private func scrollToBottom(_ proxy: ScrollViewProxy, settle: Bool) {
        let delays: [Double] = settle ? [0, 0.12, 0.3, 0.6, 1.0] : [0, 0.15]
        for d in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
        }
    }

    private func messageScroll(_ proxy: ScrollViewProxy) -> some View {
        ScrollView { messageStack }
        .simultaneousGesture(TapGesture().onEnded { showSticker = false; showCmds = false; inputFocused = false })
        .inAppLinks()
        .onChange(of: jumpReq) { id in
            guard let id else { return }
            jumpReq = nil
            let anchor = anchorId(id)
            DispatchQueue.main.async { withAnimation { proxy.scrollTo(anchor, anchor: .center) } }
            withAnimation(.easeOut(duration: 0.15)) { flashId = id }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                withAnimation(.easeOut(duration: 0.9)) { if flashId == id { flashId = nil } }
            }
        }
        // 进入聊天默认停在最底部（最新消息）；defaultScrollAnchor 是 iOS 17 API，改用 scrollTo
        .onAppear {
            if !messages.isEmpty { scrollToBottom(proxy, settle: true) }
        }
        .onChange(of: messages.count) { _ in
            var first = false
            if focusPending, !messages.isEmpty {
                focusPending = false
                first = true
                if let fid = focusMsgId, messages.contains(where: { $0.id == fid }) {
                    let anchor = anchorId(fid)
                    DispatchQueue.main.async { proxy.scrollTo(anchor, anchor: .center) }
                    withAnimation(.easeOut(duration: 0.15)) { flashId = fid }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                        withAnimation(.easeOut(duration: 0.9)) { flashId = nil }
                    }
                    return
                }
            }
            if !messages.isEmpty { scrollToBottom(proxy, settle: first) }
        }
        .onChange(of: inputFocused) { focused in
            if focused {
                // 键盘弹出时收起表情面板，避免两者叠加把内容顶飞
                showSticker = false
                if !messages.isEmpty {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        withAnimation { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var bottomArea: some View {
        if let sel = selecting {
            selectBar(sel)
        } else if botFresh {
            // 和机器人的空会话：底部是「开始」按钮（发 /start），同 Telegram
            Button { sendMsg("text", "/start") } label: {
                Text(t("chat.botStart")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity).padding(.vertical, 16)
                    .background(Theme.bg2)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            bottomBar
        }
    }

    private func navDecorated<V: View>(_ v: V) -> some View {
        v.overlay {
            if recording {
                RecordingOverlay(recorder: recorderBox)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .animation(.easeOut(duration: 0.15), value: recording)
        .fullBg()
        .toast($toastMsg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar { toolbarItems }
    }

    private var voiceRoomLabel: String {
        let n = vroom.memberCount(targetId)
        return n > 0 ? t("chat.menu.voiceRoomN", ["n": n]) : t("chat.menu.voiceRoom")
    }

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        // ToolbarContentBuilder 里的 if 要 iOS 16，所以 principal 一直放，分支写在里面
        ToolbarItem(placement: .principal) {
            HStack(spacing: 6) {
                Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                if bot != nil { BotTag() }
            }
        }
        ToolbarItem(placement: .navigationBarTrailing) {
            Menu {
                if convType == 2 {
                    Button {
                        showVoiceRoom = true
                    } label: {
                        Label(voiceRoomLabel, systemImage: "waveform")
                    }
                    Button {
                        walletRoute = .groupInfo(targetId)
                    } label: {
                        Label(t("chat.menu.groupInfo"), systemImage: "person.3")
                    }
                }
                Button(role: .destructive) {
                    showClearConfirm = true
                } label: {
                    Label(t("chat.menu.clear"), systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .frame(width: 32, height: 32)
                    .overlay(alignment: .topTrailing) {
                        if convType == 2 && vroom.memberCount(targetId) > 0 {
                            Circle().fill(Color.red).frame(width: 7, height: 7).offset(x: -2, y: 4)
                        }
                    }
            }
        }
    }

    private func decorated<V: View>(_ v: V) -> some View {
        navDecorated(v)
        .confirmationDialog(
            convType == 1 ? t("chat.clearSingleConfirm") : t("chat.clearGroupConfirm"),
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button(t("chat.menu.clear"), role: .destructive) { clearChat() }
            Button(t("common.cancel"), role: .cancel) {}
        }
        .sheet(isPresented: $showAttach) {
            AttachSheet(
                isSingle: convType == 1 && bot == nil,
                canVideoCall: state.user?.gender == 1,
                canTransfer: convType == 1 && bot == nil && walletOk,
                canVoice: convType == 2,
                onClose: { showAttach = false },
                onSendAssets: sendAttachAssets,
                onSendDatas: sendAttachDatas,
                onAction: handleAttach
            )
            .attachSheetDetents()
            .compatSheetBackground(Theme.bg)
        }
        .sheet(isPresented: $showGift) {
            GiftSheetView(toUserId: targetId)
                .compatDetents(height: 420)
        }
        .sheet(isPresented: $showVoiceRoom) {
            VoiceRoomSheet(groupId: targetId, groupName: title)
                .compatDetents(height: 440)
        }
        .fullScreenCover(item: $fullImage) { img in
            let imgs = messages.filter { $0.type == "image" }.map { imageUrlOf($0.content) }.filter { !$0.isEmpty }
            ImageViewerView(images: imgs.isEmpty ? [img] : imgs, initial: max(0, imgs.firstIndex(of: img) ?? 0), onScanQr: onImageQr) {
                fullImage = nil
            }
        }
    }

    /// 大图里认出的二维码：等查看器收起再交给统一的扫码处理
    private func onImageQr(_ text: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { scannedQr = text }
    }

    private func clearChat() {
        Task {
            struct OkResp: Codable { var ok: Bool? }
            if let _: OkResp = try? await Api.request("/im/conversations/\(convId)/clear", method: "POST") {
                await reloadMessages()
            } else {
                toastMsg = t("channel.clearFailed")
            }
        }
    }

    private func onLoad() async {
        let around = focusPending ? focusMsgId.map { "&aroundId=\($0)" } ?? "" : ""
        let first: [MsgItem] = (try? await Api.request("/im/messages?conversationId=\(convId)\(around)")) ?? []
        // 列表回来前已发出去的消息别被覆盖
        messages = first + messages.filter { m in m.pending && !first.contains(where: { $0.id == m.id }) }
        loaded = true
        Task { @MainActor in
            await loadPins()
            guard convType == 2 else { return }
            struct RoleMember: Codable { var id: String; var role: String? }
            struct RoleResp: Codable { var members: [RoleMember]? }
            if let g: RoleResp = try? await Api.request("/im/group/\(targetId)") {
                myRole = g.members?.first(where: { $0.id == myId })?.role ?? "member"
            }
        }
        if let last = messages.last { WsClient.shared.markRead(conversationId: convId, msgId: last.id) }
        WsClient.shared.connect()
        // 空会话或对方发过机器人消息：查一下对方是不是机器人
        if convType == 1 && (messages.isEmpty || messages.contains(where: { $0.senderIsBot == true && $0.senderId == targetId })) {
            bot = await BotInfoCache.shared.get(targetId)
        }
        // 群聊：拉一次语音房人数（入口角标）
        if convType == 2 { await vroom.refreshInfo(groupId: targetId) }
        removeListener = WsClient.shared.addListener { frame in handleFrame(frame) }
}

    private func handleFrame(_ frame: [String: Any]) {
        let op = frame["op"] as? String
        if op == "error" {
            // 发送被后端拒绝（如积分不足）：提示并撤回乐观显示的消息
            toastMsg = frame["msg"] as? String ?? t("chat.sendFailed")
            let tid = frame["tempId"] as? String
            let idx = tid != nil ? messages.firstIndex(where: { $0.id == tid }) : messages.lastIndex(where: { $0.id.hasPrefix("t_") })
            if let idx {
                messages.remove(at: idx)
            }
            return
        }
        if op == "ack" {
            // 乐观消息换成正式 id，菜单 / 回复 / 置顶才能用
            guard botFrameStr(frame["conversationId"]) == convId,
                  let tid = frame["tempId"] as? String,
                  let mid = botFrameStr(frame["msgId"]),
                  let idx = messages.firstIndex(where: { $0.id == tid }) else { return }
            if messages.contains(where: { $0.id == mid }) { messages.remove(at: idx); return }
            messages[idx].id = mid
            if let c = frame["createdAt"] as? String { messages[idx].createdAt = c }
            return
        }
        if op == "read" {
            guard botFrameStr(frame["conversationId"]) == convId,
                  (botFrameStr(frame["userId"]) ?? "") != myId else { return }
            for i in messages.indices where messages[i].senderId == myId { messages[i].isRead = true }
            return
        }
        if op == "msg_reactions" || op == "msg_pin" {
            guard let data = frame["data"] as? [String: Any],
                  botFrameStr(data["conversationId"]) == convId else { return }
            if op == "msg_pin" { Task { await loadPins() }; return }
            guard let id = botFrameStr(data["msgId"]),
                  let idx = messages.firstIndex(where: { $0.id == id }),
                  let raw = data["reactions"],
                  let json = try? JSONSerialization.data(withJSONObject: raw),
                  let rs = try? JSONDecoder().decode([MsgReaction].self, from: json) else { return }
            messages[idx].reactions = rs
            return
        }
        if op == "conv_cleared" {
            // 有人清空了记录（单聊=全部，群聊=其发送的消息）：重新拉取同步
            if let data = frame["data"] as? [String: Any],
               (data["conversationId"] as? String) == convId {
                Task { await reloadMessages() }
            }
            return
        }
        if op == "msg_edit" || op == "msg_delete" {
            // 机器人改消息（文字 / 按钮）或撤回
            guard let data = frame["data"] as? [String: Any],
                  botFrameStr(data["conversationId"]) == convId,
                  let id = botFrameStr(data["msgId"]) else { return }
            if op == "msg_delete" {
                removeMsgs([id])
                if replyTo?.id == id { replyTo = nil }
                if pins.contains(where: { $0.id == id }) { Task { await loadPins() } }
            } else if let idx = messages.firstIndex(where: { $0.id == id }) {
                if let c = data["content"] as? String { messages[idx].content = c }
                messages[idx].markup = InlineMarkup.from(data["markup"])
            }
            return
        }
        guard op == "msg",
              let data = frame["data"] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: data),
              let m = try? JSONDecoder().decode(MessagePayload.self, from: json),
              m.conversationId == convId,
              !messages.contains(where: { $0.id == m.id }) else { return }
        messages.append(MsgItem(id: m.id, conversationId: m.conversationId, senderId: m.senderId,
                                senderNickname: m.senderNickname, senderAvatar: m.senderAvatar,
                                receiverId: m.receiverId, type: m.type, content: m.content, createdAt: m.createdAt,
                                senderIsBot: m.senderIsBot, markup: m.markup,
                                replyTo: m.replyTo, fwdFrom: m.fwdFrom, reactions: m.reactions))
        WsClient.shared.markRead(conversationId: convId, msgId: m.id)
        if m.senderIsBot == true && convType == 1 && bot == nil {
            Task { bot = await BotInfoCache.shared.get(m.senderId) }
        }
    }

    // MARK: - 底部输入区（微信式）

    private var botFresh: Bool { bot != nil && loaded && messages.isEmpty }

    private func botIntro(_ b: BotPublic) -> some View {
        VStack(spacing: 4) {
            AvatarView(url: b.avatar, size: 64)
            HStack(spacing: 6) {
                Text(b.name ?? title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                BotTag()
            }
            .padding(.top, 6)
            Text("@\(b.username ?? "")").font(.system(size: 12)).foregroundStyle(Theme.textSub)
            if let d = b.description, !d.isEmpty {
                Text(d).font(.system(size: 14)).foregroundStyle(Theme.text).lineSpacing(4)
                    .multilineTextAlignment(.center).padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
        .padding(.horizontal, 24).padding(.top, 40)
    }

    /// 命令菜单：点「/」展开全部，或输入以 / 开头时按前缀过滤
    private var shownCmds: [BotCommandItem] {
        let cmds = bot?.commands ?? []
        if showCmds { return cmds }
        guard input.hasPrefix("/"), !input.contains(" ") else { return [] }
        let q = input.dropFirst().lowercased()
        return cmds.filter { $0.command.lowercased().hasPrefix(q) }
    }

    private var bottomBar: some View {
        VStack(spacing: 0) {
            if let r = replyTo {
                ReplyBar(nickname: r.senderNickname ?? "", snippet: msgSnippet(r.type, r.content)) { replyTo = nil }
            }
            if !shownCmds.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(shownCmds, id: \.command) { c in
                            Button {
                                showCmds = false; input = ""
                                sendMsg("text", "/\(c.command)")
                            } label: {
                                HStack(spacing: 12) {
                                    Text("/\(c.command)").font(.system(size: 14, weight: .medium)).foregroundStyle(botBlue)
                                    Text(c.description ?? "").font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 16).padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: min(CGFloat(shownCmds.count) * 40, 220))
            }
            HStack(alignment: .bottom, spacing: 8) {
                if !(bot?.commands ?? []).isEmpty {
                    Button {
                        showSticker = false; showCmds.toggle()
                    } label: {
                        Text("/").font(.system(size: 18, weight: .bold)).foregroundStyle(showCmds ? botBlue : Theme.textSub)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(showCmds ? Theme.bubbleMine : Theme.bg3))
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    voiceMode.toggle(); showSticker = false; inputFocused = false
                } label: {
                    Image(systemName: voiceMode ? "keyboard" : "waveform")
                        .font(.system(size: 17)).foregroundStyle(Theme.textSub)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)

                if voiceMode {
                    Text(recording ? t("chat.releaseToSend") : t("chat.holdToTalk"))
                        .font(.system(size: 14))
                        .foregroundStyle(recording ? .white : Theme.text)
                        .frame(maxWidth: .infinity).frame(height: 40)
                        .background(Capsule().fill(recording ? Theme.accent : Theme.bg3))
                        .onLongPressGesture(minimumDuration: 60, maximumDistance: 80, pressing: { pressing in
                            if pressing { recording = true; recorderBox.start() }
                            else if recording { recording = false; finishRecording() }
                        }, perform: {})
                } else {
                    Group {
                        if #available(iOS 16.0, *) {
                            TextField("", text: $input, prompt: Text(t("chat.inputPlaceholder")).foregroundColor(Theme.textDim), axis: .vertical)
                                .lineLimit(1 ... 4)
                                .focused($inputFocused)
                        } else {
                            TextField("", text: $input, prompt: Text(t("chat.inputPlaceholder")).foregroundColor(Theme.textDim))
                                .focused($inputFocused)
                        }
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                }

                // 表情按钮：面板顶替键盘（Telegram 式，点贴纸即发送）
                Button {
                    inputFocused = false; voiceMode = false; showSticker.toggle()
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

                if !voiceMode && !input.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button {
                        let text = input.trimmingCharacters(in: .whitespaces)
                        sendMsg("text", text)
                        input = ""
                    } label: {
                        Text(t("common.send")).font(.system(size: 14)).foregroundStyle(.white)
                            .padding(.horizontal, 16).frame(height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)

            if showSticker {
                // 贴纸 / GIF 点即发送（消息类型都是 sticker，GIF 的 format=mp4）；「最近使用」由面板自己记
                EmojiPanel(
                    onPick: { p in sendMsg("sticker", p.encoded()) },
                    onEmoji: { input += $0 },
                    onDelete: { input = dropLastGrapheme(input) },
                    onKeyboard: { showSticker = false; inputFocused = true }
                )
            }
        }
        .background(Theme.bg2)
    }

    private func handleAttach(_ action: AttachAction) {
        showAttach = false
        let peerAvatar = messages.first(where: { $0.senderId == targetId })?.senderAvatar ?? ""
        // 等弹框收起再弹礼物 / 通话页，两个 sheet 同时切换会丢一个
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            switch action {
            case .gift: showGift = true
            case .transfer: startTransfer()
            case .voice: voiceMode = true; showSticker = false
            case .location: sendLocation()
            case .voiceCall: startCallWithPermissions(calleeId: targetId, type: 1, name: title, avatar: peerAvatar)
            // 视频通话仅男方可发起（女方只能接听），弹框里已按性别隐藏入口
            case .videoCall: startCallWithPermissions(calleeId: targetId, type: 2, name: title, avatar: peerAvatar)
            }
        }
    }

    // MARK: - 发图：选好立刻显示（本地预览 + 进度圈），后台最多同时传 3 张，按选择顺序发出；多张合成相册

    private func sendAttachAssets(_ assets: [PHAsset], caption: String) {
        showAttach = false
        let items: [(String, UploadSource, Int, Int)] = assets.map { a in
            (newUploadKey(), UploadSource.asset(a), a.pixelWidth, a.pixelHeight)
        }
        startImageSend(items, caption: caption)
        for (i, a) in assets.enumerated() {
            let key = items[i].0
            Task { @MainActor in
                if localImages[key] == nil, let img = await AttachMedia.preview(a) { localImages[key] = img }
            }
        }
    }

    private func sendAttachDatas(_ datas: [Data], caption: String) {
        showAttach = false
        var items: [(String, UploadSource, Int, Int)] = []
        for d in datas {
            let key = newUploadKey()
            let img = UIImage(data: d)
            if let img { localImages[key] = img }
            items.append((key, UploadSource.data(d), Int(img?.size.width ?? 0), Int(img?.size.height ?? 0)))
        }
        startImageSend(items, caption: caption)
    }

    private func newUploadKey() -> String {
        "local_\(UUID().uuidString.prefix(12))"
    }

    /// items：(upKey, 原图, 宽, 高)
    private func startImageSend(_ items: [(String, UploadSource, Int, Int)], caption: String) {
        guard !items.isEmpty else { return }
        let g: String? = items.count > 1 ? newAlbumId() : nil
        let r = replyTo
        replyTo = nil
        let preview = r.map {
            ReplyPreview(id: $0.id, senderId: $0.senderId, senderNickname: $0.senderNickname, type: $0.type,
                         content: $0.type == "text" ? String($0.content.prefix(100)) : ($0.type == "image" ? imageUrlOf($0.content) : ""))
        }
        let now = ISO8601DateFormatter().string(from: Date())
        for (i, it) in items.enumerated() {
            upSources[it.0] = it.1
            uploads[it.0] = UploadState()
            messages.append(MsgItem(
                id: it.0, conversationId: convId, senderId: myId,
                senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
                receiverId: nil, type: "image", content: imageContent("", g: g, w: it.2, h: it.3),
                createdAt: now, replyTo: i == 0 ? preview : nil, upKey: it.0
            ))
        }
        let keys = items.map { $0.0 }
        let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { @MainActor in
            await uploadInOrder(keys, upload: { k in await uploadOne(k) }, send: { k, url in
                if let tid = sendUploaded(k, url) { _ = await awaitAck(tid) }
            })
            if !text.isEmpty { sendMsg("text", text) }
        }
    }

    @MainActor
    private func uploadOne(_ key: String) async -> String? {
        guard let src = upSources[key] else { return nil }
        uploads[key] = UploadState()
        var data: Data?
        switch src {
        case .data(let d): data = d
        case .asset(let a): data = await AttachMedia.jpegData(a)
        }
        guard let data else {
            uploads[key] = UploadState(progress: 0, failed: true)
            return nil
        }
        if localImages[key] == nil, let img = UIImage(data: data) { localImages[key] = img }
        do {
            let url = try await Api.upload("image", data: data, filename: "img.jpg", mime: "image/jpeg", progress: { p in
                if let s = uploads[key], !s.failed { uploads[key] = UploadState(progress: p, failed: false) }
            })
            uploads[key] = nil
            return url
        } catch {
            uploads[key] = UploadState(progress: 0, failed: true)
            return nil
        }
    }

    /// 传完的图发出去：本地那条换成 tempId，等 ack；回复引用挂在第一张上
    @MainActor @discardableResult
    private func sendUploaded(_ key: String, _ url: String) -> String? {
        guard let idx = messages.firstIndex(where: { $0.upKey == key }) else { return nil }
        let meta = parseImage(messages[idx].content)
        let content = imageContent(url, g: meta.g, w: meta.w, h: meta.h)
        let tempId = WsClient.shared.send(convType: convType, targetId: targetId, msgType: "image", content: content, replyToId: messages[idx].replyTo?.id)
        messages[idx].id = tempId
        messages[idx].content = content
        upSources[key] = nil
        return tempId
    }

    private func retryUpload(_ m: MsgItem) {
        guard let key = m.upKey else { return }
        Task { @MainActor in
            if let url = await uploadOne(key) { sendUploaded(key, url) }
        }
    }

    private func shouldShowTime(_ idx: Int) -> Bool {
        guard let cur = parseIsoDate(messages[idx].createdAt) else { return false }
        guard idx > 0, let prev = parseIsoDate(messages[idx - 1].createdAt) else { return idx == 0 }
        return cur.timeIntervalSince(prev) > 300
    }

    /// 重新拉取消息列表（清空记录后本端及其他端同步用）
    private func reloadMessages() async {
        messages = (try? await Api.request("/im/messages?conversationId=\(convId)")) ?? []
    }

    /// 对方头像兜底：从消息列表里找一条对方的非空头像（个别消息头像缺失时使用）
    private var peerAvatarGuess: String {
        let myId = state.user?.id ?? ""
        return messages.first(where: { $0.senderId != myId && ($0.senderAvatar?.isEmpty == false) })?.senderAvatar ?? ""
    }

    // MARK: - 发送

    /// 发消息并乐观显示（tempId 等 ack 换成正式 id）；正在回复的话只挂在这一条上
    private func sendMsg(_ type: String, _ content: String) {
        let r = replyTo
        replyTo = nil
        let tempId = WsClient.shared.send(convType: convType, targetId: targetId, msgType: type, content: content, replyToId: r?.id)
        let preview = r.map {
            ReplyPreview(id: $0.id, senderId: $0.senderId, senderNickname: $0.senderNickname, type: $0.type,
                         content: $0.type == "text" ? String($0.content.prefix(100)) : ($0.type == "image" ? $0.content : ""))
        }
        messages.append(MsgItem(
            id: tempId,
            conversationId: convId, senderId: myId,
            senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
            receiverId: nil, type: type, content: content,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            replyTo: preview
        ))
    }

    // MARK: - 长按菜单

    private func makeBubble(_ row: ChatRow) -> MsgBubble {
        let m = row.first
        let mine = m.senderId == myId
        return MsgBubble(
            m: m, mine: mine, convType: convType,
            fallbackAvatar: mine ? (state.user?.avatar ?? "") : peerAvatarGuess,
            myId: myId,
            onMenu: { inputFocused = false; showSticker = false; menuMsg = m },
            onReact: { react(m.id, $0) },
            onJump: { jumpTo($0) },
            onOpenWallet: walletOk ? { walletRoute = .chainWalletPath($0) } : nil,
            onImage: { url in if !url.isEmpty { fullImage = url } },
            album: row.isAlbum ? row.items : nil,
            uploads: uploads,
            localImages: localImages,
            onItemMenu: { item in
                guard !item.pending else { return }
                inputFocused = false; showSticker = false; menuMsg = item
            },
            onItemReact: { item, e in react(item.id, e) },
            onRetry: { item in retryUpload(item) }
        )
    }

    @ViewBuilder
    private func messageRow(_ row: ChatRow) -> some View {
        if let sel = selecting {
            selectableRow(row, sel)
        } else {
            makeBubble(row)
        }
    }

    /// 多选模式：相册整组一起勾选
    private func selectableRow(_ row: ChatRow, _ sel: Set<String>) -> some View {
        let ids = row.items.map(\.id)
        let on = ids.allSatisfy { sel.contains($0) }
        let pending = row.items.contains { $0.pending }
        return HStack(spacing: 6) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20))
                .foregroundStyle(on ? botBlue : Theme.textDim)
            makeBubble(row).allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !pending else { return }
            var s = sel
            if on { s.subtract(ids) } else { s.formUnion(ids) }
            selecting = s
        }
    }

    private func selectBar(_ sel: Set<String>) -> some View {
        let chosen = messages.filter { sel.contains($0.id) }
        return HStack {
            Button(t("common.cancel")) { selecting = nil }
                .font(.system(size: 15)).foregroundStyle(Theme.textSub)
            Spacer()
            Text(t("chat.selectedN", ["n": sel.count])).font(.system(size: 14)).foregroundStyle(Theme.text)
            Spacer()
            Button {
                let ok = chosen.filter { FORWARDABLE.contains($0.type) }.map(\.id)
                if ok.isEmpty { toastMsg = t("chat.cantForward"); return }
                if ok.count < chosen.count { toastMsg = t("chat.partForward") }
                forwardIds = IdList(ids: ok)
            } label: {
                Image(systemName: "arrowshape.turn.up.right").font(.system(size: 18))
            }
            .foregroundStyle(sel.isEmpty ? Theme.textDim : botBlue)
            .disabled(sel.isEmpty)
            .padding(.trailing, 18)
            Button {
                deleteIds = chosen.map(\.id)
            } label: {
                Image(systemName: "trash").font(.system(size: 18))
            }
            .foregroundStyle(sel.isEmpty ? Theme.textDim : Color.red)
            .disabled(sel.isEmpty)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Theme.bg2)
    }

    private func canDeleteForAll(_ m: MsgItem) -> Bool {
        m.type != "gift" && (m.senderId == myId || isGroupAdmin)
    }

    private func menuActions(_ m: MsgItem) -> MenuActions {
        let mine = m.senderId == myId
        let pinned = pins.contains(where: { $0.id == m.id })
        var a = MenuActions(onReact: { react(m.id, $0) })
        a.onReply = { replyTo = m; inputFocused = true }
        if m.type == "text" {
            a.onCopy = { UIPasteboard.general.string = m.content; toastMsg = t("common.copied") }
        }
        if m.type == "image" || m.type == "video" {
            let url = m.type == "image" ? imageUrlOf(m.content) : m.content
            a.onSave = { Task { @MainActor in toastMsg = await saveMediaToPhotos(type: m.type, url: url) } }
        }
        if canPin { a.onPin = { togglePin(m.id, pin: !pinned) } }
        if FORWARDABLE.contains(m.type) { a.onForward = { forwardIds = IdList(ids: [m.id]) } }
        if !mine { a.onReport = { reportId = m.id } }
        a.onDelete = { deleteIds = [m.id] }
        a.onSelect = { selecting = [m.id] }
        return a
    }

    private func msgActionLayers<V: View>(_ content: V) -> some View {
        let delCanForAll = (deleteIds ?? []).allSatisfy { id in
            messages.first(where: { $0.id == id }).map { canDeleteForAll($0) } ?? false
        }
        let delCount = deleteIds?.count ?? 0
        return content
            .overlay {
                if let m = menuMsg {
                    MsgMenuOverlay(
                        msgId: m.id, mine: m.senderId == myId, convType: convType,
                        myReaction: m.reactions?.first(where: { $0.userIds.contains(myId) })?.emoji,
                        pinned: pins.contains(where: { $0.id == m.id }),
                        actions: menuActions(m),
                        onDismiss: { menuMsg = nil }
                    )
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.15), value: menuMsg?.id)
            .confirmationDialog(
                delCount > 1 ? t("msg.deleteN", ["n": delCount]) : t("msg.deleteOne"),
                isPresented: Binding(get: { deleteIds != nil }, set: { if !$0 { deleteIds = nil } }),
                titleVisibility: .visible
            ) {
                if delCanForAll {
                    Button(convType == 1 ? t("msg.deleteForMeAndPeer", ["name": title]) : t("msg.deleteForAll"), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: true) }
                    }
                    Button(t("msg.deleteForMeOnly"), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: false) }
                    }
                } else {
                    Button(t("common.delete"), role: .destructive) {
                        if let ids = deleteIds { doDelete(ids, forAll: false) }
                    }
                }
                Button(t("common.cancel"), role: .cancel) { deleteIds = nil }
            } message: {
                if !delCanForAll { Text(t("msg.deleteForMeHint")) }
            }
            .sheet(item: $reportId) { id in
                ReportSheet(msgId: id) { toastMsg = $0 }
                    .compatDetents(height: 420)
            }
            .sheet(item: $forwardIds) { list in
                ForwardSheet(fromConvId: convId, ids: list.ids) { tip in
                    toastMsg = tip
                    if tip == t("msg.forwarded") { selecting = nil }
                }
            }
    }

    private func loadPins() async {
        pins = (try? await Api.request("/im/conversations/\(convId)/pins")) ?? []
        pinIdx = 0
    }

    private func react(_ id: String, _ emoji: String) {
        Task { @MainActor in
            struct ReactResp: Codable { var reactions: [MsgReaction] }
            do {
                let r: ReactResp = try await Api.request("/im/messages/\(id)/react", method: "POST", body: ["emoji": emoji])
                if let idx = messages.firstIndex(where: { $0.id == id }) { messages[idx].reactions = r.reactions }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func togglePin(_ id: String, pin: Bool) {
        Task { @MainActor in
            struct OkResp: Codable { var ok: Bool? }
            do {
                let _: OkResp = try await Api.request("/im/messages/\(id)/pin", method: "POST", body: ["pin": pin])
                await loadPins()
                toastMsg = pin ? t("chat.pinned") : t("chat.unpinned")
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    /// 播完灰飞烟灭再从列表移掉；不在屏幕上的（LazyVStack 没渲染）2 秒后兜底移除
    private func removeMsgs(_ ids: Set<String>) {
        var todo = ids.subtracting(dying)
        guard !todo.isEmpty else { return }
        // 相册只删其中几张：不播动画，直接移掉，剩下的重新拼版
        for row in rows where row.isAlbum {
            let rowIds = Set(row.items.map(\.id))
            let hit = rowIds.intersection(todo)
            if !hit.isEmpty && hit.count < rowIds.count {
                messages.removeAll { hit.contains($0.id) }
                todo.subtract(hit)
            }
        }
        guard !todo.isEmpty else { return }
        dying.formUnion(todo)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            messages.removeAll { todo.contains($0.id) }
            dying.subtract(todo)
        }
    }

    private func msgGone(_ id: String) {
        messages.removeAll { $0.id == id }
        dying.remove(id)
    }

    private func doDelete(_ ids: [String], forAll: Bool) {
        deleteIds = nil
        Task { @MainActor in
            struct DelResp: Codable { var deleted: Int? }
            do {
                let _: DelResp = try await Api.request("/im/messages/delete", method: "POST", body: [
                    "conversationId": convId, "ids": ids, "forAll": forAll,
                ])
                removeMsgs(Set(ids))
                if let r = replyTo, ids.contains(r.id) { replyTo = nil }
                selecting = nil
                if pins.contains(where: { ids.contains($0.id) }) { await loadPins() }
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    /// 跳到某条消息（回复引用 / 置顶条）；不在当前列表就按 aroundId 重新拉一段
    private func jumpTo(_ id: String) {
        if messages.contains(where: { $0.id == id }) { jumpReq = id; return }
        Task { @MainActor in
            let list: [MsgItem] = (try? await Api.request("/im/messages?conversationId=\(convId)&aroundId=\(id)")) ?? []
            guard list.contains(where: { $0.id == id }) else { toastMsg = t("chat.originalGone"); return }
            messages = list
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { jumpReq = id }
        }
    }

    private func finishRecording() {
        guard let (data, dur) = recorderBox.stop() else { return }
        Task {
            if let url = try? await Api.upload("audio", data: data, filename: "a.m4a", mime: "audio/m4a") {
                let content = "{\"url\":\"\(url)\",\"duration\":\(dur)}"
                sendMsg("audio", content)
            }
        }
    }

    private func sendLocation() {
        toastMsg = t("chat.locating")
        CityLocator.shared.currentLocation { loc, addr in
            DispatchQueue.main.async {
                // 没拿到位置就提示，不发 0,0
                guard let loc else { toastMsg = t("msg.locFailed"); return }
                let name = (addr?.isEmpty == false) ? addr! : t("chat.myLocation")
                let dict: [String: Any] = ["name": name, "lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude]
                if let d = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: d, encoding: .utf8) {
                    sendMsg("location", s)
                }
            }
        }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

/// 微信式消息气泡
/// 语音气泡声条：播放时三根声条循环跳动，静止时固定高度
struct VoiceBars: View {
    let playing: Bool
    let color: Color
    /// 由定时任务翻转驱动动画（不用 repeatForever，保证停止即刻生效）
    @State private var up = false

    private static let baseHeights: [CGFloat] = [6, 11, 15]
    private static let altHeights: [CGFloat] = [15, 6, 10]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                Capsule()
                    .fill(color)
                    .frame(width: 3, height: (playing && up) ? Self.altHeights[i] : Self.baseHeights[i])
                    .animation(.easeInOut(duration: 0.3), value: up)
                    .animation(.easeOut(duration: 0.15), value: playing)
            }
        }
        .frame(width: 16, height: 16)
        .task(id: playing) {
            guard playing else { up = false; return }
            while !Task.isCancelled {
                up.toggle()
                try? await Task.sleep(nanoseconds: 320_000_000)
            }
        }
    }
}

struct MsgBubble: View {
    let m: MsgItem
    let mine: Bool
    let convType: Int
    /// 消息本身头像缺失时的兜底
    var fallbackAvatar: String = ""
    var myId: String = ""
    var onMenu: (() -> Void)? = nil
    var onReact: ((String) -> Void)? = nil
    var onJump: ((String) -> Void)? = nil
    /// 打开链上钱包某一页（没有钱包入口为 nil：喊单卡片去网页看）
    var onOpenWallet: ((String) -> Void)? = nil
    var onImage: (String) -> Void
    /// 多图相册（第一张就是 m）
    var album: [MsgItem]? = nil
    /// 本地刚选的图：上传状态、预览图（按 upKey）
    var uploads: [String: UploadState] = [:]
    var localImages: [String: UIImage] = [:]
    /// 相册里长按 / 回应的是哪一张
    var onItemMenu: ((MsgItem) -> Void)? = nil
    var onItemReact: ((MsgItem, String) -> Void)? = nil
    var onRetry: ((MsgItem) -> Void)? = nil

    @State private var voicePlaying = false
    @State private var voiceStopTask: Task<Void, Never>?

    private var bg: Color { mine ? Theme.bubbleMine : Theme.bg3 }
    /// 浅色主题：自己的气泡是浅玫红底，文字同样用深色
    private var fg: Color { Theme.text }

    private var avatarUrl: String {
        (m.senderAvatar?.isEmpty == false) ? m.senderAvatar! : fallbackAvatar
    }

    /// 收款消息的「转账」：打开钱包转账页（没有钱包入口为 nil）
    private var payreqAction: (() -> Void)? {
        guard let open = onOpenWallet, let path = ChainCards.payreqPath(m.content, msgId: m.id, name: m.senderNickname ?? "") else { return nil }
        return { open(path) }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 50) }
            if !mine { AvatarView(url: avatarUrl, size: 38) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if !mine {
                    HStack(spacing: 4) {
                        Text(m.senderNickname ?? "").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                        if m.senderIsBot == true && convType == 2 { BotTag() }
                    }
                    .padding(.leading, 4)
                }
                if let f = m.fwdFrom, !f.isEmpty {
                    Text(t("chat.forwardedFrom", ["name": f])).font(.system(size: 11)).foregroundStyle(botBlue).padding(.horizontal, 4)
                }
                if let r = m.replyTo {
                    ReplyQuote(r: r) { onJump?(r.id) }
                }
                if let album {
                    albumView(album)
                    albumReactionChips(album)
                } else {
                    content
                        .simultaneousGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in
                            if !m.pending { onMenu?() }
                        })
                    if let rs = m.reactions, !rs.isEmpty {
                        ReactionChips(reactions: rs, myId: myId) { onReact?($0) }
                    }
                }
                if uploadFailed {
                    Text(t("chat.upload.failed")).font(.system(size: 11)).foregroundStyle(Color.red).padding(.horizontal, 4)
                }
                if !(m.markup?.inlineKeyboard ?? []).isEmpty {
                    InlineKeyboardView(markup: m.markup, messageId: m.id).frame(width: 230)
                }
            }
            .frame(maxWidth: 240, alignment: mine ? .trailing : .leading)
            if mine { AvatarView(url: avatarUrl, size: 38) }
            if !mine { Spacer(minLength: 50) }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var bubbleShape: CompatUnevenRounded {
        mine
            ? CompatUnevenRounded(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
            : CompatUnevenRounded(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16)
    }

    // MARK: 图片 / 相册

    private func uploadOf(_ item: MsgItem) -> UploadState? {
        guard let k = item.upKey else { return nil }
        return uploads[k]
    }

    private func localOf(_ item: MsgItem) -> UIImage? {
        guard let k = item.upKey else { return nil }
        return localImages[k]
    }

    private var uploadFailed: Bool {
        let list = album ?? [m]
        return list.contains { uploadOf($0)?.failed == true }
    }

    /// 单张图：有宽高按比例显示（最宽 200、最高 260），没有就 160 见方
    private var singleImage: some View {
        let meta = parseImage(m.content)
        let size = singleImageSize(w: meta.w, h: meta.h, maxW: 200, maxH: 260) ?? CGSize(width: 160, height: 160)
        let up = uploadOf(m)
        return ChatImageView(url: meta.url, local: localOf(m))
            .frame(width: size.width, height: size.height)
            .clipped()
            .overlay(UploadOverlay(state: up, sending: m.pending, onRetry: { onRetry?(m) }))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .onTapGesture { if up == nil { onImage(meta.url) } }
    }

    private func albumView(_ list: [MsgItem]) -> some View {
        let cells: [AlbumCell] = list.map { a in
            let meta = parseImage(a.content)
            return AlbumCell(id: a.upKey ?? a.id, url: meta.url, local: localOf(a), w: meta.w, h: meta.h, state: uploadOf(a), sending: a.pending)
        }
        return ImageAlbumView(
            cells: cells, width: 240,
            onTap: { i in
                if uploadOf(list[i]) == nil { onImage(imageUrlOf(list[i].content)) }
            },
            onLongPress: { i in onItemMenu?(list[i]) },
            onRetry: { i in onRetry?(list[i]) }
        )
    }

    /// 相册几张图的回应合在一起显示
    private func mergedReactions(_ list: [MsgItem]) -> [MsgReaction] {
        var order: [String] = []
        var map: [String: MsgReaction] = [:]
        for item in list {
            for r in item.reactions ?? [] {
                if var cur = map[r.emoji] {
                    cur.count += r.count
                    cur.userIds += r.userIds
                    map[r.emoji] = cur
                } else {
                    map[r.emoji] = r
                    order.append(r.emoji)
                }
            }
        }
        return order.compactMap { map[$0] }
    }

    /// 点合并后的回应：自己回应过这个表情的那张就取消那张的，否则回应第一张
    private func reactTarget(_ list: [MsgItem], _ emoji: String) -> MsgItem {
        let hit = list.first { item in
            (item.reactions ?? []).contains { $0.emoji == emoji && $0.userIds.contains(myId) }
        }
        return hit ?? list[0]
    }

    @ViewBuilder
    private func albumReactionChips(_ list: [MsgItem]) -> some View {
        if !mergedReactions(list).isEmpty {
            ReactionChips(reactions: mergedReactions(list), myId: myId) { e in onItemReact?(reactTarget(list, e), e) }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch m.type {
        case "image":
            singleImage
        case "sticker":
            // 贴纸不画气泡底
            if let p = StickerPayload.parse(m.content) {
                // GIF 比贴纸大一号、带圆角
                StickerImageView(p: p, size: p.isGif ? 220 : 140)
            } else {
                Text(t("chat.preview.sticker")).font(.system(size: 15)).foregroundStyle(fg)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(bubbleShape.fill(bg))
            }
        case "audio":
            let obj = parseJson(m.content)
            let url = obj["url"] as? String ?? m.content
            let dur = (obj["duration"] as? Int) ?? Int(obj["duration"] as? String ?? "1") ?? 1
            Button {
                voiceStopTask?.cancel()
                voicePlaying = true
                // 播放真正结束时停止动画（切换到别的语音时也会回调）
                AudioPlayerBox.shared.play(url) {
                    voiceStopTask?.cancel()
                    voicePlaying = false
                }
                // 兜底：加载失败等情况按时长 + 3 秒强制停止
                voiceStopTask = Task {
                    try? await Task.sleep(nanoseconds: UInt64(dur + 3) * 1_000_000_000)
                    if !Task.isCancelled { voicePlaying = false }
                }
            } label: {
                HStack(spacing: 8) {
                    VoiceBars(playing: voicePlaying, color: fg)
                    Text("\(dur)\"").font(.system(size: 14)).foregroundStyle(fg)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(minWidth: 70 + CGFloat(min(dur, 18)) * 8, alignment: .leading)
                .background(bubbleShape.fill(bg))
            }
            .buttonStyle(.plain)
        case "location":
            let obj = parseJson(m.content)
            HStack(spacing: 8) {
                Image(systemName: "mappin.and.ellipse").font(.system(size: 14)).foregroundStyle(fg)
                Text(obj["name"] as? String ?? t("chat.location")).font(.system(size: 14)).foregroundStyle(fg)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        case "gift":
            let obj = parseJson(m.content)
            let giftName = obj["name"] as? String ?? t("chat.giftDefault")
            let giftPrice = (obj["price"] as? String) ?? String((obj["price"] as? Int) ?? 0)
            let giftTitle = mine ? t("chat.gift.sent", ["name": giftName]) : t("chat.gift.received", ["name": giftName])
            HStack(spacing: 10) {
                RemoteImage(url: obj["icon"] as? String ?? "")
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text(giftTitle)
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(fg)
                    Text(t("chat.gift.points", ["n": fmtPoints(giftPrice)]))
                        .font(.system(size: 12)).foregroundStyle(Theme.warn)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        case "transfer":
            TransferCardView(content: m.content, mine: mine)
        case "callout":
            CalloutCardView(content: m.content, canWallet: onOpenWallet != nil) { onOpenWallet?($0) }
        case "perp":
            PerpCardView(msgId: m.id, content: m.content, canWallet: onOpenWallet != nil) {
                if let p = PerpLive.followPath(m.content, name: m.senderNickname ?? "") { onOpenWallet?(p) }
            }
        case "payreq":
            PayreqCardView(content: m.content, mine: mine, onPay: payreqAction)
        case "call":
            let obj = parseJson(m.content)
            let callType = (obj["callType"] as? Int) ?? 1
            let result = obj["result"] as? String ?? "end"
            let dur = (obj["duration"] as? Int) ?? 0
            HStack(spacing: 8) {
                Image(systemName: callType == 2 ? "video.fill" : "phone.fill")
                    .font(.system(size: 14)).foregroundStyle(fg)
                Text(callText(callType: callType, result: result, duration: dur))
                    .font(.system(size: 14)).foregroundStyle(fg)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        default:
            LinkText(text: m.content)
                .font(.system(size: 15)).foregroundStyle(fg)
                .lineSpacing(4)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(bubbleShape.fill(bg))
                .contentShape(Rectangle())
        }
    }

    private func parseJson(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:]
    }

    private func callText(callType: Int, result: String, duration: Int) -> String {
        let label = callType == 2 ? t("chat.call.video") : t("chat.call.voice")
        switch result {
        case "end": return "\(label) \(String(format: "%02d:%02d", duration / 60, duration % 60))"
        case "reject": return t("chat.call.rejected", ["label": label])
        default: return t("chat.call.canceled", ["label": label])
        }
    }
}

/// 礼物面板
struct GiftSheetView: View {
    let toUserId: String
    @Environment(\.dismiss) private var dismiss
    @State private var gifts: [GiftDef] = []
    @State private var balance = "0"
    @State private var selected: Int?
    @State private var errMsg = ""
    @State private var okMsg = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer().frame(width: 28)
                Text(t("chat.gift.title")).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity)
                Button { dismiss() } label: {
                    Text("×").font(.system(size: 18)).foregroundStyle(Theme.textSub)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)
            }
            .padding(16)

            ScrollView {
                let cols = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
                LazyVGrid(columns: cols, spacing: 8) {
                    ForEach(gifts) { g in
                        Button { selected = g.id } label: {
                            VStack(spacing: 4) {
                                RemoteImage(url: g.icon ?? "")
                                    .frame(width: 42, height: 42)
                                Text(g.name).font(.system(size: 12)).foregroundStyle(Theme.text)
                                Text(fmtPoints(g.price)).font(.system(size: 11)).foregroundStyle(Theme.warn)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 10).fill(selected == g.id ? Theme.accent.opacity(0.15) : .clear))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }

            if !errMsg.isEmpty {
                Text(errMsg).font(.system(size: 13)).foregroundStyle(Theme.danger).padding(.bottom, 6)
            }
            if !okMsg.isEmpty {
                Text(okMsg).font(.system(size: 13)).foregroundStyle(Theme.warn).padding(.bottom, 6)
            }
            HStack {
                Text(t("chat.gift.balance", ["n": fmtPoints(balance)])).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                Spacer()
                Button {
                    guard let gid = selected else { errMsg = t("chat.gift.pick"); return }
                    Task {
                        do {
                            struct Empty: Codable { var ok: Bool? }
                            let _: Empty = try await Api.request("/gifts/send", method: "POST", body: ["toUserId": toUserId, "giftId": gid])
                            // 送出后不关面板，刷新余额，可连续赠送
                            errMsg = ""
                            okMsg = t("chat.gift.sentOk")
                            if let w: WalletData = try? await Api.request("/wallet") { balance = w.balance ?? "0" }
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            okMsg = ""
                        } catch { okMsg = ""; errMsg = error.localizedDescription }
                    }
                } label: {
                    Text(t("chat.gift.send")).font(.system(size: 13)).foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Capsule().fill(Theme.accent))
                }
                .buttonStyle(.plain)
            }
            .padding(16)
        }
        .background(Theme.bg2)
        .task {
            gifts = (try? await Api.request("/gifts")) ?? []
            if let w: WalletData = try? await Api.request("/wallet") { balance = w.balance ?? "0" }
        }
    }
}

/// 图片查看器：左右翻页 + 双指缩放 + 关闭按钮；传了 onScanQr 时底部多一个「识别二维码」（认出来就关掉查看器，交给统一的扫码处理）
struct ImageViewerView: View {
    let images: [String]
    let initial: Int
    var onScanQr: ((String) -> Void)?
    var onClose: () -> Void
    @State private var page: Int
    @State private var scanning = false
    @State private var toastMsg: String?

    init(images: [String], initial: Int, onScanQr: ((String) -> Void)? = nil, onClose: @escaping () -> Void) {
        self.images = images
        self.initial = initial
        self.onScanQr = onScanQr
        self.onClose = onClose
        _page = State(initialValue: initial)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $page) {
                ForEach(Array(images.enumerated()), id: \.offset) { idx, url in
                    ZoomableImage(url: Api.fullUrl(url))
                        .tag(idx)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: images.count > 1 ? .automatic : .never))

            Button { onClose() } label: {
                Text("×").font(.system(size: 22)).foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(.white.opacity(0.15)))
            }
            .buttonStyle(.plain)
            .padding(16)
        }
        .overlay(alignment: .bottom) { scanButton }
        .toast($toastMsg)
    }

    @ViewBuilder private var scanButton: some View {
        if onScanQr != nil {
            Button { scanCurrent() } label: {
                Text(scanning ? t("chat.qrScanning") : t("chat.scanQr"))
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(Capsule().fill(.white.opacity(0.18)))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 48)
        }
    }

    private func scanCurrent() {
        guard !scanning, images.indices.contains(page), let url = URL(string: Api.fullUrl(images[page])) else { return }
        scanning = true
        Task { @MainActor in
            var text: String?
            if let pair = try? await URLSession.shared.data(from: url), let img = UIImage(data: pair.0) {
                text = detectQrCode(img)
            }
            scanning = false
            guard let code = text else {
                toastMsg = t("chat.noQrFound")
                return
            }
            onClose()
            onScanQr?(code)
        }
    }
}

/// 识别图片里的二维码（CIDetector，高精度）；没有返回 nil
func detectQrCode(_ image: UIImage) -> String? {
    guard let ci = CIImage(image: image) else { return nil }
    let options: [String: Any] = [CIDetectorAccuracy: CIDetectorAccuracyHigh]
    guard let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: options) else { return nil }
    for f in detector.features(in: ci) {
        if let q = f as? CIQRCodeFeature, let s = q.messageString, !s.isEmpty { return s }
    }
    return nil
}

/// 可缩放图片（双指缩放 + 双击还原/放大）
struct ZoomableImage: View {
    let url: String
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            AsyncImage(url: URL(string: url)) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                ProgressView().tint(.white)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { v in scale = max(1, lastScale * v) }
                    .onEnded { _ in lastScale = scale }
            )
            .simultaneousGesture(
                scale > 1
                    ? DragGesture()
                        .onChanged { v in
                            offset = CGSize(width: lastOffset.width + v.translation.width, height: lastOffset.height + v.translation.height)
                        }
                        .onEnded { _ in lastOffset = offset }
                    : nil
            )
            .onTapGesture(count: 2) {
                withAnimation {
                    if scale > 1 { scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero }
                    else { scale = 2.5; lastScale = 2.5 }
                }
            }
        }
    }
}

/// 创建群聊
struct CreateGroupView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var avatar = ""
    @State private var uploading = false
    @State private var people: [Person] = []
    @State private var selected: Set<String> = []
    @State private var created: ChatTarget?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    // 群头像（可选，不设置默认用群主头像）
                    CompatPhotoPicker(kind: .images, onPicked: { datas in
                        guard let data = datas.first else { return }
                        uploading = true
                        Task {
                            if let url = try? await Api.upload("image", data: data, filename: "g.jpg", mime: "image/jpeg") {
                                avatar = url
                            }
                            uploading = false
                        }
                    }) {
                        if avatar.isEmpty {
                            Circle().fill(Theme.bg3)
                                .frame(width: 56, height: 56)
                                .overlay(Text(uploading ? "…" : t("group.avatar")).font(.system(size: 11)).foregroundStyle(Theme.textDim))
                        } else {
                            AvatarView(url: avatar, size: 56)
                        }
                    }
                    TextField("", text: $name, prompt: Text(t("group.namePlaceholder")).foregroundColor(Theme.textDim))
                        .foregroundStyle(Theme.text)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                }
                Text(t("group.createHint")).font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .padding(16)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(people) { p in
                        Button {
                            if selected.contains(p.id) { selected.remove(p.id) } else { selected.insert(p.id) }
                        } label: {
                            HStack(spacing: 10) {
                                AvatarView(url: p.avatar, size: 36)
                                Text(p.nickname ?? "").foregroundStyle(Theme.text)
                                Spacer()
                                Text(selected.contains(p.id) ? t("group.selected") : t("common.select"))
                                    .font(.system(size: 13))
                                    .foregroundStyle(selected.contains(p.id) ? Theme.accent : Theme.textDim)
                            }
                            .padding(.horizontal, 16).padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            AccentButton(title: t("group.createWithN", ["n": selected.count]), enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                Task {
                    struct GroupCreated: Codable { var id: String = ""; var name: String? = ""; var conversationId: String = "" }
                    if let g: GroupCreated = try? await Api.request("/im/group", method: "POST", body: [
                        "name": name.trimmingCharacters(in: .whitespaces),
                        "memberIds": Array(selected),
                        "avatar": avatar,
                    ]) {
                        created = ChatTarget(convId: g.conversationId, convType: 2, targetId: g.id, title: t("chat.groupTitle", ["name": g.name ?? ""]))
                    }
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("group.create"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .fullScreenCover(item: $created, onDismiss: { dismiss() }) { t in
            ChatRoomSheet(target: t)
        }
        .task {
            people = (try? await Api.request("/guide/discover")) ?? []
        }
    }
}

/// AI 助手：免费问答，历史存服务端（GET /ai/messages POST /ai/chat POST /ai/clear）
struct AiChatView: View {
    struct AiMsg: Codable, Identifiable {
        var id: String = "0"
        var role: String = "user"
        var content: String = ""
        var createdAt: String? = ""
    }

    @EnvironmentObject var state: AppState
    @State private var messages: [AiMsg] = []
    @State private var input = ""
    @State private var thinking = false
    @State private var toastMsg: String?
    @State private var htmlPreview: HtmlPreview?
    @FocusState private var inputFocused: Bool

    struct HtmlPreview: Identifiable {
        let id = UUID()
        let html: String
    }

    /// 把回复拆成 文字说明 + HTML 文档（AI 写攻略/页面时输出 ```html 代码块）
    private static func extractHtml(_ content: String) -> (text: String, html: String?) {
        if let r = content.range(of: "```html\\s*([\\s\\S]*?)```", options: [.regularExpression, .caseInsensitive]) {
            let block = String(content[r])
            let html = block
                .replacingOccurrences(of: "```html", with: "", options: .caseInsensitive)
                .replacingOccurrences(of: "```", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (content.replacingCharacters(in: r, with: "").trimmingCharacters(in: .whitespacesAndNewlines), html)
        }
        if let r = content.range(of: "<!DOCTYPE html[\\s\\S]*</html\\s*>|<html[\\s\\S]*</html\\s*>", options: [.regularExpression, .caseInsensitive]) {
            let html = String(content[r])
            return (content.replacingCharacters(in: r, with: "").trimmingCharacters(in: .whitespacesAndNewlines), html)
        }
        return (content, nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            if messages.isEmpty && !thinking {
                EmptyHint(text: t("ai.empty"))
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(messages) { m in
                                aiBubble(m.content, mine: m.role == "user")
                                    .id(m.id)
                            }
                            if thinking {
                                aiBubble(t("ai.thinking"), mine: false, dim: true)
                                    .id("thinking")
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                    }
                    .onTapGesture { inputFocused = false }
                    // 进入默认停在最底部；defaultScrollAnchor 是 iOS 17 API，改用 scrollTo
                    .onAppear {
                        if let last = messages.last {
                            DispatchQueue.main.async { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                    .onChange(of: messages.count) { _ in
                        if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                    .onChange(of: thinking) { v in
                        if v { proxy.scrollTo("thinking", anchor: .bottom) }
                    }
                }
            }

            // 底部输入区（对齐聊天页：圆角输入框 + 有文字才显示发送键）
            HStack(alignment: .bottom, spacing: 8) {
                Group {
                    if #available(iOS 16.0, *) {
                        TextField("", text: $input, prompt: Text(t("ai.inputHint")).foregroundColor(Theme.textDim), axis: .vertical)
                            .lineLimit(1 ... 4)
                            .focused($inputFocused)
                    } else {
                        TextField("", text: $input, prompt: Text(t("ai.inputHint")).foregroundColor(Theme.textDim))
                            .focused($inputFocused)
                    }
                }
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                if !input.trimmingCharacters(in: .whitespaces).isEmpty && !thinking {
                    Button { send() } label: {
                        Text(t("common.send")).font(.system(size: 14)).foregroundStyle(.white)
                            .padding(.horizontal, 16).frame(height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
            .background(Theme.bg2)
        }
        .fullBg()
        .toast($toastMsg)
        .navigationTitle(t("ai.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task {
                        struct OkResp: Codable { var ok: Bool? }
                        let _: OkResp? = try? await Api.request("/ai/clear", method: "POST")
                        messages = []
                    }
                } label: {
                    Text(t("chat.clear")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                }
            }
        }
        .task {
            messages = (try? await Api.request("/ai/messages")) ?? []
        }
        .fullScreenCover(item: $htmlPreview) { p in
            WebPreviewSheet(html: p.html)
        }
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !thinking else { return }
        input = ""
        messages.append(AiMsg(id: "local_\(Int(Date().timeIntervalSince1970 * 1000))", role: "user", content: text))
        thinking = true
        Task {
            do {
                let reply: AiMsg = try await Api.request("/ai/chat", method: "POST", body: ["content": text])
                messages.append(reply)
            } catch {
                toastMsg = error.localizedDescription
            }
            thinking = false
        }
    }

    private func aiBubble(_ content: String, mine: Bool, dim: Bool = false) -> some View {
        let parts = mine ? (text: content, html: String?.none) : Self.extractHtml(content)
        return HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 50) }
            if !mine {
                Circle().fill(Theme.accentGrad)
                    .frame(width: 38, height: 38)
                    .overlay(Text("AI").font(.system(size: 12, weight: .heavy)).foregroundStyle(.white))
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                if !parts.text.isEmpty {
                    Text(parts.text)
                        .font(.system(size: 15))
                        .foregroundStyle(dim ? Theme.textSub : Theme.text)
                        .lineSpacing(4)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(
                            (mine
                                ? CompatUnevenRounded(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
                                : CompatUnevenRounded(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16))
                                .fill(mine ? Theme.bubbleMine : Theme.bg3),
                        )
                }
                if let html = parts.html {
                    Button { htmlPreview = HtmlPreview(html: html) } label: {
                        HStack(spacing: 10) {
                            Text("🌐").font(.system(size: 22))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t("ai.webContent")).font(.system(size: 14)).foregroundStyle(Theme.text)
                                Text(t("ai.openPreview")).font(.system(size: 11)).foregroundStyle(Theme.accent)
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(
                            CompatUnevenRounded(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16)
                                .fill(Theme.bg3),
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            if mine { AvatarView(url: state.user?.avatar, size: 38) }
            if !mine { Spacer(minLength: 50) }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

/// 内部网页全屏预览（共用：AI 生成的 HTML 或新闻原文 url）
struct WebPreviewSheet: View {
    var html: String? = nil
    var url: URL? = nil
    var title: String? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title ?? t("web.preview")).font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                if let url, html == nil {
                    Menu {
                        Button(t("web.openInBrowser")) { UIApplication.shared.open(url) }
                        Button(t("web.copyLink")) { UIPasteboard.general.string = url.absoluteString }
                    } label: {
                        Image(systemName: "ellipsis.circle").font(.system(size: 17)).foregroundStyle(Theme.textSub)
                    }
                    .padding(.trailing, 10)
                }
                Button(t("common.close")) { dismiss() }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.bg)
            WebContentView(html: html, url: url)
        }
        .background(Theme.bg)
    }
}

/// WKWebView 包装：渲染 HTML 字符串或加载 url
struct WebContentView: UIViewRepresentable {
    var html: String? = nil
    var url: URL? = nil

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        if let html { web.loadHTMLString(html, baseURL: nil) }
        else if let url { web.load(URLRequest(url: url)) }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// 群信息
struct GroupInfoView: View {
    let groupId: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    struct GroupMemberItem: Codable, Identifiable {
        var id: String = ""
        var nickname: String? = ""
        var avatar: String? = ""
        var role: String? = "member"
        var isBot: Bool? = false
    }
    struct GroupInfoData: Codable {
        var id: String = ""
        var name: String? = ""
        var avatar: String? = ""
        var notice: String? = ""
        var members: [GroupMemberItem]? = []
    }

    @State private var info: GroupInfoData?
    @State private var showShare = false
    @State private var showBots = false

    var body: some View {
        VStack(spacing: 0) {
            if let g = info {
                let myRoleForEdit = g.members?.first { $0.id == state.user?.id }?.role ?? "member"
                let canEdit = myRoleForEdit == "owner" || myRoleForEdit == "admin"
                // 群头像（群主/管理员点击可换）+ 人数
                HStack(spacing: 12) {
                    if canEdit {
                        CompatPhotoPicker(kind: .images, onPicked: { datas in
                            guard let data = datas.first else { return }
                            Task {
                                struct Empty: Codable { var id: String? }
                                if let url = try? await Api.upload("image", data: data, filename: "g.jpg", mime: "image/jpeg") {
                                    let _: Empty? = try? await Api.request("/im/group/\(groupId)", method: "PUT", body: ["avatar": url])
                                    info = try? await Api.request("/im/group/\(groupId)")
                                }
                            }
                        }) {
                            AvatarView(url: g.avatar, size: 56)
                        }
                    } else {
                        AvatarView(url: g.avatar, size: 56)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(t("group.memberCount", ["n": g.members?.count ?? 0]))
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        if canEdit {
                            Text(t("group.tapAvatarToEdit")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        }
                    }
                    Spacer()
                    if canEdit {
                        Button { showBots = true } label: {
                            Text(t("chat.bot")).font(.system(size: 13)).foregroundStyle(botBlue)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(Capsule().fill(Theme.bg3))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
                ScrollView {
                    let cols = Array(repeating: GridItem(.flexible(), spacing: 12), count: 5)
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(g.members ?? []) { m in
                            VStack(spacing: 4) {
                                AvatarView(url: m.avatar, size: 48)
                                Text((m.nickname ?? "") + (m.role == "owner" ? " " + t("group.ownerBadge") : ""))
                                    .font(.system(size: 11)).foregroundStyle(m.isBot == true ? botBlue : Theme.textSub).lineLimit(1)
                                if m.isBot == true { Text(t("chat.bot")).font(.system(size: 9)).foregroundStyle(botBlue) }
                            }
                        }
                    }
                    .padding(16)
                }
                let myRole = g.members?.first { $0.id == state.user?.id }?.role ?? "member"
                AccentButton(title: myRole == "owner" ? t("group.dissolve") : t("group.leave")) {
                    Task {
                        struct Empty: Codable { var ok: Bool? }
                        let _: Empty? = try? await Api.request("/im/group/\(groupId)/\(myRole == "owner" ? "dissolve" : "leave")", method: "POST")
                        dismiss()
                    }
                }
                .padding(16)
            } else {
                EmptyHint(text: t("common.loading"))
            }
        }
        .fullBg()
        .navigationTitle(info?.name ?? t("chat.menu.groupInfo"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(t("common.share")) { showShare = true }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
        }
        .sheet(isPresented: $showShare) {
            GroupShareSheet(groupId: groupId)
        }
        .sheet(isPresented: $showBots) {
            AddBotSheet(groupId: groupId) {
                Task { info = try? await Api.request("/im/group/\(groupId)") }
            }
        }
        .task {
            info = try? await Api.request("/im/group/\(groupId)")
        }
    }
}

/// 群分享面板：二维码 + 邀请码 + 密码设置（群主/管理员）；频道不设密码
struct GroupShareSheet: View {
    let groupId: String
    var channel = false
    @Environment(\.dismiss) private var dismiss

    struct ShareInfo: Codable {
        var code: String = ""
        var hasPassword: Bool = false
        var password: String? = nil
        var canEdit: Bool = false
        var name: String? = ""
    }

    @State private var share: ShareInfo?
    @State private var mode = "none" // none=无密码 pwd=有密码
    @State private var pwd = ""
    @State private var saving = false
    @State private var toastMsg: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let s = share {
                    Text(channel ? t("group.shareChannel") : t("group.invite")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(channel ? t("group.shareChannelHint") : (s.hasPassword ? t("group.invitePwdHint") : t("group.inviteHint")))
                        .font(.system(size: 12)).foregroundStyle(Theme.textSub)

                    if let img = makeQRImage(groupQrContent(code: s.code), size: 640) {
                        Image(uiImage: img)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: 200, height: 200)
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 12).fill(.white))
                    }

                    Button {
                        UIPasteboard.general.string = s.code
                        toastMsg = t("group.codeCopied")
                    } label: {
                        HStack(spacing: 6) {
                            Text(s.code).font(.system(size: 18, weight: .bold)).tracking(3).foregroundStyle(Theme.text)
                            Text(t("common.copy")).font(.system(size: 12)).foregroundStyle(Theme.accent)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg3))
                    }
                    .buttonStyle(.plain)

                    if s.canEdit && !channel {
                        // 模式切换 + 行内小保存按钮
                        HStack(spacing: 8) {
                            ForEach([("none", t("group.noPassword")), ("pwd", t("group.withPassword"))], id: \.0) { k, label in
                                Button {
                                    mode = k
                                } label: {
                                    Text(label)
                                        .font(.system(size: 12))
                                        .foregroundStyle(mode == k ? .white : Theme.textSub)
                                        .padding(.horizontal, 14).padding(.vertical, 5)
                                        .background(Capsule().fill(mode == k ? Theme.accent : Theme.bg3))
                                }
                                .buttonStyle(.plain)
                            }
                            Spacer()
                            Button {
                                guard !saving else { return }
                                if mode == "pwd", pwd.trimmingCharacters(in: .whitespaces).isEmpty {
                                    toastMsg = t("group.enterPassword")
                                    return
                                }
                                saving = true
                                Task {
                                    let s2: ShareInfo? = try? await Api.request(
                                        "/im/group/\(groupId)/share", method: "POST",
                                        body: ["password": mode == "pwd" ? pwd.trimmingCharacters(in: .whitespaces) : ""]
                                    )
                                    if let s2 { share = s2; toastMsg = t("common.saved") } else { toastMsg = t("common.saveFailed") }
                                    saving = false
                                }
                            } label: {
                                Text(saving ? t("group.saving") : t("common.save"))
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 16).padding(.vertical, 5)
                                    .background(Capsule().fill(Theme.accent))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 24)
                        if mode == "pwd" {
                            TextField("", text: $pwd, prompt: Text(t("group.setPassword")).foregroundColor(Theme.textDim))
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.text)
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                                .padding(.horizontal, 24)
                                .onChange(of: pwd) { v in if v.count > 20 { pwd = String(v.prefix(20)) } }
                        }
                    }

                    Divider().overlay(Theme.bg3).padding(.horizontal, 24).padding(.top, 4)

                    HStack(spacing: 30) {
                        if let img = makeQRImage(groupQrContent(code: s.code), size: 640) {
                            Button {
                                ShareSheet.present([img])
                            } label: {
                                Text(t("group.shareQr")).font(.system(size: 13)).foregroundStyle(Theme.accent)
                            }
                            .buttonStyle(.plain)
                        }
                        Button(t("common.close")) { dismiss() }
                            .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Text(t("common.loading")).font(.system(size: 13)).foregroundStyle(Theme.textSub).padding(40)
                }
            }
            .padding(.vertical, 26)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .toast($toastMsg)
        .task {
            let s: ShareInfo? = try? await Api.request("/im/group/\(groupId)/share")
            share = s
            if let s { mode = s.hasPassword ? "pwd" : "none"; pwd = s.password ?? "" }
        }
    }
}

/// 加入群聊：群列表可直接加入，也可输邀请码/扫码；有密码的群需输入密码
struct JoinGroupView: View {
    var initialCode: String? = nil

    struct CodeInfo: Codable {
        var groupId: String = ""
        var name: String? = ""
        var memberCount: Int? = 0
        var hasPassword: Bool = false
        var isMember: Bool = false
        var conversationId: String? = nil
        /// 2 = 频道：直接进频道页订阅
        var kind: Int? = 1
    }

    struct GroupListItem: Codable, Identifiable {
        var id: String = ""
        var name: String? = ""
        var avatar: String? = ""
        var memberCount: Int? = 0
        var hasPassword: Bool = false
        var isMember: Bool = false
        var conversationId: String? = nil
    }

    @State private var code = ""
    @State private var info: CodeInfo?
    @State private var pwd = ""
    @State private var busy = false
    @State private var showScan = false
    @State private var opened: ChatTarget?
    @State private var toastMsg: String?
    @State private var groups: [GroupListItem] = []
    @State private var pwdTarget: GroupListItem?
    @State private var showPwdAlert = false
    @State private var pwdInput = ""
    @State private var channelRoute: Route?

    var body: some View {
        VStack(spacing: 14) {
            // 邀请码输入框（右侧内嵌扫码图标）
            HStack(spacing: 8) {
                TextField("", text: $code, prompt: Text(t("group.codePlaceholder")).foregroundColor(Theme.textDim))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .foregroundStyle(Theme.text)
                    .onChange(of: code) { v in
                        let up = v.uppercased()
                        code = String(up.prefix(12))
                        info = nil
                    }
                Button {
                    showScan = true
                } label: {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 19))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))

            if let g = info {
                VStack(spacing: 6) {
                    Text(g.name ?? "").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(memberLine(g.memberCount, g.hasPassword))
                        .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    if g.isMember {
                        Text(t("group.alreadyMember")).font(.system(size: 12)).foregroundStyle(Theme.success)
                    } else if g.hasPassword {
                        SecureField("", text: $pwd, prompt: Text(t("group.passwordPlaceholder")).foregroundColor(Theme.textDim))
                            .foregroundStyle(Theme.text)
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                            .padding(.top, 6)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                AccentButton(title: g.isMember ? t("group.enter") : (busy ? t("group.joining") : t("group.joinGroup"))) {
                    guard !busy else { return }
                    if g.isMember, let convId = g.conversationId {
                        opened = ChatTarget(convId: convId, convType: 2, targetId: g.groupId, title: t("chat.groupTitle", ["name": g.name ?? ""]))
                        return
                    }
                    if g.hasPassword, pwd.trimmingCharacters(in: .whitespaces).isEmpty {
                        toastMsg = t("group.enterGroupPassword")
                        return
                    }
                    busy = true
                    Task {
                        struct Joined: Codable { var id: String = ""; var name: String? = ""; var conversationId: String? = nil }
                        do {
                            let j: Joined = try await Api.request("/im/group/join-by-code", method: "POST", body: [
                                "code": code.trimmingCharacters(in: .whitespaces),
                                "password": pwd.trimmingCharacters(in: .whitespaces),
                            ])
                            if let convId = j.conversationId {
                                opened = ChatTarget(convId: convId, convType: 2, targetId: j.id, title: t("chat.groupTitle", ["name": j.name ?? ""]))
                            }
                        } catch {
                            toastMsg = (error as? ApiError)?.msg ?? t("group.joinFailed")
                        }
                        busy = false
                    }
                }
            } else if !code.isEmpty {
                AccentButton(title: busy ? t("group.searching") : t("group.find")) {
                    guard !busy else { return }
                    let c = code.trimmingCharacters(in: .whitespaces)
                    if c.count < 6 { toastMsg = t("group.codeIncomplete"); return }
                    Task { await check(c) }
                }
            }

            // 群列表：直接浏览加入
            Text(t("group.list"))
                .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if groups.isEmpty {
                        Text(t("group.empty")).font(.system(size: 13)).foregroundStyle(Theme.textDim).padding(.top, 20)
                    }
                    ForEach(groups) { g in
                        HStack(spacing: 12) {
                            AvatarView(url: g.avatar, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.name ?? "").font(.system(size: 15)).foregroundStyle(Theme.text).lineLimit(1)
                                Text(memberLine(g.memberCount, g.hasPassword))
                                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                            }
                            Spacer()
                            Button {
                                if g.isMember, let convId = g.conversationId {
                                    opened = ChatTarget(convId: convId, convType: 2, targetId: g.id, title: t("chat.groupTitle", ["name": g.name ?? ""]))
                                } else if g.hasPassword {
                                    pwdInput = ""
                                    pwdTarget = g
                                    showPwdAlert = true
                                } else {
                                    Task { await joinById(g, password: "") }
                                }
                            } label: {
                                Text(g.isMember ? t("group.open") : t("group.join"))
                                    .font(.system(size: 12))
                                    .foregroundStyle(g.isMember ? Theme.textSub : .white)
                                    .padding(.horizontal, 16).padding(.vertical, 6)
                                    .background(Capsule().fill(g.isMember ? Theme.bg3 : Theme.accent))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 9)
                        Divider().overlay(Theme.bg3.opacity(0.5))
                    }
                }
            }
        }
        .padding(16)
        .fullBg()
        .navigationTitle(t("group.joinGroup"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
        .alert(pwdTarget?.name ?? t("group.pwdAlertTitle"), isPresented: $showPwdAlert) {
            TextField(t("group.passwordPlaceholder"), text: $pwdInput)
            Button(t("common.cancel"), role: .cancel) {}
            Button(t("group.join")) {
                if let g = pwdTarget {
                    Task { await joinById(g, password: pwdInput) }
                }
            }
        } message: {
            Text(t("group.pwdAlertMsg"))
        }
        .task {
            if let c = initialCode, !c.isEmpty {
                code = c
                await check(c)
            }
            groups = (try? await Api.request("/im/group/list")) ?? []
        }
        .fullScreenCover(isPresented: $showScan) {
            QrScanView { text in
                if let c = parseGroupCode(text) {
                    code = c
                    Task { await check(c) }
                } else {
                    toastMsg = t("group.badQr")
                }
            }
        }
        .fullScreenCover(item: $opened) { t in
            ChatRoomSheet(target: t)
        }
        .routePush($channelRoute)
    }

    private func check(_ c: String) async {
        guard !busy else { return }
        busy = true
        do {
            let g: CodeInfo = try await Api.request("/im/group/code/\(c)")
            if g.kind == 2 {
                channelRoute = .channel(g.groupId)
            } else {
                info = g
                pwd = ""
            }
        } catch {
            toastMsg = (error as? ApiError)?.msg ?? t("group.invalidCode")
        }
        busy = false
    }

    private func memberLine(_ count: Int?, _ hasPassword: Bool) -> String {
        let base = t("group.memberCount", ["n": count ?? 0])
        return hasPassword ? base + " · " + t("group.passwordRequired") : base
    }

    /** 按群 id 加入（群列表入口），密码可空 */
    private func joinById(_ g: GroupListItem, password: String) async {
        guard !busy else { return }
        busy = true
        struct Joined: Codable { var id: String = ""; var name: String? = ""; var conversationId: String? = nil }
        do {
            let j: Joined = try await Api.request("/im/group/\(g.id)/join", method: "POST", body: [
                "password": password.trimmingCharacters(in: .whitespaces),
            ])
            if let convId = j.conversationId {
                opened = ChatTarget(convId: convId, convType: 2, targetId: j.id, title: t("chat.groupTitle", ["name": j.name ?? ""]))
            }
        } catch {
            toastMsg = (error as? ApiError)?.msg ?? t("group.joinFailed")
        }
        busy = false
    }
}
