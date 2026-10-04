import SwiftUI
import CoreImage

/// 链上钱包的聊天卡片（和 Android ChainCards.kt、Web components/ChainCards.tsx 同一套字段）：
/// - transfer：钱包转账成功后，服务端到链上核对过才发的转账卡片（POST /im/transfer），点开看区块浏览器；
/// - callout：喊单卡片（钱包代币页「喊单到聊天」），点开在钱包里打开这个币的页面，能直接买。
struct ChainAddr: Codable, Identifiable {
    var evm: String?
    var sol: String?
    var trx: String?
    var ton: String?

    var id: String { (evm ?? "-") + "|" + (sol ?? "-") + "|" + (trx ?? "-") + "|" + (ton ?? "-") }

    /// 对方公开了的链：(钱包 chain 参数，nil 是 EVM, 地址)
    var options: [(chain: String?, address: String)] {
        var out: [(chain: String?, address: String)] = []
        if let a = evm { out.append((nil, a)) }
        if let a = sol { out.append(("sol", a)) }
        if let a = trx { out.append(("trx", a)) }
        if let a = ton { out.append(("ton", a)) }
        return out
    }
}

enum ChainCards {
    static let chainNames = ["arc": "Arc", "eth": "Ethereum", "bsc": "BNB Chain", "base": "Base", "arb": "Arbitrum", "polygon": "Polygon", "sol": "Solana", "trx": "TRON", "ton": "TON"]
    static let explorers = [
        "arc": "https://arc-scan.org/tx/", "eth": "https://etherscan.io/tx/", "bsc": "https://bscscan.com/tx/", "base": "https://basescan.org/tx/",
        "arb": "https://arbiscan.io/tx/", "polygon": "https://polygonscan.com/tx/", "sol": "https://solscan.io/tx/", "trx": "https://tronscan.org/#/transaction/",
        "ton": "https://tonviewer.com/transaction/",
    ]

    static func obj(_ s: String) -> [String: Any] {
        guard let d = s.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return o
    }

    static func chainName(_ c: String) -> String { chainNames[c] ?? c }

    /// 最小单位 → 人看的数量（最多 6 位小数）
    static func amount(_ raw: String?, _ decimals: Int) -> String {
        guard let raw, let v = Decimal(string: raw) else { return "?" }
        let n = NSDecimalNumber(decimal: v).multiplying(byPowerOf10: Int16(-decimals))
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.maximumFractionDigits = 6
        f.roundingMode = .down
        return f.string(from: n) ?? "?"
    }

    static func usd(_ v: Double?) -> String? {
        guard let v, v > 0 else { return nil }
        if v >= 1e9 { return String(format: "$%.2fB", v / 1e9) }
        if v >= 1e6 { return String(format: "$%.2fM", v / 1e6) }
        if v >= 1e3 { return String(format: "$%.1fK", v / 1e3) }
        if v >= 1 { return String(format: "$%.2f", v) }
        return "$" + String(format: "%.4g", v)
    }

    /// 会话列表 / 引用里的一行预览
    static func preview(_ type: String, _ content: String) -> String? {
        let o = obj(content)
        switch type {
        case "transfer":
            let dec = (o["decimals"] as? Int) ?? Int(o["decimals"] as? String ?? "") ?? 0
            return "[转账] \(amount(o["amount"] as? String, dec)) \(o["symbol"] as? String ?? "")"
        case "callout":
            return "[喊单] $\(o["symbol"] as? String ?? "")"
        case "perp":
            let side = (o["side"] as? String) == "short" ? "做空" : "做多"
            let lev = Int(PerpLive.num(o["lev"]) ?? 0)
            return "[合约喊单] \(side) \(o["coin"] as? String ?? "") \(lev)x"
        case "payreq":
            if let a = o["amount"] as? String { return "[收款] \(amount(a, (o["decimals"] as? Int) ?? 0)) \(o["symbol"] as? String ?? "")" }
            return "[收款] \(chainName(o["chain"] as? String ?? ""))"
        default:
            return nil
        }
    }

