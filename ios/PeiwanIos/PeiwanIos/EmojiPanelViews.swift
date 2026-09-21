import SwiftUI
import UIKit

// MARK: - Emoji 数据

/// 一组 emoji：items 每项 [emoji, 中文名, 关键词]
struct EmojiGroup: Codable, Identifiable, Hashable {
    var key: String
    var name: String
    var icon: String
    var items: [[String]] = []
    var id: String { key }
}

private struct EmojiResp: Codable {
    var version: Int? = 0
    var notModified: Bool? = false
    var groups: [EmojiGroup]? = []
}

/// Unicode emoji 分类数据（后端 /emojis，UserDefaults 缓存按 version 增量）+ 最近使用
@MainActor
final class EmojiStore: ObservableObject {
    static let shared = EmojiStore()
    @Published var groups: [EmojiGroup] = []
    @Published var recent: [String] = (UserDefaults.standard.array(forKey: "emoji_recent") as? [String]) ?? []
    private var version = 0
    private var fetched = false

    private init() {
        version = UserDefaults.standard.integer(forKey: "emoji_version")
        if let data = UserDefaults.standard.data(forKey: "emoji_groups"), let g = try? JSONDecoder().decode([EmojiGroup].self, from: data) { groups = g }
    }

    func ensureLoaded() async {
        if fetched && !groups.isEmpty { return }
        let path = version > 0 ? "/emojis?ver=\(version)" : "/emojis"
        guard let r: EmojiResp = try? await Api.request(path) else { return }
        fetched = true
        if r.notModified == true, !groups.isEmpty { return }
        guard let g = r.groups, !g.isEmpty else { return }
        version = r.version ?? 0
        groups = g
        UserDefaults.standard.set(version, forKey: "emoji_version")
        if let data = try? JSONEncoder().encode(groups) { UserDefaults.standard.set(data, forKey: "emoji_groups") }
    }

    func addRecent(_ e: String) {
        recent = ([e] + recent.filter { $0 != e }).prefix(32).map { $0 }
        UserDefaults.standard.set(recent, forKey: "emoji_recent")
    }

    /// 关键词搜索（中英文，空格分词全部命中）
    func search(_ q: String, limit: Int = 120) -> [String] {
        let words = q.trimmingCharacters(in: .whitespaces).lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if words.isEmpty { return [] }
        var out: [String] = []
        for g in groups {
            for it in g.items {
                let hay = ((it.count > 1 ? it[1] : "") + " " + (it.count > 2 ? it[2] : "")).lowercased()
                if words.allSatisfy({ hay.contains($0) || it[0] == $0 }) {
                    out.append(it[0])
                    if out.count >= limit { return out }
                }
            }
        }
        return out
    }
}

/// 删掉字符串末尾一个「用户看到的字符」（emoji 可能由多个码点 + ZWJ 组成；Swift 的 Character 就是字素簇）
func dropLastGrapheme(_ s: String) -> String {
    s.isEmpty ? s : String(s.dropLast())
}

/// 记住键盘高度：面板要跟键盘差不多高
@MainActor
final class KeyboardHeight: ObservableObject {
    static let shared = KeyboardHeight()
    @Published var last: CGFloat = CGFloat(UserDefaults.standard.double(forKey: "kb_height"))
    private var token: NSObjectProtocol?

    private init() {
        token = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] n in
            guard let f = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, f.height > 200 else { return }
            Task { @MainActor in
                self?.last = f.height
                UserDefaults.standard.set(Double(f.height), forKey: "kb_height")
            }
        }
    }

    /// 面板高度（去掉底部安全区；没记录过用 336）
    var panelHeight: CGFloat {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let bottom = scene?.windows.first?.safeAreaInsets.bottom ?? 0
        let h = last > 0 ? last - bottom : 336
        return min(440, max(320, h))
    }
}

// MARK: - 面板壳

enum PanelMode: String { case gif, sticker, emoji }

/// 内容区滚动方向 → 顶部条 / 底部胶囊收起或展开（往下滚收起，往上滚或回到顶部展开）
/// 不标 @MainActor：onPreferenceChange 的回调在新 SDK 里是 @Sendable，回调本身就在主线程
final class PanelChrome: ObservableObject {
    @Published var hidden = false
    private var last: CGFloat = 0

    /// minY 为内容顶部在滚动坐标系里的位置（往下滚为负）
    func onOffset(_ minY: CGFloat) {
        let top = -minY
        defer { last = top }
        if top < 12 { if hidden { hidden = false }; return }
        let d = top - last
        if d > 8 { if !hidden { hidden = true } } else if d < -8 { if hidden { hidden = false } }
    }

