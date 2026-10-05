import Photos
import SwiftUI

// 聊天多图（相册）：一次选多张图时每张仍是一条 image 消息，地址后面带 `#g=相册id&w=宽&h=高`。
// 同一个人连续发、g 相同的图片合成一组，按 Telegram 的分组规则排版。老版本加载图片时忽略 # 后面的部分。
// 网页版 web/src/album.ts、Android ChatAlbum.kt 是同一套算法，改的话三端一起改。

struct ImageMeta {
    var url: String
    var g: String? = nil
    var w: Int = 0
    var h: Int = 0
}

let maxAlbum = 10

func parseImage(_ content: String) -> ImageMeta {
    guard let hash = content.firstIndex(of: "#") else { return ImageMeta(url: content) }
    var meta = ImageMeta(url: String(content[content.startIndex..<hash]))
    let frag = content[content.index(after: hash)...]
    for kv in frag.split(separator: "&") {
        let parts = kv.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { continue }
        switch parts[0] {
        case "g": if !parts[1].isEmpty { meta.g = parts[1] }
        case "w": meta.w = Int(parts[1]) ?? 0
        case "h": meta.h = Int(parts[1]) ?? 0
        default: break
        }
    }
    return meta
}

func imageContent(_ url: String, g: String?, w: Int, h: Int) -> String {
    var kv: [String] = []
    if let g, !g.isEmpty { kv.append("g=\(g)") }
    if w > 0 && h > 0 { kv.append("w=\(w)"); kv.append("h=\(h)") }
    return kv.isEmpty ? url : url + "#" + kv.joined(separator: "&")
}

func imageUrlOf(_ content: String) -> String {
    guard let hash = content.firstIndex(of: "#") else { return content }
    return String(content[content.startIndex..<hash])
}

func newAlbumId() -> String {
    let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    return String((0..<8).map { _ in chars[Int.random(in: 0..<chars.count)] })
}

/// 聊天列表里的一行：普通消息一条，同一相册的连续图片合成一行
struct ChatRow: Identifiable {
    let id: String
    let items: [MsgItem]
    /// 这行第一条在 messages 里的下标
    let start: Int
    var first: MsgItem { items[0] }
    var isAlbum: Bool { items.count > 1 }
}

func groupAlbums(_ list: [MsgItem]) -> [ChatRow] {
    var groups: [[MsgItem]] = []
    var curG = ""
    for m in list {
        let g = m.type == "image" ? (parseImage(m.content).g ?? "") : ""
        if !g.isEmpty, g == curG, let last = groups.last, last[0].senderId == m.senderId, last.count < maxAlbum {
            groups[groups.count - 1].append(m)
            continue
        }
        groups.append([m])
        curG = g
    }
    var rows: [ChatRow] = []
    var start = 0
    for items in groups {
        let first = items[0]
        let key: String
        if items.count > 1 {
            key = "g_" + (parseImage(first.content).g ?? first.id)
        } else {
            key = first.upKey ?? first.id
        }
        rows.append(ChatRow(id: key, items: items, start: start))
        start += items.count
    }
    return rows
}

/// 相册里一格的位置，单位是相册宽度
struct AlbumRect {
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat
}

private let albumMaxH: CGFloat = 1.02
private let albumMinW: CGFloat = 0.27

