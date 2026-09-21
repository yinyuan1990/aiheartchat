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

    /// 解码降采样目标：显示尺寸 × 屏幕倍率（再大也看不出区别，白费 CPU 和内存）
    private var px: CGFloat { size * UIScreen.main.scale }
    /// 面板网格 / 待发小图（≤ 80pt）一屏几十个同时播：限 12fps；气泡里正常 30fps
    private var fpsCap: Double { size <= 80 ? 12 : 30 }

    var body: some View {
        Group {
            switch p.format {
            case "lottie":
                if !autoplay {
                    StaticThumbView(url: (p.thumb ?? "").isEmpty ? p.url : p.thumb!, maxPixel: px)
                } else if let u = URL(string: Api.fullUrl(p.url)) {
                    LottieView {
                        try await LottieAnimation.loadedFrom(url: u)
                    } placeholder: {
                        if let t = p.thumb, !t.isEmpty { StaticThumbView(url: t, maxPixel: px) } else { Color.clear }
                    }
                    .playbackMode(.playing(.fromProgress(0, toProgress: 1, loopMode: .loop)))
                    // 按动画自己的帧率（一般 30/60）而不是屏幕刷新率驱动；小图再降一半
                    .configure { view in
                        view.respectAnimationFrameRate = true
                        view.shouldRasterizeWhenIdle = true
                    }
                }
            case "awebp":
                if autoplay {
                    AnimatedImageView(url: Api.fullUrl(p.url), animate: true, maxPixel: px, maxFps: fpsCap)
                } else {
                    // 不播时只要一张静态图：有 thumb 用 thumb，否则解动图首帧
                    StaticThumbView(url: (p.thumb ?? "").isEmpty ? p.url : p.thumb!, maxPixel: px)
                }
            case "mp4":
                if autoplay {
                    GifVideoView(url: Api.fullUrl(p.url), poster: Api.fullUrl(p.thumb ?? ""))
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    AnimatedImageView(url: Api.fullUrl((p.thumb ?? "").isEmpty ? p.url : p.thumb!), animate: true, fill: true, maxPixel: px, maxFps: 12)
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            default:
                // 静态 WebP：也走后台降采样解码（RemoteImage 是主线程按原图解）
                StaticThumbView(url: p.url, maxPixel: px)
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

/**
 动态 WebP / GIF / APNG 播放（iOS 14+ ImageIO 原生支持 WebP，不依赖第三方库）。

 之前用 `CGAnimateImageDataWithBlock`：它在主线程逐帧解码，GIF 弹框一屏 20 多个瓦片同时播就把主线程占满，来回滑明显卡。
 现在自己起播放器 `AnimatedPlayer`：帧在后台队列解码（并按显示尺寸降采样），只把解好的一帧丢回主线程显示；
 任一时刻只持有当前帧，内存和流式方案一样小；文件数据用 NSCache 缓存，滑走再滑回不重新下载。
 */
struct AnimatedImageView: UIViewRepresentable {
    let url: String
    var animate: Bool
    var fill = false
    /// 解码时降采样到的最大像素（长边）。0 = 不降采样。面板小图 / GIF 瓦片传显示尺寸×scale 即可
    var maxPixel: CGFloat = 0
    /// 帧率上限（0 = 按源文件）。面板一屏几十个小图同时播，30fps 的源全解会把 CPU 吃满、滑动卡，小图 12fps 看不出差别
    var maxFps: Double = 0

    final class Holder {
        var url = ""
        var player: AnimatedPlayer?
    }

    func makeCoordinator() -> Holder { Holder() }

    func makeUIView(context: Context) -> UIImageView {
        let v = UIImageView()
        v.contentMode = fill ? .scaleAspectFill : .scaleAspectFit
        v.clipsToBounds = true
        return v
    }

    func updateUIView(_ v: UIImageView, context: Context) {
        let holder = context.coordinator
        guard holder.url != url else { return }
        holder.url = url
        holder.player?.stop()
        holder.player = nil
        v.image = nil
        let target = url
        let animate = self.animate
        let maxPixel = self.maxPixel
        let maxFps = self.maxFps
        Task { @MainActor in
            guard let data = await AnimatedImageCache.data(for: target), holder.url == target else { return }
            if animate {
                let player = AnimatedPlayer(data: data, maxPixel: maxPixel, maxFps: maxFps) { [weak v] img in v?.image = img }
                holder.player = player
                player.start()
            } else {
                // 只要首帧：后台解一张（降采样）回来
                let img = await StaticThumbCache.decode(data: data, key: target, maxPixel: maxPixel)
                if holder.url == target { v.image = img }
            }
        }
    }

    static func dismantleUIView(_ uiView: UIImageView, coordinator: Holder) {
        coordinator.player?.stop()
        coordinator.player = nil
        coordinator.url = ""
    }
}

/// 逐帧播放器：后台解码、主线程显示。所有实例共用一个并发队列（qos userInitiated），不额外开线程
final class AnimatedPlayer {
    private static let queue = DispatchQueue(label: "peiwan.anim.decode", qos: .userInitiated, attributes: .concurrent)
    private let source: CGImageSource?
    private let count: Int
    private let durations: [TimeInterval]
    private let options: CFDictionary
    private let downsample: Bool
    /// 两帧之间最短间隔（帧率上限），0 = 不限
    private let minInterval: TimeInterval
    private let onFrame: (UIImage) -> Void
    private var stopped = false
    private var index = 0

    init(data: Data, maxPixel: CGFloat, maxFps: Double = 0, onFrame: @escaping (UIImage) -> Void) {
        self.onFrame = onFrame
        minInterval = maxFps > 0 ? 1.0 / maxFps : 0
        // kCGImageSourceShouldCache=false：不让 ImageIO 把解过的帧全留在内存里
        let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        source = src
        count = src.map { CGImageSourceGetCount($0) } ?? 0
        durations = src.map { s in (0..<CGImageSourceGetCount(s)).map { AnimatedPlayer.frameDuration(s, $0) } } ?? []
        var opt: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        downsample = maxPixel > 0
        if downsample {
            opt[kCGImageSourceCreateThumbnailFromImageAlways] = true
            opt[kCGImageSourceCreateThumbnailWithTransform] = true
            opt[kCGImageSourceThumbnailMaxPixelSize] = Int(maxPixel)
        }
        options = opt as CFDictionary
    }

    func start() {
        guard count > 0 else { return }
        stopped = false
        schedule(after: 0)
    }

    func stop() { stopped = true }

    private func schedule(after delay: TimeInterval) {
        AnimatedPlayer.queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.tick() }
    }

    private func tick() {
        guard !stopped, let source else { return }
        let i = index
        let started = CFAbsoluteTimeGetCurrent()
        // 降采样解码：给了 maxPixel 走 thumbnail 接口（长边 maxPixel），否则原尺寸解
        let cg = i < count
            ? (downsample ? CGImageSourceCreateThumbnailAtIndex(source, i, options) : CGImageSourceCreateImageAtIndex(source, i, options))
            : nil
        guard !stopped else { return }
        if let cg {
            let img = UIImage(cgImage: cg)
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped else { return }
                self.onFrame(img)
            }
        }
        // 静态图（1 帧）显示一次即止
        if count <= 1 { return }
        // 帧率上限：源帧太密就跳帧，把跳过的帧时长累加到等待里，动画总时长不变
        var next = (i + 1) % count
        var wait = durations[i]
        while wait < minInterval && next != i {
            wait += durations[next]
            next = (next + 1) % count
        }
        index = next
        let spent = CFAbsoluteTimeGetCurrent() - started
        schedule(after: max(0.016, wait - spent))
    }

    /// 单帧时长：GIF / APNG / WebP 各自的属性字典；缺省 0.1s（ImageIO 对 ≤10ms 的 GIF 也按 100ms 处理）
    static func frameDuration(_ src: CGImageSource, _ i: Int) -> TimeInterval {
        guard let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any] else { return 0.1 }
        let candidates: [(CFString, CFString, CFString)] = [
            (kCGImagePropertyWebPDictionary, kCGImagePropertyWebPUnclampedDelayTime, kCGImagePropertyWebPDelayTime),
            (kCGImagePropertyGIFDictionary, kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyGIFDelayTime),
            (kCGImagePropertyPNGDictionary, kCGImagePropertyAPNGUnclampedDelayTime, kCGImagePropertyAPNGDelayTime),
        ]
        for (dict, unclamped, clamped) in candidates {
            if let d = props[dict] as? [CFString: Any] {
                let v = (d[unclamped] as? Double) ?? (d[clamped] as? Double) ?? 0.1
                return v < 0.011 ? 0.1 : v
            }
        }
        return 0.1
    }
}

/// 文件数据缓存（动态 WebP / GIF 预览），滑走再滑回不重新下载；同一 url 并发请求只发一次
enum AnimatedImageCache {
    private static let cache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 64 * 1024 * 1024
        return c
    }()
    private static var inflight: [String: Task<Data?, Never>] = [:]

    @MainActor
    static func data(for url: String) async -> Data? {
        if let d = cache.object(forKey: url as NSString) { return d as Data }
        if let t = inflight[url] { return await t.value }
        let t = Task<Data?, Never> {
            guard let u = URL(string: url), let (d, _) = try? await URLSession.shared.data(from: u) else { return nil }
            return d
        }
        inflight[url] = t
        let d = await t.value
        inflight[url] = nil
        if let d { cache.setObject(d as NSData, forKey: url as NSString, cost: d.count) }
        return d
    }
}

