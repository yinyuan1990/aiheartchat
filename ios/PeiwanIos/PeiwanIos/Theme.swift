import SwiftUI

// 纯黑沉浸 + 玫红渐变（对齐 Web 定稿）
enum Theme {
    static let bg = Color(red: 0.039, green: 0.039, blue: 0.047)
    static let bg2 = Color(red: 0.086, green: 0.086, blue: 0.098)
    static let bg3 = Color(red: 0.129, green: 0.129, blue: 0.149)
    static let line = Color(red: 0.122, green: 0.122, blue: 0.141)
    static let accent = Color(red: 0.996, green: 0.173, blue: 0.333)
    static let accent2 = Color(red: 1.0, green: 0.42, blue: 0.506)
    static let text = Color.white
    static let textSub = Color(red: 0.541, green: 0.541, blue: 0.576)
    static let textDim = Color(red: 0.29, green: 0.29, blue: 0.32)
    static let danger = Color(red: 1.0, green: 0.302, blue: 0.31)
    static let success = Color(red: 0.043, green: 0.816, blue: 0.49)
    static let warn = Color(red: 1.0, green: 0.722, blue: 0.0)
    // 兼容旧引用
    static let gold = accent
    static let gold2 = accent2
    static let goldDim = accent.opacity(0.35)

    static let accentGrad = LinearGradient(colors: [accent, accent2], startPoint: .leading, endPoint: .trailing)

    /// 自己消息气泡：深玫红，比 accent 柔和不晃眼
    static let bubbleMine = Color(red: 75 / 255, green: 32 / 255, blue: 40 / 255)
}

func fmtPoints(_ fen: String?) -> String {
    let n = (Double(fen ?? "0") ?? 0) / 100.0
    var s = String(format: "%.2f", n)
    if s.contains(".") { while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() } }
    return s.isEmpty ? "0" : s
}

extension View {
    func fullBg() -> some View { ZStack { Theme.bg.ignoresSafeArea(); self } }
}

struct LuxuryCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(LinearGradient(colors: [Theme.bg2, Theme.bg3], startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.goldDim, lineWidth: 1))
    }
}

extension View {
    func luxuryCard() -> some View { modifier(LuxuryCard()) }
}
