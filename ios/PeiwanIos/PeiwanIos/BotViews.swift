import SwiftUI
import UIKit

// 机器人（Telegram 兼容 Bot API）：消息下的内联按钮、我的机器人、群 / 频道里加机器人

let botBlue = Color(red: 0.184, green: 0.486, blue: 0.965)

/// 内联按钮（Telegram inline_keyboard 格式）
struct InlineButton: Codable, Hashable {
    var text: String?
    var url: String?
    var callbackData: String?

    enum CodingKeys: String, CodingKey {
        case text, url
        case callbackData = "callback_data"
    }
}

struct InlineMarkup: Codable, Hashable {
    var inlineKeyboard: [[InlineButton]]?

    enum CodingKeys: String, CodingKey {
        case inlineKeyboard = "inline_keyboard"
    }

    /// WS 帧里的 markup 是字典，转一下
    static func from(_ v: Any?) -> InlineMarkup? {
        guard let v, !(v is NSNull), let d = try? JSONSerialization.data(withJSONObject: v) else { return nil }
        return try? JSONDecoder().decode(InlineMarkup.self, from: d)
    }
}

struct BotCommandItem: Codable, Hashable {
    var command: String = ""
    var description: String? = ""
}

struct BotPublic: Codable, Hashable {
    var id: String = ""
    var username: String? = ""
    var name: String? = ""
    var avatar: String? = ""
    var description: String? = ""
    var commands: [BotCommandItem]? = []
}

private struct MyBot: Codable, Identifiable {
    var id: String = ""
    var username: String? = ""
    var name: String? = ""
    var avatar: String? = ""
    var description: String? = ""
    var privacy: Bool? = true
    var commands: [BotCommandItem]? = []
    var webhookUrl: String? = ""
    var status: Int? = 0
    var pendingUpdates: Int? = 0
    var lastError: String? = ""
    var token: String? = nil
}

private struct BotOkResp: Codable { var ok: Bool? }
private struct BotTokenResp: Codable { var token: String? }
private struct BotQueryResp: Codable { var queryId: String? }

/// WS 帧里的 id 可能是字符串也可能是数字
func botFrameStr(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

/// 机器人公开资料：按 id 缓存（不是机器人也缓存 nil，免得反复请求）
@MainActor
final class BotInfoCache {
    static let shared = BotInfoCache()
    private var cache: [String: BotPublic?] = [:]

    func get(_ key: String) async -> BotPublic? {
        if let hit = cache[key] { return hit }
        let info: BotPublic? = try? await Api.request("/im/bot/info/\(key)")
        cache[key] = .some(info)
        return info
    }

    func forget(_ key: String) { cache.removeValue(forKey: key) }
}

/// 机器人的回应可能比 /im/bot/callback 的 HTTP 响应先到：先缓存，再按 queryId 认领
@MainActor
final class BotCallbacks {
    static let shared = BotCallbacks()
    struct Answer { let text: String; let showAlert: Bool; let url: String }
    private var answers: [String: Answer] = [:]
    private var waiters: [String: CheckedContinuation<Answer?, Never>] = [:]
    private var installed = false

    func install() {
        guard !installed else { return }
        installed = true
        WsClient.shared.addListener { frame in
            guard frame["op"] as? String == "bot_callback_answer",
                  let d = frame["data"] as? [String: Any],
                  let id = botFrameStr(d["queryId"]) else { return }
            let a = Answer(text: d["text"] as? String ?? "", showAlert: d["showAlert"] as? Bool ?? false, url: d["url"] as? String ?? "")
            Task { @MainActor in BotCallbacks.shared.deliver(id, a) }
        }
    }

    private func deliver(_ id: String, _ a: Answer) {
        if let w = waiters.removeValue(forKey: id) { w.resume(returning: a) } else { answers[id] = a }
    }

    func wait(for queryId: String) async -> Answer? {
        if let a = answers.removeValue(forKey: queryId) { return a }
        return await withCheckedContinuation { cont in
            waiters[queryId] = cont
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                Task { @MainActor in
                    BotCallbacks.shared.waiters.removeValue(forKey: queryId)?.resume(returning: nil)
                }
            }
        }
    }
}