    func reset() { last = 0; hidden = false }
}

private struct OffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct SectionsKey: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) { value.merge(nextValue()) { $1 } }
}

/// 搜索行右侧的快捷 emoji（Telegram 同款）：贴纸按 emoji 过滤，GIF 当搜索词
private let quickEmojis = ["❤️", "👍", "👎", "🎉", "👋", "😀", "😢", "😠"]

/// 底部 sheet 请求：商店 / 管理 / GIF 搜索 / 表情搜索。query 非 nil = 从搜索行进来（"" 只聚焦搜索框，emoji 直接带着搜）
private enum SheetKind { case store, manage, gif, emoji }
private struct SheetReq: Identifiable {
    var kind: SheetKind
    var query: String? = nil
    var id: String { "\(kind)-\(query ?? "<nil>")" }
}

/**
 表情面板（Telegram 式，三端同一套）：底部悬浮胶囊切 GIF / 贴纸 / 表情，内容往下滚时胶囊和顶部条一起收起。
 - 表情：点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 - 贴纸 / GIF：点了回调 onPick（聊天里即发送，评论里挂到待发区），右 ⚙ 管理我的贴纸
 */
struct EmojiPanel: View {
    var onPick: (StickerPayload) -> Void
    var onEmoji: ((String) -> Void)? = nil
    var onDelete: (() -> Void)? = nil
    var onKeyboard: (() -> Void)? = nil

    @State private var mode: PanelMode = PanelMode(rawValue: UserDefaults.standard.string(forKey: "emoji_panel_mode") ?? "") ?? .sticker
    @StateObject private var chrome = PanelChrome()
    @ObservedObject private var kb = KeyboardHeight.shared
    @State private var sheet: SheetReq? = nil

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch mode {
                case .sticker: StickerPane(chrome: chrome, onPick: pick, onStore: { q in sheet = SheetReq(kind: .store, query: q) })
                case .gif: GifPane(chrome: chrome, onPick: pick, onSearch: { q in sheet = SheetReq(kind: .gif, query: q) })
                case .emoji: EmojiPane(chrome: chrome, onEmoji: pickEmoji, onSearch: { q in sheet = SheetReq(kind: .emoji, query: q) })
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // 底部悬浮：左 🌐（表情）/ 胶囊 / 右 ⌫（表情）或 ⚙（贴纸）
            HStack {
                if mode == .emoji, let onKeyboard {
                    sideBtn(action: onKeyboard) { Image(systemName: "globe").font(.system(size: 18)) }
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
                Spacer()
                HStack(spacing: 2) {
                    pillItem(.gif, "GIF"); pillItem(.sticker, "贴纸"); pillItem(.emoji, "表情")
                }
                .padding(3)
                .background(Capsule().fill(Theme.bg).shadow(color: .black.opacity(0.14), radius: 6, y: 2))
                .overlay(Capsule().stroke(Theme.line, lineWidth: 0.5))
                Spacer()
                if mode == .emoji, let onDelete {
                    sideBtn(action: onDelete) { Image(systemName: "delete.left").font(.system(size: 17)) }
                } else if mode == .sticker {
                    sideBtn(action: { sheet = SheetReq(kind: .manage) }) { Image(systemName: "gearshape").font(.system(size: 17)) }
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 10)
            .offset(y: chrome.hidden ? 70 : 0)
            .opacity(chrome.hidden ? 0 : 1)
            .allowsHitTesting(!chrome.hidden)
            .animation(.easeInOut(duration: 0.2), value: chrome.hidden)
        }
        .frame(height: kb.panelHeight)
        .background(Theme.bg2)
        .clipped()
        .onChange(of: mode) { m in chrome.reset(); UserDefaults.standard.set(m.rawValue, forKey: "emoji_panel_mode") }
        .sheet(item: $sheet) { r in
            switch r.kind {
            case .store, .manage: StickerStoreSheet(manage: r.kind == .manage, initialQuery: r.query ?? "", focusSearch: r.query != nil)
            case .gif: GifSearchSheet(initialQuery: r.query ?? "", onPick: pick)
            case .emoji: EmojiSearchSheet(initialQuery: r.query ?? "", onEmoji: pickEmoji)
            }
        }
    }

    private func pick(_ p: StickerPayload) {
        onPick(p)
        StickerStore.shared.addRecent(p)
    }

    private func pickEmoji(_ e: String) {
        onEmoji?(e)
        EmojiStore.shared.addRecent(e)
    }

    private func pillItem(_ m: PanelMode, _ label: String) -> some View {
        let on = mode == m
        return Text(label)
            .font(.system(size: 14, weight: on ? .semibold : .regular))
            .foregroundStyle(on ? Theme.text : Theme.textSub)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(on ? Theme.bg3 : Color.clear))
            .contentShape(Capsule())
            .onTapGesture { mode = m }
    }

