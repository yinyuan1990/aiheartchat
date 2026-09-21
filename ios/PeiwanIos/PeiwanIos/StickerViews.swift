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

/// 「滚动中」环境值：表情面板的滚动区在滚动时置 true，网格里的动图 / Lottie 一律停在当前帧（Telegram 同款策略），停下再播。
/// 气泡 / 评论等没设这个值的地方默认 false，照常播。
private struct StickerPlaybackPausedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var stickerPlaybackPaused: Bool {
        get { self[StickerPlaybackPausedKey.self] }
        set { self[StickerPlaybackPausedKey.self] = newValue }
    }
}

/// 渲染一张贴纸 / GIF。size 为长边，按 w/h 保比例。静态 WebP → RemoteImage；动态 WebP → ImageIO 逐帧；Lottie → lottie-ios；
/// GIF（mp4）→ AVPlayer 静音循环，autoplay=false 时只放动态 WebP 预览（面板网格 / 待发小图）。
struct StickerImageView: View {
    let p: StickerPayload
    var size: CGFloat = 140
    var autoplay = true
    @Environment(\.stickerPlaybackPaused) private var paused

    private var w: CGFloat { p.aspect >= 1 ? size : size * p.aspect }
    private var h: CGFloat { p.aspect >= 1 ? size / p.aspect : size }

    /// 解码降采样目标：显示尺寸 × 屏幕倍率（再大也看不出区别，白费 CPU 和内存）
    private var px: CGFloat { size * UIScreen.main.scale }
    /// 面板网格 / 待发小图（≤ 80pt）一屏几十个同时播：限 12fps；气泡里正常 30fps
    private var fpsCap: Double { size <= 80 ? 12 : 30 }
    private var small: Bool { size <= 80 }

