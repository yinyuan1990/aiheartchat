import Foundation
import SwiftUI

/// 界面文字多语言：bundle 里的 i18n_<语言>.json（仓库根目录 i18n/ 里维护，node i18n/sync.mjs 复制过来）。缺的 key 显示中文。
/// 工程默认隔离是 nonisolated：查表放在不绑主线程的 `I18nStore`（表只读、当前语言加锁），`t()` 在任何上下文都能调；
/// `I18n` 只负责界面：切换语言后根视图按 `choice` 重建（回到首页）。
final class I18nStore: @unchecked Sendable {
    static let shared = I18nStore()
    static let system = "system"
    static let fallback = "zh"
    /// 没在「我的 → 语言」里选过时用英文（不跟随系统）；选过「跟随系统」的照旧
    static let defaultChoice = "en"
    private static let key = "appLang"

    let tables: [String: [String: String]]
    private let lock = NSLock()
    private var _choice: String
    private let serverPatterns: [(key: String, re: NSRegularExpression, names: [String])]

    private init() {
        var all: [String: [String: String]] = [:]
        let urls = (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: "i18n") ?? [])
        for url in urls {
            let name = url.deletingPathExtension().lastPathComponent
            guard name.hasPrefix("i18n_"), let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { continue }
            all[String(name.dropFirst(5))] = obj
        }
        tables = all
        _choice = UserDefaults.standard.string(forKey: I18nStore.key) ?? I18nStore.defaultChoice
        serverPatterns = I18nStore.serverKeys.compactMap { k in
            guard let zh = all[I18nStore.fallback]?[k] else { return nil }
            return I18nStore.compile(k, zh)
        }
    }

    /// "system" 或语言代码
    var choice: String {
        get { lock.lock(); defer { lock.unlock() }; return _choice }
        set {
            lock.lock(); _choice = newValue; lock.unlock()
            UserDefaults.standard.set(newValue, forKey: I18nStore.key)
        }
    }

    /// 当前生效的语言代码：选了就用选的；跟随系统时系统中文用中文，有语言包用语言包，其它一律英文
    var lang: String {
        let c = choice
        if c != I18nStore.system, tables[c] != nil { return c }
        let sys = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "zh"
        if sys == "zh" { return "zh" }
        return tables[sys] != nil ? sys : "en"
    }

    /// 打包进来的语言：代码 + 本语言里的名字（"简体中文"、"English"），中文排第一
    var languages: [(code: String, name: String)] {
        tables.keys.sorted { a, b in a == I18nStore.fallback || (b != I18nStore.fallback && a < b) }
            .map { ($0, tables[$0]?["lang.name"] ?? $0) }
    }

    func text(_ key: String, _ args: [String: Any]) -> String {
        let l = lang
        var s = tables[l]?[key] ?? tables[I18nStore.fallback]?[key] ?? key
        for (k, v) in args { s = s.replacingOccurrences(of: "{\(k)}", with: "\(v)") }
        if l == "en", args.values.contains(where: { "\($0)" == "1" }) { s = I18nStore.singular(s) }
        return s
    }

    /// 英文「1 comments」→「1 comment」：紧跟在单独的 1 后面的词，-ies → -y，去掉 -s（-ss 不动）
    private static let singularRe = try? NSRegularExpression(pattern: "\\b1 ([A-Za-z]*?[a-rt-zA-RT-Z])(ies|s)\\b")
    static func singular(_ s: String) -> String {
        guard let re = singularRe else { return s }
        let ns = s as NSString
        var out = s
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)).reversed() {
            let word = ns.substring(with: m.range(at: 1))
            let suffix = ns.substring(with: m.range(at: 2))
            out = (out as NSString).replacingCharacters(in: m.range, with: "1 " + word + (suffix == "ies" ? "y" : ""))
        }
        return out
    }

    // MARK: 服务端生成、全群共用的中文（币群名 / 群公告 / 系统昵称）：按 zh 模板匹配，换成当前语言

    private static let serverKeys = ["coinGroup.name", "coinGroup.perpName", "coinGroup.perpNotice", "coinGroup.notice", "coinGroup.bot"]

    private static func compile(_ key: String, _ zh: String) -> (key: String, re: NSRegularExpression, names: [String])? {
        guard let holes = try? NSRegularExpression(pattern: "\\{(\\w+)\\}") else { return nil }
        let ns = zh as NSString
        var pattern = "^"
        var names: [String] = []
        var cursor = 0
        for m in holes.matches(in: zh, range: NSRange(location: 0, length: ns.length)) {
            pattern += NSRegularExpression.escapedPattern(for: ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))
            pattern += "(.+?)"
            names.append(ns.substring(with: m.range(at: 1)))
            cursor = m.range.location + m.range.length
        }
        pattern += NSRegularExpression.escapedPattern(for: ns.substring(from: cursor)) + "$"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        return (key, re, names)
    }

    func server(_ s: String) -> String {
        guard lang != I18nStore.fallback, s.contains("群") else { return s }
        let ns = s as NSString
        for p in serverPatterns {
            guard let m = p.re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { continue }
            var args: [String: Any] = [:]
            for (i, n) in p.names.enumerated() { args[n] = ns.substring(with: m.range(at: i + 1)) }
            return text(p.key, args)
        }
        return s
    }

    /// 接口返回的 JSON 里把上面这些服务端文字换成当前语言；中文或不含「群」时原样返回
    func localizeServerJSON(_ data: Data) -> Data {
        guard lang != I18nStore.fallback, data.range(of: Data("群".utf8)) != nil,
              let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return data }
        func walk(_ v: Any) -> Any {
            if let s = v as? String { return s.count >= 3 && s.count <= 400 ? server(s) : s }
            if let a = v as? [Any] { return a.map(walk) }
            if let d = v as? [String: Any] { return d.mapValues(walk) }
            return v
        }
        return (try? JSONSerialization.data(withJSONObject: walk(obj), options: [.fragmentsAllowed])) ?? data
    }
}

/// 界面用：选择语言后发布 `choice`，根视图据此重建
@MainActor
final class I18n: ObservableObject {
    static let shared = I18n()
    static let system = I18nStore.system

    /// "system" 或语言代码
    @Published private(set) var choice: String

    private init() {
        choice = I18nStore.shared.choice
    }

    var lang: String { I18nStore.shared.lang }
    var languages: [(code: String, name: String)] { I18nStore.shared.languages }

    func select(_ code: String) {
        I18nStore.shared.choice = code
        choice = code
    }
}

/// t("me.frozen", ["n": 12])；任何线程都能调
func t(_ key: String, _ args: [String: Any] = [:]) -> String {
    I18nStore.shared.text(key, args)
}