    private func sideBtn<C: View>(action: @escaping () -> Void, @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            content()
                .foregroundStyle(Theme.text)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Theme.bg).shadow(color: .black.opacity(0.14), radius: 6, y: 2))
                .overlay(Circle().stroke(Theme.line, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 公共小件

/// 顶部条上的一个格子（图标 / 封面），expanded 时下面带名字
private struct BarCell<C: View>: View {
    var active: Bool
    var expanded: Bool
    var title: String
    var badge = false
    var action: () -> Void
    @ViewBuilder var content: () -> C

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                ZStack(alignment: .topTrailing) {
                    content().frame(width: 30, height: 30)
                    if badge {
                        Text("+").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 14, height: 14).background(Circle().fill(Theme.accent))
                            .offset(x: 4, y: -3)
                    }
                }
                if expanded {
                    Text(title).font(.system(size: 10)).foregroundStyle(Theme.textSub).lineLimit(1).frame(maxWidth: 54)
                }
            }
            .frame(width: expanded ? 56 : 40, height: expanded ? 64 : 40)
            .background(RoundedRectangle(cornerRadius: 10).fill(active ? Theme.bg3 : Color.clear))
        }
        .buttonStyle(.plain)
    }
}

/**
 搜索行（Telegram 图）：一整条圆角胶囊，左边 🔍「搜索」，右边一排**虚化**的快捷 emoji。
 - 贴纸页传 onTap：整条胶囊是个按钮（和「+」一样弹表情商店 sheet 并聚焦搜索框），点快捷 emoji 直接带着它去搜；
 - 表情 / GIF 页不传：点胶囊变成输入框就地搜，快捷 emoji 点亮一个当过滤词。
 */
private struct SearchRow: View {
    @Binding var text: String
    @Binding var chip: String
    var placeholder: String
    var onTap: (() -> Void)? = nil

    @FocusState private var focused: Bool
    private var editing: Bool { onTap == nil && (focused || !text.isEmpty) }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textDim)
            if onTap != nil {
                Text(placeholder).font(.system(size: 14)).foregroundStyle(Theme.textDim)
            } else {
                TextField(placeholder, text: $text).font(.system(size: 14)).foregroundStyle(Theme.text)
                    .focused($focused)
                    .frame(width: editing ? nil : 44)
            }
            if editing {
                Spacer(minLength: 0)
                Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    .frame(width: 26, height: 26).contentShape(Rectangle())
                    .onTapGesture { text = ""; chip = ""; focused = false }
            } else {
                Spacer(minLength: 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(quickEmojis, id: \.self) { e in
                            let on = chip == e
                            Text(e).font(.system(size: 19))
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(on ? Theme.bg : Color.clear))
                                // 虚化：灰度 + 半透明，被选中的那个恢复彩色
                                .grayscale(on ? 0 : 1)
                                .opacity(on ? 1 : 0.45)
                                .contentShape(Rectangle())
                                .onTapGesture { chip = on ? "" : e }
                        }
                    }
                }
                .frame(maxWidth: 8 * 32)
            }
        }
        .padding(.leading, 12).padding(.trailing, 6).frame(height: 32)
        .background(Capsule().fill(Theme.bg3))
        .contentShape(Capsule())
        .onTapGesture { if let onTap { onTap() } else { focused = true } }
        .padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 8)
        .frame(height: 44)
    }
}

private func sectionTitle(_ title: String) -> some View {
    Text(title.uppercased()).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSub).lineLimit(1)
}

private func emptyText(_ t: String) -> some View {
    Text(t).font(.system(size: 13)).foregroundStyle(Theme.textDim).frame(maxWidth: .infinity).padding(.vertical, 24)
}

/// 顶部横向条被用户拖动时展开成两行（图 5），松手 1.5 秒后收回
private final class BarExpand: ObservableObject {
    @Published var expanded = false
    private var task: Task<Void, Never>?
    func touch() {
        expanded = true
        task?.cancel()
        task = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { self?.expanded = false }
        }
    }
    func collapse() { task?.cancel(); expanded = false }
}

private func baseEmoji(_ e: String) -> String { e.replacingOccurrences(of: "\u{FE0F}", with: "") }

private func actionBtn(_ label: String, primary: Bool, busy: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        Text(label).font(.system(size: 13, weight: .medium))
            .foregroundStyle(primary ? .white : Theme.text)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Capsule().fill(primary ? Theme.accent : Theme.bg3))
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .opacity(busy ? 0.5 : 1)
}

