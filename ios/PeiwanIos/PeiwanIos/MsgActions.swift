import SwiftUI
import Photos

/// 与后端 MSG_REACTIONS 一致；前 7 个是菜单顶上那一排
let MSG_REACTIONS = ["❤️", "👍", "👎", "🔥", "🥰", "👏", "😁", "😂", "😮", "😢", "🎉", "🙏"]

/// 能转发的类型（礼物、通话记录、转账卡片不行；喊单卡片可以），和后端 message.service FORWARDABLE 一致
let FORWARDABLE: Set<String> = ["text", "image", "video", "audio", "location", "sticker", "callout"]

func msgSnippet(_ type: String, _ content: String) -> String {
    switch type {
    case "text": return String(content.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(60))
    case "image": return t("msg.snippet.image")
    case "video": return t("msg.snippet.video")
    case "audio": return t("msg.snippet.audio")
    case "sticker": return t("msg.snippet.sticker")
    case "location": return t("msg.snippet.location")
    case "gift": return t("msg.snippet.gift")
    case "transfer", "callout", "payreq", "perp": return ChainCards.preview(type, content) ?? t("msg.snippet.message")
    default: return type.hasPrefix("call") ? t("msg.snippet.call") : t("msg.snippet.message")
    }
}

// MARK: - 链接

struct LinkTarget: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private let urlRegex = try! NSRegularExpression(
    pattern: "(https?://|www\\.)[^\\s<>\"'“”‘’，。！？；：、（）【】《》]+",
    options: [.caseInsensitive]
)

/// 把文本切成普通文字和链接（www. 开头的补 https://）
func splitLinks(_ text: String) -> [(text: String, url: URL?)] {
    let ns = text as NSString
    var out: [(text: String, url: URL?)] = []
    var last = 0
    for m in urlRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        var raw = ns.substring(with: m.range)
        while let c = raw.last, ".,;:!?)]}>".contains(c) { raw.removeLast() }
        if raw.isEmpty || raw.lowercased() == "www." { continue }
        let full = raw.lowercased().hasPrefix("www.") ? "https://" + raw : raw
        guard let url = URL(string: full)
            ?? full.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed).flatMap({ URL(string: $0) })
        else { continue }
        if m.range.location > last {
            out.append((ns.substring(with: NSRange(location: last, length: m.range.location - last)), nil))
        }
        out.append((raw, url))
        last = m.range.location + (raw as NSString).length
    }
    if last < ns.length { out.append((ns.substring(from: last), nil)) }
    return out
}

func linkified(_ text: String) -> AttributedString {
    var out = AttributedString()
    for part in splitLinks(text) {
        var s = AttributedString(part.text)
        if let u = part.url { s.link = u }
        out += s
    }
    return out
}

/// 文字里的链接可点；点开由外层 .inAppLinks() 接管，走应用内网页
struct LinkText: View {
    let text: String

    var body: some View {
        if text.range(of: "http", options: .caseInsensitive) == nil && text.range(of: "www.", options: .caseInsensitive) == nil {
            Text(text)
        } else {
            Text(linkified(text)).tint(botBlue)
        }
    }
}

/// 接管子视图里 Text 链接的点击：http(s) 在应用内 WebView 打开（顶部可浏览器打开 / 复制链接）
struct InAppLinks: ViewModifier {
    @State private var target: LinkTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "http" || url.scheme == "https" else { return .systemAction }
                target = LinkTarget(url: url)
                return .handled
            })
            .fullScreenCover(item: $target) { lt in
                WebPreviewSheet(url: lt.url, title: lt.url.host ?? t("web.page"))
            }
    }
}

extension View {
    func inAppLinks() -> some View { modifier(InAppLinks()) }
}

// MARK: - 长按菜单

