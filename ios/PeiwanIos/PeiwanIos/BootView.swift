import SwiftUI

/// 启动进入：设备已注册直接恢复账号，否则去注册（无密码）。启动页至少停留 1.6s 让文字动画走完
struct BootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        SplashContent()
            .task {
                let minShow = Task { try? await Task.sleep(nanoseconds: 1_600_000_000) }
                struct ReviewMode: Codable { var ios: Bool? }
                async let reviewReq: ReviewMode? = try? await Api.request("/app/review-mode")
                let resp: EnterResp? = try? await Api.request("/auth/enter", method: "POST", body: ["deviceId": Api.deviceId])
                let reviewMode = (await reviewReq)?.ios ?? false
                _ = await minShow.value
                if let resp, resp.registered, let token = resp.token, let user = resp.user {
                    Api.token = token
                    state.user = user
                    state.stage = .main
                } else if Api.token != nil, let me: UserProfile = try? await Api.request("/user/me") {
                    // 演示账号不绑定设备：上次账号密码登录留下的 token 仍有效就直接进
                    state.user = me
                    state.stage = .main
                } else {
                    // 审核模式：显示账号密码登录页；否则一机一号注册
                    state.stage = reviewMode ? .login : .register
                }
            }
    }
}

private struct Particle: Identifiable {
    let id: Int
    let x: CGFloat, y: CGFloat, r: CGFloat, speed: CGFloat, alpha: Double, phase: CGFloat
}

/// 启动页：纯黑底 + 玫红/紫两团柔光 + 缓慢上浮的光点，中间呼吸的心形，
/// 右起竖排「爱情和金钱无关 / 与内心相连」逐字浮现，底部品牌与三点加载
private struct SplashContent: View {
    @State private var shown = false
    @State private var pulse = false
    @State private var dot = 0
    private let start = Date()
    private let particles: [Particle] = {
        var g = SystemRandomNumberGenerator()
        return (0..<22).map { i in
            Particle(id: i, x: CGFloat.random(in: 0...1, using: &g), y: CGFloat.random(in: 0...1, using: &g),
                     r: CGFloat.random(in: 1...3.2, using: &g), speed: CGFloat.random(in: 0.35...1.25, using: &g),
                     alpha: Double.random(in: 0.15...0.6, using: &g), phase: CGFloat.random(in: 0...6.28, using: &g))
        }
    }()

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            // 柔光
            RadialGradient(colors: [Theme.accent.opacity(0.26), .clear], center: .center, startRadius: 0, endRadius: 180)
                .frame(width: 360, height: 360).offset(x: 120, y: -260)
            RadialGradient(colors: [Color(red: 0.47, green: 0.31, blue: 1.0).opacity(0.18), .clear], center: .center, startRadius: 0, endRadius: 160)
                .frame(width: 320, height: 320).offset(x: -130, y: 300)

            // 上浮光点（TimelineView 逐帧驱动）
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
                Canvas { g, size in
                    let t = ctx.date.timeIntervalSince(start) / 14.0
                    for p in particles {
                        let y = ((p.y - CGFloat(t) * p.speed).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)
                        let x = p.x + 0.012 * sin(CGFloat(t) * 6.28 * 2 + p.phase)
                        let rect = CGRect(x: x * size.width - p.r, y: y * size.height - p.r, width: p.r * 2, height: p.r * 2)
                        g.fill(Path(ellipseIn: rect), with: .color(Color(red: 1, green: 0.7, blue: 0.76).opacity(p.alpha)))
                    }
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)

            VStack(spacing: 44) {
                HeartGlyph(glow: pulse ? 0.95 : 0.45)
                    .frame(width: 96, height: 96)
                    .scaleEffect(pulse ? 1.06 : 0.94)

                // 右起竖读：右列第一句，左列第二句略下沉，左列底下一枚「心」印
                HStack(alignment: .top, spacing: 26) {
                    VStack(spacing: 14) {
                        VerticalChars(text: "与内心相连", shown: shown, startIndex: 7, size: 17, color: Theme.textSub, weight: .regular)
                        Text("心")
                            .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Theme.accent))
                            .opacity(shown ? 1 : 0)
                            .animation(.easeOut(duration: 0.5).delay(1.25), value: shown)
                    }
                    .padding(.top, 56)
                    VerticalChars(text: "爱情和金钱无关", shown: shown, startIndex: 0, size: 24, color: .white, weight: .medium)
                }
            }
            .offset(y: -24)

            // 底部品牌 + 三点加载
            VStack(spacing: 4) {
                Text("心 之 音").font(.system(size: 13)).tracking(4).foregroundStyle(Theme.textSub)
                Text("LOVE HAS NOTHING TO DO WITH MONEY").font(.system(size: 9)).tracking(2).foregroundStyle(Theme.textDim)
                HStack(spacing: 6) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle().fill(dot == i ? Theme.accent2 : Theme.accent.opacity(0.25)).frame(width: 5, height: 5)
                    }
                }
                .padding(.top, 14)
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 54)
        }
        .onAppear {
            shown = true
            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) { pulse = true }
        }
        .onReceive(Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()) { _ in dot = (dot + 1) % 3 }
    }
}

/// 竖排逐字浮现（每字延迟 90ms，从下方 10pt 淡入）
private struct VerticalChars: View {
    let text: String
    let shown: Bool
    let startIndex: Int
    let size: CGFloat
    let color: Color
    let weight: Font.Weight

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(text.enumerated()), id: \.offset) { i, ch in
                Text(String(ch))
                    .font(.system(size: size, weight: weight))
                    .foregroundStyle(color)
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown ? 0 : 10)
                    .animation(.easeOut(duration: 0.52).delay(0.2 + Double(startIndex + i) * 0.09), value: shown)
            }
        }
    }
}

/// 心形：外圈多层低透明描边模拟发光 + 渐变主描边
private struct HeartGlyph: View {
    var glow: Double

    var body: some View {
        Canvas { g, size in
            let w = size.width, h = size.height
            var p = Path()
            p.move(to: CGPoint(x: w * 0.5, y: h * 0.86))
            p.addCurve(to: CGPoint(x: w * 0.10, y: h * 0.26), control1: CGPoint(x: w * 0.18, y: h * 0.64), control2: CGPoint(x: w * 0.02, y: h * 0.44))
            p.addCurve(to: CGPoint(x: w * 0.5, y: h * 0.30), control1: CGPoint(x: w * 0.18, y: h * 0.08), control2: CGPoint(x: w * 0.42, y: h * 0.10))
            p.addCurve(to: CGPoint(x: w * 0.90, y: h * 0.26), control1: CGPoint(x: w * 0.58, y: h * 0.10), control2: CGPoint(x: w * 0.82, y: h * 0.08))
            p.addCurve(to: CGPoint(x: w * 0.5, y: h * 0.86), control1: CGPoint(x: w * 0.98, y: h * 0.44), control2: CGPoint(x: w * 0.82, y: h * 0.64))
            p.closeSubpath()
            for i in stride(from: 4, through: 1, by: -1) {
                g.stroke(p, with: .color(Theme.accent.opacity(0.05 * glow * Double(i))), style: StrokeStyle(lineWidth: w * 0.07 + CGFloat(i) * w * 0.045, lineCap: .round, lineJoin: .round))
            }
            g.stroke(p, with: .linearGradient(Gradient(colors: [Theme.accent2, Theme.accent]), startPoint: .zero, endPoint: CGPoint(x: w, y: h)),
                     style: StrokeStyle(lineWidth: w * 0.075, lineCap: .round, lineJoin: .round))
        }
    }
}