// MARK: - 贴纸页

private struct StickerSection: Identifiable {
    var key: String
    var title: String
    var items: [StickerPayload]
    var id: String { key }
}

/// 贴纸页：顶部条（⊕ 商店 / 🕒 最近 / 我的包封面… / 库里没加的带 +）+ 搜索行，
/// 内容是所有包连续滚动、每包一个标题分区；滚到哪个包顶部封面跟着亮。
/// 搜索行整条是按钮：和「+」一样弹表情商店 sheet（onStore("") 聚焦搜索框）；点快捷 emoji 带着它去搜（onStore(emoji)）。
private struct StickerPane: View {
    @ObservedObject var chrome: PanelChrome
    var onPick: (StickerPayload) -> Void
    var onStore: (String?) -> Void

    @ObservedObject private var store = StickerStore.shared
    @StateObject private var bar = BarExpand()
    @State private var active = "recent"
    @State private var adding: Int? = nil
    /// 搜索行是按钮，这两个只是占位给 SearchRow 的绑定
    @State private var noText = ""
    @State private var chipTap = ""

    private var sections: [StickerSection] {
        var out: [StickerSection] = []
        if !store.recent.isEmpty { out.append(StickerSection(key: "recent", title: "最近使用", items: store.recent)) }
        out += store.mineSets.map { StickerSection(key: "s\($0.id)", title: $0.title ?? "", items: $0.items) }
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            if !chrome.hidden {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 2) {
                                BarCell(active: false, expanded: bar.expanded, title: "表情商店", action: { onStore(nil) }) {
                                    Image(systemName: "plus.circle").font(.system(size: 22)).foregroundStyle(Theme.textSub)
                                }
                                BarCell(active: active == "recent", expanded: bar.expanded, title: "最近使用", action: { jump("recent") }) {
                                    Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(Theme.textSub)
                                }.id("recent")
                                ForEach(store.mineSets) { s in
                                    BarCell(active: active == "s\(s.id)", expanded: bar.expanded, title: s.title ?? "", action: { jump("s\(s.id)") }) { cover(s) }
                                        .id("s\(s.id)")
                                }
                                ForEach(store.otherSets.prefix(12)) { s in
                                    BarCell(active: false, expanded: bar.expanded, title: s.title ?? "", badge: true, action: { add(s.id) }) {
                                        cover(s).opacity(adding == s.id ? 0.4 : 1)
                                    }
                                }
                            }
                            .padding(.horizontal, 6).padding(.vertical, 6)
                        }
                        .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in bar.touch() })
                        .onChange(of: active) { k in withAnimation { proxy.scrollTo(k, anchor: .center) } }
                    }
                    .frame(height: bar.expanded ? 76 : 52)
                    .animation(.easeInOut(duration: 0.15), value: bar.expanded)
                    SearchRow(text: $noText, chip: $chipTap, placeholder: "搜索", onTap: { onStore("") })
                        .onChange(of: chipTap) { e in if !e.isEmpty { chipTap = ""; onStore(e) } }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            ScrollViewReader { proxy in
                ScrollView {
                    GeometryReader { g in Color.clear.preference(key: OffsetKey.self, value: g.frame(in: .named("stkScroll")).minY) }.frame(height: 0)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        let secs = sections
                        if secs.isEmpty {
                            VStack(spacing: 10) {
                                Text(store.mineSets.isEmpty ? "还没有贴纸包" : "还没用过贴纸，往下挑一个")
                                    .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                                if store.mineSets.isEmpty {
                                    Button("去表情商店添加") { onStore(nil) }.font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
                                        .padding(.horizontal, 16).padding(.vertical, 7).background(Capsule().fill(Theme.accent)).buttonStyle(.plain)
                                }
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                        }
                        ForEach(secs) { s in
                            HStack {
                                sectionTitle(s.title)
                                Spacer()
                            }
                            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                            .id("h-\(s.key)")
                            .background(GeometryReader { g in Color.clear.preference(key: SectionsKey.self, value: [s.key: g.frame(in: .named("stkScroll")).minY]) })
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 5), spacing: 6) {
                                ForEach(s.items) { p in
                                    StickerThumbView(p: p, size: 62)
                                        .frame(maxWidth: .infinity)
                                        .aspectRatio(1, contentMode: .fit)
                                        .contentShape(Rectangle())
                                        .onTapGesture { onPick(p) }
                                }
                            }
                            .padding(.horizontal, 8)
                        }
                        Color.clear.frame(height: 64)
                    }
                }
                .coordinateSpace(name: "stkScroll")
                .onPreferenceChange(OffsetKey.self) { chrome.onOffset($0) }
                .onPreferenceChange(SectionsKey.self) { dict in
                    if let k = dict.filter({ $0.value <= 8 }).max(by: { $0.value < $1.value })?.key { active = k }
                    else if let first = sections.first?.key, dict[first] != nil { active = first }
                }
                .onChange(of: jumpTarget) { t in
                    guard let t else { return }
                    withAnimation { proxy.scrollTo("h-\(t)", anchor: .top) }
                    jumpTarget = nil
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: chrome.hidden)
        .task { await store.ensureLoaded(); await store.loadMine() }
    }

    @State private var jumpTarget: String? = nil

    private func jump(_ key: String) {
        bar.collapse()
        active = key
        jumpTarget = key
    }

    private func add(_ id: Int) {
        adding = id
        Task { try? await store.addMine(id); adding = nil }
    }

    @ViewBuilder
    private func cover(_ s: StickerSetItem) -> some View {
        if let t = s.thumb, !t.isEmpty {
            RemoteImage(url: t).frame(width: 28, height: 28)
        } else {
            Text(String((s.title ?? "").prefix(2))).font(.system(size: 11)).foregroundStyle(Theme.textSub)
        }
    }
}