/// 传 nil 的项不显示
struct MenuActions {
    var onReact: (String) -> Void
    var onReply: (() -> Void)?
    var onCopy: (() -> Void)?
    var onSave: (() -> Void)?
    var onPin: (() -> Void)?
    var onForward: (() -> Void)?
    var onReport: (() -> Void)?
    var onDelete: (() -> Void)?
    var onSelect: (() -> Void)?
}

struct ReaderUser: Codable, Identifiable {
    var id: String
    var nickname: String? = ""
    var avatar: String? = ""
}

struct ReadInfo: Codable {
    var read: Bool? = nil
    var readAt: String? = nil
    var count: Int? = nil
    var users: [ReaderUser]? = nil
}

private func fmtReadAt(_ iso: String?) -> String {
    guard let d = parseIsoDate(iso) else { return "" }
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    let c = Calendar.current.dateComponents([.month, .day], from: d)
    return t("msg.readDate", ["m": c.month ?? 0, "d": c.day ?? 0, "time": f.string(from: d)])
}

private struct MenuEntry {
    let label: String
    let icon: String
    let fn: () -> Void
}

/// Telegram 式消息菜单：顶上一排表情，自己的消息显示已读时间，下面按类型给操作
struct MsgMenuOverlay: View {
    let msgId: String
    let mine: Bool
    let convType: Int
    let myReaction: String?
    let pinned: Bool
    let actions: MenuActions
    let onDismiss: () -> Void

    @State private var expand = false
    @State private var info: ReadInfo?
    @State private var showReaders = false

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
                .onTapGesture(perform: onDismiss)
            VStack(spacing: 8) {
                reactionRow
                VStack(spacing: 0) {
                    readLine
                    ForEach(Array(entries.enumerated()), id: \.offset) { i, e in
                        if i > 0 || info != nil { Divider().background(Theme.textDim.opacity(0.3)) }
                        Button { run(e.fn) } label: {
                            HStack {
                                Text(e.label).font(.system(size: 15))
                                Spacer()
                                Image(systemName: e.icon).font(.system(size: 15))
                            }
                            .foregroundStyle(e.icon == "trash" ? Color.red : Theme.text)
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(width: 250)
                .background(Theme.bg)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        .task {
            if mine { info = try? await Api.request("/im/messages/\(msgId)/readers") }
        }
    }

    private var entries: [MenuEntry] {
        var out: [MenuEntry] = []
        func add(_ label: String, _ icon: String, _ fn: (() -> Void)?) {
            if let fn { out.append(MenuEntry(label: label, icon: icon, fn: fn)) }
        }
        add(t("msg.reply"), "arrowshape.turn.up.left", actions.onReply)
        add(t("msg.copy"), "doc.on.doc", actions.onCopy)
        add(t("common.save"), "square.and.arrow.down", actions.onSave)
        add(pinned ? t("msg.unpin") : t("msg.pin"), pinned ? "pin.slash" : "pin", actions.onPin)
        add(t("msg.forward"), "arrowshape.turn.up.right", actions.onForward)
        add(t("common.report"), "exclamationmark.bubble", actions.onReport)
        add(t("common.delete"), "trash", actions.onDelete)
        add(t("msg.select"), "checkmark.circle", actions.onSelect)
        return out
    }

    private func run(_ fn: () -> Void) {
        onDismiss()
        fn()
    }

    private var reactionRow: some View {
        let shown = expand ? MSG_REACTIONS : Array(MSG_REACTIONS.prefix(7))
        let rows = stride(from: 0, to: shown.count, by: 7).map { Array(shown[$0 ..< min($0 + 7, shown.count)]) }
        return VStack(spacing: 2) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 2) {
                    ForEach(rows[i], id: \.self) { e in
                        Text(e).font(.system(size: 21))
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(myReaction == e ? botBlue.opacity(0.15) : Color.clear))
                            .contentShape(Circle())
                            .onTapGesture { run { actions.onReact(e) } }
                    }
                    if !expand && i == rows.count - 1 {
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.textSub)
                            .frame(width: 28, height: 28)
                            .background(Circle().fill(Theme.bg3))
                            .onTapGesture { expand = true }
                    }
                }
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 22).fill(Theme.bg))
    }

    @ViewBuilder
    private var readLine: some View {
        if let r = info {
            let n = r.count ?? 0
            let readAt = fmtReadAt(r.readAt)
            let readText = readAt.isEmpty ? t("msg.read") : t("msg.readAt", ["time": readAt])
            let groupText = n > 0 ? "\(t("msg.readByN", ["n": n])) \(showReaders ? "⌃" : "›")" : t("msg.readByNone")
            let line: String = convType == 1
                ? (r.read == true ? "✓✓ \(readText)" : "✓ \(t("msg.unread"))")
                : "✓✓ \(groupText)"
            Text(line).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(Theme.bg2)
                .contentShape(Rectangle())
                .onTapGesture { if n > 0 { showReaders.toggle() } }
            if showReaders {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(r.users ?? []) { u in
                            HStack(spacing: 8) {
                                AvatarView(url: u.avatar ?? "", size: 22)
                                Text(u.nickname ?? "").font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 6)
                }
                .frame(maxHeight: 160)
                .background(Theme.bg2)
            }
        }
    }
}

