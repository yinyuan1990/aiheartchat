import SwiftUI

/// 链上钱包的聊天卡片（和 Android ChainCards.kt、Web components/ChainCards.tsx 同一套字段）：
/// - transfer：钱包转账成功后，服务端到链上核对过才发的转账卡片（POST /im/transfer），点开看区块浏览器；
/// - callout：喊单卡片（钱包代币页「喊单到聊天」），点开在钱包里打开这个币的页面，能直接买。
struct ChainAddr: Codable {
    var evm: String?
    var sol: String?
}

enum ChainCards {
    static let chainNames = ["arc": "Arc", "eth": "Ethereum", "bsc": "BNB Chain", "base": "Base", "arb": "Arbitrum", "polygon": "Polygon", "sol": "Solana"]
    static let explorers = [
        "arc": "https://arc-scan.org/tx/", "eth": "https://etherscan.io/tx/", "bsc": "https://bscscan.com/tx/", "base": "https://basescan.org/tx/",
        "arb": "https://arbiscan.io/tx/", "polygon": "https://polygonscan.com/tx/", "sol": "https://solscan.io/tx/",
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
        default:
            return nil
        }
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
    static func transferPath(address: String, sol: Bool, name: String) -> String {
        let n = String(name.prefix(24)).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) ?? ""
        return "/wallet/send?to=\(address)&name=\(n)&ret=1" + (sol ? "&chain=sol" : "")
    }

    /// 钱包交回的转账结果 → 服务端核对链上交易后发转账卡片，返回那条消息
    static func postTransfer(targetId: String, resultJson: String) async throws -> MsgItem? {
        let r = obj(resultJson)
        guard r["kind"] as? String == "transfer" else { return nil }
        var body: [String: Any] = ["targetId": targetId]
        for k in ["chain", "hash", "token", "amount", "symbol", "from", "to", "proof"] { if let v = r[k] as? String { body[k] = v } }
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
                    Text("链上转账 · \(ChainCards.chainName(chain))").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                    Spacer()
                    if o["verified"] as? Bool == true { Text("已到账 ✓").font(.system(size: 11)).foregroundStyle(Color(red: 0.09, green: 0.64, blue: 0.29)) }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Color.white)
            }
            .frame(width: 220)
            .background(Color(red: 0.96, green: 0.62, blue: 0.04))
            .clipShape(RoundedRectangle(cornerRadius: 14))
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

/// 钱包代币页「喊单到聊天」：选会话（最多 10 个），每个发一张喊单卡片
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
                Text("喊单 $\(card["symbol"] as? String ?? "") 到…").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
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

    private func send() {
        guard let d = try? JSONSerialization.data(withJSONObject: card), let content = String(data: d, encoding: .utf8) else { return }
        for id in picked {
            guard let c = convs.first(where: { $0.id == id }) else { continue }
            if c.type == 1, let p = c.peer { _ = WsClient.shared.send(convType: 1, targetId: p.id, msgType: "callout", content: content) }
            else if let g = c.group { _ = WsClient.shared.send(convType: 2, targetId: g.id, msgType: "callout", content: content) }
        }
        onDone("已喊单到 \(picked.count) 个聊天")
        dismiss()
    }
}

/// 对方 EVM / Solana 收款地址都开了时，问转到哪条链
struct TransferChainSheet: View {
    let addr: ChainAddr
    let onPick: (String, Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 10) {
            Text("转账到哪条链").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).padding(.top, 18)
            if let a = addr.evm { choice("EVM 链", "Arc / Ethereum / BNB / Base / Arbitrum / Polygon", a) { onPick(a, false) } }
            if let a = addr.sol { choice("Solana", "SOL、USDC、pump 币等", a) { onPick(a, true) } }
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