// MARK: - 表情页

/// 表情页：顶部 🕒 + 8 个分类图标，搜索行，内容 8 列按分类分区。
/// 搜索行整条是按钮：和贴纸页一样弹搜索 sheet（onSearch("") 聚焦输入框；点快捷 emoji 带着它去搜）。
/// 网格不用 LazyVGrid 嵌在 LazyVStack 里（嵌套后失去懒加载，1800 多个 emoji 一次建完，往下滑会卡死），改成每 8 个一行、行作为 LazyVStack 的元素。
private struct EmojiPane: View {
    @ObservedObject var chrome: PanelChrome
    var onEmoji: (String) -> Void
    var onSearch: (String) -> Void

    @ObservedObject private var store = EmojiStore.shared
    @StateObject private var bar = BarExpand()
    @State private var active = "recent"
    @State private var jumpTarget: String? = nil
    @State private var noText = ""
    @State private var chipTap = ""

    var body: some View {
        VStack(spacing: 0) {
            if !chrome.hidden {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 2) {
                                BarCell(active: active == "recent", expanded: bar.expanded, title: "最近使用", action: { jump("recent") }) {
                                    Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(Theme.textSub)
                                }.id("recent")
                                ForEach(store.groups) { g in
                                    BarCell(active: active == g.key, expanded: bar.expanded, title: g.name, action: { jump(g.key) }) {
                                        Text(g.icon).font(.system(size: 20)).opacity(active == g.key ? 1 : 0.6)
                                    }.id(g.key)
                                }
                            }
                            .padding(.horizontal, 6).padding(.vertical, 6)
                        }
                        .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in bar.touch() })
                        .onChange(of: active) { k in withAnimation { proxy.scrollTo(k, anchor: .center) } }
                    }
                    .frame(height: bar.expanded ? 76 : 52)
                    .animation(.easeInOut(duration: 0.15), value: bar.expanded)
                    SearchRow(text: $noText, chip: $chipTap, placeholder: "搜索表情", onTap: { onSearch("") })
                        .onChange(of: chipTap) { e in if !e.isEmpty { chipTap = ""; onSearch(e) } }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            ScrollViewReader { proxy in
                ScrollView {
                    GeometryReader { g in Color.clear.preference(key: OffsetKey.self, value: g.frame(in: .named("emojiScroll")).minY) }.frame(height: 0)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !store.recent.isEmpty {
                            header("recent", "最近使用")
                            EmojiRows(items: store.recent, onEmoji: onEmoji)
                        }
                        ForEach(store.groups) { g in
                            header(g.key, g.name)
                            EmojiRows(items: g.items.map { $0[0] }, onEmoji: onEmoji)
                        }
                        if store.groups.isEmpty { emptyText("加载中…") }
                        Color.clear.frame(height: 64)
                    }
                }
                .coordinateSpace(name: "emojiScroll")
                .onPreferenceChange(OffsetKey.self) { chrome.onOffset($0) }
                .onPreferenceChange(SectionsKey.self) { dict in
                    if let k = dict.filter({ $0.value <= 8 }).max(by: { $0.value < $1.value })?.key, k != active { active = k }
                }
                .onChange(of: jumpTarget) { t in
                    guard let t else { return }
                    withAnimation { proxy.scrollTo("h-\(t)", anchor: .top) }
                    jumpTarget = nil
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: chrome.hidden)
        .task { await store.ensureLoaded() }
    }

    private func header(_ key: String, _ title: String) -> some View {
        sectionTitle(title)
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id("h-\(key)")
            .background(GeometryReader { g in Color.clear.preference(key: SectionsKey.self, value: [key: g.frame(in: .named("emojiScroll")).minY]) })
    }

    private func jump(_ key: String) {
        bar.collapse()
        active = key
        jumpTarget = key
    }
}