// MARK: - 气泡里的小部件

struct ReactionChips: View {
    let reactions: [MsgReaction]
    let myId: String
    let onToggle: (String) -> Void

    var body: some View {
        let rows = stride(from: 0, to: reactions.count, by: 4).map { Array(reactions[$0 ..< min($0 + 4, reactions.count)]) }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 4) {
                    ForEach(rows[i], id: \.emoji) { r in
                        let on = r.userIds.contains(myId)
                        Text("\(r.emoji) \(r.count)").font(.system(size: 13))
                            .foregroundStyle(on ? botBlue : Theme.text)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Capsule().fill(on ? botBlue.opacity(0.16) : Theme.bg3))
                            .onTapGesture { onToggle(r.emoji) }
                    }
                }
            }
        }
        .padding(.top, 4)
    }
}

struct ReplyQuote: View {
    let r: ReplyPreview
    let onTap: () -> Void

    var body: some View {
        let deleted = r.deleted == true
        HStack(spacing: 0) {
            Rectangle().fill(botBlue).frame(width: 3, height: 36)
            if r.type == "image", !deleted, let c = r.content, !c.isEmpty {
                RemoteImage(url: c).frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 3)).padding(.leading, 6)
            }
            VStack(alignment: .leading, spacing: 1) {
                if deleted {
                    Text(t("msg.originalDeleted")).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                } else {
                    Text(r.senderNickname ?? "").font(.system(size: 12, weight: .semibold)).foregroundStyle(botBlue).lineLimit(1)
                    Text(r.type == "text" ? (r.content ?? "") : msgSnippet(r.type ?? "", ""))
                        .font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
        }
        .frame(maxWidth: 220, alignment: .leading)
        .background(botBlue.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
        .onTapGesture { if !deleted { onTap() } }
        .padding(.bottom, 4)
    }
}

/// 输入框上方「回复 xxx」条
struct ReplyBar: View {
    let nickname: String
    let snippet: String
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrowshape.turn.up.left.fill").font(.system(size: 15)).foregroundStyle(botBlue)
            VStack(alignment: .leading, spacing: 1) {
                Text(t("msg.replyTo", ["name": nickname])).font(.system(size: 13, weight: .semibold)).foregroundStyle(botBlue).lineLimit(1)
                Text(snippet).font(.system(size: 12)).foregroundStyle(Theme.textSub).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: onCancel) {
                Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Theme.textDim).padding(6)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Theme.bg2)
    }
}

struct PinItem: Codable, Identifiable {
    var id: String
    var senderId: String? = ""
    var senderNickname: String? = ""
    var type: String? = ""
    var content: String? = ""
    var pinnedAt: String? = ""
}

