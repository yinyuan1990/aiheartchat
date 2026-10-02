import SwiftUI

/// 从左扫到右用时、每颗粒子最长存活（秒）
private let dustSweep: Double = 0.45
private let dustLife: Double = 0.9
private let dustMaxParticles = 5000
/// 粒子往上飘，画布向上多留的空间
private let dustHeadroom: CGFloat = 120

/// 一团粒子：从快照像素生成，坐标是相对内容左上角的点
struct DustCloud {
    var n = 0
    var x: [CGFloat] = []
    var y: [CGFloat] = []
    var vx: [CGFloat] = []
    var vy: [CGFloat] = []
    var delay: [Double] = []
    var life: [Double] = []
    var r: [Double] = []
    var g: [Double] = []
    var b: [Double] = []
    var a: [Double] = []
    var size: CGFloat = 2

    static func make(_ cg: CGImage, pointsPerPixel: CGFloat) -> DustCloud? {
        let w = cg.width
        let h = cg.height
        guard w > 1, h > 1 else { return nil }
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = buf.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }

        var step = 2
        while (w / step) * (h / step) > dustMaxParticles { step += 1 }
        var c = DustCloud()
        c.size = CGFloat(step) * pointsPerPixel
        var py = 0
        while py < h {
            var px = 0
            while px < w {
                let i = (py * w + px) * 4
                let alpha = Double(buf[i + 3])
                if alpha >= 24 {
                    c.append(px: px, py: py, w: w, rgba: (Double(buf[i]), Double(buf[i + 1]), Double(buf[i + 2]), alpha), scale: pointsPerPixel)
                }
                px += step
            }
            py += step
        }
        return c.n > 0 ? c : nil
    }

    private mutating func append(px: Int, py: Int, w: Int, rgba: (Double, Double, Double, Double), scale: CGFloat) {
        let ang = -Double.pi / 2 + (Double.random(in: 0...1) - 0.15) * 1.6
        let speed = 30 + Double.random(in: 0...90)
        x.append(CGFloat(px) * scale)
        y.append(CGFloat(py) * scale)
        vx.append(CGFloat(cos(ang) * speed + 25))
        vy.append(CGFloat(sin(ang) * speed))
        delay.append(Double(px) / Double(w) * dustSweep + Double.random(in: 0...0.08))
        life.append(dustLife * (0.6 + Double.random(in: 0...0.6)))
        // 快照是预乘 alpha，还原成直通色
        let k = rgba.3 > 0 ? 255.0 / rgba.3 : 0
        r.append(min(1, rgba.0 * k / 255))
        g.append(min(1, rgba.1 * k / 255))
        b.append(min(1, rgba.2 * k / 255))
        a.append(rgba.3 / 255)
        n += 1
    }

    func draw(_ gc: inout GraphicsContext, t: Double) {
        for i in 0..<n {
            let age = t - delay[i]
            if age > life[i] { continue }
            var px = x[i]
            var py = y[i] + dustHeadroom
            var k = 1.0
            if age > 0 {
                let f = age / life[i]
                px += vx[i] * CGFloat(age) + CGFloat(sin((Double(y[i]) + age * 60) * 0.08) * 6 * f)
                py += vy[i] * CGFloat(age) - CGFloat(18 * age * age)
                k = 1 - f
            }
            let s = age > 0 ? size * CGFloat(0.5 + 0.5 * k) : size
            let alpha = a[i] * (age > 0 ? k * k : 1)
            gc.fill(Path(CGRect(x: px, y: py, width: s, height: s)), with: .color(Color(.sRGB, red: r[i], green: g[i], blue: b[i], opacity: alpha)))
        }
    }
}

/// Telegram 式删除动画（灰飞烟灭）：dying 变 true 时把内容拆成粒子从左到右飘散，播完调 onGone 再从列表移掉。
/// iOS 16+ 用 ImageRenderer 取真实像素；iOS 15 拿不到快照，退回淡出。
struct DustOut<Content: View>: View {
    let dying: Bool
    let onGone: () -> Void
    @ViewBuilder let content: () -> Content
    @EnvironmentObject private var state: AppState
    @State private var size: CGSize = .zero
    @State private var cloud: DustCloud?
    @State private var start = Date()
    @State private var fading = false

    var body: some View {
        content()
            .opacity(cloud != nil || fading ? 0 : 1)
            .background(sizeReader)
            .overlay(alignment: .topLeading) { particles }
            .onChange(of: dying) { d in if d { begin() } }
            .onAppear { if dying { begin() } }
    }

    private var sizeReader: some View {
        GeometryReader { g in
            Color.clear
                .onAppear { size = g.size }
                .onChange(of: g.size) { size = $0 }
        }
    }

    @ViewBuilder private var particles: some View {
        if let c = cloud {
            TimelineView(.animation) { tl in
                Canvas { gc, _ in
                    c.draw(&gc, t: tl.date.timeIntervalSince(start))
                }
            }
            .frame(width: size.width + 140, height: size.height + dustHeadroom + 20)
            .offset(y: -dustHeadroom)
            .allowsHitTesting(false)
        }
    }

    private func begin() {
        guard cloud == nil, !fading else { return }
        if let made = snapshotCloud() {
            start = Date()
            cloud = made
            DispatchQueue.main.asyncAfter(deadline: .now() + dustSweep + dustLife + 0.1) { onGone() }
        } else {
            withAnimation(.easeOut(duration: 0.25)) { fading = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.27) { onGone() }
        }
    }

    private func snapshotCloud() -> DustCloud? {
        guard size.width > 1, size.height > 1 else { return nil }
        if #available(iOS 16.0, *) {
            let renderer = ImageRenderer(content: content().environmentObject(state).frame(width: size.width, height: size.height))
            renderer.scale = 1
            guard let cg = renderer.cgImage else { return nil }
            return DustCloud.make(cg, pointsPerPixel: size.width / CGFloat(cg.width))
        }
        return nil
    }
}