    /// 点收款消息的「转账」：钱包转账页填好收款地址 / 币 / 金额，转完交回结果（req = 收款消息 id，服务端据此把卡片发回原聊天）
    static func payreqPath(_ content: String, msgId: String, name: String) -> String? {
        let o = obj(content)
        guard let chain = o["chain"] as? String, let to = o["address"] as? String else { return nil }
        let n = String(name.prefix(24)).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) ?? ""
        var p = "/wallet/send?to=\(to)&chain=\(chain)&name=\(n)&ret=1&req=\(msgId)"
        if let t = o["token"] as? String { p += "&token=\(t)" }
        if let a = o["amount"] as? String, let v = Decimal(string: a) {
            let n = NSDecimalNumber(decimal: v).multiplying(byPowerOf10: Int16(-((o["decimals"] as? Int) ?? 0)))
            p += "&amount=\(n.stringValue)"
        }
        return p
    }

    /// 喊单卡片在钱包里打开的页面
    static func calloutPath(_ content: String) -> String? {
        let o = obj(content)
        guard let chain = o["chain"] as? String, let addr = o["address"] as? String else { return nil }
        switch chain {
        case "sol": return "/wallet/coin?mint=\(addr)"
        case "arc": return "/wallet/token?address=\(addr)"
        default: return "/wallet/market?chain=\(chain)&address=\(addr.lowercased())"
        }
    }

    /// 没有钱包入口的人点喊单卡片：去网页看
    static func calloutWebURL(_ content: String) -> URL? {
        let o = obj(content)
        let addr = o["address"] as? String ?? ""
        switch o["chain"] as? String ?? "" {
        case "sol": return URL(string: "https://pump.fun/coin/\(addr)")
        case "arc": return URL(string: "https://arm.yyheart.com/token/\(addr)")
        case let c: return URL(string: "https://dexscreener.com/\(["eth": "ethereum", "arb": "arbitrum"][c] ?? c)/\(addr)")
        }
    }

    /// 聊天里点「转账」：打开钱包转账页，收款人已填好，转完把结果交回聊天（ret=1）
    static func transferPath(address: String, chain: String?, name: String) -> String {
        let n = String(name.prefix(24)).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) ?? ""
        return "/wallet/send?to=\(address)&name=\(n)&ret=1" + (chain.map { "&chain=\($0)" } ?? "")
    }

    /// 钱包交回的转账结果 → 服务端核对链上交易后发转账卡片，返回那条消息（付收款消息时 targetId 可以为空）
    static func postTransfer(targetId: String, resultJson: String) async throws -> MsgItem? {
        let r = obj(resultJson)
        guard r["kind"] as? String == "transfer" else { return nil }
        var body: [String: Any] = [:]
        if !targetId.isEmpty { body["targetId"] = targetId }
        for k in ["chain", "hash", "token", "amount", "symbol", "from", "to", "proof", "req"] { if let v = r[k] as? String { body[k] = v } }
        if let d = r["decimals"] as? Int { body["decimals"] = d }
        let m: MsgItem = try await Api.request("/im/transfer", method: "POST", body: body)
        return m
    }
}

struct TransferCardView: View {
    let content: String
    let mine: Bool