/// emoji 网格：每 8 个一行，每行是 LazyVStack 的一个元素（真正懒加载）；最后一行不满用空格子补齐保持等宽
private struct EmojiRows: View {
    let items: [String]
    var onEmoji: (String) -> Void
    private let cols = 8

    var body: some View {
        let rows = stride(from: 0, to: items.count, by: cols).map { Array(items[$0..<min($0 + cols, items.count)]) }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            HStack(spacing: 0) {
                ForEach(Array(row.enumerated()), id: \.offset) { _, e in
                    Text(e).font(.system(size: 26))
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .contentShape(Rectangle())
                        .onTapGesture { onEmoji(e) }
                }
                if row.count < cols {
                    ForEach(0..<(cols - row.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity).frame(height: 42) }
                }
            }
            .padding(.horizontal, 6)
        }
    }
}

// MARK: - GIF 页

/// GIF 页：没有顶部封面条，只有搜索行；内容 3 列瓦片（最近使用 + 热门），滚到底自动翻页。
/// 搜索行整条是按钮：和贴纸页一样弹搜索 sheet。
private struct GifPane: View {
    @ObservedObject var chrome: PanelChrome
    var onPick: (StickerPayload) -> Void
    var onSearch: (String) -> Void

    @ObservedObject private var store = StickerStore.shared
    @StateObject private var feed = GifFeed()
    @State private var noText = ""
    @State private var chipTap = ""

    var body: some View {
        VStack(spacing: 0) {
            if !chrome.hidden {
                SearchRow(text: $noText, chip: $chipTap, placeholder: "搜索 GIF", onTap: { onSearch("") })
                    .onChange(of: chipTap) { e in if !e.isEmpty { chipTap = ""; onSearch(e) } }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            ScrollView {
                GeometryReader { g in Color.clear.preference(key: OffsetKey.self, value: g.frame(in: .named("gifScroll")).minY) }.frame(height: 0)
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !store.recentGifs.isEmpty {
                        sectionTitle("最近使用").padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                        GifGrid(items: store.recentGifs, onPick: onPick, onNearEnd: nil)
                    }
                    sectionTitle("热门").padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                    GifGrid(items: feed.items, onPick: onPick, onNearEnd: { feed.more() })
                    GifFooter(feed: feed, emptyHint: "暂无 GIF")
                    Color.clear.frame(height: 64)
                }
            }
            .coordinateSpace(name: "gifScroll")
            .onPreferenceChange(OffsetKey.self) { chrome.onOffset($0) }
        }
        .animation(.easeInOut(duration: 0.18), value: chrome.hidden)
        .task { await feed.load("") }
    }
}

/// 一路 GIF 结果（热门或某个搜索词）：首页 + 翻页 + 首次搜索 3 秒后补拉
@MainActor
private final class GifFeed: ObservableObject {
    @Published var items: [StickerPayload] = []
    @Published var next = ""
    @Published var loading = false
    @Published var error = ""
    private(set) var query = ""
    private var seq = 0

    func load(_ q: String) async {
        query = q
        seq += 1
        let my = seq
        loading = true; error = ""
        do {
            let (list, n) = try await StickerStore.shared.searchGifs(q)
            guard my == seq else { return }
            items = list; next = n; loading = false
            // 首次搜索后端还在后台补齐时结果会少，3 秒后再拉一次
            if list.count < 10, !n.isEmpty {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard my == seq else { return }
                if let r = try? await StickerStore.shared.searchGifs(q), r.0.count > list.count { items = r.0; next = r.1 }
            }
        } catch {
            guard my == seq else { return }
            self.error = error.localizedDescription; loading = false
        }
    }

    func more() {
        guard !loading, !next.isEmpty else { return }
        loading = true
        let my = seq
        Task {
            defer { if my == seq { loading = false } }
            guard let r = try? await StickerStore.shared.searchGifs(query, offset: next), my == seq else { return }
            let seen = Set(items.map(\.id))
            items += r.0.filter { !seen.contains($0.id) }
            next = r.1
        }
    }
}

