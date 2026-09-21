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
/// 不标 @MainActor：由 ScrollTrackerView 的 KVO 回调（主线程）直接调用
final class PanelChrome: ObservableObject {
    @Published var hidden = false
    /// 锚点：展开时跟着最低点走，收起时跟着最高点走（见 onOffset）
    private var anchor: CGFloat = 0
    /// 上次切换时间：切换后顶部条高度变了，ScrollView 会重排、offset 抖一下，这段时间内的变化不算
    private var lastToggle: CFTimeInterval = 0

    /**
     top = 已滚过的距离（往下滚为正），maxTop = 能滚到的最大值（超出即在底部回弹）。
     Telegram 手感，用「锚点」而不是逐帧方向（手指抖动、120Hz 小步都不怕）：
     展开状态下锚点跟着最低点走，比锚点再往下 24pt 就收；收起状态下锚点跟着最高点走，比锚点往上 40pt 才展开（收比展容易）。
     回到顶部 12pt 内一定展开；底部回弹阶段和刚切换后的 300ms 内忽略。
     */
    func onOffset(top: CGFloat, maxTop: CGFloat) {
        if top < 12 { anchor = top; set(false); return }
        if top > maxTop + 1 { anchor = min(top, maxTop); return }
        if CACurrentMediaTime() - lastToggle < 0.3 { anchor = top; return }
        if !hidden {
            if top < anchor { anchor = top }
            if top - anchor > 24 { set(true) }
        } else {
            if top > anchor { anchor = top }
            if anchor - top > 40 { set(false) }
        }
    }

    private func set(_ h: Bool) {
        guard hidden != h else { return }
        hidden = h
        lastToggle = CACurrentMediaTime()
    }

    func reset() { anchor = 0; lastToggle = 0; hidden = false }
}

/**
 滚动跟踪（一个 pane 一个）：从宿主 UIScrollView 直读 contentOffset（KVO），一次回调干三件事：
 1. 喂给 `PanelChrome.onOffset` 做顶部条 / 胶囊的收起判定；
 2. **分区高亮**：分区标题下面挂一个 `SectionAnchor`（隐形 UIView），位置用 UIKit `convert` 算——之前用 GeometryReader(.global) + PreferenceKey，
    滚动时每帧改值、每帧走一遍整棵树的 preference 归约再回调 `onPreferenceChange`，是滚动卡顿的固定开销之一；
    懒加载销毁掉的标题位置也记着（内容坐标不随滚动变），滚到一个大包中间时仍能算对；
 3. **滚动中 / 静止**：150ms 没动算静止。网格里的动图 / Lottie 滚动中一律停在当前帧、停下再播（`stickerPlaybackPaused` 环境值），Telegram 同款策略。
 */
final class ScrollTracker: ObservableObject {
    @Published var scrolling = false
    @Published var active: String
    /// 分区标题在滚动内容坐标里的 y（含已被 LazyVStack 销毁的）
    private var positions: [String: CGFloat] = [:]
    /// 当前还在层级里的标题锚点
    private var anchors: [String: WeakView] = [:]
    private var idle: DispatchWorkItem?
    /// 点封面跳分区时：先手动置 active，动画滚动过程中不要被途经的分区抢走
    private var holdUntil: CFTimeInterval = 0

    private struct WeakView { weak var view: UIView? }

    init(active: String) { self.active = active }

    fileprivate func register(_ key: String, _ v: UIView) {
        anchors[key] = WeakView(view: v)
        if let sv = hostScrollView(of: v) { positions[key] = v.convert(CGPoint.zero, to: sv).y }
    }

    fileprivate func unregister(_ key: String) { anchors[key] = nil }

    /// 手动指定当前分区（点封面），0.6 秒内不让滚动过程改写
    func select(_ key: String) {
        holdUntil = CACurrentMediaTime() + 0.6
        if active != key { active = key }
    }

    /// 分区列表变了（加 / 删包）：把已经不存在的分区的记忆位置清掉；还在层级里的下一帧会重新量
    func prune(valid: Set<String>) {
        positions = positions.filter { valid.contains($0.key) }
    }