    var body: some View {
        let o = ChainCards.obj(content)
        let chain = o["chain"] as? String ?? ""
        let dec = (o["decimals"] as? Int) ?? 0
        Button {
            if let h = o["hash"] as? String, let base = ChainCards.explorers[chain], let u = URL(string: base + h) { UIApplication.shared.open(u) }
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 38, height: 38).background(Circle().fill(Color.white.opacity(0.22)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(ChainCards.amount(o["amount"] as? String, dec)) \(o["symbol"] as? String ?? "")")
                            .font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                        Text(mine ? "已转账给对方" : "对方给你转账").font(.system(size: 12)).foregroundStyle(.white.opacity(0.85))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                HStack {
                    Text("链上转账 · \(ChainCards.chainName(chain))").font(.system(size: 11)).foregroundStyle(Color(red: 0.6, green: 0.36, blue: 0))
                    Spacer()
                    if o["verified"] as? Bool == true { Text("已到账 ✓").font(.system(size: 11)).foregroundStyle(Color(red: 0.09, green: 0.64, blue: 0.29)) }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Color(red: 1, green: 0.957, blue: 0.87))
            }
            .frame(width: 220)
            .background(Color(red: 0.96, green: 0.62, blue: 0.04))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            // 描边 + 浅橙底栏：白色聊天背景上卡片也有边界
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(red: 0.96, green: 0.62, blue: 0.04), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct CalloutCardView: View {
    let content: String
    let canWallet: Bool
    let onOpenWallet: (String) -> Void

    var body: some View {
        let o = ChainCards.obj(content)
        let symbol = o["symbol"] as? String ?? ""
        Button {
            if canWallet, let p = ChainCards.calloutPath(content) { onOpenWallet(p) } else if let u = ChainCards.calloutWebURL(content) { UIApplication.shared.open(u) }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.17))
                        Text(String(symbol.prefix(2)).uppercased()).font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        if let img = o["image"] as? String { RemoteImage(url: img).clipShape(RoundedRectangle(cornerRadius: 10)) }
                    }
                    .frame(width: 42, height: 42)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("$\(symbol)").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                        Text(o["name"] as? String ?? "").font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 1) {
                        if let p = ChainCards.usd(o["priceUsd"] as? Double) { Text(p).font(.system(size: 12)).foregroundStyle(.white) }
                        if let m = ChainCards.usd(o["mcapUsd"] as? Double) { Text("市值 \(m)").font(.system(size: 10)).foregroundStyle(.white.opacity(0.55)) }
                    }
                }
                if let note = o["note"] as? String, !note.isEmpty {
                    Text(note).font(.system(size: 13)).foregroundStyle(.white).multilineTextAlignment(.leading)
                }
                HStack(spacing: 4) {
                    Image(systemName: "megaphone.fill").font(.system(size: 11)).foregroundStyle(Color(red: 0.29, green: 0.87, blue: 0.5))
                    Text("喊单 · \(ChainCards.chainName(o["chain"] as? String ?? ""))").font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
                    Spacer()
                    Text(canWallet ? "去看看" : "看行情")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.black)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(Color(red: 0.29, green: 0.87, blue: 0.5)))
                }
            }
            .padding(12)
            .frame(width: 230, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.06, green: 0.07, blue: 0.08)))
        }
        .buttonStyle(.plain)
    }
}

/// 合约喊单（msgType perp，后端 perp-call.service.ts）的实时状态：聊天页打开时 WsClient.perpWatch 告诉服务端在看哪些卡片，
/// 服务端每 3 秒推 perpTick（行情价 + 变了的卡片状态，见 perp-watch.service.ts），这里存着给卡片读。
final class PerpLive: ObservableObject {
    static let shared = PerpLive()
    @Published var statuses: [String: [String: Any]] = [:]
    @Published var marks: [String: Double] = [:]

    static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    func onFrame(_ f: [String: Any]) {
        guard f["op"] as? String == "perpTick" else { return }
        if let m = f["marks"] as? [String: Any] {
            for (k, v) in m { if let d = PerpLive.num(v) { marks[k] = d } }
        }
        if let s = f["statuses"] as? [String: Any] {
            for (k, v) in s { if let o = v as? [String: Any] { statuses[k] = o } }
        }
    }

    /// 卡片上的「跟单」：钱包合约页按喊单填好方向、杠杆、止盈止损，保证金自己定
    static func followPath(_ content: String, name: String) -> String? {
        let o = ChainCards.obj(content)
        guard let coin = o["coin"] as? String, let side = o["side"] as? String else { return nil }
        var f: [String: Any] = ["coin": coin, "side": side, "name": String(name.prefix(24))]
        for k in ["lev", "entry", "tp", "sl"] { if let v = num(o[k]) { f[k] = v } }
        guard let d = try? JSONSerialization.data(withJSONObject: f), let s = String(data: d, encoding: .utf8) else { return nil }
        let enc = s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return "/wallet/perp?follow=" + enc
    }

    static func px(_ v: Double) -> String {
        if v >= 1000 {
            let f = NumberFormatter()
            f.numberStyle = .decimal
            f.maximumFractionDigits = 1
            return f.string(from: NSNumber(value: v)) ?? String(v)
        }
        if v >= 1 { return String(format: "%.4g", v) }
        return String(format: "%.4g", v)
    }

