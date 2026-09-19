import SwiftUI

// 浅色主题（对齐 Telegram iOS 浅色：白底、浅灰次级背景、近黑文字、灰色辅助文字）+ 玫红渐变强调色
// 2026-09-19 由纯黑沉浸切换：纯黑底白字长时间看费眼。与 Android ui/theme/Color.kt 同值
enum Theme {
    static let bg = Color.white
    /// 卡片 / 顶栏 / 底栏  #F5F5F8
    static let bg2 = Color(red: 0.961, green: 0.961, blue: 0.973)
    /// 输入框 / 未选中胶囊 / 对方气泡  #EBEBF0
    static let bg3 = Color(red: 0.922, green: 0.922, blue: 0.941)
    /// #E5E5EA
    static let line = Color(red: 0.898, green: 0.898, blue: 0.918)
    static let accent = Color(red: 0.996, green: 0.173, blue: 0.333)
    static let accent2 = Color(red: 1.0, green: 0.42, blue: 0.506)
    /// #111114
    static let text = Color(red: 0.067, green: 0.067, blue: 0.078)
    /// #8E8E93
    static let textSub = Color(red: 0.557, green: 0.557, blue: 0.576)
    /// #B5B5BC
    static let textDim = Color(red: 0.71, green: 0.71, blue: 0.737)
    static let danger = Color(red: 1.0, green: 0.302, blue: 0.31)
    static let success = Color(red: 0.043, green: 0.816, blue: 0.49)
    /// 浅底上金黄要压暗一点才看得清 #E6A100
    static let warn = Color(red: 0.902, green: 0.631, blue: 0.0)
    // 兼容旧引用
    static let gold = accent
    static let gold2 = accent2
    static let goldDim = accent.opacity(0.35)

    static let accentGrad = LinearGradient(colors: [accent, accent2], startPoint: .leading, endPoint: .trailing)

    /// 自己消息气泡：浅玫红底 + 深色文字（浅色主题下不再用白字） #FFE1E7
    static let bubbleMine = Color(red: 1.0, green: 0.882, blue: 0.906)
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
