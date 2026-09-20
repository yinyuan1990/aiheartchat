import SwiftUI
import ImageIO
import Lottie

// MARK: - 模型

/// 一张贴纸：聊天消息 type=sticker 的 content、评论的 sticker 字段都是这个 JSON
struct StickerPayload: Codable, Hashable, Identifiable {
    var id: String = ""
    /// webp=静态图；lottie=Lottie JSON；awebp=动态 WebP
    var format: String = "webp"
    var url: String = ""
    var thumb: String? = ""
    var w: Int? = 512
    var h: Int? = 512
    var emoji: String? = ""

    var aspect: CGFloat {
        let ww = CGFloat(w ?? 512), hh = CGFloat(h ?? 512)
        return ww > 0 && hh > 0 ? ww / hh : 1
    }

    static func parse(_ content: String) -> StickerPayload? {
        guard let d = content.data(using: .utf8), let p = try? JSONDecoder().decode(StickerPayload.self, from: d), !p.url.isEmpty else { return nil }
        return p
    }

    func encoded() -> String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

struct StickerSetItem: Codable, Identifiable, Hashable {
    var id: Int = 0
    var title: String? = ""
    var kind: String? = "static"
    var thumb: String? = ""
    var items: [StickerPayload] = []
}

private struct StickerCatalog: Codable {
    var version: Int? = 0
    var notModified: Bool? = false
    var sets: [StickerSetItem]? = []
}

/// 表情包目录（UserDefaults 落盘，按 version 增量）与「最近使用」
@MainActor
final class StickerStore: ObservableObject {
    static let shared = StickerStore()
    @Published var sets: [StickerSetItem] = []
    @Published var recent: [StickerPayload] = []
    private var version = 0
    private var loaded = false
    private var fetching = false
    private let recentMax = 24

    private init() {
        let d = UserDefaults.standard
        version = d.integer(forKey: "stk_version")
        if let data = d.data(forKey: "stk_sets"), let s = try? JSONDecoder().decode([StickerSetItem].self, from: data) { sets = s }
        if let data = d.data(forKey: "stk_recent"), let r = try? JSONDecoder().decode([StickerPayload].self, from: data) { recent = r }
    }

    /// 进面板 / 首次渲染贴纸时调用：先用本地缓存，再问后端 version 有没有变
    func ensureLoaded() async {
        if fetching { return }
        fetching = true
        defer { fetching = false }
        let path = version > 0 ? "/stickers?ver=\(version)" : "/stickers"
        guard let cat: StickerCatalog = try? await Api.request(path) else { return }
        if cat.notModified == true { return }
        version = cat.version ?? 0
        sets = cat.sets ?? []
        let d = UserDefaults.standard
        d.set(version, forKey: "stk_version")
        if let data = try? JSONEncoder().encode(sets) { d.set(data, forKey: "stk_sets") }
        loaded = true
    }

    func addRecent(_ p: StickerPayload) {
        recent = ([p] + recent.filter { $0.id != p.id }).prefix(recentMax).map { $0 }
        if let data = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(data, forKey: "stk_recent") }
    }
}

// MARK: - 渲染

/// 渲染一张贴纸。size 为长边，按 w/h 保比例。静态 WebP → RemoteImage；动态 WebP → ImageIO 逐帧；Lottie → lottie-ios。
struct StickerImageView: View {
    let p: StickerPayload
    var size: CGFloat = 140
    var autoplay = true

    private var w: CGFloat { p.aspect >= 1 ? size : size * p.aspect }
    private var h: CGFloat { p.aspect >= 1 ? size / p.aspect : size }

    var body: some View {
        Group {
            switch p.format {
            case "lottie":
                if !autoplay, let t = p.thumb, !t.isEmpty {
                    RemoteImage(url: t)
                } else if let u = URL(string: Api.fullUrl(p.url)) {
                    LottieView {
                        try await LottieAnimation.loadedFrom(url: u)
                    } placeholder: {
                        if let t = p.thumb, !t.isEmpty { RemoteImage(url: t) } else { Color.clear }
                    }
                    .playbackMode(autoplay ? .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)) : .paused(at: .progress(0)))
                }
            case "awebp":
                AnimatedImageView(url: Api.fullUrl(p.url), animate: autoplay)
            default:
                RemoteImage(url: p.url)
            }
        }
        .frame(width: w, height: h)
        .clipped()
    }
}

/// 面板网格里的小图：动态的用静态缩略图，省资源
struct StickerThumbView: View {
    let p: StickerPayload
    var size: CGFloat = 56
    var body: some View {
        let src = p.format == "webp" ? p.url : (p.thumb ?? "")
        if !src.isEmpty {
            RemoteImage(url: src).frame(width: size, height: size)
        } else {
            StickerImageView(p: p, size: size, autoplay: false)
        }
    }
}

/// 动态 WebP / GIF / APNG：用 ImageIO 的 CGAnimateImageData 逐帧回调（iOS 14+ 支持 WebP），不依赖第三方库
struct AnimatedImageView: UIViewRepresentable {
    let url: String
    var animate: Bool

    final class Box {
        var stop = false
        var url = ""
    }

    func makeCoordinator() -> Box { Box() }

    func makeUIView(context: Context) -> UIImageView {
        let v = UIImageView()
        v.contentMode = .scaleAspectFit
        v.clipsToBounds = true
        return v
    }