/// ratios：每张图的宽 / 高。返回每格的位置和相册总高度（相对宽度）
func albumLayout(_ raw: [CGFloat]) -> (rects: [AlbumRect], height: CGFloat) {
    let n = raw.count
    let r: [CGFloat] = raw.map { x in (x.isFinite && x > 0) ? min(max(x, 0.2), 5) : 1 }
    let H = albumMaxH
    if n == 1 {
        let h = min(1 / r[0], H * 1.2)
        return ([AlbumRect(x: 0, y: 0, w: 1, h: h)], h)
    }
    let prop: [Character] = r.map { x -> Character in x > 1.2 ? "w" : (x < 0.8 ? "n" : "q") }
    let propStr = String(prop)
    let avg = r.reduce(0, +) / CGFloat(n)
    let force = r.contains { $0 > 2 }

    if !force && n == 2 {
        if propStr == "ww" && avg > 1.4 / H && abs(r[1] - r[0]) < 0.2 {
            let h = min(min(1 / r[0], 1 / r[1]), H / 2)
            return ([AlbumRect(x: 0, y: 0, w: 1, h: h), AlbumRect(x: 0, y: h, w: 1, h: h)], h * 2)
        }
        if propStr == "ww" || propStr == "qq" {
            let h = min(min(0.5 / r[0], 0.5 / r[1]), H)
            return ([AlbumRect(x: 0, y: 0, w: 0.5, h: h), AlbumRect(x: 0.5, y: 0, w: 0.5, h: h)], h)
        }
        let w1 = max(0.4, r[1] / (r[0] + r[1]))
        let w0 = 1 - w1
        let h = min(H, min(w0 / r[0], w1 / r[1]))
        return ([AlbumRect(x: 0, y: 0, w: w0, h: h), AlbumRect(x: w0, y: 0, w: w1, h: h)], h)
    }

    if !force && n == 3 {
        if prop[0] == "n" {
            // 左边一张大图占满高度，右边上下两张
            let h2 = min(H * 0.5, r[1] / (r[2] + r[1]))
            let h1 = H - h2
            let rw = max(albumMinW, min(0.5, min(h2 * r[2], h1 * r[1])))
            let lw = 1 - rw
            return ([AlbumRect(x: 0, y: 0, w: lw, h: H), AlbumRect(x: lw, y: 0, w: rw, h: h1), AlbumRect(x: lw, y: h1, w: rw, h: h2)], H)
        }
        // 上面一张通栏，下面两张并排
        let h0 = min(1 / r[0], H * 0.66)
        let h1 = min(H - h0, min(0.5 / r[1], 0.5 / r[2]))
        return ([AlbumRect(x: 0, y: 0, w: 1, h: h0), AlbumRect(x: 0, y: h0, w: 0.5, h: h1), AlbumRect(x: 0.5, y: h0, w: 0.5, h: h1)], h0 + h1)
    }

    if !force && n == 4 {
        if prop[0] == "w" {
            // 上面一张通栏，下面三张并排
            let h0 = min(1 / r[0], H * 0.66)
            var h = 1 / (r[1] + r[2] + r[3])
            let w0 = max(albumMinW, h * r[1])
            let w2 = max(albumMinW, h * r[3])
            let w1 = max(0.1, 1 - w0 - w2)
            h = min(H - h0, h)
            let rects = [
                AlbumRect(x: 0, y: 0, w: 1, h: h0),
                AlbumRect(x: 0, y: h0, w: w0, h: h),
                AlbumRect(x: w0, y: h0, w: w1, h: h),
                AlbumRect(x: w0 + w1, y: h0, w: 1 - w0 - w1, h: h),
            ]
            return (rects, h0 + h)
        }
        // 左边一张大图，右边三张竖排
        let sumInv = 1 / r[1] + 1 / r[2] + 1 / r[3]
        let rw = min(0.5, max(albumMinW, H / sumInv))
        let h0 = min(0.33 * H, rw / r[1])
        let h1 = min(0.33 * H, rw / r[2])
        let h2 = H - h0 - h1
        let lw = 1 - rw
        let rects = [
            AlbumRect(x: 0, y: 0, w: lw, h: H),
            AlbumRect(x: lw, y: 0, w: rw, h: h0),
            AlbumRect(x: lw, y: h0, w: rw, h: h1),
            AlbumRect(x: lw, y: h0 + h1, w: rw, h: h2),
        ]
        return (rects, H)
    }

    // 5 张以上（或有特别宽的图）：枚举 2～4 行的切法，选总高度最接近 4:3 的
    let cr: [CGFloat] = r.map { x in avg > 1.1 ? max(1, x) : min(1, x) }
    func rowH(_ start: Int, _ count: Int) -> CGFloat {
        var s: CGFloat = 0
        for i in start..<(start + count) { s += cr[i] }
        return 1 / s
    }
    var attempts: [[Int]] = []
    if n >= 2 {
        for a in 1..<n {
            let b = n - a
            if a <= 3 && b <= 3 { attempts.append([a, b]) }
        }
    }
    if n >= 3 {
        for a in 1..<(n - 1) {
            for b in 1..<(n - a) {
                let c = n - a - b
                let maxB = avg < 0.85 ? 4 : 3
                if a <= 3 && b <= maxB && c <= 3 { attempts.append([a, b, c]) }
            }
        }
    }
    if n >= 4 {
        for a in 1..<(n - 2) {
            for b in 1..<(n - a - 1) {
                for c in 1..<(n - a - b) {
                    let d = n - a - b - c
                    if a <= 3 && b <= 3 && c <= 3 && d <= 3 { attempts.append([a, b, c, d]) }
                }
            }
        }
    }
    let target: CGFloat = 4.0 / 3.0
    var best: [Int] = attempts.first ?? [n]
    var bestDiff = CGFloat.greatestFiniteMagnitude
    for counts in attempts {
        var start = 0
        var total: CGFloat = 0
        var minH = CGFloat.greatestFiniteMagnitude
        for c in counts {
            let h = rowH(start, c)
            total += h
            minH = min(minH, h)
            start += c
        }
        var diff = abs(total - target)
        var uneven = false
        if counts.count > 1 && counts[0] > counts[1] { uneven = true }
        if counts.count > 2 && counts[1] > counts[2] { uneven = true }
        if counts.count > 3 && counts[2] > counts[3] { uneven = true }
        if uneven { diff *= 1.2 }
        if minH < albumMinW { diff *= 1.5 }
        if diff < bestDiff {
            bestDiff = diff
            best = counts
        }
    }
    var rects: [AlbumRect] = []
    var start = 0
    var y: CGFloat = 0
    for c in best {
        let h = rowH(start, c)
        var x: CGFloat = 0
        for i in start..<(start + c) {
            let w: CGFloat = (i == start + c - 1) ? 1 - x : cr[i] * h
            rects.append(AlbumRect(x: x, y: y, w: w, h: h))
            x += w
        }
        y += h
        start += c
    }
    return (rects, y)
}