/// 顶部置顶条：点一下跳到这条，再点轮到下一条（新的在前）
struct PinBar: View {
    let pins: [PinItem]
    let index: Int
    let canUnpin: Bool
    let onJump: () -> Void
    let onUnpin: () -> Void

    var body: some View {
        if !pins.isEmpty {
            let cur = index % pins.count
            let p = pins[cur]
            HStack(spacing: 10) {
                VStack(spacing: 2) {
                    ForEach(0 ..< min(pins.count, 5), id: \.self) { i in
                        Capsule().fill(i == cur ? botBlue : botBlue.opacity(0.3)).frame(width: 2)
                    }
                }
                .frame(height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t("msg.pinnedMessage") + (pins.count > 1 ? " #\(cur + 1)" : ""))
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(botBlue)
                    Text(p.type == "text" ? (p.content ?? "") : msgSnippet(p.type ?? "", ""))
                        .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineLimit(1)
                }
                Spacer(minLength: 0)
                if canUnpin {
                    Button(action: onUnpin) {
                        Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Theme.textDim).padding(6)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Theme.bg2)
            .contentShape(Rectangle())
            .onTapGesture(perform: onJump)
        }
    }
}

// MARK: - 举报 / 转发

private let REPORT_REASONS = ["垃圾广告", "色情低俗", "诈骗", "辱骂骚扰", "违法违规", "其他"]

/// REPORT_REASONS 是发给后端的值，这里只换显示文字
private func reportReasonLabel(_ r: String) -> String {
    switch r {
    case "垃圾广告": return t("msg.report.spam")
    case "色情低俗": return t("msg.report.porn")
    case "诈骗": return t("msg.report.fraud")
    case "辱骂骚扰": return t("msg.report.abuse")
    case "违法违规": return t("msg.report.illegal")
    case "其他": return t("msg.report.other")
    default: return r
    }
}

struct ReportSheet: View {
    let msgId: String
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var other = false
    @State private var text = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(t("msg.reportTitle")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Button(t("common.cancel")) { dismiss() }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
            }
            .padding(16)
            if !other {
                ForEach(REPORT_REASONS, id: \.self) { r in
                    Button {
                        if r == "其他" { other = true } else { submit(r) }
                    } label: {
                        Text(reportReasonLabel(r)).font(.system(size: 15)).foregroundStyle(Theme.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 11)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else {
                TextField(t("msg.reportPlaceholder"), text: $text)
                    .foregroundStyle(Theme.text)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                    .padding(.horizontal, 16)
                let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button {
                    submit("其他：" + String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)))
                } label: {
                    Text(t("common.submit")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(Capsule().fill(empty ? Theme.textDim : Theme.accent))
                }
                .buttonStyle(.plain)
                .disabled(empty || busy)
                .padding(16)
            }
            Spacer(minLength: 0)
        }
        .background(Theme.bg2)
    }

    private func submit(_ reason: String) {
        guard !busy else { return }
        busy = true
        Task { @MainActor in
            struct ReportResp: Codable { var ok: Bool?; var duplicated: Bool? }
            let tip: String
            do {
                let r: ReportResp = try await Api.request("/im/messages/\(msgId)/report", method: "POST", body: ["reason": reason])
                tip = r.duplicated == true ? t("msg.reportDuplicated") : t("msg.reported")
            } catch {
                tip = error.localizedDescription
            }
            busy = false
            onDone(tip)
            dismiss()
        }
    }
}

struct IdList: Identifiable {
    let ids: [String]
    var id: String { ids.joined(separator: ",") }
}

/// 转发：选会话（最多 10 个），按原消息顺序发过去
struct ForwardSheet: View {
    let fromConvId: String
    let ids: [String]
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var convs: [ConversationItem] = []
    @State private var q = ""
    @State private var picked: [String] = []
    @State private var busy = false

    private func name(_ c: ConversationItem) -> String { c.peer?.nickname ?? c.group?.name ?? "" }
    private func avatar(_ c: ConversationItem) -> String { c.peer?.avatar ?? c.group?.avatar ?? "" }

