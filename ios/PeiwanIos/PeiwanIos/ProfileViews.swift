import AVFoundation
import SwiftUI
import PhotosUI

/// 我的
struct MeView: View {
    @EnvironmentObject var state: AppState
    @State private var me: UserProfile?
    @State private var camDefaultOn = UserDefaults.standard.bool(forKey: "camDefaultOn")
    @State private var showScan = false
    @State private var chainWalletVisible = false
    @State private var showLanguage = false

    var body: some View {
        NavStack {
            content
                .fullBg()
                .withRoutes()
                // 扫一扫（统一处理见 QrViews.swift ScanHandlerModifier）；放在导航栈里面，扫到钱包地址 / 收款码才能 push
                .scanFlow(isPresented: $showScan)
        }
        .task {
            if let u: UserProfile = try? await Api.request("/user/me") {
                me = u
                state.user = u
            }
            chainWalletVisible = await ChainWallet.visible(me)
        }
    }

    @ViewBuilder
    private var content: some View {
        // 优先用全局状态：编辑资料保存后（state.user 已更新）立即生效
        if let u = state.user ?? me {
            ScrollView {
                VStack(spacing: 0) {
                    // 头部
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .top, spacing: 16) {
                            AvatarView(url: u.avatar, size: 76)
                            VStack(alignment: .leading, spacing: 8) {
                                Text(u.nickname).font(.system(size: 21, weight: .bold)).foregroundStyle(Theme.text)
                                HStack(spacing: 6) {
                                    Text("\(u.gender == 1 ? t("me.male") : t("me.female")) \(u.age)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(u.gender == 1 ? Color(red: 0.43, green: 0.70, blue: 1.0) : Color(red: 1.0, green: 0.48, blue: 0.58))
                                        .padding(.horizontal, 10).padding(.vertical, 2)
                                        .background(Capsule().fill(Theme.bg3))
                                    if u.isGuide {
                                        Text(t("me.verified")).font(.system(size: 11)).foregroundStyle(Theme.accent)
                                            .padding(.horizontal, 8).padding(.vertical, 2)
                                            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
                                    }
                                }
                                if let sid = u.shortId {
                                    Text(t("me.id", ["id": sid])).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .padding(.top, 4)
                            Spacer()
                            // 扫一扫（扫群邀请二维码加群）
                            Button {
                                showScan = true
                            } label: {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 17))
                                    .foregroundStyle(Theme.text)
                                    .frame(width: 38, height: 38)
                                    .background(Circle().fill(Theme.bg3))
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }
                        Text(u.signature.isEmpty ? t("me.noSignature") : u.signature)
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            .padding(.top, 14)
                        // 点击进关注/粉丝列表
                        HStack(spacing: 6) {
                            RouteLink(.followList("following")) {
                                HStack(spacing: 6) {
                                    Text("\(u.following ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text(t("me.following")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                            Spacer().frame(width: 14)
                            RouteLink(.followList("fans")) {
                                HStack(spacing: 6) {
                                    Text("\(u.fans ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text(t("me.fans")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.top, 16)

                        // 积分余额：融合进头部（玻璃质感行，点击进钱包）
                        RouteLink(.wallet) {
                            HStack(alignment: .center) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t("me.balance")).font(.system(size: 11)).foregroundStyle(Theme.textSub)
                                    Text(fmtPoints(u.balance)).font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.accent)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 6) {
                                    Text(t("me.frozen", ["n": fmtPoints(u.frozen)])).font(.system(size: 11)).foregroundStyle(Theme.textSub)
                                    Text(t("me.details")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.04)))
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 16)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 28, leading: 20, bottom: 16, trailing: 20))
                    .background(LinearGradient(colors: [Theme.accent.opacity(0.14), Theme.bg], startPoint: .top, endPoint: .bottom))

                    // 男方专属：视频通话默认是否开启自己画面（默认关闭；女方无此设置）
                    if u.gender == 1 {
                        VStack(spacing: 0) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t("me.camDefault")).font(.system(size: 15)).foregroundStyle(Theme.text)
                                    Text(t("me.camDefaultSub")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                }
                                Spacer()
                                Toggle("", isOn: $camDefaultOn)
                                    .labelsHidden()
                                    .tint(Theme.accent)
                                    .onChange(of: camDefaultOn) { v in
                                        UserDefaults.standard.set(v, forKey: "camDefaultOn")
                                    }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                    // 菜单
                    menuRow(t("me.editProfile"), .editProfile)
                    // 专属邀请网页（链接 + 二维码）：女生发给男生 / 男生发给女生，下载后自动归因到我
                    if !state.reviewMode { menuRow(t("me.inviteCard"), .inviteCard) }
                    menuRow(t("me.myMoments"), .myMoments)
                    // 关注的人动态（原主页「关注」tab 移到这里）
                    menuRow(t("me.followMoments"), .followMoments)
                    menuRow(u.gender == 2 ? t("me.myTasksGuide") : t("me.myTasks"), .taskMine)
                    menuRow(t("me.gifts"), .giftsReceived)
                    menuRow(t("me.bots"), .bots)
                    // 链上钱包：App Store 非中国区 + 后台开关（或本机已有钱包）
                    if chainWalletVisible { menuRow(t("me.chainWallet"), .chainWallet) }
                    // 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名）
                    if !u.isGuide { menuRow(t("me.guideApply"), .guideApply) }
                    languageRow
                }
            }
        } else {
            EmptyHint(text: t("common.loading"))
        }
    }

    /// 语言：跟随系统 + 打包进来的每种语言（名字用各自的语言写）
    private var languageRow: some View {
        let i18n = I18n.shared
        let current = i18n.choice == I18n.system ? t("lang.system") : (i18n.languages.first { $0.code == i18n.choice }?.name ?? i18n.choice)
        return Button {
            showLanguage = true
        } label: {
            VStack(spacing: 0) {
                HStack {
                    Text(t("lang.title")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Spacer()
                    Text(current).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                }
                .padding(.horizontal, 16).padding(.vertical, 15)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .confirmationDialog(t("lang.title"), isPresented: $showLanguage, titleVisibility: .visible) {
            Button(t("lang.system")) { i18n.select(I18n.system) }
            ForEach(i18n.languages, id: \.code) { l in
                Button(l.name) { i18n.select(l.code) }
            }
        }
    }

    private func menuRow(_ label: String, _ route: Route) -> some View {
        RouteLink(route) {
            VStack(spacing: 0) {
                HStack {
                    Text(label).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Spacer()
                    Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                }
                .padding(.horizontal, 16).padding(.vertical, 15)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            // 让整行（含空白区域）都可点击
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private func txLabel(_ type: String) -> String {
    switch type {
    case "admin_grant": return t("wallet.tx.adminGrant")
    case "gift_send": return t("wallet.tx.giftSend")
    case "gift_recv": return t("wallet.tx.giftRecv")
    case "task_freeze": return t("wallet.tx.taskFreeze")
    case "task_settle": return t("wallet.tx.taskSettle")
    case "task_refund": return t("wallet.tx.taskRefund")
    case "msg_fee": return t("wallet.tx.msgFee")
    case "msg_income": return t("wallet.tx.msgIncome")
    case "call_fee": return t("wallet.tx.callFee")
    case "call_income": return t("wallet.tx.callIncome")
    case "transfer_out": return t("wallet.tx.transferOut")
    case "transfer_in": return t("wallet.tx.transferIn")
    case "adjust": return t("wallet.tx.adjust")
    default: return type
    }
}

/// 贡献榜条目
struct ContribRankItem: Codable, Identifiable {
    var userId: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var totalFen: String? = "0"
    var giftFen: String? = "0"
    var callFen: String? = "0"
    var msgFen: String? = "0"
    var id: String { userId }
}

/// 积分明细
struct WalletView: View {
    @EnvironmentObject var state: AppState
    @State private var wallet: WalletData?
    @State private var txs: [WalletTx] = []
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var tab = 0 // 0=明细 1=榜单
    @State private var rank: [ContribRankItem] = []
    @State private var rankLoaded = false

    private var rankTitle: String { state.user?.gender == 2 ? t("wallet.rankContrib") : t("wallet.rankGifting") }

    var body: some View {
        VStack(spacing: 0) {
            // 积分卡固定在顶部，不随流水滚动
            VStack(spacing: 4) {
                Text(t("wallet.available")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                Text(fmtPoints(wallet?.balance)).font(.system(size: 38, weight: .bold)).foregroundStyle(Theme.text)
                Text(t("wallet.frozenN", ["n": fmtPoints(wallet?.frozen)])).font(.system(size: 12)).foregroundStyle(Theme.textDim)
            }
            .frame(maxWidth: .infinity)
            .padding(24)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
            .padding(16)

            // 明细 / 榜单切换
            HStack(spacing: 10) {
                ForEach(Array([t("wallet.tabTxs"), rankTitle].enumerated()), id: \.offset) { idx, label in
                    Text(label)
                        .font(.system(size: 13, weight: tab == idx ? .semibold : .regular))
                        .foregroundStyle(tab == idx ? .white : Theme.textSub)
                        .padding(.horizontal, 18).padding(.vertical, 6)
                        .background(Capsule().fill(tab == idx ? Theme.accent : Theme.bg3))
                        .onTapGesture {
                            tab = idx
                            if idx == 1, !rankLoaded {
                                Task {
                                    struct RankResp: Codable { var title: String?; var list: [ContribRankItem]? }
                                    if let r: RankResp = try? await Api.request("/wallet/contrib-rank") {
                                        rank = r.list ?? []
                                        rankLoaded = true
                                    }
                                }
                            }
                        }
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.bottom, 6)

            if tab == 1 {
                rankList
            } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(txs) { tx in
                        VStack(spacing: 0) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(txLabel(tx.type ?? "")).font(.system(size: 14)).foregroundStyle(Theme.text)
                                    Text(tx.remark ?? "").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                }
                                Spacer()
                                let amount = tx.amount ?? "0"
                                let neg = amount.hasPrefix("-")
                                Text((neg ? "-" : "+") + fmtPoints(neg ? String(amount.dropFirst()) : amount))
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(neg ? Theme.text : Theme.success)
                            }
                            .padding(.vertical, 12)
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                        .padding(.horizontal, 16)
                        .onAppear {
                            // 滚动到最后一条时自动加载下一页
                            if tx.id == txs.last?.id, hasMore {
                                Task { await loadMore() }
                            }
                        }
                    }

                    if loadingMore {
                        ProgressView().padding(14)
                    }
                }
            }
            }
        }
        .fullBg()
        .navigationTitle(t("wallet.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                RouteLink(.transfer) {
                    Text(t("wallet.transfer")).font(.system(size: 14)).foregroundStyle(Theme.accent)
                }
            }
        }
        .task {
            wallet = try? await Api.request("/wallet")
            txs = (try? await Api.request("/wallet/transactions")) ?? []
            hasMore = txs.count >= 30
        }
    }

    private func loadMore() async {
        guard !loadingMore, let last = txs.last else { return }
        loadingMore = true
        let list: [WalletTx] = (try? await Api.request("/wallet/transactions?beforeId=\(last.id)")) ?? []
        txs += list
        hasMore = list.count >= 30
        loadingMore = false
    }

    /// 贡献榜 / 送花榜列表
    private var rankList: some View {
        ScrollView {
            VStack(spacing: 0) {
                if rank.isEmpty {
                    Text(t("wallet.noData")).font(.system(size: 13)).foregroundStyle(Theme.textDim).padding(30)
                }
                ForEach(Array(rank.enumerated()), id: \.element.id) { idx, r in
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            Text("\(idx + 1)")
                                .font(.system(size: idx < 3 ? 17 : 14, weight: .bold).italic())
                                .foregroundStyle(idx < 3 ? Theme.accent : Theme.textDim)
                                .frame(width: 24)
                            AvatarView(url: r.avatar ?? "", size: 40)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(r.nickname ?? t("chatSearch.user")).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                Text(t("wallet.rankBreakdown", ["gift": fmtPoints(r.giftFen), "call": fmtPoints(r.callFen), "msg": fmtPoints(r.msgFen)]))
                                    .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            }
                            Spacer()
                            Text(fmtPoints(r.totalFen))
                                .font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.accent)
                        }
                        .padding(.vertical, 12)
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
    }
}

/// 积分转赠（支付宝转账式：大号居中输入 + 收款人确认卡）
struct TransferView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    private let initialSid: String
    @State private var sid = ""
    @State private var target: LookupUser?
    @State private var amount = ""
    @State private var balance = "0"
    @State private var toastMsg: String?
    @State private var showScan = false
    @State private var showMyQr = false

    init(initialSid: String = "") {
        self.initialSid = initialSid
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                // 收款人
                VStack(spacing: 12) {
                    Text(t("transfer.targetId")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    TextField("", text: $sid, prompt: Text(t("transfer.idPlaceholder")).foregroundColor(Theme.textDim))
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 30, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.text)
                        .compatTracking(6)
                        .onChange(of: sid) { v in
                            let filtered = String(v.filter(\.isNumber).prefix(6))
                            if filtered != v { sid = filtered }
                            if filtered.count == 6 {
                                Task { target = try? await Api.request("/wallet/lookup/\(filtered)") }
                            } else { target = nil }
                        }
                    Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 40)

                    if let tu = target {
                        HStack(spacing: 10) {
                            AvatarView(url: tu.avatar, size: 40)
                            Text(tu.nickname ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                            Spacer()
                            HStack(spacing: 4) {
                                Circle().fill(Theme.success).frame(width: 6, height: 6)
                                Text(t("transfer.confirmed")).font(.system(size: 12)).foregroundStyle(Theme.success)
                            }
                        }
                        .padding(.horizontal, 4)
                    } else if sid.count == 6 {
                        Text(t("transfer.lookingUp")).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    } else {
                        Text(t("transfer.idHint")).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }

                    HStack(spacing: 0) {
                        Button {
                            showScan = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "qrcode.viewfinder").font(.system(size: 15))
                                Text(t("me.scan")).font(.system(size: 13))
                            }
                            .foregroundStyle(Theme.accent)
                            .frame(maxWidth: .infinity)
                        }
                        Rectangle().fill(Theme.line).frame(width: 1, height: 18)
                        Button {
                            showMyQr = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "qrcode").font(.system(size: 15))
                                Text(t("transfer.myQr")).font(.system(size: 13))
                            }
                            .foregroundStyle(Theme.accent)
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.top, 4)
                }
                .padding(18)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                // 金额
                VStack(spacing: 10) {
                    Text(t("transfer.amountLabel")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    TextField("", text: $amount, prompt: Text("0").foregroundColor(Theme.textDim))
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(Theme.accent)
                    Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 40)
                    HStack(spacing: 6) {
                        Text(t("transfer.available", ["n": fmtPoints(balance)])).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                        Button(t("transfer.all")) { amount = fmtPoints(balance) }
                            .font(.system(size: 12)).foregroundStyle(Theme.accent)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                AccentButton(title: t("transfer.submit"), enabled: target != nil && toFen(amount) > 0) {
                    Task {
                        let fen = toFen(amount)
                        do {
                            struct Empty: Codable { var ok: Bool? }
                            let _: Empty = try await Api.request("/wallet/transfer", method: "POST", body: [
                                "toShortId": target?.shortId ?? "",
                                "amountFen": "\(fen)",
                            ])
                            dismiss()
                        } catch {
                            toastMsg = error.localizedDescription
                        }
                    }
                }
                .padding(.top, 6)

                if let mySid = state.user?.shortId {
                    Text(t("transfer.myIdHint", ["id": mySid]))
                        .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("transfer.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
        .fullScreenCover(isPresented: $showScan) {
            QrScanView { text in
                if let s = parsePaySid(text) {
                    sid = s
                } else {
                    toastMsg = t("transfer.badQr")
                }
            }
        }
        .sheet(isPresented: $showMyQr) {
            MyQrCodeView().compatDetents(height: 480)
        }
        .task {
            // 从扫一扫进来（扫到收款码）：直接填好，onChange 会去查对方
            if sid.isEmpty, initialSid.count == 6 { sid = initialSid }
            if let w: WalletData = try? await Api.request("/wallet") { balance = w.balance ?? "0" }
        }
    }
}

/// 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号
struct RealnameView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var idCard = ""
    @State private var busy = false
    @State private var toastMsg: String?

    private var verified: Bool { state.user?.realname == true }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if verified {
                    VStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 44)).foregroundStyle(Theme.success)
                        Text(t("realname.done")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        Text(t("realname.verifiedName", ["name": state.user?.realNameMasked ?? ""]))
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t("realname.name")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $name, prompt: Text(t("realname.namePlaceholder")).foregroundColor(Theme.textDim))
                                .font(.system(size: 16)).foregroundStyle(Theme.text)
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t("realname.idCardNo")).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $idCard, prompt: Text(t("realname.idCardPlaceholder")).foregroundColor(Theme.textDim))
                                .font(.system(size: 16, design: .monospaced)).foregroundStyle(Theme.text)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                                .onChange(of: idCard) { v in
                                    let filtered = String(v.uppercased().filter { $0.isNumber || $0 == "X" }.prefix(18))
                                    if filtered != v { idCard = filtered }
                                }
                        }
                        Text(t("realname.privacy"))
                            .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }
                    .padding(18)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                    AccentButton(title: busy ? t("realname.submitting") : t("realname.submit"), enabled: !busy && name.count >= 2 && idCard.count == 18) {
                        Task { await submit() }
                    }
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("realname.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            struct OkResp: Codable { var ok: Bool? }
            let _: OkResp = try await Api.request("/user/realname", method: "POST", body: [
                "name": name.trimmingCharacters(in: .whitespaces),
                "idCard": idCard,
            ])
            if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
            toastMsg = t("realname.success")
        } catch {
            toastMsg = error.localizedDescription
        }
    }
}

