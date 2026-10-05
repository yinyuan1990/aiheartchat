import Foundation
import SwiftUI

/// 界面文字多语言：bundle 里的 i18n_<语言>.json（仓库根目录 i18n/ 里维护，node i18n/sync.mjs 复制过来）。
/// 切换语言后根视图按 `lang` 重建（回到首页）。缺的 key 显示中文。
/// 显式 @MainActor：同 AppState，工程默认 MainActor 隔离，隐式推断时部分 Xcode 版本误报 ObservableObject
@MainActor
final class I18n: ObservableObject {
    static let shared = I18n()
    static let system = "system"
    private static let fallback = "zh"
    private static let key = "appLang"

    private let tables: [String: [String: String]]
    /// "system" 或语言代码
    @Published private(set) var choice: String

    private init() {
        var t: [String: [String: String]] = [:]
        let urls = (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: "i18n") ?? [])
        for url in urls {
            let name = url.deletingPathExtension().lastPathComponent
            guard name.hasPrefix("i18n_"), let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { continue }
            t[String(name.dropFirst(5))] = obj
        }
        tables = t
        choice = UserDefaults.standard.string(forKey: I18n.key) ?? I18n.system
    }

    /// 打包进来的语言：代码 + 本语言里的名字（"简体中文"、"English"），中文排第一
    var languages: [(code: String, name: String)] {
        tables.keys.sorted { a, b in a == I18n.fallback || (b != I18n.fallback && a < b) }
            .map { ($0, tables[$0]?["lang.name"] ?? $0) }
    }

    /// 当前生效的语言代码
    var lang: String {
        if choice != I18n.system, tables[choice] != nil { return choice }
        let sys = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "zh"
        if sys == "zh" { return "zh" }
        return tables[sys] != nil ? sys : "en"
    }

    func select(_ code: String) {
        UserDefaults.standard.set(code, forKey: I18n.key)
        choice = code
    }

    func text(_ key: String, _ args: [String: Any]) -> String {
        var s = tables[lang]?[key] ?? tables[I18n.fallback]?[key] ?? key
        for (k, v) in args { s = s.replacingOccurrences(of: "{\(k)}", with: "\(v)") }
        return s
    }
}

/// t("me.frozen", ["n": 12])
@MainActor
func t(_ key: String, _ args: [String: Any] = [:]) -> String {
    I18n.shared.text(key, args)
}