    private var shown: [ConversationItem] {
        let k = q.trimmingCharacters(in: .whitespaces)
        return convs.filter { k.isEmpty || name($0).localizedCaseInsensitiveContains(k) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(t("common.cancel")) { dismiss() }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
                Spacer()
                Text(ids.count > 1 ? t("msg.forwardNTo", ["n": ids.count]) : t("msg.forwardTo"))
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                let sendLabel = picked.isEmpty ? t("common.send") : t("msg.sendCount", ["n": picked.count])
                Button(busy ? t("msg.sendingShort") : sendLabel) { send() }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(picked.isEmpty || busy ? Theme.textDim : Theme.accent)
                    .disabled(picked.isEmpty || busy)
            }
            .padding(16)
            TextField(t("common.search"), text: $q)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                .padding(.horizontal, 16)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(shown) { c in
                        let on = picked.contains(c.id)
                        HStack(spacing: 12) {
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 20)).foregroundStyle(on ? botBlue : Theme.textDim)
                            AvatarView(url: avatar(c), size: 40)
                            Text(name(c)).font(.system(size: 15)).foregroundStyle(Theme.text).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if on { picked.removeAll { $0 == c.id } } else if picked.count < 10 { picked.append(c.id) }
                        }
                    }
                }
                .padding(.top, 6)
            }
        }
        .background(Theme.bg2)
        .task {
            let list: [ConversationItem] = (try? await Api.request("/im/conversations")) ?? []
            convs = list.filter { $0.peer != nil || $0.group != nil }
        }
    }

    private func send() {
        let targets: [[String: Any]] = picked.compactMap { id in
            guard let c = convs.first(where: { $0.id == id }) else { return nil }
            if c.type == 1, let p = c.peer { return ["convType": 1, "targetId": p.id] }
            if let g = c.group { return ["convType": 2, "targetId": g.id] }
            return nil
        }
        busy = true
        Task { @MainActor in
            struct ForwardResult: Codable { var ok: Bool; var error: String? }
            struct ForwardResp: Codable { var results: [ForwardResult] }
            let tip: String
            do {
                let r: ForwardResp = try await Api.request("/im/messages/forward", method: "POST", body: [
                    "fromConversationId": fromConvId,
                    "ids": ids,
                    "targets": targets,
                ])
                let failed = r.results.filter { !$0.ok }
                tip = failed.isEmpty ? t("msg.forwarded") : t("msg.forwardPartialFail", ["n": failed.count, "error": failed[0].error ?? ""])
            } catch {
                tip = error.localizedDescription
            }
            busy = false
            onDone(tip)
            dismiss()
        }
    }
}

// MARK: - 保存到相册

func saveMediaToPhotos(type: String, url: String) async -> String {
    let key = await saveMediaToPhotosKey(type: type, url: url)
    return t(key)
}

/// 返回提示文字的 i18n key
private func saveMediaToPhotosKey(type: String, url: String) async -> String {
    guard let u = URL(string: Api.fullUrl(url)) else { return "msg.saveFailed" }
    let status: PHAuthorizationStatus = await withCheckedContinuation { cont in
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { cont.resume(returning: $0) }
    }
    guard status == .authorized || status == .limited else { return "msg.noPhotoPermission" }
    guard let res = try? await URLSession.shared.data(from: u) else { return "msg.downloadFailed" }
    let isVideo = type == "video"
    let file = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString + (isVideo ? ".mp4" : ".jpg"))
    do {
        try res.0.write(to: file)
        try await PHPhotoLibrary.shared().performChanges {
            if isVideo {
                _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: file)
            } else {
                _ = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: file)
            }
        }
        try? FileManager.default.removeItem(at: file)
        return "msg.savedToGallery"
    } catch {
        try? FileManager.default.removeItem(at: file)
        return "msg.saveFailed"
    }
}