/// 静态缩略图：后台降采样解码成位图后缓存 UIImage（列表滑动时不再在主线程解大图）
enum StaticThumbCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 600
        return c
    }()

    static func cached(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }

    /// 下载 + 解码（首帧，长边 maxPixel）
    static func image(url: String, maxPixel: CGFloat) async -> UIImage? {
        let key = "\(url)@\(Int(maxPixel))"
        if let img = cached(key) { return img }
        guard let data = await AnimatedImageCache.data(for: url) else { return nil }
        return await decode(data: data, key: url, maxPixel: maxPixel)
    }

    static func decode(data: Data, key: String, maxPixel: CGFloat) async -> UIImage? {
        let ck = "\(key)@\(Int(maxPixel))"
        if let img = cached(ck) { return img }
        let img = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
            var opt: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true, kCGImageSourceCreateThumbnailWithTransform: true]
            if maxPixel > 0 { opt[kCGImageSourceCreateThumbnailFromImageAlways] = true; opt[kCGImageSourceThumbnailMaxPixelSize] = Int(maxPixel) }
            let cg = maxPixel > 0 ? CGImageSourceCreateThumbnailAtIndex(src, 0, opt as CFDictionary) : CGImageSourceCreateImageAtIndex(src, 0, opt as CFDictionary)
            return cg.map { UIImage(cgImage: $0) }
        }.value
        if let img { cache.setObject(img, forKey: ck as NSString) }
        return img
    }
}

/// 静态缩略图视图：任何格式（静态 WebP / 动态 WebP 首帧 / Lottie 的 thumb）都只解一张降采样位图，商店 sheet 预览用
struct StaticThumbView: View {
    let url: String
    var maxPixel: CGFloat = 256
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() } else { Color.clear }
        }
        .task(id: url) {
            let full = Api.fullUrl(url)
            if let c = StaticThumbCache.cached("\(full)@\(Int(maxPixel))") { image = c; return }
            image = await StaticThumbCache.image(url: full, maxPixel: maxPixel)
        }
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