/// 3 列正方形瓦片：格子先用 Color.clear 定成正方形再叠图（UIViewRepresentable 自己报的尺寸不一致会让行错位）
private struct GifGrid: View {
    let items: [StickerPayload]
    var onPick: (StickerPayload) -> Void
    var onNearEnd: (() -> Void)?
    private let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    var body: some View {
        LazyVGrid(columns: cols, spacing: 2) {
            ForEach(items) { p in
                Color.clear
                    .aspectRatio(1, contentMode: .fit)
                    .background(Theme.bg3)
                    .overlay(AnimatedImageView(url: Api.fullUrl((p.thumb ?? "").isEmpty ? p.url : p.thumb!), animate: true, fill: true))
                    .clipped()
                    .contentShape(Rectangle())
                    .onTapGesture { onPick(p) }
                    .onAppear { if let onNearEnd, p.id == items.suffix(6).first?.id { onNearEnd() } }
            }
        }
    }
}

private struct GifFooter: View {
    @ObservedObject var feed: GifFeed
    var emptyHint: String
    var body: some View {
        if feed.loading { emptyText(feed.items.isEmpty ? "正在拉取 GIF，第一次会慢几秒…" : "加载更多…") }
        else if !feed.error.isEmpty { emptyText(feed.error) }
        else if feed.items.isEmpty { emptyText(emptyHint) }
    }
}

// MARK: - 搜索 sheet（GIF / 表情，和贴纸「点搜索弹框」一致）

/// 搜索 sheet 外壳：顶部搜索框（自动聚焦）+「完成」，一行快捷 emoji（点了当搜索词），下面放结果
private struct SearchSheetShell<Content: View>: View {
    var placeholder: String
    @Binding var query: String
    var autoFocus = true
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.textDim)
                    TextField(placeholder, text: $query).font(.system(size: 15)).foregroundStyle(Theme.text).focused($focused)
                    if !query.isEmpty {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.textDim).onTapGesture { query = "" }
                    }
                }
                .padding(.horizontal, 10).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                Button("完成") { dismiss() }.font(.system(size: 16)).foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(quickEmojis, id: \.self) { e in
                        let on = baseEmoji(query.trimmingCharacters(in: .whitespaces)) == baseEmoji(e)
                        Text(e).font(.system(size: 22))
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(on ? Theme.bg3 : Color.clear))
                            .grayscale(on ? 0 : 1).opacity(on ? 1 : 0.5)
                            .contentShape(Rectangle())
                            .onTapGesture { query = on ? "" : e }
                    }
                }
                .padding(.horizontal, 12)
            }
            .frame(height: 40)
            content()
        }
        .background(Theme.bg.ignoresSafeArea())
        .onAppear { if autoFocus { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { focused = true } } }
    }
}

/// GIF 搜索 sheet：输入防抖 400ms，快捷 emoji 立即；3 列瓦片，滚到底翻页；点了 GIF 回调并关闭
struct GifSearchSheet: View {
    var initialQuery: String
    var onPick: (StickerPayload) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var q = ""
    @StateObject private var feed = GifFeed()

    private var query: String { q.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        SearchSheetShell(placeholder: "搜索 GIF", query: $q) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if query.isEmpty { sectionTitle("热门").padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4) }
                    GifGrid(items: feed.items, onPick: { p in onPick(p); dismiss() }, onNearEnd: { feed.more() })
                    GifFooter(feed: feed, emptyHint: query.isEmpty ? "暂无 GIF" : "没有找到相关 GIF")
                    Color.clear.frame(height: 30)
                }
            }
        }
        .onAppear { q = initialQuery }
        .task(id: query) {
            // 输入防抖 400ms；空 / 快捷 emoji 立即
            if !query.isEmpty, !quickEmojis.contains(query) { try? await Task.sleep(nanoseconds: 400_000_000) }
            if Task.isCancelled { return }
            await feed.load(query)
        }
    }
}

/// 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起
struct EmojiSearchSheet: View {
    var initialQuery: String
    var onEmoji: (String) -> Void
    @ObservedObject private var store = EmojiStore.shared
    @State private var q = ""

    private var query: String { q.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        // 打开时不自动弹键盘：先看最近使用 / 快捷 emoji，要搜再点输入框
        SearchSheetShell(placeholder: "搜索表情", query: $q, autoFocus: false) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let results = query.isEmpty ? store.recent : store.search(query)
                    if query.isEmpty, !store.recent.isEmpty { sectionTitle("最近使用").padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4) }
                    if results.isEmpty {
                        emptyText(query.isEmpty ? "输入关键词搜表情，比如「笑」「猫」「爱心」" : "没有匹配的表情")
                    } else {
                        EmojiRows(items: results, onEmoji: onEmoji)
                    }
                    Color.clear.frame(height: 30)
                }
            }
        }
        .onAppear { q = initialQuery }
        .task { await store.ensureLoaded() }
    }
}