    /// 宿主 UIScrollView 每次 contentOffset 变化都会来一次（主线程，每帧）
    fileprivate func offsetChanged(_ sv: UIScrollView) {
        refreshActive(sv)
        if !scrolling { scrolling = true }
        idle?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.scrolling = false }
        idle = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: w)
    }

    private func refreshActive(_ sv: UIScrollView) {
        for (k, a) in anchors {
            if let v = a.view, v.window != nil { positions[k] = v.convert(CGPoint.zero, to: sv).y } else { anchors[k] = nil }
        }
        guard !positions.isEmpty, CACurrentMediaTime() >= holdUntil else { return }
        let top = sv.contentOffset.y + sv.adjustedContentInset.top
        // 标题顶到可视区顶部 8pt 以内的最靠下的那个；一个都没过顶（还在最上面）就取最靠上的
        var best: (String, CGFloat)?, first: (String, CGFloat)?
        for (k, y) in positions {
            if y - top <= 8, best.map({ y > $0.1 }) ?? true { best = (k, y) }
            if first.map({ y < $0.1 }) ?? true { first = (k, y) }
        }
        if let k = (best ?? first)?.0, k != active { active = k }
    }

    fileprivate static func hostScrollView(of v: UIView) -> UIScrollView? {
        var cur: UIView? = v.superview
        while let c = cur, !(c is UIScrollView) { cur = c.superview }
        return cur as? UIScrollView
    }

    private func hostScrollView(of v: UIView) -> UIScrollView? { ScrollTracker.hostScrollView(of: v) }
}

/**
 滚动偏移观察：塞进 ScrollView 内容里的一个隐形 UIView，挂到窗口后沿 superview 找到宿主 UIScrollView，KVO 它的 contentOffset。
 之前用 GeometryReader + 命名坐标系 + preference 那套，在真机上不回调（顶部条 / 胶囊从来不收），改用 UIKit 直读最稳。
 onOffset 参数 = (已滚过的距离（往下滚为正）, 最大可滚距离)，同时通知 tracker。
 */
private struct ScrollTrackerView: UIViewRepresentable {
    let tracker: ScrollTracker
    var onOffset: (CGFloat, CGFloat) -> Void

    func makeUIView(context: Context) -> ObserverView {
        let v = ObserverView()
        v.tracker = tracker
        v.onOffset = onOffset
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: ObserverView, context: Context) {
        v.tracker = tracker
        v.onOffset = onOffset
    }

    final class ObserverView: UIView {
        weak var tracker: ScrollTracker?
        var onOffset: ((CGFloat, CGFloat) -> Void)?
        private var obs: NSKeyValueObservation?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            obs = nil
            guard window != nil else { return }
            // 等这一轮布局结束再找，刚挂上时 superview 链可能还没接到 UIScrollView
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        private func attach() {
            guard let sv = ScrollTracker.hostScrollView(of: self) else { return }
            obs = sv.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
                guard let self else { return }
                let inset = sv.adjustedContentInset
                let top = sv.contentOffset.y + inset.top
                let maxTop = max(0, sv.contentSize.height + inset.top + inset.bottom - sv.bounds.height)
                self.onOffset?(top, maxTop)
                self.tracker?.offsetChanged(sv)
            }
        }
    }
}

/// 分区标题的锚点：挂在标题 `.background` 上的隐形 UIView，进层级就到 tracker 报到、出层级注销（位置由 tracker 用 convert 读）
private struct SectionAnchor: UIViewRepresentable {
    let key: String
    let tracker: ScrollTracker

    func makeUIView(context: Context) -> AnchorView {
        let v = AnchorView()
        v.key = key
        v.tracker = tracker
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: AnchorView, context: Context) {
        if v.key != key {
            v.tracker?.unregister(v.key)
            v.key = key
            if v.window != nil { tracker.register(key, v) }
        }
        v.tracker = tracker
    }

    static func dismantleUIView(_ v: AnchorView, coordinator: ()) { v.tracker?.unregister(v.key) }

