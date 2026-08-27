import SwiftUI
import PhotosUI
import AVFoundation
import Combine
import WebKit

struct PeerBrief: Codable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
}

struct GroupBrief: Codable, Hashable {
    var id: String = ""
    var name: String? = ""
    var avatar: String? = ""
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
}

private func preview(_ msg: LastMsg?) -> String {
    guard let msg, let type = msg.type else { return "" }
    switch type {
    case "text": return String((msg.content ?? "").prefix(30))
    case "image": return "[图片]"
    case "video": return "[视频]"
    case "audio": return "[语音]"
    case "location": return "[位置]"
    case "gift": return "[礼物]"
    default: return type.hasPrefix("call") ? "[通话]" : ""
    }
}

/// 消息主页：私聊 / 群聊 / 评论 / 接单
struct MessagesView: View {
    @State private var tab = "single"
    @State private var convs: [ConversationItem] = []
    @State private var notices: [NotificationItem] = []
    @State private var unread = UnreadCounts()
    @State private var chatTarget: ChatTarget?
    @State private var removeListener: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                if tab == "single" || tab == "group" {
                    // AI 助手 + 花边新闻置顶入口
                    if tab == "single" { aiEntryRow; newsEntryRow }
                    let shown = convs.filter { tab == "single" ? $0.type == 1 : $0.type == 2 }
                    if shown.isEmpty {
                        EmptyHint(text: tab == "single" ? "暂无私聊\n去广场或大厅找人打招呼" : "暂无群聊\n点右上角发起群聊")
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) { ForEach(shown) { convRow($0) } }
                        }
                    }
                } else {
                    if notices.isEmpty {
                        EmptyHint(text: tab == "comment" ? "暂无评论消息" : "暂无接单消息")
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) { ForEach(notices) { noticeRow($0) } }
                        }
                    }
                }
            }
            .fullBg()
            .withRoutes()
        }
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .task {
            await loadConvs(); await loadUnread()
            WsClient.shared.connect()
            removeListener = WsClient.shared.addListener { frame in
                let op = frame["op"] as? String
                if op == "msg" || op == "conv_cleared" { Task { await loadConvs() } }
                if op == "notify" { Task { await loadUnread() } }
            }
        }
        .onDisappear { removeListener?() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            let singleUnread = convs.filter { $0.type == 1 }.reduce(0) { $0 + ($1.unread ?? 0) }
            let groupUnread = convs.filter { $0.type == 2 }.reduce(0) { $0 + ($1.unread ?? 0) }
            pillTab("私聊", "single", singleUnread)
            pillTab("群聊", "group", groupUnread)
            pillTab("评论", "comment", unread.comment ?? 0)
            pillTab("接单", "task", unread.task ?? 0)
            Spacer()
            Menu {
                NavigationLink(value: Route.createGroup) { Label("创建群聊", systemImage: "person.2.badge.plus") }
                NavigationLink(value: Route.joinGroup(nil)) { Label("加入群聊", systemImage: "qrcode.viewfinder") }
            } label: {
                Text("+").font(.system(size: 18)).foregroundStyle(Theme.text)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Theme.bg3))
            }
            .buttonStyle(.plain)
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 12, trailing: 16))
    }

    private func pillTab(_ label: String, _ key: String, _ badge: Int) -> some View {
        Button {
            tab = key
            if key == "comment" || key == "task" { Task { await loadNotices(key) } }
        } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 15, weight: tab == key ? .semibold : .regular))
                    .foregroundStyle(tab == key ? .white : Theme.textSub)
                if badge > 0 {
                    Text("\(badge)").font(.system(size: 11)).foregroundStyle(tab == key ? Theme.accent : .white)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(tab == key ? .white : Theme.accent))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Capsule().fill(tab == key ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Theme.bg3)))
        }
        .buttonStyle(.plain)
    }

    private var aiEntryRow: some View {
        NavigationLink(value: Route.aiChat) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Circle().fill(Theme.accentGrad)
                        .frame(width: 48, height: 48)
                        .overlay(Text("AI").font(.system(size: 15, weight: .heavy)).foregroundStyle(.white))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AI 助手").font(.system(size: 15)).foregroundStyle(Theme.text)
                        Text("有问必答，随便问").font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                    Spacer()
                    Text("免费").font(.system(size: 10)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.accent.opacity(0.12)))
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 76)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 花边新闻置顶入口（每小时更新）
    private var newsEntryRow: some View {
        NavigationLink(value: Route.newsList) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Circle()
                        .fill(LinearGradient(colors: [Color(red: 1, green: 0.58, blue: 0), Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 48, height: 48)
                        .overlay(Text("📰").font(.system(size: 22)))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("花边新闻").font(.system(size: 15)).foregroundStyle(Theme.text)
                        Text("逆袭·励志·情感，看看别人的故事").font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                    Spacer()
                    Text("每小时更新").font(.system(size: 10)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.accent.opacity(0.12)))
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 76)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func convRow(_ c: ConversationItem) -> some View {
        let title = c.type == 1 ? (c.peer?.nickname ?? "") : "\(c.group?.name ?? "")（群）"
        let avatar = c.type == 1 ? c.peer?.avatar : c.group?.avatar
        let target = c.type == 1 ? (c.peer?.id ?? "") : (c.group?.id ?? "")
        return Button {
            chatTarget = ChatTarget(convId: c.id, convType: c.type, targetId: target, title: title)
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    AvatarView(url: avatar, size: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.system(size: 15)).foregroundStyle(Theme.text)
                        Text(preview(c.lastMsg)).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(fmtTime(c.lastMsgAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        if (c.unread ?? 0) > 0 {
                            Text("\(c.unread ?? 0)").font(.system(size: 10)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(Theme.accent))
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                // 微信式分隔线（与头像右侧对齐）
                Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 76)
            }
            // 让整行（含空白区域）都可点击
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func noticeRow(_ n: NotificationItem) -> some View {
        NavigationLink(value: tab == "comment" ? Route.moment(n.refId ?? "0") : Route.task(n.refId ?? "0")) {
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

    private func loadConvs() async { convs = (try? await Api.request("/im/conversations")) ?? convs }
    private func loadUnread() async { unread = (try? await Api.request("/notifications/unread")) ?? unread }
    private func loadNotices(_ kind: String) async {
        notices = (try? await Api.request("/notifications?kind=\(kind)")) ?? []
        await loadUnread()
    }
}

/// 聊天全屏容器（fullScreenCover 用，带关闭按钮）
struct ChatRoomSheet: View {
    let target: ChatTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ChatRoomView(convId: target.convId, convType: target.convType, targetId: target.targetId, title: target.title)
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
private struct RecordingOverlay: View {
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
                .foregroundStyle(.white)
                .monospacedDigit()

            Text("松开发送")
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

    @EnvironmentObject var state: AppState
    @State private var messages: [MsgItem] = []
    @State private var input = ""
    @State private var voiceMode = false
    @State private var recording = false
    @State private var showPanel = false
    @State private var showGift = false
    @State private var fullImage: String?
    @State private var imageItem: PhotosPickerItem?
    @State private var removeListener: (() -> Void)?
    @State private var toastMsg: String?
    @State private var showClearConfirm = false
    private let recorderBox = VoiceRecorder()
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { idx, m in
                            // 微信式时间分隔条：与上一条间隔超 5 分钟显示
                            if shouldShowTime(idx) {
                                Text(fmtTime(m.createdAt))
                                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                            }
                            MsgBubble(m: m, mine: m.senderId == (state.user?.id ?? ""), convType: convType,
                                      fallbackAvatar: m.senderId == (state.user?.id ?? "") ? (state.user?.avatar ?? "") : peerAvatarGuess) { img in
                                fullImage = img
                            }
                            .id(m.id)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .onTapGesture { showPanel = false; inputFocused = false }
                // 进入聊天默认停在最底部（最新消息）；defaultScrollAnchor 是 iOS 17 API，改用 scrollTo
                .onAppear {
                    if let last = messages.last {
                        DispatchQueue.main.async { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
                .onChange(of: messages.count) { _ in
                    if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .onChange(of: inputFocused) { focused in
                    if focused {
                        // 键盘弹出时收起 + 面板，避免两者叠加把内容顶飞
                        showPanel = false
                        if let last = messages.last {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                            }
                        }
                    }
                }
            }

            bottomBar
        }
        .overlay {
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
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 14) {
                    Button {
                        showClearConfirm = true
                    } label: {
                        Text("清空").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    }
                    if convType == 2 {
                        NavigationLink(value: GroupInfoNav(groupId: targetId)) {
                            Text("群信息").font(.system(size: 13)).foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            convType == 1 ? "清空后双方的聊天记录都将删除，不可恢复" : "将删除我在本群发送的全部消息，所有成员都将不再看到",
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("清空聊天记录", role: .destructive) {
                Task {
                    struct OkResp: Codable { var ok: Bool? }
                    if let _: OkResp = try? await Api.request("/im/conversations/\(convId)/clear", method: "POST") {
                        await reloadMessages()
                    } else {
                        toastMsg = "清空失败"
                    }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .navigationDestination(for: GroupInfoNav.self) { nav in
            GroupInfoView(groupId: nav.groupId)
        }
        .sheet(isPresented: $showGift) {
            GiftSheetView(toUserId: targetId)
                .presentationDetents([.height(420)])
        }
        .fullScreenCover(item: $fullImage) { img in
            let imgs = messages.filter { $0.type == "image" }.map(\.content)
            ImageViewerView(images: imgs.isEmpty ? [img] : imgs, initial: max(0, imgs.firstIndex(of: img) ?? 0)) {
                fullImage = nil
            }
        }
        .task {
            messages = (try? await Api.request("/im/messages?conversationId=\(convId)")) ?? []
            if let last = messages.last { WsClient.shared.markRead(conversationId: convId, msgId: last.id) }
            WsClient.shared.connect()
            removeListener = WsClient.shared.addListener { frame in
                let op = frame["op"] as? String
                if op == "error" {
                    // 发送被后端拒绝（如积分不足）：提示并撤回乐观显示的消息
                    toastMsg = frame["msg"] as? String ?? "发送失败"
                    if let idx = messages.lastIndex(where: { $0.id.hasPrefix("local_") }) {
                        messages.remove(at: idx)
                    }
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
                guard op == "msg",
                      let data = frame["data"] as? [String: Any],
                      let json = try? JSONSerialization.data(withJSONObject: data),
                      let m = try? JSONDecoder().decode(MessagePayload.self, from: json),
                      m.conversationId == convId else { return }
                messages.append(MsgItem(id: m.id, conversationId: m.conversationId, senderId: m.senderId,
                                        senderNickname: m.senderNickname, senderAvatar: m.senderAvatar,
                                        receiverId: m.receiverId, type: m.type, content: m.content, createdAt: m.createdAt))
                WsClient.shared.markRead(conversationId: convId, msgId: m.id)
            }
        }
        .onDisappear { removeListener?() }
        .onChange(of: imageItem) { item in
            guard let item else { return }
            showPanel = false
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data),
                   let jpeg = img.jpegData(compressionQuality: 0.85),
                   let url = try? await Api.upload("image", data: jpeg, filename: "img.jpg", mime: "image/jpeg") {
                    sendMsg("image", url)
                }
                imageItem = nil
            }
        }
    }

    // MARK: - 底部输入区（微信式）

    private var bottomBar: some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    voiceMode.toggle(); showPanel = false; inputFocused = false
                } label: {
                    Image(systemName: voiceMode ? "keyboard" : "waveform")
                        .font(.system(size: 17)).foregroundStyle(Theme.textSub)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)

                if voiceMode {
                    Text(recording ? "松开发送" : "按住 说话")
                        .font(.system(size: 14))
                        .foregroundStyle(recording ? .white : Theme.text)
                        .frame(maxWidth: .infinity).frame(height: 40)
                        .background(Capsule().fill(recording ? Theme.accent : Theme.bg3))
                        .onLongPressGesture(minimumDuration: 60, maximumDistance: 80, pressing: { pressing in
                            if pressing { recording = true; recorderBox.start() }
                            else if recording { recording = false; finishRecording() }
                        }, perform: {})
                } else {
                    TextField("", text: $input, prompt: Text("发消息").foregroundColor(Theme.textDim), axis: .vertical)
                        .lineLimit(1...4)
                        .focused($inputFocused)
                        .foregroundStyle(Theme.text)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                }

                Button {
                    inputFocused = false; voiceMode = false; showPanel.toggle()
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
                        Text("发送").font(.system(size: 14)).foregroundStyle(.white)
                            .padding(.horizontal, 16).frame(height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)

            if showPanel { panelGrid }
        }
        .background(Theme.bg2)
    }

    private var panelGrid: some View {
        let actions: [(String, String, () -> Void)] = {
            var a: [(String, String, () -> Void)] = [
                ("photo", "相册", { showPanel = false }),
                ("mappin.and.ellipse", "位置", { showPanel = false; sendLocation() }),
            ]
            if convType == 1 {
                let peerAvatar = messages.first(where: { $0.senderId == targetId })?.senderAvatar ?? ""
                a.append(("phone", "语音通话", { showPanel = false; startCallWithPermissions(calleeId: targetId, type: 1, name: title, avatar: peerAvatar) }))
                // 视频通话仅男方可发起（女方只能接听）
                if state.user?.gender == 1 {
                    a.append(("video", "视频通话", { showPanel = false; startCallWithPermissions(calleeId: targetId, type: 2, name: title, avatar: peerAvatar) }))
                }
                a.append(("gift", "礼物", { showPanel = false; showGift = true }))
            }
            return a
        }()
        let cols = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
        return LazyVGrid(columns: cols, spacing: 14) {
            ForEach(Array(actions.enumerated()), id: \.offset) { _, item in
                if item.1 == "相册" {
                    PhotosPicker(selection: $imageItem, matching: .images) {
                        panelCell(icon: item.0, label: item.1)
                    }
                } else {
                    Button { item.2() } label: {
                        panelCell(icon: item.0, label: item.1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(EdgeInsets(top: 12, leading: 12, bottom: 20, trailing: 12))
    }

    private func panelCell(icon: String, label: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 22)).foregroundStyle(Theme.text)
                .frame(width: 56, height: 56)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg3))
            Text(label).font(.system(size: 11)).foregroundStyle(Theme.textSub)
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

    private func sendMsg(_ type: String, _ content: String) {
        WsClient.shared.send(convType: convType, targetId: targetId, msgType: type, content: content)
        messages.append(MsgItem(
            id: "local_\(Int(Date().timeIntervalSince1970 * 1000))",
            conversationId: convId, senderId: state.user?.id ?? "",
            senderNickname: state.user?.nickname ?? "", senderAvatar: state.user?.avatar ?? "",
            receiverId: nil, type: type, content: content,
            createdAt: ISO8601DateFormatter().string(from: Date())
        ))
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
        CityLocator.shared.currentLocation { loc, addr in
            DispatchQueue.main.async {
                let name = addr ?? "我的位置"
                let lat = loc?.coordinate.latitude ?? 0
                let lng = loc?.coordinate.longitude ?? 0
                sendMsg("location", "{\"name\":\"\(name)\",\"lat\":\(lat),\"lng\":\(lng)}")
            }
        }
    }
}

private struct GroupInfoNav: Hashable { let groupId: String }

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
    var onImage: (String) -> Void

    @State private var voicePlaying = false
    @State private var voiceStopTask: Task<Void, Never>?

    private var bg: Color { mine ? Theme.bubbleMine : Theme.bg3 }
    private var fg: Color { mine ? .white : Theme.text }

    private var avatarUrl: String {
        (m.senderAvatar?.isEmpty == false) ? m.senderAvatar! : fallbackAvatar
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 50) }
            if !mine { AvatarView(url: avatarUrl, size: 38) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if !mine {
                    Text(m.senderNickname ?? "").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                        .padding(.leading, 4)
                }
                content
            }
            .frame(maxWidth: 240, alignment: mine ? .trailing : .leading)
            if mine { AvatarView(url: avatarUrl, size: 38) }
            if !mine { Spacer(minLength: 50) }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var bubbleShape: UnevenRoundedRectangle {
        mine
            ? UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
            : UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16)
    }

    @ViewBuilder
    private var content: some View {
        switch m.type {
        case "image":
            RemoteImage(url: m.content)
                .frame(width: 160, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onTapGesture { onImage(m.content) }
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
                Text(obj["name"] as? String ?? "位置").font(.system(size: 14)).foregroundStyle(fg)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
        case "gift":
            let obj = parseJson(m.content)
            let giftName = obj["name"] as? String ?? "礼物"
            let giftPrice = (obj["price"] as? String) ?? String((obj["price"] as? Int) ?? 0)
            HStack(spacing: 10) {
                RemoteImage(url: obj["icon"] as? String ?? "")
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(mine ? "送出" : "收到")「\(giftName)」")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(fg)
                    Text("\(fmtPoints(giftPrice)) 积分")
                        .font(.system(size: 12)).foregroundStyle(mine ? .white.opacity(0.85) : Theme.warn)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(bubbleShape.fill(bg))
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
            Text(m.content)
                .font(.system(size: 15)).foregroundStyle(fg)
                .lineSpacing(4)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(bubbleShape.fill(bg))
        }
    }

    private func parseJson(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:]
    }

    private func callText(callType: Int, result: String, duration: Int) -> String {
        let label = callType == 2 ? "视频通话" : "语音通话"
        switch result {
        case "end": return "\(label) \(String(format: "%02d:%02d", duration / 60, duration % 60))"
        case "reject": return "\(label) 已拒绝"
        default: return "\(label) 已取消"
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
                Text("送礼物").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
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
                Text("余额 \(fmtPoints(balance)) 积分").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                Spacer()
                Button {
                    guard let gid = selected else { errMsg = "请先选择礼物"; return }
                    Task {
                        do {
                            struct Empty: Codable { var ok: Bool? }
                            let _: Empty = try await Api.request("/gifts/send", method: "POST", body: ["toUserId": toUserId, "giftId": gid])
                            // 送出后不关面板，刷新余额，可连续赠送
                            errMsg = ""
                            okMsg = "已送出"
                            if let w: WalletData = try? await Api.request("/wallet") { balance = w.balance ?? "0" }
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            okMsg = ""
                        } catch { okMsg = ""; errMsg = error.localizedDescription }
                    }
                } label: {
                    Text("赠送").font(.system(size: 13)).foregroundStyle(.white)
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

/// 图片查看器：左右翻页 + 双指缩放 + 关闭按钮
struct ImageViewerView: View {
    let images: [String]
    let initial: Int
    var onClose: () -> Void
    @State private var page: Int

    init(images: [String], initial: Int, onClose: @escaping () -> Void) {
        self.images = images
        self.initial = initial
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
    }
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
    @State private var avatarItem: PhotosPickerItem?
    @State private var uploading = false
    @State private var people: [Person] = []
    @State private var selected: Set<String> = []
    @State private var created: ChatTarget?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    // 群头像（可选，不设置默认用群主头像）
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        if avatar.isEmpty {
                            Circle().fill(Theme.bg3)
                                .frame(width: 56, height: 56)
                                .overlay(Text(uploading ? "…" : "头像").font(.system(size: 11)).foregroundStyle(Theme.textDim))
                        } else {
                            AvatarView(url: avatar, size: 56)
                        }
                    }
                    TextField("", text: $name, prompt: Text("群名称").foregroundColor(Theme.textDim))
                        .foregroundStyle(Theme.text)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                }
                Text("群头像可选，不设置默认显示群主头像 · 邀请成员（可选）").font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .padding(16)
            .onChange(of: avatarItem) { item in
                guard let item else { return }
                uploading = true
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let url = try? await Api.upload("image", data: data, filename: "g.jpg", mime: "image/jpeg") {
                        avatar = url
                    }
                    uploading = false
                }
            }

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
                                Text(selected.contains(p.id) ? "已选" : "选择")
                                    .font(.system(size: 13))
                                    .foregroundStyle(selected.contains(p.id) ? Theme.accent : Theme.textDim)
                            }
                            .padding(.horizontal, 16).padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            AccentButton(title: "创建（\(selected.count) 人）", enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                Task {
                    struct GroupCreated: Codable { var id: String = ""; var name: String? = ""; var conversationId: String = "" }
                    if let g: GroupCreated = try? await Api.request("/im/group", method: "POST", body: [
                        "name": name.trimmingCharacters(in: .whitespaces),
                        "memberIds": Array(selected),
                        "avatar": avatar,
                    ]) {
                        created = ChatTarget(convId: g.conversationId, convType: 2, targetId: g.id, title: "\(g.name ?? "")（群）")
                    }
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle("创建群聊")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
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
                EmptyHint(text: "我是 AI 助手，完全免费\n有什么想问的尽管说")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(messages) { m in
                                aiBubble(m.content, mine: m.role == "user")
                                    .id(m.id)
                            }
                            if thinking {
                                aiBubble("正在思考…", mine: false, dim: true)
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
                TextField("", text: $input, prompt: Text("随便问点什么…").foregroundColor(Theme.textDim), axis: .vertical)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Theme.bg3))
                if !input.trimmingCharacters(in: .whitespaces).isEmpty && !thinking {
                    Button { send() } label: {
                        Text("发送").font(.system(size: 14)).foregroundStyle(.white)
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
        .navigationTitle("AI 助手")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task {
                        struct OkResp: Codable { var ok: Bool? }
                        let _: OkResp? = try? await Api.request("/ai/clear", method: "POST")
                        messages = []
                    }
                } label: {
                    Text("清空").font(.system(size: 13)).foregroundStyle(Theme.textSub)
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
                        .foregroundStyle(dim ? Theme.textSub : (mine ? .white : Theme.text))
                        .lineSpacing(4)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(
                            (mine
                                ? UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 4)
                                : UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16))
                                .fill(mine ? Theme.bubbleMine : Theme.bg3),
                        )
                }
                if let html = parts.html {
                    Button { htmlPreview = HtmlPreview(html: html) } label: {
                        HStack(spacing: 10) {
                            Text("🌐").font(.system(size: 22))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("网页内容").font(.system(size: 14)).foregroundStyle(Theme.text)
                                Text("点击打开预览 ›").font(.system(size: 11)).foregroundStyle(Theme.accent)
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(
                            UnevenRoundedRectangle(topLeadingRadius: 4, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16)
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
    var title: String = "网页预览"
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                Button("关闭") { dismiss() }
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
    @State private var avatarItem: PhotosPickerItem?

    var body: some View {
        VStack(spacing: 0) {
            if let g = info {
                let myRoleForEdit = g.members?.first { $0.id == state.user?.id }?.role ?? "member"
                let canEdit = myRoleForEdit == "owner" || myRoleForEdit == "admin"
                // 群头像（群主/管理员点击可换）+ 人数
                HStack(spacing: 12) {
                    if canEdit {
                        PhotosPicker(selection: $avatarItem, matching: .images) {
                            AvatarView(url: g.avatar, size: 56)
                        }
                    } else {
                        AvatarView(url: g.avatar, size: 56)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("共 \(g.members?.count ?? 0) 人")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        if canEdit {
                            Text("点头像可修改").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
                .onChange(of: avatarItem) { item in
                    guard let item else { return }
                    Task {
                        struct Empty: Codable { var id: String? }
                        if let data = try? await item.loadTransferable(type: Data.self),
                           let url = try? await Api.upload("image", data: data, filename: "g.jpg", mime: "image/jpeg") {
                            let _: Empty? = try? await Api.request("/im/group/\(groupId)", method: "PUT", body: ["avatar": url])
                            info = try? await Api.request("/im/group/\(groupId)")
                        }
                    }
                }
                ScrollView {
                    let cols = Array(repeating: GridItem(.flexible(), spacing: 12), count: 5)
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(g.members ?? []) { m in
                            VStack(spacing: 4) {
                                AvatarView(url: m.avatar, size: 48)
                                Text((m.nickname ?? "") + (m.role == "owner" ? " 主" : ""))
                                    .font(.system(size: 11)).foregroundStyle(Theme.textSub).lineLimit(1)
                            }
                        }
                    }
                    .padding(16)
                }
                let myRole = g.members?.first { $0.id == state.user?.id }?.role ?? "member"
                AccentButton(title: myRole == "owner" ? "解散群聊" : "退出群聊") {
                    Task {
                        struct Empty: Codable { var ok: Bool? }
                        let _: Empty? = try? await Api.request("/im/group/\(groupId)/\(myRole == "owner" ? "dissolve" : "leave")", method: "POST")
                        dismiss()
                    }
                }
                .padding(16)
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        .navigationTitle(info?.name ?? "群信息")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("分享") { showShare = true }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
        }
        .sheet(isPresented: $showShare) {
            GroupShareSheet(groupId: groupId)
        }
        .task {
            info = try? await Api.request("/im/group/\(groupId)")
        }
    }
}

/// 群分享面板：二维码 + 邀请码 + 密码设置（群主/管理员）
struct GroupShareSheet: View {
    let groupId: String
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
                    Text("群邀请").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(s.hasPassword ? "扫码或输码后需输入密码才能加入" : "扫码或输入邀请码即可加入")
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
                        toastMsg = "邀请码已复制"
                    } label: {
                        HStack(spacing: 6) {
                            Text(s.code).font(.system(size: 18, weight: .bold)).tracking(3).foregroundStyle(Theme.text)
                            Text("复制").font(.system(size: 12)).foregroundStyle(Theme.accent)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg3))
                    }
                    .buttonStyle(.plain)

                    if s.canEdit {
                        // 模式切换 + 行内小保存按钮
                        HStack(spacing: 8) {
                            ForEach([("none", "无密码"), ("pwd", "有密码")], id: \.0) { k, label in
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
                                    toastMsg = "请输入密码"
                                    return
                                }
                                saving = true
                                Task {
                                    let s2: ShareInfo? = try? await Api.request(
                                        "/im/group/\(groupId)/share", method: "POST",
                                        body: ["password": mode == "pwd" ? pwd.trimmingCharacters(in: .whitespaces) : ""]
                                    )
                                    if let s2 { share = s2; toastMsg = "已保存" } else { toastMsg = "保存失败" }
                                    saving = false
                                }
                            } label: {
                                Text(saving ? "保存中…" : "保存")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 16).padding(.vertical, 5)
                                    .background(Capsule().fill(Theme.accent))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 24)
                        if mode == "pwd" {
                            TextField("", text: $pwd, prompt: Text("设置入群密码").foregroundColor(Theme.textDim))
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
                            ShareLink(
                                item: Image(uiImage: img),
                                preview: SharePreview("群邀请码", image: Image(uiImage: img))
                            ) {
                                Text("分享二维码").font(.system(size: 13)).foregroundStyle(Theme.accent)
                            }
                        }
                        Button("关闭") { dismiss() }
                            .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    }
                } else {
                    Text("加载中…").font(.system(size: 13)).foregroundStyle(Theme.textSub).padding(40)
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

    var body: some View {
        VStack(spacing: 14) {
            // 邀请码输入框（右侧内嵌扫码图标）
            HStack(spacing: 8) {
                TextField("", text: $code, prompt: Text("输入群邀请码").foregroundColor(Theme.textDim))
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
                    Text("共 \(g.memberCount ?? 0) 人\(g.hasPassword ? " · 需要密码" : "")")
                        .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    if g.isMember {
                        Text("你已在群里").font(.system(size: 12)).foregroundStyle(Theme.success)
                    } else if g.hasPassword {
                        SecureField("", text: $pwd, prompt: Text("输入入群密码").foregroundColor(Theme.textDim))
                            .foregroundStyle(Theme.text)
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                            .padding(.top, 6)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                AccentButton(title: g.isMember ? "进入群聊" : (busy ? "加入中…" : "加入群聊")) {
                    guard !busy else { return }
                    if g.isMember, let convId = g.conversationId {
                        opened = ChatTarget(convId: convId, convType: 2, targetId: g.groupId, title: "\(g.name ?? "")（群）")
                        return
                    }
                    if g.hasPassword, pwd.trimmingCharacters(in: .whitespaces).isEmpty {
                        toastMsg = "请输入入群密码"
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
                                opened = ChatTarget(convId: convId, convType: 2, targetId: j.id, title: "\(j.name ?? "")（群）")
                            }
                        } catch {
                            toastMsg = (error as? ApiError)?.msg ?? "加入失败"
                        }
                        busy = false
                    }
                }
            } else if !code.isEmpty {
                AccentButton(title: busy ? "查询中…" : "查找群聊") {
                    guard !busy else { return }
                    let c = code.trimmingCharacters(in: .whitespaces)
                    if c.count < 6 { toastMsg = "请输入完整邀请码"; return }
                    Task { await check(c) }
                }
            }

            // 群列表：直接浏览加入
            Text("群列表")
                .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            ScrollView {
                LazyVStack(spacing: 0) {
                    if groups.isEmpty {
                        Text("暂无群聊").font(.system(size: 13)).foregroundStyle(Theme.textDim).padding(.top, 20)
                    }
                    ForEach(groups) { g in
                        HStack(spacing: 12) {
                            AvatarView(url: g.avatar, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.name ?? "").font(.system(size: 15)).foregroundStyle(Theme.text).lineLimit(1)
                                Text("共 \(g.memberCount ?? 0) 人\(g.hasPassword ? " · 需要密码" : "")")
                                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                            }
                            Spacer()
                            Button {
                                if g.isMember, let convId = g.conversationId {
                                    opened = ChatTarget(convId: convId, convType: 2, targetId: g.id, title: "\(g.name ?? "")（群）")
                                } else if g.hasPassword {
                                    pwdInput = ""
                                    pwdTarget = g
                                    showPwdAlert = true
                                } else {
                                    Task { await joinById(g, password: "") }
                                }
                            } label: {
                                Text(g.isMember ? "进入" : "加入")
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
        .navigationTitle("加入群聊")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toast($toastMsg)
        .alert(pwdTarget?.name ?? "入群密码", isPresented: $showPwdAlert) {
            TextField("输入入群密码", text: $pwdInput)
            Button("取消", role: .cancel) {}
            Button("加入") {
                if let g = pwdTarget {
                    Task { await joinById(g, password: pwdInput) }
                }
            }
        } message: {
            Text("该群需要密码才能加入")
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
                    toastMsg = "无法识别的群二维码"
                }
            }
        }
        .fullScreenCover(item: $opened) { t in
            ChatRoomSheet(target: t)
        }
    }

    private func check(_ c: String) async {
        guard !busy else { return }
        busy = true
        do {
            let g: CodeInfo = try await Api.request("/im/group/code/\(c)")
            info = g
            pwd = ""
        } catch {
            toastMsg = (error as? ApiError)?.msg ?? "邀请码无效"
        }
        busy = false
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
                opened = ChatTarget(convId: convId, convType: 2, targetId: j.id, title: "\(j.name ?? "")（群）")
            }
        } catch {
            toastMsg = (error as? ApiError)?.msg ?? "加入失败"
        }
        busy = false
    }
}
