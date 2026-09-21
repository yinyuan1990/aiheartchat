import SwiftUI
import ImageIO
import AVFoundation
import Lottie

// MARK: - 模型

/// 一张贴纸 / 一条 GIF：聊天消息 type=sticker 的 content、评论的 sticker 字段都是这个 JSON
struct StickerPayload: Codable, Hashable, Identifiable {
    var id: String = ""
    /// webp=静态图；lottie=Lottie JSON；awebp=动态 WebP；mp4=GIF（无声视频，thumb 是动态 WebP 预览）
    var format: String = "webp"
    var url: String = ""
    var thumb: String? = ""
    var w: Int? = 512
    var h: Int? = 512
    var emoji: String? = ""

    var isGif: Bool { format == "mp4" }

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

private struct GifPage: Codable {
    var items: [StickerPayload]? = []
    var next: String? = ""
}

/// 表情包目录（UserDefaults 落盘，按 version 增量）、「最近使用」、我的包、GIF
@MainActor
final class StickerStore: ObservableObject {
    static let shared = StickerStore()
    @Published var sets: [StickerSetItem] = []
    @Published var recent: [StickerPayload] = []
    @Published var recentGifs: [StickerPayload] = []
    private var version = 0
    private var fetching = false
    private let recentMax = 24

    private init() {
        let d = UserDefaults.standard
        version = d.integer(forKey: "stk_version")
        if let data = d.data(forKey: "stk_sets"), let s = try? JSONDecoder().decode([StickerSetItem].self, from: data) { sets = s }
        if let data = d.data(forKey: "stk_recent"), let r = try? JSONDecoder().decode([StickerPayload].self, from: data) { recent = r }
        if let data = d.data(forKey: "stk_recent_gif"), let r = try? JSONDecoder().decode([StickerPayload].self, from: data) { recentGifs = r }
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
        // 后台下架的包：把「最近使用」里已经不在目录中的贴纸清掉
        let alive = Set(sets.flatMap { $0.items.map(\.id) })
        let pruned = recent.filter { alive.contains($0.id) }
        if pruned.count != recent.count {
            recent = pruned
            if let data = try? JSONEncoder().encode(recent) { d.set(data, forKey: "stk_recent") }
        }
    }

    /// 记一次使用：贴纸进贴纸「最近」，GIF 进 GIF「最近」
    func addRecent(_ p: StickerPayload) {
        if p.isGif {
            recentGifs = ([p] + recentGifs.filter { $0.id != p.id }).prefix(recentMax).map { $0 }
            if let data = try? JSONEncoder().encode(recentGifs) { UserDefaults.standard.set(data, forKey: "stk_recent_gif") }
        } else {
            recent = ([p] + recent.filter { $0.id != p.id }).prefix(recentMax).map { $0 }
            if let data = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(data, forKey: "stk_recent") }
        }
    }

    // MARK: 我的表情包（表情商店）

    /// 我面板里的集合 id（有序）；先用本地缓存，进面板时向后端刷一次
    @Published var mineIds: [Int] = (UserDefaults.standard.array(forKey: "stk_mine") as? [Int]) ?? []

    var mineSets: [StickerSetItem] { mineIds.compactMap { id in sets.first { $0.id == id } } }
    var otherSets: [StickerSetItem] { sets.filter { !mineIds.contains($0.id) } }

    private struct MineResp: Codable { var ids: [Int]? }

    private func applyMine(_ r: MineResp) {
        mineIds = r.ids ?? []
        UserDefaults.standard.set(mineIds, forKey: "stk_mine")
    }

    func loadMine() async {
        if let r: MineResp = try? await Api.request("/stickers/mine") { applyMine(r) }
    }

    func addMine(_ setId: Int) async throws {
        let r: MineResp = try await Api.request("/stickers/mine/\(setId)", method: "POST")
        applyMine(r)
    }

    func removeMine(_ setId: Int) async throws {
        let r: MineResp = try await Api.request("/stickers/mine/\(setId)", method: "DELETE")
        applyMine(r)
    }

    func reorderMine(_ ids: [Int]) async throws {
        mineIds = ids
        let r: MineResp = try await Api.request("/stickers/mine", method: "PUT", body: ["ids": ids])
        applyMine(r)
    }

    // MARK: GIF（后端 /gifs：Telegram @gif 中转）

    private var gifPages: [String: (Date, [StickerPayload], String)] = [:]