    var body: some View {
        Group {
            switch p.format {
            case "lottie":
                if !autoplay {
                    StaticThumbView(url: (p.thumb ?? "").isEmpty ? p.url : p.thumb!, maxPixel: px)
                } else if let u = URL(string: Api.fullUrl(p.url)) {
                    LottieStickerView(url: u, thumb: p.thumb ?? "", px: px, paused: paused, stagger: small)
                }
            case "awebp":
                if autoplay {
                    AnimatedImageView(url: Api.fullUrl(p.url), animate: !paused, maxPixel: px, maxFps: fpsCap)
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
                    AnimatedImageView(url: Api.fullUrl((p.thumb ?? "").isEmpty ? p.url : p.thumb!), animate: !paused, fill: true, maxPixel: px, maxFps: 12)
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

/**
 Lottie 贴纸（默认 Core Animation 渲染引擎：动画交给渲染服务，主线程不逐帧画）。

 两个性能点：
 1. `.resizable()` 必须有——不加时 LottieView 按动画固有尺寸（TG 贴纸 512pt）布局，再被外面 `.frame(62).clipped()` 裁，
    每个格子都是一棵 512pt 大小、几百层带蒙版的图层树在滚动中被合成；一屏 35 个就够渲染服务掉帧了。
 2. 滚动中（paused）：**不新建** LottieView（图层树在主线程搭，一行 5 个进视口就是一次卡顿），已建好的暂停并隐藏（opacity 0 的图层渲染服务不合成），
    露出静态 thumb；停下后再建，且小图错开 0~0.4 秒（几十个同时建会顿一下，错开后每帧只建一两个，静止时看不出来）。
 注意：不要 configure { respectAnimationFrameRate / shouldRasterizeWhenIdle }——Core Animation 引擎不支持，会走 LottieLogger.assertionFailure，Debug 下直接卡死。
 */
private struct LottieStickerView: View {
    let url: URL
    let thumb: String
    let px: CGFloat
    var paused: Bool
    /// 建 LottieView 前随机等一小会（面板网格用）
    var stagger: Bool
    @State private var created = false

    private var hasThumb: Bool { !thumb.isEmpty }
    /// 有 thumb 时滚动中用 thumb 顶替；没 thumb 的只能让 Lottie 停在当前帧继续显示
    private var hideLottie: Bool { paused && hasThumb }

    var body: some View {
        ZStack {
            if !created || hideLottie { thumbView }
            if created {
                LottieView {
                    try await LottieAnimation.loadedFrom(url: url)
                } placeholder: {
                    thumbView
                }
                .playbackMode(paused ? .paused(at: .currentFrame) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)))
                .resizable()
                .opacity(hideLottie ? 0 : 1)
            }
        }
        .task(id: paused) {
            guard !created, !paused else { return }
            if stagger { try? await Task.sleep(nanoseconds: UInt64.random(in: 0...400_000_000)) }
            if !Task.isCancelled { created = true }
        }
    }

    @ViewBuilder private var thumbView: some View {
        if hasThumb { StaticThumbView(url: thumb, maxPixel: px) } else { Color.clear }
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
    /// false = 停在当前帧（还没显示过就解首帧出来）。面板滚动中传 false，停下再传 true，不重建播放器
    var animate: Bool
    var fill = false
    /// 解码时降采样到的最大像素（长边）。0 = 不降采样。面板小图 / GIF 瓦片传显示尺寸×scale 即可
    var maxPixel: CGFloat = 0
    /// 帧率上限（0 = 按源文件）。面板一屏几十个小图同时播，30fps 的源全解会把 CPU 吃满、滑动卡，小图 12fps 看不出差别
    var maxFps: Double = 0

    final class Holder {
        var url = ""
        var animate = true
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
        if holder.url == url {
            // 只是播 / 停切换：不重新下载、不重建，停在当前帧
            if holder.animate != animate {
                holder.animate = animate
                holder.player?.setPlaying(animate)
            }
            return
        }
        holder.url = url
        holder.animate = animate
        holder.player?.stop()
        holder.player = nil
        v.image = nil
        let target = url
        let maxPixel = self.maxPixel
        let maxFps = self.maxFps
        Task { @MainActor in
            guard let data = await AnimatedImageCache.data(for: target), holder.url == target else { return }
            // 播放器 init 不碰 ImageIO（容器解析 / 帧时长都在解码队列上做），主线程这里只是建个对象
            let player = AnimatedPlayer(data: data, maxPixel: maxPixel, maxFps: maxFps) { [weak v] img in v?.image = img }
            holder.player = player
            player.setPlaying(holder.animate)
        }
    }

    static func dismantleUIView(_ uiView: UIImageView, coordinator: Holder) {
        coordinator.player?.stop()
        coordinator.player = nil
        coordinator.url = ""
    }
}

/**
 逐帧播放器：后台解码、主线程显示。所有实例共用一个并发队列（qos userInitiated），不额外开线程。
 - 可暂停 / 恢复（`setPlaying`）：暂停时停在当前帧，恢复从下一帧继续；用代数 `gen` 让旧的 tick 链自然失效，不会出现两条链同时跑
 - 容器解析（`CGImageSourceCreateWithData` / `GetCount`）和逐帧时长都在解码队列上懒做，主线程建对象零成本
 */
final class AnimatedPlayer {
    private static let queue = DispatchQueue(label: "peiwan.anim.decode", qos: .userInitiated, attributes: .concurrent)
    private let data: Data
    private let options: CFDictionary
    private let downsample: Bool
    /// 两帧之间最短间隔（帧率上限），0 = 不限
    private let minInterval: TimeInterval
    private let onFrame: (UIImage) -> Void

    // 以下状态主线程（setPlaying / stop）和解码队列（tick）都会碰，统一加锁
    private let lock = NSLock()
    private var source: CGImageSource?
    /// -1 = 容器还没解析
    private var count = -1
    private var durations: [TimeInterval?] = []
    private var index = 0
    private var playing = false
    private var stopped = false
    /// 是否已经把至少一帧交给了视图
    private var shown = false
    /// 每次 setPlaying / stop 递增；tick 链带着自己的代数，代数对不上就结束
    private var gen = 0

    init(data: Data, maxPixel: CGFloat, maxFps: Double = 0, onFrame: @escaping (UIImage) -> Void) {
        self.data = data
        self.onFrame = onFrame
        minInterval = maxFps > 0 ? 1.0 / maxFps : 0
        var opt: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        downsample = maxPixel > 0
        if downsample {
            opt[kCGImageSourceCreateThumbnailFromImageAlways] = true
            opt[kCGImageSourceCreateThumbnailWithTransform] = true
            opt[kCGImageSourceThumbnailMaxPixelSize] = Int(maxPixel)
        }
        options = opt as CFDictionary
    }

    /// 播 / 停。停时保留当前帧；一帧都还没显示过（刚建好就是停的）就先解一帧出来
    func setPlaying(_ p: Bool) {
        lock.lock()
        playing = p
        gen += 1
        let g = gen
        let needTick = p || !shown
        lock.unlock()
        if needTick { schedule(g, after: 0) }
    }

    func stop() {
        lock.lock()
        stopped = true
        playing = false
        gen += 1
        lock.unlock()
    }

    private func schedule(_ g: Int, after delay: TimeInterval) {
        AnimatedPlayer.queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.tick(g) }
    }

    private func alive(_ g: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !stopped && gen == g
    }

    /// 解析容器（只做一次，在解码队列上）。kCGImageSourceShouldCache=false：不让 ImageIO 把解过的帧全留在内存里
    private func prepare() {
        lock.lock()
        let done = count >= 0
        lock.unlock()
        if done { return }
        let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        let n = src.map { CGImageSourceGetCount($0) } ?? 0
        lock.lock()
        if count < 0 {
            source = src
            count = n
            durations = Array(repeating: nil, count: n)
        }
        lock.unlock()
    }

    private func duration(_ src: CGImageSource, _ i: Int) -> TimeInterval {
        lock.lock()
        let cached = i < durations.count ? durations[i] : nil
        lock.unlock()
        if let cached { return cached }
        let d = AnimatedPlayer.frameDuration(src, i)
        lock.lock()
        if i < durations.count { durations[i] = d }
        lock.unlock()
        return d
    }

    private func tick(_ g: Int) {
        guard alive(g) else { return }
        prepare()
        lock.lock()
        let src = source, n = count, i = index
        lock.unlock()
        guard let src, n > 0, i < n else { return }
        let started = CFAbsoluteTimeGetCurrent()
        // 降采样解码：给了 maxPixel 走 thumbnail 接口（长边 maxPixel），否则原尺寸解
        let cg = downsample ? CGImageSourceCreateThumbnailAtIndex(src, i, options) : CGImageSourceCreateImageAtIndex(src, i, options)
        guard alive(g) else { return }
        if let cg {
            let img = UIImage(cgImage: cg)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                // 解到一半被暂停的帧照样显示（只是慢了一点的当前帧），被 stop 的才丢
                self.lock.lock()
                let dead = self.stopped
                self.shown = self.shown || !dead
                self.lock.unlock()
                if !dead { self.onFrame(img) }
            }
        }
        lock.lock()
        let cont = playing && n > 1
        lock.unlock()
        // 静态图（1 帧）或暂停中：显示这一帧即止
        guard cont else { return }
        // 帧率上限：源帧太密就跳帧，把跳过的帧时长累加到等待里，动画总时长不变
        var next = (i + 1) % n
        var wait = duration(src, i)
        while wait < minInterval && next != i {
            wait += duration(src, next)
            next = (next + 1) % n
        }
        lock.lock()
        index = next
        lock.unlock()
        let spent = CFAbsoluteTimeGetCurrent() - started
        schedule(g, after: max(0.016, wait - spent))
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