    final class AnchorView: UIView {
        var key = ""
        weak var tracker: ScrollTracker?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil {
                // 等布局完再报到，这时 frame 才是真的
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.window != nil else { return }
                    self.tracker?.register(self.key, self)
                }
            } else {
                tracker?.unregister(key)
            }
        }
    }
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
    @StateObject private var tracker = ScrollTracker(active: "recent")
    @State private var adding: Int? = nil
    /// 搜索行是按钮，这两个只是占位给 SearchRow 的绑定
    @State private var noText = ""
    @State private var chipTap = ""

    private var active: String { tracker.active }

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
                    ScrollTrackerView(tracker: tracker) { top, maxTop in chrome.onOffset(top: top, maxTop: maxTop) }.frame(height: 1)
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
                            .background(SectionAnchor(key: s.key, tracker: tracker))
                            // 每 5 张一行、行是 LazyVStack 的元素：LazyVGrid 嵌在 LazyVStack 里会把整包（上百张动图）一次全建出来，滑动就卡
                            StickerRows(items: s.items, key: s.key, onPick: onPick)
                        }
                        Color.clear.frame(height: 64)
                    }
                    // 滚动中网格动图停在当前帧，停下再播
                    .environment(\.stickerPlaybackPaused, tracker.scrolling)
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
        // 加 / 删包、「最近使用」从无到有：内容整体位移，清掉不存在分区的记忆位置
        .onChange(of: sections.map(\.key)) { keys in tracker.prune(valid: Set(keys)) }
    }

    @State private var jumpTarget: String? = nil

    private func jump(_ key: String) {
        bar.collapse()
        tracker.select(key)
        jumpTarget = key
    }

    private func add(_ id: Int) {
        adding = id
        Task { try? await store.addMine(id); adding = nil }
    }

    @ViewBuilder
    private func cover(_ s: StickerSetItem) -> some View {
        if let t = s.thumb, !t.isEmpty {
            // 顶部条收起 / 展开会整条重建，封面走后台降采样缓存（RemoteImage 是主线程按原图解）
            StaticThumbView(url: t, maxPixel: 28 * UIScreen.main.scale).frame(width: 28, height: 28)
        } else {
            Text(String((s.title ?? "").prefix(2))).font(.system(size: 11)).foregroundStyle(Theme.textSub)
        }
    }
}

/// 贴纸网格：每 5 张一行，每行是 LazyVStack 的一个元素（真正懒加载，滑到才建、才开始下载 / 播）；末行用空格子补齐等宽。
/// 行 id 必须带上分区 key：LazyVStack 会把嵌套 ForEach 拍平成一个列表，各包都用 0/1/2… 会撞 id，表现为不同包的贴纸互相串行
private struct StickerRows: View {
    let items: [StickerPayload]
    var key: String
    var onPick: (StickerPayload) -> Void
    private let cols = 5

    var body: some View {
        ForEach(chunkRows(items, cols: cols, key: key)) { row in
            HStack(spacing: 6) {
                ForEach(row.items) { p in
                    StickerThumbView(p: p, size: 62)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(1, contentMode: .fit)
                        .contentShape(Rectangle())
                        .onTapGesture { onPick(p) }
                }
                if row.items.count < cols {
                    ForEach(0..<(cols - row.items.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity).aspectRatio(1, contentMode: .fit) }
                }
            }
            .padding(.horizontal, 8).padding(.bottom, 6)
        }
    }
}

/// 一行网格内容，id = "分区key-行号"，保证 LazyVStack 里全局唯一
private struct GridRow<T>: Identifiable {
    var id: String
    var index: Int
    var items: [T]
}

private func chunkRows<T>(_ items: [T], cols: Int, key: String) -> [GridRow<T>] {
    stride(from: 0, to: items.count, by: cols).enumerated().map { i, start in
        GridRow(id: "\(key)-r\(i)", index: i, items: Array(items[start..<min(start + cols, items.count)]))
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
    @StateObject private var tracker = ScrollTracker(active: "recent")
    @State private var jumpTarget: String? = nil
    @State private var noText = ""
    @State private var chipTap = ""

    private var active: String { tracker.active }

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
                    ScrollTrackerView(tracker: tracker) { top, maxTop in chrome.onOffset(top: top, maxTop: maxTop) }.frame(height: 1)
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !store.recent.isEmpty {
                            header("recent", "最近使用")
                            EmojiRows(items: store.recent, key: "recent", onEmoji: onEmoji)
                        }
                        ForEach(store.groups) { g in
                            header(g.key, g.name)
                            EmojiRows(items: g.items.map { $0[0] }, key: g.key, onEmoji: onEmoji)
                        }
                        if store.groups.isEmpty { emptyText("加载中…") }
                        Color.clear.frame(height: 64)
                    }
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
            .background(SectionAnchor(key: key, tracker: tracker))
    }

    private func jump(_ key: String) {
        bar.collapse()
        tracker.select(key)
        jumpTarget = key
    }
}