struct BotTag: View {
    var body: some View {
        Text("机器人").font(.system(size: 10)).foregroundStyle(botBlue)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 4).fill(botBlue.opacity(0.1)))
    }
}

/// 消息下面的内联按钮：url 按钮在应用内 WebView 打开；回调按钮发给机器人，机器人 answerCallbackQuery 后提示 / 弹窗
struct InlineKeyboardView: View {
    let markup: InlineMarkup?
    let messageId: String
    @State private var busy: String?
    @State private var alertText: String?
    @State private var webTarget: LinkTarget?
    @State private var tip: String?

    private var rows: [[InlineButton]] { (markup?.inlineKeyboard ?? []).filter { !$0.isEmpty } }

    var body: some View {
        if !rows.isEmpty && !messageId.hasPrefix("local_") && !messageId.hasPrefix("t_") {
            VStack(spacing: 4) {
                ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                    HStack(spacing: 4) {
                        ForEach(Array(row.enumerated()), id: \.offset) { j, b in
                            button(b, key: "\(i)-\(j)")
                        }
                    }
                }
                if let tip {
                    Text(tip).font(.system(size: 13)).foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Capsule().fill(Color.black.opacity(0.75)))
                        .transition(.opacity)
                }
            }
            .padding(.top, 4)
            .fullScreenCover(item: $webTarget) { t in
                WebPreviewSheet(url: t.url, title: t.url.host ?? "网页")
            }
            .alert(alertText ?? "", isPresented: Binding(get: { alertText != nil }, set: { if !$0 { alertText = nil } })) {
                Button("好", role: .cancel) { alertText = nil }
            }
        }
    }

    private func button(_ b: InlineButton, key: String) -> some View {
        Button { press(b, key: key) } label: {
            Text(busy == key ? "…" : (b.text ?? "")).font(.system(size: 14)).foregroundStyle(botBlue).lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 6).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 8).fill(botBlue.opacity(busy == key ? 0.05 : 0.1)))
                .overlay(alignment: .topTrailing) {
                    if b.url != nil {
                        Image(systemName: "arrow.up.right").font(.system(size: 8)).foregroundStyle(botBlue).padding(4)
                    }
                }
        }
        .buttonStyle(.plain)
    }

    private func open(_ s: String) {
        guard let u = URL(string: s) else { return }
        if u.scheme == "http" || u.scheme == "https" { webTarget = LinkTarget(url: u) } else { UIApplication.shared.open(u) }
    }

    private func showTip(_ t: String) {
        withAnimation { tip = t }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { withAnimation { if tip == t { tip = nil } } }
    }

    private func press(_ b: InlineButton, key: String) {
        if let u = b.url { open(u); return }
        guard let data = b.callbackData, busy == nil else { return }
        busy = key
        Task { @MainActor in
            BotCallbacks.shared.install()
            do {
                let r: BotQueryResp = try await Api.request("/im/bot/callback", method: "POST", body: ["messageId": messageId, "data": data])
                if let q = r.queryId, let a = await BotCallbacks.shared.wait(for: q) {
                    if !a.url.isEmpty { open(a.url) }
                    if !a.text.isEmpty { if a.showAlert { alertText = a.text } else { showTip(a.text) } }
                }
            } catch {
                showTip(error.localizedDescription)
            }
            busy = nil
        }
    }
}

/// 群 / 频道里管理机器人：按用户名添加（可从我的机器人里点选），已加入的可移出
struct AddBotSheet: View {
    let groupId: String
    var channel = false
    var onChanged: () -> Void = {}

    private struct Member: Codable, Identifiable {
        var id: String = ""
        var nickname: String? = ""
        var avatar: String? = ""
        var isBot: Bool? = false
    }
    private struct Members: Codable { var members: [Member]? = [] }