/// 编辑资料
struct EditProfileView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var age = 18
    @State private var avatar = ""
    @State private var signature = ""
    @State private var city = ""
    @State private var videoPrice = ""
    @State private var toastMsg: String?
    @State private var loaded = false
    /// 照片墙（最多 8 张，支持多选）
    @State private var photos: [String] = []
    @State private var uploadingPhoto = false
    /// 平台手续费（分/分钟）= 流量成本 x 平台倍率
    @State private var feeCut = 4
    /// 年纪滚轮选择（底部弹层）
    @State private var showAgeSheet = false
    @State private var pendingAge = 18

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // ===== 头像 =====
                CompatPhotoPicker(kind: .images, onPicked: { datas in
                    guard let data = datas.first else { return }
                    Task {
                        if let url = try? await Api.upload("image", data: data, filename: "avatar.jpg", mime: "image/jpeg") {
                            avatar = url
                        }
                    }
                }) {
                    VStack(spacing: 8) {
                        ZStack(alignment: .bottom) {
                            AvatarView(url: avatar, size: 92)
                            Text(t("profile.change"))
                                .font(.system(size: 10)).foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 2)
                                .background(Capsule().fill(Color.black.opacity(0.55)))
                        }
                        Text(t("profile.changeAvatar")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                }
                .padding(.top, 10)

                // ===== 基本信息 =====
                editCard {
                    editRow(t("profile.nickname")) {
                        TextField(t("profile.nicknameHint"), text: $nickname)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                    }
                    editDivider
                    editRow(t("profile.age")) {
                        HStack {
                            Text(t("profile.ageYears", ["n": age])).font(.system(size: 15)).foregroundStyle(Theme.text)
                            Spacer()
                            Text("›").font(.system(size: 20)).foregroundStyle(Theme.textDim)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { pendingAge = age; showAgeSheet = true }
                    editDivider
                    editRow(t("profile.city")) {
                        HStack(spacing: 10) {
                            TextField(t("profile.cityHint"), text: $city)
                                .font(.system(size: 15)).foregroundStyle(Theme.text)
                            Button(t("profile.locate")) {
                                CityLocator.shared.detect { name in
                                    DispatchQueue.main.async { if let name { city = name } }
                                }
                            }
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                        }
                    }
                }

                // ===== 视频价格（仅女生） =====
                if state.user?.gender == 2 {
                    editCard {
                        editRow(t("profile.videoPrice")) {
                            HStack(spacing: 8) {
                                TextField("0", text: $videoPrice)
                                    .keyboardType(.decimalPad)
                                    .font(.system(size: 15)).foregroundStyle(Theme.text)
                                Text(t("profile.perMin")).font(.system(size: 13)).foregroundStyle(Theme.textDim)
                            }
                        }
                        editDivider
                        // 手续费提示：收入 = 价格 - 手续费，价格须高于手续费
                        let priceFen = toFen(videoPrice)
                        let income = max(0, priceFen - feeCut)
                        Text(t("profile.feeHint", ["fee": fmtPoints(String(feeCut)), "income": fmtPoints(String(income))]))
                            .font(.system(size: 11)).lineSpacing(3)
                            .foregroundStyle(priceFen > feeCut ? Theme.textDim : Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                    }
                }

                // ===== 签名 =====
                editCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(t("profile.bio")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                        CompatVerticalTextField(text: $signature, prompt: Text(t("profile.bioPlaceholder")), lineRange: 3...6)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                            .onChange(of: signature) { v in
                                if v.count > 80 { signature = String(v.prefix(80)) }
                            }
                        Text("\(signature.count)/80")
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(.vertical, 14)
                }

                // ===== 照片墙：最多 8 张，展示在个人主页 =====
                editCard {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(t("profile.photoWall")).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            Spacer()
                            Text("\(photos.count)/8")
                                .font(.system(size: 12))
                                .foregroundStyle(photos.count >= 8 ? Theme.accent : Theme.textDim)
                        }
                        Text(photos.count >= 8
                            ? t("profile.wallFull")
                            : t("profile.wallRemain", ["n": 8 - photos.count]))
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                        let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                        LazyVGrid(columns: cols, spacing: 8) {
                            ForEach(Array(photos.enumerated()), id: \.offset) { idx, url in
                                ZStack(alignment: .topTrailing) {
                                    Color.clear
                                        .aspectRatio(1, contentMode: .fit)
                                        .overlay(RemoteImage(url: url).aspectRatio(contentMode: .fill))
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    Button {
                                        photos.remove(at: idx)
                                    } label: {
                                        Text("✕").font(.system(size: 11)).foregroundStyle(.white)
                                            .frame(width: 20, height: 20)
                                            .background(Circle().fill(Color.black.opacity(0.55)))
                                    }
                                    .buttonStyle(.plain)
                                    .padding(4)
                                }
                            }
                            if photos.count < 8 {
                                // 多选：一次最多选剩余可加张数
                                CompatPhotoPicker(kind: .images, maxCount: 8 - photos.count, onPicked: { datas in
                                    uploadingPhoto = true
                                    Task {
                                        for data in datas where photos.count < 8 {
                                            if let url = try? await Api.upload("image", data: data, filename: "wall.jpg", mime: "image/jpeg") {
                                                photos.append(url)
                                            }
                                        }
                                        uploadingPhoto = false
                                    }
                                }) {
                                    RoundedRectangle(cornerRadius: 10).fill(Theme.bg3)
                                        .aspectRatio(1, contentMode: .fit)
                                        .overlay(Text(uploadingPhoto ? "…" : "＋").font(.system(size: 26)).foregroundStyle(Theme.textDim))
                                }
                            }
                        }
                    }
                    .padding(.vertical, 14)
                }

                Spacer(minLength: 30)
            }
            .padding(.horizontal, 16)
        }
        .fullBg()
        .navigationTitle(t("me.editProfile"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(t("common.save")) { save() }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
            }
        }
        // 年纪滚轮：底部弹层，取消/确定
        .sheet(isPresented: $showAgeSheet) {
            VStack(spacing: 0) {
                HStack {
                    Button(t("common.cancel")) { showAgeSheet = false }
                        .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Spacer()
                    Text(t("profile.pickAge")).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button(t("common.ok")) { age = pendingAge; showAgeSheet = false }
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
                }
                .padding(16)
                Picker("", selection: $pendingAge) {
                    ForEach(18...70, id: \.self) {
                        Text("\($0)").foregroundStyle(Theme.text).tag($0)
                    }
                }
                .pickerStyle(.wheel)
            }
            .compatDetents(height: 300)
            .compatSheetBackground(Theme.bg2)
        }
        .toast($toastMsg)
        .onAppear {
            guard !loaded, let u = state.user else { return }
            nickname = u.nickname; age = max(18, u.age); avatar = u.avatar
            signature = u.signature; city = u.cityName
            photos = (u.albums ?? []).filter { ($0.type ?? 1) == 1 }.map(\.url)
            if let p = u.videoPriceFen, p > 0 {
                videoPrice = fmtPoints("\(p)")
            }
            // 手续费 = 成本 x 平台倍率；未设置价格时默认价 = 成本 x5
            Task {
                struct PriceCfg: Codable { var videoBaseFenPerMin: Int? = 2; var videoPlatformX: Int? = 2 }
                if let cfg: PriceCfg = try? await Api.request("/call/config") {
                    let base = cfg.videoBaseFenPerMin ?? 2
                    feeCut = base * (cfg.videoPlatformX ?? 2)
                    if videoPrice.isEmpty, u.gender == 2 {
                        videoPrice = fmtPoints("\(base * 5)")
                    }
                }
            }
            loaded = true
        }
    }

    /// 编辑资料分组卡片（bg2 圆角）
    private func editCard(@ViewBuilder content: () -> some View) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, 14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
            .padding(.top, 14)
    }

    /// 编辑资料行：左标签 + 右内容
    private func editRow(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        HStack(spacing: 0) {
            Text(label).font(.system(size: 14)).foregroundStyle(Theme.textSub)
                .frame(width: 76, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 15)
    }

    private var editDivider: some View {
        Rectangle().fill(Theme.line).frame(height: 0.5)
    }

    private func save() {
        guard !nickname.trimmingCharacters(in: .whitespaces).isEmpty else {
            toastMsg = t("profile.nicknameEmpty")
            return
        }
        Task {
            var body: [String: Any] = [
                "nickname": nickname.trimmingCharacters(in: .whitespaces),
                "age": age,
                "avatar": avatar,
                "signature": signature.trimmingCharacters(in: .whitespaces),
                "cityName": city,
                "cityCode": city,
            ]
            if state.user?.gender == 2 {
                body["videoPriceFen"] = videoPrice.isEmpty ? 0 : toFen(videoPrice)
            }
            do {
                let _: UserProfile = try await Api.request("/user/me", method: "PUT", body: body)
                // 照片墙整组保存
                struct OkResp: Codable { var ok: Bool? }
                let _: OkResp = try await Api.request("/user/albums", method: "PUT", body: ["photos": photos])
                // 重新拉取带照片墙的完整资料
                if let u: UserProfile = try? await Api.request("/user/me") { state.user = u }
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

/// 搭子认证申请
struct GuideApplyView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var realName = ""
    @State private var idCard = ""
    @State private var intro = ""
    @State private var toastMsg: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Text(t("guide.applyHint"))
                    .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                inputField(t("realname.name"), text: $realName)
                inputField(t("realname.idCardNo"), text: $idCard)
                inputField(t("guide.intro"), text: $intro)
                AccentButton(title: t("guide.submitApply"), enabled: !realName.isEmpty && !idCard.isEmpty) {
                    Task {
                        do {
                            struct Empty: Codable { var ok: Bool? }
                            let _: Empty = try await Api.request("/guide/apply", method: "POST", body: [
                                "realName": realName, "idCardNo": idCard, "intro": intro,
                            ])
                            dismiss()
                        } catch {
                            toastMsg = error.localizedDescription
                        }
                    }
                }
                .padding(.top, 8)
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("me.guideApply"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
    }

    private func inputField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundColor(Theme.textDim))
            .foregroundStyle(Theme.text)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
    }
}

/// 收到的礼物（礼物墙：全部礼物 + 数量）
struct GiftsReceivedView: View {
    @State private var gifts: [GiftDef] = []

    var body: some View {
        ScrollView {
            let cols = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
            LazyVGrid(columns: cols, spacing: 14) {
                ForEach(gifts) { g in
                    VStack(spacing: 6) {
                        RemoteImage(url: g.icon ?? "")
                            .frame(width: 52, height: 52)
                            .opacity((g.count ?? 0) > 0 ? 1 : 0.3)
                        Text(g.name).font(.system(size: 12)).foregroundStyle((g.count ?? 0) > 0 ? Theme.text : Theme.textDim)
                        Text("x\(g.count ?? 0)").font(.system(size: 11)).foregroundStyle((g.count ?? 0) > 0 ? Theme.accent : Theme.textDim)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("me.gifts"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .task {
            gifts = (try? await Api.request("/gifts/received")) ?? []
        }
    }
}

/// 我的动态（双列网格，对齐 Android/Web）
struct MyMomentsView: View {
    @State private var items: [Moment] = []
    @State private var deleting: Moment?

    var body: some View {
        Group {
            if items.isEmpty {
                EmptyHint(text: t("profile.myMomentsEmpty"))
            } else {
                ScrollView {
                    let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                    LazyVGrid(columns: cols, spacing: 8) {
                        ForEach(items) { m in
                            momentCell(m)
                        }
                    }
                    .padding(12)
                }
            }
        }
        .fullBg()
        .navigationTitle(t("me.myMoments"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .confirmationDialog(t("moments.deleteConfirm"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button(t("common.delete"), role: .destructive) {
                guard let m = deleting else { return }
                Task {
                    struct OkResp: Codable { var ok: Bool? }
                    if let _: OkResp = try? await Api.request("/moments/\(m.id)", method: "DELETE") {
                        items.removeAll { $0.id == m.id }
                    }
                    deleting = nil
                }
            }
            Button(t("common.cancel"), role: .cancel) { deleting = nil }
        }
        .task {
            items = (try? await Api.request("/moments/mine")) ?? []
        }
    }

    private func momentCell(_ m: Moment) -> some View {
        let cover = m.type == 2 ? (m.coverUrl ?? "") : (m.images?.first ?? "")
        return ZStack(alignment: .topTrailing) {
            RouteLink(.moment(m.id)) {
                VStack(alignment: .leading, spacing: 0) {
                    if !cover.isEmpty {
                        RemoteImage(url: cover)
                            .frame(maxWidth: .infinity).frame(height: 150)
                            .clipped()
                    } else {
                        Text(m.content ?? "")
                            .font(.system(size: 14)).foregroundStyle(Theme.text)
                            .lineLimit(4).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
                            .padding(14)
                            .background(Theme.bg3)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if !cover.isEmpty, let content = m.content, !content.isEmpty {
                            Text(content).font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        Text(t("moments.stats", ["likes": m.likeCount ?? 0, "comments": m.commentCount ?? 0]))
                            .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)

            Button { deleting = m } label: {
                Text("×").font(.system(size: 16)).foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            }
            .buttonStyle(.plain)
            .padding(6)
        }
    }
}

/// 关注/粉丝列表条目（GET /user/follows/list）
struct FollowUser: Codable, Identifiable, Hashable {
    var id: String = "0"
    var nickname: String? = ""
    var avatar: String? = ""
    var age: Int? = 0
    var gender: Int? = 1
    var cityName: String? = ""
    var signature: String? = ""
    var isGuide: Bool? = false
}

/// 关注/粉丝列表（我的页面点击数字进入）
struct FollowListView: View {
    let type: String
    @State private var list: [FollowUser]?

    var body: some View {
        Group {
            if let list {
                if list.isEmpty {
                    Text(type == "fans" ? t("me.noFans") : t("me.noFollowing"))
                        .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(list) { u in
                                RouteLink(.userHome(u.id)) {
                                    HStack(spacing: 12) {
                                        AvatarView(url: u.avatar, size: 46)
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(spacing: 6) {
                                                Text(u.nickname ?? "").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                                                if u.isGuide == true {
                                                    Text(t("me.verified")).font(.system(size: 10)).foregroundStyle(Theme.accent)
                                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                                        .background(RoundedRectangle(cornerRadius: 3).fill(Theme.accent.opacity(0.12)))
                                                }
                                            }
                                            let sub = (u.signature?.isEmpty == false) ? (u.signature ?? "") : (u.cityName ?? "")
                                            if !sub.isEmpty {
                                                Text(sub).font(.system(size: 12)).foregroundStyle(Theme.textSub).lineLimit(1)
                                            }
                                        }
                                        Spacer()
                                        Text("›").font(.system(size: 18)).foregroundStyle(Theme.textDim)
                                    }
                                    .padding(.horizontal, 16).padding(.vertical, 12)
                                }
                                .buttonStyle(.plain)
                                Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 74)
                            }
                        }
                    }
                }
            } else {
                Text(t("common.loading")).font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .fullBg()
        .navigationTitle(type == "fans" ? t("me.fans") : t("me.following"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .task {
            list = (try? await Api.request("/user/follows/list?type=\(type)")) ?? []
        }
    }
}