/// emoji 网格：每 8 个一行，每行是 LazyVStack 的一个元素（真正懒加载）；最后一行不满用空格子补齐保持等宽。行 id 带分区 key 防撞
private struct EmojiRows: View {
    let items: [String]
    var key: String
    var onEmoji: (String) -> Void
    private let cols = 8

    var body: some View {
        ForEach(chunkRows(items, cols: cols, key: key)) { row in
            HStack(spacing: 0) {
                ForEach(Array(row.items.enumerated()), id: \.offset) { _, e in
                    Text(e).font(.system(size: 26))
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .contentShape(Rectangle())
                        .onTapGesture { onEmoji(e) }
                }
                if row.items.count < cols {
                    ForEach(0..<(cols - row.items.count), id: \.self) { _ in Color.clear.frame(maxWidth: .infinity).frame(height: 42) }
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
    @StateObject private var tracker = ScrollTracker(active: "")
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
                ScrollTrackerView(tracker: tracker) { top, maxTop in chrome.onOffset(top: top, maxTop: maxTop) }.frame(height: 1)
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !store.recentGifs.isEmpty {
                        sectionTitle("最近使用").padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                        GifGrid(items: store.recentGifs, key: "recent", onPick: onPick, onNearEnd: nil)
                    }
                    sectionTitle("热门").padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                    GifGrid(items: feed.items, key: "hot", onPick: onPick, onNearEnd: { feed.more() })
                    GifFooter(feed: feed, emptyHint: "暂无 GIF")
                    Color.clear.frame(height: 64)
                }
                // 滚动中瓦片停在当前帧，停下再播
                .environment(\.stickerPlaybackPaused, tracker.scrolling)
            }
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

/// 3 列正方形瓦片：每 3 个一行、行是 LazyVStack 的元素（LazyVGrid 嵌在 LazyVStack 里会把几十个动图一次全建出来，滑动就卡）；
/// 格子先用 Color.clear 定成正方形再叠图（UIViewRepresentable 自己报的尺寸不一致会让行错位）
private struct GifGrid: View {
    let items: [StickerPayload]
    var key: String
    var onPick: (StickerPayload) -> Void
    var onNearEnd: (() -> Void)?
    private let cols = 3
    /// 滚动中停在当前帧（面板 / 搜索 sheet 的滚动区设置）
    @Environment(\.stickerPlaybackPaused) private var paused

    var body: some View {
        let rows = chunkRows(items, cols: cols, key: key)
        ForEach(rows) { row in
            HStack(spacing: 2) {
                ForEach(row.items) { p in
                    Color.clear
                        .aspectRatio(1, contentMode: .fit)
                        .background(Theme.bg3)
                        .overlay(AnimatedImageView(url: Api.fullUrl((p.thumb ?? "").isEmpty ? p.url : p.thumb!), animate: !paused, fill: true, maxFps: 12))
                        .clipped()
                        .contentShape(Rectangle())
                        .onTapGesture { onPick(p) }
                }
                if row.items.count < cols {
                    ForEach(0..<(cols - row.items.count), id: \.self) { _ in Color.clear.aspectRatio(1, contentMode: .fit) }
                }
            }
            .padding(.bottom, 2)
            // 倒数第 2 行出现就翻页
            .onAppear { if let onNearEnd, row.index >= rows.count - 2 { onNearEnd() } }
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
    @StateObject private var tracker = ScrollTracker(active: "")

    private var query: String { q.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        SearchSheetShell(placeholder: "搜索 GIF", query: $q) {
            ScrollView {
                ScrollTrackerView(tracker: tracker) { _, _ in }.frame(height: 1)
                LazyVStack(alignment: .leading, spacing: 0) {
                    if query.isEmpty { sectionTitle("热门").padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4) }
                    GifGrid(items: feed.items, key: "q", onPick: { p in onPick(p); dismiss() }, onNearEnd: { feed.more() })
                    GifFooter(feed: feed, emptyHint: query.isEmpty ? "暂无 GIF" : "没有找到相关 GIF")
                    Color.clear.frame(height: 30)
                }
                .environment(\.stickerPlaybackPaused, tracker.scrolling)
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
                        EmojiRows(items: results, key: "q", onEmoji: onEmoji)
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