    /// 保证金收益率（%）：价格变动 × 杠杆，空单反过来
    static func roe(entry: Double, price: Double, lev: Double, long: Bool) -> Double {
        let r = (price / entry - 1) * lev * 100
        return long ? r : -r
    }

    static func pct(_ v: Double) -> String { (v >= 0 ? "+" : "") + String(format: "%.1f", v) + "%" }
}

private struct PerpLine {
    let label: String
    let value: String
    let color: Color
}

struct PerpCardView: View {
    let msgId: String
    let content: String
    let canWallet: Bool
    let onFollow: () -> Void
    @ObservedObject private var live = PerpLive.shared

    private static let up = Color(red: 0.13, green: 0.77, blue: 0.37)
    private static let down = Color(red: 0.94, green: 0.27, blue: 0.27)
    private static let dim = Color.white.opacity(0.55)

    private func line(_ o: [String: Any], _ st: [String: Any]) -> PerpLine {
        let long = (o["side"] as? String) != "short"
        let lev = PerpLive.num(o["lev"]) ?? 1
        let entry = PerpLive.num(o["entry"]) ?? 0
        let coin = o["coin"] as? String ?? ""
        let state = st["state"] as? String ?? ""
        if state == "open" {
            let e = PerpLive.num(st["entry"]) ?? entry
            let l = PerpLive.num(st["lev"]) ?? lev
            var r = PerpLive.num(st["roe"]) ?? 0
            if let mark = live.marks[coin], e > 0 { r = PerpLive.roe(entry: e, price: mark, lev: l, long: long) }
            return PerpLine(label: "持仓中", value: PerpLive.pct(r), color: r >= 0 ? PerpCardView.up : PerpCardView.down)
        }
        if state == "closed" {
            let reason = st["reason"] as? String ?? ""
            let exit = PerpLive.num(st["exit"]) ?? 0
            let r = entry > 0 && exit > 0 ? PerpLive.roe(entry: entry, price: exit, lev: lev, long: long) : 0
            var why = "已平仓"
            if reason == "tp" { why = "止盈出局" }
            if reason == "sl" { why = "止损出局" }
            if reason == "liq" { return PerpLine(label: "已强平", value: "-100%", color: PerpCardView.down) }
            return PerpLine(label: why, value: PerpLive.pct(r), color: r >= 0 ? PerpCardView.up : PerpCardView.down)
        }
        if state == "pending" {
            let p = PerpLive.num(st["px"]).map { "@ " + PerpLive.px($0) } ?? ""
            return PerpLine(label: "挂单中", value: p, color: .white.opacity(0.7))
        }
        if state == "none" { return PerpLine(label: "未成交 / 已撤单", value: "", color: PerpCardView.dim) }
        return PerpLine(label: "读取实时状态…", value: "", color: PerpCardView.dim)
    }