    @State private var username = ""
    @State private var inChat: [Member] = []
    @State private var mine: [MyBot] = []
    @State private var toastMsg: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(channel ? "频道机器人" : "群机器人").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity)
                Text(channel ? "机器人在频道里是管理员，可以发帖，能收到所有帖子" : "机器人默认只收到 /命令 和 @它 的消息（创建者可关闭隐私模式）")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity).padding(.top, 4).padding(.bottom, 12)
                HStack(spacing: 8) {
                    TextField("", text: $username, prompt: Text("机器人用户名，如 @weather_bot").foregroundColor(Theme.textDim))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .foregroundStyle(Theme.text)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                    Button { add(username) } label: {
                        Text("添加").font(.system(size: 14)).foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
                if !inChat.isEmpty {
                    Text("已加入").font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.top, 16).padding(.bottom, 4)
                    ForEach(inChat) { b in
                        HStack(spacing: 10) {
                            AvatarView(url: b.avatar, size: 36)
                            Text(b.nickname ?? "").font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                            BotTag()
                            Spacer()
                            Button("移出") { remove(b) }.font(.system(size: 13)).foregroundStyle(Theme.danger).buttonStyle(.plain)
                        }
                        .padding(.vertical, 6)
                    }
                }
                let addable = mine.filter { m in !inChat.contains { $0.id == m.id } }
                if !addable.isEmpty {
                    Text("我的机器人").font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.top, 16).padding(.bottom, 4)
                    ForEach(addable) { b in
                        HStack(spacing: 10) {
                            AvatarView(url: b.avatar, size: 36)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(b.name ?? "").font(.system(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                                Text("@\(b.username ?? "")").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            }
                            Spacer()
                            Button("添加") { add(b.username ?? "") }.font(.system(size: 13)).foregroundStyle(Theme.accent).buttonStyle(.plain)
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 24)
        }
        .background(Theme.bg)
        .toast($toastMsg)
        .task {
            await load()
            let list: [MyBot] = (try? await Api.request("/im/bots")) ?? []
            mine = list.filter { ($0.status ?? 0) == 0 }
        }
    }

    private func load() async {
        if let r: Members = try? await Api.request("/im/group/\(groupId)") {
            inChat = (r.members ?? []).filter { $0.isBot == true }
        }
    }

    private func add(_ name: String) {
        var u = name.trimmingCharacters(in: .whitespaces)
        if u.hasPrefix("@") { u.removeFirst() }
        guard !u.isEmpty else { return }
        Task {
            do {
                let _: BotOkResp = try await Api.request("/im/group/\(groupId)/bot", method: "POST", body: ["username": u])
                username = ""
                toastMsg = "已添加"
                await load()
                onChanged()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func remove(_ b: Member) {
        Task {
            do {
                let _: BotOkResp = try await Api.request("/im/group/\(groupId)/kick/\(b.id)", method: "POST")
                await load()
                onChanged()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

/// token 只在创建 / 重置时返回一次
private struct TokenSheet: View {
    let token: String
    var onClose: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("机器人 Token").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
            Text("只显示这一次，请马上保存。拿到 token 就能控制这个机器人，不要泄露；泄露了就去重置。")
                .font(.system(size: 13)).foregroundStyle(Theme.textSub)
            Text(token).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg3))
            HStack(spacing: 12) {
                Button {
                    UIPasteboard.general.string = token
                    copied = true
                } label: {
                    Text(copied ? "已复制" : "复制").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .background(Capsule().fill(Theme.accent))
                }
                Button(action: onClose) {
                    Text("我已保存").font(.system(size: 15)).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .background(Capsule().fill(Theme.bg3))
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(Theme.bg)
        .interactiveDismissDisabled()
    }
}

/// 创建机器人
private struct CreateBotSheet: View {
    var onCreated: (MyBot) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var username = ""
    @State private var desc = ""
    @State private var saving = false
    @State private var toastMsg: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("创建机器人").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
            field($name, "名称（聊天里显示的名字）")
                .onChange(of: name) { v in if v.count > 30 { name = String(v.prefix(30)) } }
            field($username, "用户名，以 bot 结尾，如 weather_bot")
                .onChange(of: username) { v in
                    let f = String(v.filter { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" }.prefix(32))
                    if f != v { username = f }
                }
            CompatVerticalTextField(text: $desc, prompt: Text("简介（用户第一次打开聊天时看到）").foregroundColor(Theme.textDim), lineRange: 2...4)
                .foregroundStyle(Theme.text)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                .onChange(of: desc) { v in if v.count > 500 { desc = String(v.prefix(500)) } }
            AccentButton(title: saving ? "创建中…" : "创建") { create() }
                .padding(.top, 6)
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(Theme.bg)
        .toast($toastMsg)
    }

    private func field(_ text: Binding<String>, _ hint: String) -> some View {
        TextField("", text: text, prompt: Text(hint).foregroundColor(Theme.textDim))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .foregroundStyle(Theme.text)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
    }

    private func create() {
        let n = name.trimmingCharacters(in: .whitespaces)
        let u = username.trimmingCharacters(in: .whitespaces)
        guard !saving, !n.isEmpty, !u.isEmpty else { return }
        saving = true
        Task {
            do {
                let b: MyBot = try await Api.request("/im/bots", method: "POST", body: [
                    "name": n, "username": u, "description": desc.trimmingCharacters(in: .whitespacesAndNewlines),
                ])
                onCreated(b)
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
            saving = false
        }
    }
}

/// 我的机器人：列表 + 创建
struct BotsView: View {
    @State private var list: [MyBot]?
    @State private var creating = false
    @State private var created: MyBot?
    @State private var pushRoute: Route?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("机器人可以接入你自己的程序：用 Telegram 兼容的 Bot API 收发消息、发图片、带按钮，能私聊、进群、在频道发帖。现有的 Telegram 机器人代码改一下接口地址就能直接用。")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(5)
                    .padding(.horizontal, 16).padding(.vertical, 8)
                if let l = list {
                    if l.isEmpty {
                        VStack(spacing: 16) {
                            Text("还没有机器人").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            AccentButton(title: "创建第一个机器人") { creating = true }.frame(width: 200)
                        }
                        .frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        ForEach(l) { b in
                            RouteLink(.bot(b.id)) { row(b) }.buttonStyle(.plain)
                        }
                    }
                } else {
                    EmptyHint(text: "加载中…").padding(.top, 30)
                }
            }
        }
        .fullBg()
        .navigationTitle("我的机器人")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("创建") { creating = true }.font(.system(size: 14)).foregroundStyle(Theme.accent)
            }
        }
        .routePush($pushRoute)
        .sheet(isPresented: $creating) {
            CreateBotSheet { b in
                // 等创建弹层收起再弹 token，两个 sheet 同时切换会丢一个
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { created = b }
                Task { await load() }
            }
            .compatDetents(height: 420)
        }
        .sheet(item: $created) { b in
            TokenSheet(token: b.token ?? "") {
                created = nil
                pushRoute = .bot(b.id)
            }
            .compatDetents(height: 320)
        }
        .task { await load() }
    }

    private func load() async { list = (try? await Api.request("/im/bots")) ?? (list ?? []) }

    private func row(_ b: MyBot) -> some View {
        HStack(spacing: 12) {
            AvatarView(url: b.avatar, size: 48)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(b.name ?? "").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    BotTag()
                    if (b.status ?? 0) != 0 { Text("已封禁").font(.system(size: 11)).foregroundStyle(Theme.warn) }
                }
                Text("@\(b.username ?? "") · \((b.webhookUrl ?? "").isEmpty ? "getUpdates" : "Webhook")")
                    .font(.system(size: 13)).foregroundStyle(Theme.textSub)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Theme.textDim)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// 机器人详情：资料、隐私模式、接收状态、token、接入说明
struct BotDetailView: View {
    let botId: String
    @Environment(\.dismiss) private var dismiss
    @State private var bot: MyBot?
    @State private var error = ""
    @State private var editing = false
    @State private var name = ""
    @State private var desc = ""
    @State private var newToken: String?
    @State private var confirmReset = false
    @State private var confirmDelete = false
    @State private var chatTarget: ChatTarget?
    @State private var toastMsg: String?

    var body: some View {
        Group {
            if let b = bot {
                content(b)
            } else {
                EmptyHint(text: error.isEmpty ? "加载中…" : error)
            }
        }
        .fullBg()
        .toast($toastMsg)
        .navigationTitle(bot?.name ?? "机器人")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if let b = bot {
                    Button("聊天") {
                        Task { chatTarget = await openChatWith(userId: b.id, nickname: b.name ?? "") }
                    }
                    .font(.system(size: 14)).foregroundStyle(Theme.accent)
                }
            }
        }
        .fullScreenCover(item: $chatTarget) { ChatRoomSheet(target: $0) }
        .sheet(item: $newToken) { t in
            TokenSheet(token: t) { newToken = nil }.compatDetents(height: 320)
        }
        .alert("重置 Token？", isPresented: $confirmReset) {
            Button("重置", role: .destructive) { resetToken() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("重置后旧 token 立即失效，正在运行的程序要换成新 token")
        }
        .alert("删除机器人？", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) { remove() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除 @\(bot?.username ?? "")？会退出所有群和频道，不能恢复")
        }
        .task { await load() }
    }

    private var apiBase: String { Api.baseURL + "/api" }

    private func content(_ b: MyBot) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 4) {
                    CompatPhotoPicker(kind: .images, onPicked: { datas in
                        guard let data = datas.first else { return }
                        Task {
                            if let url = try? await Api.upload("image", data: data, filename: "bot.jpg", mime: "image/jpeg") {
                                save(["avatar": url])
                            } else {
                                toastMsg = "上传失败"
                            }
                        }
                    }) {
                        AvatarView(url: b.avatar, size: 76)
                    }
                    Text("点头像可修改").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    if editing {
                        TextField("", text: $name, prompt: Text("名称").foregroundColor(Theme.textDim))
                            .foregroundStyle(Theme.text).padding(12)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                            .padding(.top, 10)
                            .onChange(of: name) { v in if v.count > 30 { name = String(v.prefix(30)) } }
                        CompatVerticalTextField(text: $desc, prompt: Text("简介").foregroundColor(Theme.textDim), lineRange: 3...6)
                            .foregroundStyle(Theme.text).padding(12)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg2))
                            .padding(.top, 6)
                            .onChange(of: desc) { v in if v.count > 500 { desc = String(v.prefix(500)) } }
                        HStack(spacing: 20) {
                            Spacer()
                            Button("取消") { editing = false }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            Button("保存") {
                                save(["name": name.trimmingCharacters(in: .whitespaces), "description": desc.trimmingCharacters(in: .whitespacesAndNewlines)])
                            }
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
                        }
                        .padding(.top, 10)
                    } else {
                        HStack(spacing: 6) {
                            Text(b.name ?? "").font(.system(size: 19, weight: .bold)).foregroundStyle(Theme.text)
                            BotTag()
                        }
                        .padding(.top, 8)
                        Text("@\(b.username ?? "")" + ((b.status ?? 0) != 0 ? "  · 已被平台封禁" : ""))
                            .font(.system(size: 13)).foregroundStyle((b.status ?? 0) != 0 ? Theme.warn : Theme.textSub)
                        let d = b.description ?? ""
                        Text(d.isEmpty ? "（无简介）" : d).font(.system(size: 14)).foregroundStyle(d.isEmpty ? Theme.textDim : Theme.text)
                            .lineSpacing(4).multilineTextAlignment(.center).padding(.top, 10)
                        Button("编辑资料") { name = b.name ?? ""; desc = b.description ?? ""; editing = true }
                            .font(.system(size: 13)).foregroundStyle(Theme.accent).padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity)

                card {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("群隐私模式").font(.system(size: 15)).foregroundStyle(Theme.text)
                            Text("开启：群里只收到 /命令 和 @它 的消息；关闭：收到全部群消息")
                                .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                        }
                        Spacer(minLength: 0)
                        let on = b.privacy ?? true
                        Button { save(["privacy": !on]) } label: {
                            Text(on ? "已开启" : "已关闭").font(.system(size: 12)).foregroundStyle(on ? .white : Theme.textSub)
                                .padding(.horizontal, 14).padding(.vertical, 5)
                                .background(Capsule().fill(on ? Theme.accent : Theme.bg3))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 12)
                    Rectangle().fill(Theme.line).frame(height: 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("接收方式").font(.system(size: 15)).foregroundStyle(Theme.text)
                        let hook = b.webhookUrl ?? ""
                        Text((hook.isEmpty ? "getUpdates 轮询（没有设置 Webhook）" : "Webhook：\(hook)") + " · 待取消息 \(b.pendingUpdates ?? 0) 条")
                            .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                        if let e = b.lastError, !e.isEmpty {
                            Text("最近一次推送失败：\(e)").font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                    Rectangle().fill(Theme.line).frame(height: 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("命令菜单").font(.system(size: 15)).foregroundStyle(Theme.text)
                        let cmds = b.commands ?? []
                        Text(cmds.isEmpty ? "还没设置，程序里调用 setMyCommands 设置" : cmds.map { "/\($0.command) \($0.description ?? "")" }.joined(separator: "\n"))
                            .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                }
                .padding(.top, 16)

                card {
                    menuRow("重置 Token", Theme.text) { confirmReset = true }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    menuRow("删除机器人", Theme.danger) { confirmDelete = true }
                }
                .padding(.top, 12)

                Text("接入说明").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).padding(.top, 20).padding(.bottom, 6)
                Text("接口和 Telegram Bot API 一样，只是地址换成：\n\(apiBase)/bot<token>/方法名\n\n"
                    + "支持 getMe、getUpdates、setWebhook、deleteWebhook、getWebhookInfo、sendMessage、sendPhoto、editMessageText、editMessageReplyMarkup、deleteMessage、answerCallbackQuery、setMyCommands、getChat、getFile 等。"
                    + "按钮只支持 inline_keyboard（url / callback_data）。chat_id：私聊是用户 id，群和频道是负数。用户要先给机器人发过消息，机器人才能私聊他。\n\n"
                    + "Python（python-telegram-bot）：base_url 设为 \(apiBase)/bot，base_file_url 设为 \(apiBase)/file/bot\n"
                    + "Node.js（Telegraf）：telegram.apiRoot 设为 \(apiBase)\n\n"
                    + "Webhook 需要 https 公网地址；设置 secret_token 后每次推送都会带 X-Telegram-Bot-Api-Secret-Token 头。")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(5)
                    .textSelection(.enabled)
                Spacer(minLength: 30)
            }
            .padding(16)
        }
    }

    private func card<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack(spacing: 0) { c() }
            .padding(.horizontal, 14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
    }

    private func menuRow(_ label: String, _ color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 15)).foregroundStyle(color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        do {
            let b: MyBot = try await Api.request("/im/bots/\(botId)")
            bot = b
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ body: [String: Any]) {
        Task {
            do {
                let b: MyBot = try await Api.request("/im/bots/\(botId)", method: "PUT", body: body)
                bot = b
                editing = false
                await BotInfoCache.shared.forget(botId)
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func resetToken() {
        Task {
            do {
                let r: BotTokenResp = try await Api.request("/im/bots/\(botId)/token", method: "POST")
                newToken = r.token
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }

    private func remove() {
        Task {
            do {
                let _: BotOkResp = try await Api.request("/im/bots/\(botId)/delete", method: "POST")
                await BotInfoCache.shared.forget(botId)
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}