// MARK: - 表情商店 / 我的贴纸（底部 sheet）

/// 表情商店（manage=false）：搜索 + 全部包，每行前几张预览 + 添加 / 已添加（图 7）；
/// 我的贴纸（manage=true）：置顶 / 移除。库里的包由后台维护，用户只决定自己面板里有哪些、什么顺序。
struct StickerStoreSheet: View {
    var manage: Bool
    /// 面板搜索行带进来的词（快捷 emoji）；focusSearch 时打开就聚焦搜索框
    var initialQuery: String = ""
    var focusSearch: Bool = false
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = StickerStore.shared
    @State private var q = ""
    @State private var busy: Int? = nil
    @State private var toast: String? = nil
    @FocusState private var searchFocused: Bool

    /// 搜索：按包名，或按贴纸 emoji；搜 emoji 时预览只放命中的贴纸
    private var list: [(set: StickerSetItem, preview: [StickerPayload])] {
        let src = manage ? store.mineSets : store.sets
        let w = q.trimmingCharacters(in: .whitespaces).lowercased()
        if w.isEmpty { return src.map { ($0, Array($0.items.prefix(6))) } }
        let wb = baseEmoji(w)
        return src.compactMap { s in
            let hit = s.items.filter { baseEmoji($0.emoji ?? "").contains(wb) }
            if !hit.isEmpty { return (s, Array(hit.prefix(6))) }
            if (s.title ?? "").lowercased().contains(w) { return (s, Array(s.items.prefix(6))) }
            return nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.textDim)
                    TextField(manage ? "搜索我的贴纸" : "搜索贴纸", text: $q).font(.system(size: 15)).foregroundStyle(Theme.text)
                        .focused($searchFocused)
                    if !q.isEmpty {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.textDim).onTapGesture { q = "" }
                    }
                }
                .padding(.horizontal, 10).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                Button("完成") { dismiss() }.font(.system(size: 16)).foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 8)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if manage {
                        Text("我的贴纸（\(store.mineSets.count)）").font(.system(size: 12)).foregroundStyle(Theme.textSub).padding(.horizontal, 16).padding(.top, 4)
                    }
                    ForEach(list, id: \.set.id) { item in
                        let s = item.set
                        row(s, item.preview) {
                            let idx = store.mineIds.firstIndex(of: s.id) ?? -1
                            if manage {
                                HStack(spacing: 6) {
                                    if idx > 0, q.isEmpty {
                                        actionBtn("置顶", primary: false, busy: busy == s.id) { run(s.id) { try await store.reorderMine([s.id] + store.mineIds.filter { $0 != s.id }) } }
                                    }
                                    actionBtn("移除", primary: false, busy: busy == s.id) { run(s.id) { try await store.removeMine(s.id) } }
                                }
                            } else if idx >= 0 {
                                actionBtn("已添加", primary: false, busy: busy == s.id) { run(s.id) { try await store.removeMine(s.id) } }
                            } else {
                                actionBtn("添加", primary: true, busy: busy == s.id) { run(s.id) { try await store.addMine(s.id) } }
                            }
                        }
                    }
                    if list.isEmpty { emptyText(store.sets.isEmpty ? "表情包还在路上…" : "没有匹配的贴纸包") }
                    Color.clear.frame(height: 30)
                }
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .overlay {
            if let t = toast {
                Text(t).font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 22).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.85)))
            }
        }
        .task { await store.ensureLoaded(); await store.loadMine() }
        .onAppear {
            q = initialQuery
            if focusSearch { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { searchFocused = true } }
        }
    }

    private func run(_ id: Int, _ job: @escaping () async throws -> Void) {
        busy = id
        Task {
            do { try await job() } catch { show(error.localizedDescription) }
            busy = nil
        }
    }

    private func show(_ msg: String) {
        toast = msg
        Task { try? await Task.sleep(nanoseconds: 1_600_000_000); if toast == msg { toast = nil } }
    }

    private func kindText(_ k: String?) -> String {
        switch k { case "static": return "静态"; case "animated", "video": return "动态"; default: return "" }
    }

    private func row<A: View>(_ s: StickerSetItem, _ preview: [StickerPayload], @ViewBuilder actions: () -> A) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.title ?? "").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text("\(s.items.count) 张贴图 · \(kindText(s.kind))").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                }
                Spacer(minLength: 8)
                actions()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(preview) { p in StickerImageView(p: p, size: 64, autoplay: false) }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.line) }
    }
}