    private func cell(_ k: String, _ v: Double?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(k).font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
            Text(v.map { PerpLive.px($0) } ?? "—").font(.system(size: 12, weight: .medium)).foregroundStyle(.white).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        let o = ChainCards.obj(content)
        let coin = o["coin"] as? String ?? ""
        let long = (o["side"] as? String) != "short"
        let lev = Int(PerpLive.num(o["lev"]) ?? 1)
        let sideColor = long ? PerpCardView.up : PerpCardView.down
        let st = live.statuses[msgId] ?? [:]
        let l = line(o, st)
        let closed = (st["state"] as? String) == "closed"
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("\(coin)-USD").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                Text("\(long ? "做多" : "做空") \(lev)x").font(.system(size: 11, weight: .semibold)).foregroundStyle(sideColor)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 6).fill(sideColor.opacity(0.18)))
                Spacer(minLength: 0)
                if let m = live.marks[coin] { Text(PerpLive.px(m)).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)) }
            }
            HStack(spacing: 4) {
                cell((o["orderType"] as? String) == "limit" ? "挂单" : "开仓", PerpLive.num(o["entry"]))
                cell("止盈", PerpLive.num(o["tp"]))
                cell("止损", PerpLive.num(o["sl"]))
            }
            HStack {
                Text(l.label).font(.system(size: 12)).foregroundStyle(.white.opacity(0.75))
                Spacer(minLength: 0)
                Text(l.value).font(.system(size: 18, weight: .bold)).foregroundStyle(l.color)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 0.106, green: 0.122, blue: 0.153)))
            if let note = o["note"] as? String, !note.isEmpty {
                Text(note).font(.system(size: 13)).foregroundStyle(.white).multilineTextAlignment(.leading)
            }
            HStack(spacing: 4) {
                Image(systemName: "megaphone.fill").font(.system(size: 11)).foregroundStyle(Color(red: 0.29, green: 0.87, blue: 0.5))
                Text("合约喊单 · 收益率实时").font(.system(size: 11)).foregroundStyle(PerpCardView.dim)
                Spacer()
                if canWallet && !closed {
                    Button(action: onFollow) {
                        Text("跟单").font(.system(size: 12, weight: .semibold)).foregroundStyle(.black)
                            .padding(.horizontal, 12).padding(.vertical, 4)
                            .background(Capsule().fill(Color(red: 0.29, green: 0.87, blue: 0.5)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .frame(width: 240, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.06, green: 0.07, blue: 0.08)))
    }
}

/// 收款消息：二维码 + 地址（点一下复制）+ 可选的币和金额；别人点「转账」直接进钱包转账页
struct PayreqCardView: View {
    let content: String
    let mine: Bool
    let onPay: (() -> Void)?
    @State private var copied = false

    private static let orange = Color(red: 0.96, green: 0.62, blue: 0.04)

    private static func qr(_ text: String) -> UIImage? {
        let f = CIFilter(name: "CIQRCodeGenerator")
        f?.setValue(Data(text.utf8), forKey: "inputMessage")
        f?.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f?.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    var body: some View {
        let o = ChainCards.obj(content)
        let address = o["address"] as? String ?? ""
        let chain = o["chain"] as? String ?? ""
        let amount = (o["amount"] as? String).map { "\(ChainCards.amount($0, (o["decimals"] as? Int) ?? 0)) \(o["symbol"] as? String ?? "")" }
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.left.arrow.right").font(.system(size: 12, weight: .semibold))
                Text("收款 · \(ChainCards.chainName(chain))").font(.system(size: 13, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(.white).padding(.horizontal, 12).padding(.vertical, 9).background(Self.orange)
            VStack(spacing: 6) {
                Text(amount ?? ((o["symbol"] as? String).map { "收 \($0)" } ?? "金额由付款人填写"))
                    .font(.system(size: amount != nil ? 20 : 14, weight: .semibold)).foregroundStyle(Color(white: 0.07))
                if let note = o["note"] as? String, !note.isEmpty { Text(note).font(.system(size: 12)).foregroundStyle(Color(white: 0.33)) }
                if let img = Self.qr(address) {
                    Image(uiImage: img).interpolation(.none).resizable().frame(width: 140, height: 140)
                }
                Text(address)
                    .font(.system(size: 11)).foregroundStyle(Color(white: 0.2)).multilineTextAlignment(.center)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.955)))
                    .onTapGesture {
                        UIPasteboard.general.string = address
                        copied = true
                    }
                Text(copied ? "地址已复制" : "点地址复制 · 只收 \(ChainCards.chainName(chain)) 上的币").font(.system(size: 10)).foregroundStyle(Color(white: 0.53))
                if !mine, let onPay {
                    Button(action: onPay) {
                        Text("转账").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).frame(height: 36).background(Capsule().fill(Self.orange))
                    }
                    .buttonStyle(.plain).padding(.top, 4)
                }
            }
            .padding(12)
        }
        .frame(width: 230)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Self.orange, lineWidth: 1))
    }
}

/// 钱包里「喊单到聊天」/「收款发到聊天」：选会话（最多 10 个），每个发一张卡片（card["kind"] == "payreq" 是收款，否则喊单）
struct ShareCardSheet: View {
    let card: [String: Any]
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var convs: [ConversationItem] = []
    @State private var q = ""
    @State private var picked: [String] = []