// MARK: - 上传

/// 本地图片的上传状态：progress 0～1；失败等重试
struct UploadState {
    var progress: Double = 0
    var failed: Bool = false
}

/// 待上传的图：相册里的照片（上传时才导出 JPEG）或已经是 JPEG 的数据
enum UploadSource {
    case asset(PHAsset)
    case data(Data)
}

/// 最多 limit 个同时上传（第 i 个等第 i-limit 个传完再开始），传完按 keys 的顺序发出（send 等到服务端确认再发下一张）；失败的跳过，留给重试
@MainActor
func uploadInOrder(_ keys: [String], limit: Int = 3, upload: @escaping @MainActor (String) async -> String?, send: @escaping @MainActor (String, String) async -> Void) async {
    var tasks: [Task<String?, Never>] = []
    for (i, k) in keys.enumerated() {
        let prev: Task<String?, Never>? = i >= limit ? tasks[i - limit] : nil
        let task = Task { @MainActor () -> String? in
            if let prev { _ = await prev.value }
            return await upload(k)
        }
        tasks.append(task)
    }
    for (i, k) in keys.enumerated() {
        if let url = await tasks[i].value { await send(k, url) }
    }
}

private final class AckWaiter {
    var done = false
    var remove: (() -> Void)?
}

/// 等服务端确认这条消息（ack / error），最多 timeout 秒。
/// 连发几条时要一条一条等：服务端并发处理同一连接的帧，连着发入库顺序不固定。
@MainActor
func awaitAck(_ tempId: String, timeout: Double = 8) async -> Bool {
    await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
        let w = AckWaiter()
        let finish: (Bool) -> Void = { ok in
            if w.done { return }
            w.done = true
            w.remove?()
            cont.resume(returning: ok)
        }
        w.remove = WsClient.shared.addListener { frame in
            guard (frame["tempId"] as? String) == tempId else { return }
            let op = frame["op"] as? String
            if op == "ack" { finish(true) } else if op == "error" { finish(false) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(false) }
    }
}

extension AttachMedia {
    /// 聊天里先显示的预览图（长边约 600）
    static func preview(_ asset: PHAsset) async -> UIImage? {
        let opts = PHImageRequestOptions()
        opts.deliveryMode = .highQualityFormat
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = true
        let target = CGSize(width: 600, height: 600)
        return await withCheckedContinuation { cont in
            PHImageManager.default().requestImage(for: asset, targetSize: target, contentMode: .aspectFit, options: opts) { img, _ in
                cont.resume(returning: img)
            }
        }
    }
}