    func updateUIView(_ v: UIImageView, context: Context) {
        let holder = context.coordinator
        guard holder.url != url else { return }
        holder.url = url // 上一个动画的回调发现 url 变了会自行停止
        let target = url
        let animate = self.animate
        Task { @MainActor in
            guard let data = await AnimatedImageCache.data(for: target), holder.url == target else { return }
            v.image = UIImage(data: data)
            guard animate else { return }
            CGAnimateImageDataWithBlock(data as CFData, nil) { _, cg, stop in
                if holder.stop || holder.url != target { stop.pointee = true; return }
                v.image = UIImage(cgImage: cg)
            }
        }
    }

    static func dismantleUIView(_ uiView: UIImageView, coordinator: Box) {
        coordinator.stop = true
    }
}

enum AnimatedImageCache {
    private static let cache = NSCache<NSString, NSData>()
    static func data(for url: String) async -> Data? {
        if let d = cache.object(forKey: url as NSString) { return d as Data }
        guard let u = URL(string: url), let (d, _) = try? await URLSession.shared.data(from: u) else { return nil }
        cache.setObject(d as NSData, forKey: url as NSString)
        return d
    }
}

// MARK: - 面板

let stickerEmojis = [
    "😀", "😂", "🥰", "😍", "😘", "😊", "🤔", "😎", "🥺", "😭", "😅", "🙃", "😏", "😴", "🤗", "😡",
    "❤️", "💕", "💔", "👍", "👏", "🙏", "🌹", "🎉", "🔥", "✨", "🙌", "🤝", "💪", "🍻", "🎂", "🌙",
]

/// 表情面板（三端同一套交互）：顶部横向 tab（emoji / 最近 / 各表情包封面），下面 5 列网格。
/// onEmoji 传了才有 emoji tab（插入文字）；onPick 点贴纸——聊天里即发送，评论里挂到待发评论上。
struct StickerPanel: View {
    var onPick: (StickerPayload) -> Void
    var onEmoji: ((String) -> Void)? = nil
    var height: CGFloat = 260

    @ObservedObject private var store = StickerStore.shared
    /// -2 emoji，-1 最近，>=0 表情包 id
    @State private var tab: Int = -3

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    if onEmoji != nil {
                        tabCell(active: tab == -2) { tab = -2 } content: {
                            Image(systemName: "face.smiling").font(.system(size: 20)).foregroundStyle(Theme.text)
                        }
                    }
                    tabCell(active: tab == -1) { tab = -1 } content: {
                        Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(Theme.textSub)
                    }
                    ForEach(store.sets) { s in
                        tabCell(active: tab == s.id) { tab = s.id } content: {
                            if let t = s.thumb, !t.isEmpty {
                                RemoteImage(url: t).frame(width: 28, height: 28)
                            } else {
                                Text(String((s.title ?? "").prefix(2))).font(.system(size: 11)).foregroundStyle(Theme.textSub)
                            }
                        }
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 6)
            }
            Divider().overlay(Theme.line)

            Group {
                if tab == -2, let onEmoji {
                    ScrollView {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 8), spacing: 2) {
                            ForEach(stickerEmojis, id: \.self) { e in
                                Text(e).font(.system(size: 26)).padding(.vertical, 6)
                                    .frame(maxWidth: .infinity)
                                    .contentShape(Rectangle())
                                    .onTapGesture { onEmoji(e) }
                            }
                        }
                        .padding(8)
                    }
                } else if tab == -1 {
                    if store.recent.isEmpty {
                        Text(store.sets.isEmpty ? "表情包还在路上…" : "还没用过表情，先从右边的表情包里挑一个")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        grid(store.recent)
                    }
                } else if let cur = store.sets.first(where: { $0.id == tab }) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(cur.title ?? "").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                            .padding(.leading, 12).padding(.top, 8).padding(.bottom, 2)
                        grid(cur.items)
                    }
                } else {
                    Text("加载中…").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(height: height)
        .background(Theme.bg2)
        .task {
            if tab == -3 { tab = onEmoji != nil ? -2 : (store.recent.isEmpty ? (store.sets.first?.id ?? -1) : -1) }
            await store.ensureLoaded()
            if tab == -1, store.recent.isEmpty, onEmoji == nil, let first = store.sets.first { tab = first.id }
        }
    }

    private func grid(_ items: [StickerPayload]) -> some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 5), spacing: 6) {
                ForEach(items) { p in
                    StickerThumbView(p: p, size: 60)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(1, contentMode: .fit)
                        .contentShape(Rectangle())
                        .onTapGesture { onPick(p) }
                }
            }
            .padding(8)
        }
    }

    private func tabCell<C: View>(active: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            content()
                .frame(width: 40, height: 40)
                .background(RoundedRectangle(cornerRadius: 10).fill(active ? Theme.bg3 : Color.clear))
        }
        .buttonStyle(.plain)
    }
}

/// 评论输入栏上方的「待发贴纸」小图 + 删除
struct PendingStickerChip: View {
    let p: StickerPayload
    var onRemove: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            StickerImageView(p: p, size: 56, autoplay: false)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(Color.black.opacity(0.6)))
            }
            .buttonStyle(.plain)
            .offset(x: 6, y: -6)
        }
    }
}