    private func name(_ c: ConversationItem) -> String { c.peer?.nickname ?? c.group?.name ?? "" }
    private func avatar(_ c: ConversationItem) -> String { c.peer?.avatar ?? c.group?.avatar ?? "" }
    private var shown: [ConversationItem] {
        let k = q.trimmingCharacters(in: .whitespaces)
        return convs.filter { k.isEmpty || name($0).localizedCaseInsensitiveContains(k) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("取消") { dismiss() }.font(.system(size: 14)).foregroundStyle(Theme.textSub)
                Spacer()
                Text(isPayreq ? "把收款发到…" : "喊单 $\(card["symbol"] as? String ?? "") 到…").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                Spacer()
                Button(picked.isEmpty ? "发送" : "发送(\(picked.count))") { send() }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(picked.isEmpty ? Theme.textDim : Theme.accent)
                    .disabled(picked.isEmpty)
            }
            .padding(16)
            TextField("搜索", text: $q)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                .padding(.horizontal, 16)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(shown) { c in
                        let on = picked.contains(c.id)
                        HStack(spacing: 12) {
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 20)).foregroundStyle(on ? botBlue : Theme.textDim)
                            AvatarView(url: avatar(c), size: 40)
                            Text(name(c)).font(.system(size: 15)).foregroundStyle(Theme.text).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if on { picked.removeAll { $0 == c.id } } else if picked.count < 10 { picked.append(c.id) }
                        }
                    }
                }
                .padding(.top, 6)
            }
        }
        .background(Theme.bg2)
        .task {
            let list: [ConversationItem] = (try? await Api.request("/im/conversations")) ?? []
            convs = list.filter { ($0.peer != nil && $0.peer?.isBot != true) || $0.group != nil }
            WsClient.shared.connect()
        }
    }

    private var isPayreq: Bool { card["kind"] as? String == "payreq" }

    private func send() {
        var payload = card
        payload.removeValue(forKey: "kind")
        guard let d = try? JSONSerialization.data(withJSONObject: payload), let content = String(data: d, encoding: .utf8) else { return }
        let type = isPayreq ? "payreq" : "callout"
        for id in picked {
            guard let c = convs.first(where: { $0.id == id }) else { continue }
            if c.type == 1, let p = c.peer { _ = WsClient.shared.send(convType: 1, targetId: p.id, msgType: type, content: content) }
            else if let g = c.group { _ = WsClient.shared.send(convType: 2, targetId: g.id, msgType: type, content: content) }
        }
        onDone(isPayreq ? "收款已发到 \(picked.count) 个聊天" : "已喊单到 \(picked.count) 个聊天")
        dismiss()
    }
}

/// 对方开了不止一种链的收款地址时，问转到哪条链
struct TransferChainSheet: View {
    let addr: ChainAddr
    let onPick: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 10) {
            Text("转账到哪条链").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).padding(.top, 18)
            if let a = addr.evm { choice("EVM 链", "Arc / Ethereum / BNB / Base / Arbitrum / Polygon", a) { onPick(a, nil) } }
            if let a = addr.sol { choice("Solana", "SOL、USDC、pump 币等", a) { onPick(a, "sol") } }
            if let a = addr.trx { choice("TRON 波场", "TRX、USDT（TRC20）", a) { onPick(a, "trx") } }
            if let a = addr.ton { choice("TON", "GRAM（原 Toncoin）、USDT 等", a) { onPick(a, "ton") } }
            Text("转账页里可以选币种和网络；转完会在聊天里发一张转账卡片。").font(.system(size: 12)).foregroundStyle(Theme.textSub)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .background(Theme.bg2)
    }

    private func choice(_ title: String, _ sub: String, _ address: String, _ action: @escaping () -> Void) -> some View {
        Button {
            dismiss()
            action()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                    Text(sub).font(.system(size: 11)).foregroundStyle(Theme.textSub)
                }
                Spacer()
                Text("\(address.prefix(6))…\(address.suffix(4))").font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg3))
        }
        .buttonStyle(.plain)
    }
}