// MARK: - 界面

/// 图片上盖的一层：上传中是进度圈，传完等服务端确认时转圈，失败点一下重试
struct UploadOverlay: View {
    let state: UploadState?
    let sending: Bool
    var onRetry: () -> Void = {}
    @State private var spin = false

    var body: some View {
        if let s = state, s.failed {
            Button(action: onRetry) {
                VStack(spacing: 4) {
                    Text("!").font(.system(size: 20, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.red))
                    Text(t("chat.upload.retry")).font(.system(size: 11)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.opacity(0.18))
            }
            .buttonStyle(.plain)
        } else if state != nil || sending {
            ZStack {
                Color.black.opacity(0.18)
                Circle().fill(Color.black.opacity(0.45)).frame(width: 44, height: 44)
                ring
            }
            .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var ring: some View {
        if let s = state {
            Circle()
                .trim(from: 0, to: CGFloat(max(0.04, s.progress)))
                .stroke(Color.white, style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: 34, height: 34)
                .animation(.linear(duration: 0.2), value: s.progress)
        } else {
            Circle()
                .trim(from: 0, to: 0.28)
                .stroke(Color.white, style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
                .frame(width: 34, height: 34)
                .rotationEffect(.degrees(spin ? 360 : 0))
                .onAppear {
                    withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true }
                }
        }
    }
}

/// 相册里的一格
struct AlbumCell: Identifiable {
    let id: String
    let url: String
    let local: UIImage?
    let w: Int
    let h: Int
    let state: UploadState?
    let sending: Bool
}

/// 一格图片：本地预览优先，否则加载服务器地址
struct ChatImageView: View {
    let url: String
    let local: UIImage?

    var body: some View {
        if let local {
            Image(uiImage: local).resizable().scaledToFill()
        } else {
            RemoteImage(url: url)
        }
    }
}

/// Telegram 式多图拼版：整块圆角，格子之间留 2pt 缝
struct ImageAlbumView: View {
    let cells: [AlbumCell]
    let width: CGFloat
    let onTap: (Int) -> Void
    let onLongPress: (Int) -> Void
    let onRetry: (Int) -> Void

    private var layout: (rects: [AlbumRect], height: CGFloat) {
        let ratios: [CGFloat] = cells.map { c in (c.w > 0 && c.h > 0) ? CGFloat(c.w) / CGFloat(c.h) : 1 }
        return albumLayout(ratios)
    }

    var body: some View {
        let l = layout
        let total = l.height * width
        return ZStack(alignment: .topLeading) {
            Theme.bg3
            ForEach(Array(cells.enumerated()), id: \.element.id) { i, c in
                cellView(i, c, l.rects[i], l.height)
            }
        }
        .frame(width: width, height: total)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func cellView(_ i: Int, _ c: AlbumCell, _ r: AlbumRect, _ height: CGFloat) -> some View {
        let gap: CGFloat = 1
        let left = r.x * width + (r.x > 0.001 ? gap : 0)
        let right = (r.x + r.w) * width - (r.x + r.w < 0.999 ? gap : 0)
        let top = r.y * width + (r.y > 0.001 ? gap : 0)
        let bottom = (r.y + r.h) * width - (r.y + r.h < height - 0.001 ? gap : 0)
        let w = max(1, right - left)
        let h = max(1, bottom - top)
        return ChatImageView(url: c.url, local: c.local)
            .frame(width: w, height: h)
            .clipped()
            .overlay(UploadOverlay(state: c.state, sending: c.sending, onRetry: { onRetry(i) }))
            .contentShape(Rectangle())
            .onTapGesture { onTap(i) }
            .onLongPressGesture(minimumDuration: 0.35) { onLongPress(i) }
            .padding(.leading, left)
            .padding(.top, top)
    }
}

/// 单张图：有宽高就按比例预留尺寸（加载前不跳动）
func singleImageSize(w: Int, h: Int, maxW: CGFloat, maxH: CGFloat) -> CGSize? {
    guard w > 0, h > 0 else { return nil }
    let s = min(maxW / CGFloat(w), maxH / CGFloat(h))
    return CGSize(width: max(60, CGFloat(w) * s), height: max(60, CGFloat(h) * s))
}