    /// 搜 GIF（q 空 = 热门）；同一页 5 分钟内复用。返回 items + 下一页 offset（空 = 没了）
    func searchGifs(_ q: String, offset: String = "") async throws -> ([StickerPayload], String) {
        let key = "\(q)|\(offset)"
        if let hit = gifPages[key], Date().timeIntervalSince(hit.0) < 300 { return (hit.1, hit.2) }
        let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
        let page: GifPage = try await Api.request("/gifs?q=\(enc(q))&offset=\(enc(offset))")
        let items = page.items ?? [], next = page.next ?? ""
        // 首次搜索后端可能还在后台补齐，结果少时只短缓存
        gifPages[key] = (Date().addingTimeInterval(items.count < 10 ? -240 : 0), items, next)
        return (items, next)
    }
}

// MARK: - 渲染

/// 渲染一张贴纸 / GIF。size 为长边，按 w/h 保比例。静态 WebP → RemoteImage；动态 WebP → ImageIO 逐帧；Lottie → lottie-ios；
/// GIF（mp4）→ AVPlayer 静音循环，autoplay=false 时只放动态 WebP 预览（面板网格 / 待发小图）。
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
            case "mp4":
                if autoplay {
                    GifVideoView(url: Api.fullUrl(p.url), poster: Api.fullUrl(p.thumb ?? ""))
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    AnimatedImageView(url: Api.fullUrl((p.thumb ?? "").isEmpty ? p.url : p.thumb!), animate: true, fill: true)
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            default:
                RemoteImage(url: p.url)
            }
        }
        .frame(width: w, height: h)
        .clipped()
    }
}

/// 面板网格里的小图：和 Telegram 一样动态的也直接播（LazyVGrid 只创建可见的那几行）；GIF 只放预览
struct StickerThumbView: View {
    let p: StickerPayload
    var size: CGFloat = 56
    var body: some View {
        StickerImageView(p: p, size: size, autoplay: !p.isGif)
    }
}

/// 动态 WebP / GIF / APNG：用 ImageIO 的 CGAnimateImageData 逐帧回调（iOS 14+ 支持 WebP），不依赖第三方库
struct AnimatedImageView: UIViewRepresentable {
    let url: String
    var animate: Bool
    var fill = false

    final class Box {
        var stop = false
        var url = ""
    }

    func makeCoordinator() -> Box { Box() }

    func makeUIView(context: Context) -> UIImageView {
        let v = UIImageView()
        v.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
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

/// GIF（无声 mp4）：AVPlayer 静音循环；起播前先垫动态 WebP 预览
struct GifVideoView: UIViewRepresentable {
    let url: String
    var poster: String

    final class PlayerView: UIView {
        let playerLayer = AVPlayerLayer()
        let poster = UIImageView()
        var player: AVPlayer?
        var url = ""
        var observer: NSObjectProtocol?
        var ready: NSKeyValueObservation?

        override init(frame: CGRect) {
            super.init(frame: frame)
            poster.contentMode = .scaleAspectFill
            poster.clipsToBounds = true
            addSubview(poster)
            playerLayer.videoGravity = .resizeAspectFill
            layer.addSublayer(playerLayer)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func layoutSubviews() {
            super.layoutSubviews()
            poster.frame = bounds
            playerLayer.frame = bounds
        }

        func load(_ u: String, poster p: String) {
            guard u != url, let src = URL(string: u) else { return }
            url = u
            stop()
            if !p.isEmpty {
                let target = p
                Task { @MainActor [weak self] in
                    guard let self, let data = await AnimatedImageCache.data(for: target), self.url == u else { return }
                    self.poster.image = UIImage(data: data)
                }
            }
            let item = AVPlayerItem(url: src)
            let pl = AVPlayer(playerItem: item)
            pl.isMuted = true
            pl.actionAtItemEnd = .none
            observer = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak pl] _ in
                pl?.seek(to: .zero); pl?.play()
            }
            ready = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                if it.status == .readyToPlay { DispatchQueue.main.async { self?.poster.isHidden = true } }
            }
            playerLayer.player = pl
            player = pl
            pl.play()
        }

        func stop() {
            if let o = observer { NotificationCenter.default.removeObserver(o) }
            observer = nil
            ready = nil
            player?.pause()
            player = nil
            playerLayer.player = nil
            poster.isHidden = false
        }
    }

    func makeUIView(context: Context) -> PlayerView { PlayerView() }

    func updateUIView(_ v: PlayerView, context: Context) {
        v.load(url, poster: poster)
    }

    static func dismantleUIView(_ v: PlayerView, coordinator: ()) {
        v.stop()
    }
}

/// 评论输入栏上方的「待发贴纸」小图 + 删除
struct PendingStickerChip: View {
    let p: StickerPayload
    var onRemove: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            StickerImageView(p: p, size: 56, autoplay: !p.isGif)
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
