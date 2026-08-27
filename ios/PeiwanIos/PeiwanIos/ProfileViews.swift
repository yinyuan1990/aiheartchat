import SwiftUI
import PhotosUI

/// 我的
struct MeView: View {
    @Environment(AppState.self) var state
    @State private var me: UserProfile?
    @State private var camDefaultOn = UserDefaults.standard.bool(forKey: "camDefaultOn")

    var body: some View {
        NavigationStack {
            content
                .fullBg()
                .withRoutes()
        }
        .task {
            if let u: UserProfile = try? await Api.request("/user/me") {
                me = u
                state.user = u
            }
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
                                    Text("\(u.gender == 1 ? "男" : "女") \(u.age)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(u.gender == 1 ? Color(red: 0.43, green: 0.70, blue: 1.0) : Color(red: 1.0, green: 0.48, blue: 0.58))
                                        .padding(.horizontal, 10).padding(.vertical, 2)
                                        .background(Capsule().fill(Theme.bg3))
                                    if u.isGuide {
                                        Text("认证").font(.system(size: 11)).foregroundStyle(Theme.accent)
                                            .padding(.horizontal, 8).padding(.vertical, 2)
                                            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
                                    }
                                }
                                if let sid = u.shortId {
                                    Text("ID：\(sid)").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .padding(.top, 4)
                            Spacer()
                        }
                        Text(u.signature.isEmpty ? "还没有签名" : u.signature)
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            .padding(.top, 14)
                        // 点击进关注/粉丝列表
                        HStack(spacing: 6) {
                            NavigationLink(value: Route.followList("following")) {
                                HStack(spacing: 6) {
                                    Text("\(u.following ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text("关注").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                            Spacer().frame(width: 14)
                            NavigationLink(value: Route.followList("fans")) {
                                HStack(spacing: 6) {
                                    Text("\(u.fans ?? 0)").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                                    Text("粉丝").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.top, 16)

                        // 积分余额：融合进头部（玻璃质感行，点击进钱包）
                        NavigationLink(value: Route.wallet) {
                            HStack(alignment: .center) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("积分余额").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                                    Text(fmtPoints(u.balance)).font(.system(size: 26, weight: .bold)).foregroundStyle(Theme.accent)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 6) {
                                    Text("冻结 \(fmtPoints(u.frozen))").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                                    Text("明细 ›").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                                }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
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
                                    Text("视频通话开启我的画面").font(.system(size: 15)).foregroundStyle(Theme.text)
                                    Text("默认关闭，通话中可随时手动开启").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                }
                                Spacer()
                                Toggle("", isOn: $camDefaultOn)
                                    .labelsHidden()
                                    .tint(Theme.accent)
                                    .onChange(of: camDefaultOn) { _, v in
                                        UserDefaults.standard.set(v, forKey: "camDefaultOn")
                                    }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                    // 菜单
                    menuRow("编辑资料", .editProfile)
                    menuRow("我的动态", .myMoments)
                    // 关注的人动态（原主页「关注」tab 移到这里）
                    menuRow("关注动态", .followMoments)
                    menuRow(u.gender == 2 ? "我的接单" : "我的约单", .taskMine)
                    menuRow("收到的礼物", .giftsReceived)
                    // 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名）
                    if !u.isGuide { menuRow("搭子认证", .guideApply) }
                }
            }
        } else {
            EmptyHint(text: "加载中…")
        }
    }

    private func menuRow(_ label: String, _ route: Route) -> some View {
        NavigationLink(value: route) {
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

private let txLabels: [String: String] = [
    "admin_grant": "平台发放", "gift_send": "送出礼物", "gift_recv": "收到礼物",
    "task_freeze": "约单托管", "task_settle": "约单结算", "task_refund": "约单退回",
    "msg_fee": "发送消息", "msg_income": "消息收入", "call_fee": "视频通话", "call_income": "通话收入",
    "transfer_out": "转赠支出", "transfer_in": "收到转赠", "adjust": "调整",
]

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
    @Environment(AppState.self) var state
    @State private var wallet: WalletData?
    @State private var txs: [WalletTx] = []
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var tab = 0 // 0=明细 1=榜单
    @State private var rank: [ContribRankItem] = []
    @State private var rankLoaded = false

    private var rankTitle: String { state.user?.gender == 2 ? "贡献榜" : "送花榜" }

    var body: some View {
        VStack(spacing: 0) {
            // 积分卡固定在顶部，不随流水滚动
            VStack(spacing: 4) {
                Text("可用积分").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                Text(fmtPoints(wallet?.balance)).font(.system(size: 38, weight: .bold)).foregroundStyle(Theme.text)
                Text("冻结中 \(fmtPoints(wallet?.frozen))").font(.system(size: 12)).foregroundStyle(Theme.textDim)
            }
            .frame(maxWidth: .infinity)
            .padding(24)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
            .padding(16)

            // 明细 / 榜单切换
            HStack(spacing: 10) {
                ForEach(Array(["明细", rankTitle].enumerated()), id: \.offset) { idx, label in
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
                    ForEach(txs) { t in
                        VStack(spacing: 0) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(txLabels[t.type ?? ""] ?? (t.type ?? "")).font(.system(size: 14)).foregroundStyle(Theme.text)
                                    Text(t.remark ?? "").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                }
                                Spacer()
                                let amount = t.amount ?? "0"
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
                            if t.id == txs.last?.id, hasMore {
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
        .navigationTitle("积分明细")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.transfer) {
                    Text("转赠").font(.system(size: 14)).foregroundStyle(Theme.accent)
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
                    Text("暂无数据").font(.system(size: 13)).foregroundStyle(Theme.textDim).padding(30)
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
                                Text(r.nickname ?? "用户").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                                Text("礼物 \(fmtPoints(r.giftFen)) · 通话 \(fmtPoints(r.callFen)) · 消息 \(fmtPoints(r.msgFen))")
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
    @Environment(AppState.self) var state
    @Environment(\.dismiss) private var dismiss
    @State private var sid = ""
    @State private var target: LookupUser?
    @State private var amount = ""
    @State private var balance = "0"
    @State private var toastMsg: String?
    @State private var showScan = false
    @State private var showMyQr = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                // 收款人
                VStack(spacing: 12) {
                    Text("对方 ID").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    TextField("", text: $sid, prompt: Text("6 位数字").foregroundStyle(Theme.textDim))
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 30, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.text)
                        .tracking(6)
                        .onChange(of: sid) { _, v in
                            let filtered = String(v.filter(\.isNumber).prefix(6))
                            if filtered != v { sid = filtered }
                            if filtered.count == 6 {
                                Task { target = try? await Api.request("/wallet/lookup/\(filtered)") }
                            } else { target = nil }
                        }
                    Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 40)

                    if let t = target {
                        HStack(spacing: 10) {
                            AvatarView(url: t.avatar, size: 40)
                            Text(t.nickname ?? "").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.text)
                            Spacer()
                            HStack(spacing: 4) {
                                Circle().fill(Theme.success).frame(width: 6, height: 6)
                                Text("已确认").font(.system(size: 12)).foregroundStyle(Theme.success)
                            }
                        }
                        .padding(.horizontal, 4)
                    } else if sid.count == 6 {
                        Text("正在查找…").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    } else {
                        Text("输入对方的 6 位 ID 自动确认收款人").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }

                    HStack(spacing: 0) {
                        Button {
                            showScan = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "qrcode.viewfinder").font(.system(size: 15))
                                Text("扫一扫").font(.system(size: 13))
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
                                Text("我的收款码").font(.system(size: 13))
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
                    Text("转赠积分").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    TextField("", text: $amount, prompt: Text("0").foregroundStyle(Theme.textDim))
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(Theme.accent)
                    Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 40)
                    HStack(spacing: 6) {
                        Text("可用余额 \(fmtPoints(balance))").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                        Button("全部") { amount = fmtPoints(balance) }
                            .font(.system(size: 12)).foregroundStyle(Theme.accent)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                AccentButton(title: "确认转赠", enabled: target != nil && toFen(amount) > 0) {
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
                    Text("我的 ID：\(mySid)（告诉对方即可互转）")
                        .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle("积分转赠")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toast($toastMsg)
        .fullScreenCover(isPresented: $showScan) {
            QrScanView { text in
                if let s = parsePaySid(text) {
                    sid = s
                } else {
                    toastMsg = "无法识别的二维码"
                }
            }
        }
        .sheet(isPresented: $showMyQr) {
            MyQrCodeView().presentationDetents([.height(480)])
        }
        .task {
            if let w: WalletData = try? await Api.request("/wallet") { balance = w.balance ?? "0" }
        }
    }
}

/// 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号
struct RealnameView: View {
    @Environment(AppState.self) var state
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
                        Text("已完成实名认证").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        Text("认证姓名：\(state.user?.realNameMasked ?? "")")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("真实姓名").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $name, prompt: Text("与身份证一致").foregroundStyle(Theme.textDim))
                                .font(.system(size: 16)).foregroundStyle(Theme.text)
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("身份证号").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            TextField("", text: $idCard, prompt: Text("18 位身份证号码").foregroundStyle(Theme.textDim))
                                .font(.system(size: 16, design: .monospaced)).foregroundStyle(Theme.text)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .padding(12)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
                                .onChange(of: idCard) { _, v in
                                    let filtered = String(v.uppercased().filter { $0.isNumber || $0 == "X" }.prefix(18))
                                    if filtered != v { idCard = filtered }
                                }
                        }
                        Text("信息仅用于身份核验，平台不对外展示。每个身份证号仅可认证一个账号。")
                            .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    }
                    .padding(18)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))

                    AccentButton(title: busy ? "提交中…" : "提交认证", enabled: !busy && name.count >= 2 && idCard.count == 18) {
                        Task { await submit() }
                    }
                }
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle("实名认证")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
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
            toastMsg = "认证成功"
        } catch {
            toastMsg = error.localizedDescription
        }
    }
}

/// 编辑资料
struct EditProfileView: View {
    @Environment(AppState.self) var state
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var age = 18
    @State private var avatar = ""
    @State private var signature = ""
    @State private var city = ""
    @State private var videoPrice = ""
    @State private var avatarItem: PhotosPickerItem?
    @State private var toastMsg: String?
    @State private var loaded = false
    /// 照片墙（最多 8 张，支持多选）
    @State private var photos: [String] = []
    @State private var wallItems: [PhotosPickerItem] = []
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
                PhotosPicker(selection: $avatarItem, matching: .images) {
                    VStack(spacing: 8) {
                        ZStack(alignment: .bottom) {
                            AvatarView(url: avatar, size: 92)
                            Text("更换")
                                .font(.system(size: 10)).foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 2)
                                .background(Capsule().fill(Color.black.opacity(0.55)))
                        }
                        Text("点击更换头像").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                }
                .padding(.top, 10)

                // ===== 基本信息 =====
                editCard {
                    editRow("昵称") {
                        TextField("填写昵称", text: $nickname)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                    }
                    editDivider
                    editRow("年纪") {
                        HStack {
                            Text("\(age) 岁").font(.system(size: 15)).foregroundStyle(Theme.text)
                            Spacer()
                            Text("›").font(.system(size: 20)).foregroundStyle(Theme.textDim)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { pendingAge = age; showAgeSheet = true }
                    editDivider
                    editRow("城市") {
                        HStack(spacing: 10) {
                            TextField("填写或点右侧定位", text: $city)
                                .font(.system(size: 15)).foregroundStyle(Theme.text)
                            Button("定位") {
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
                        editRow("视频价格") {
                            HStack(spacing: 8) {
                                TextField("0", text: $videoPrice)
                                    .keyboardType(.decimalPad)
                                    .font(.system(size: 15)).foregroundStyle(Theme.text)
                                Text("积分/分钟").font(.system(size: 13)).foregroundStyle(Theme.textDim)
                            }
                        }
                        editDivider
                        // 手续费提示：收入 = 价格 - 手续费，价格须高于手续费
                        let priceFen = toFen(videoPrice)
                        let income = max(0, priceFen - feeCut)
                        Text("平台手续费 \(fmtPoints(String(feeCut))) 积分/分钟，你的收入 \(fmtPoints(String(income))) 积分/分钟（价格须高于手续费）")
                            .font(.system(size: 11)).lineSpacing(3)
                            .foregroundStyle(priceFen > feeCut ? Theme.textDim : Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                    }
                }

                // ===== 签名 =====
                editCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("签名").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                        TextField("介绍一下自己…", text: $signature, axis: .vertical)
                            .lineLimit(3...6)
                            .font(.system(size: 15)).foregroundStyle(Theme.text)
                            .onChange(of: signature) { _, v in
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
                            Text("照片墙").font(.system(size: 14)).foregroundStyle(Theme.textSub)
                            Spacer()
                            Text("\(photos.count)/8")
                                .font(.system(size: 12))
                                .foregroundStyle(photos.count >= 8 ? Theme.accent : Theme.textDim)
                        }
                        Text(photos.count >= 8
                            ? "已满 8 张，删除后可再添加 · 展示在你的个人主页"
                            : "还可选 \(8 - photos.count) 张（支持多选）· 展示在你的个人主页")
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
                                PhotosPicker(selection: $wallItems, maxSelectionCount: 8 - photos.count, matching: .images) {
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
        .navigationTitle("编辑资料")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { save() }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.accent)
            }
        }
        // 年纪滚轮：底部弹层，取消/确定
        .sheet(isPresented: $showAgeSheet) {
            VStack(spacing: 0) {
                HStack {
                    Button("取消") { showAgeSheet = false }
                        .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                    Spacer()
                    Text("选择年纪").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button("确定") { age = pendingAge; showAgeSheet = false }
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
            .presentationDetents([.height(300)])
            .presentationBackground(Theme.bg2)
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
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data),
                   let jpeg = img.jpegData(compressionQuality: 0.85),
                   let url = try? await Api.upload("image", data: jpeg, filename: "avatar.jpg", mime: "image/jpeg") {
                    avatar = url
                }
                avatarItem = nil
            }
        }
        .onChange(of: wallItems) { _, items in
            guard !items.isEmpty else { return }
            uploadingPhoto = true
            Task {
                for item in items where photos.count < 8 {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let img = UIImage(data: data),
                       let jpeg = img.jpegData(compressionQuality: 0.85),
                       let url = try? await Api.upload("image", data: jpeg, filename: "wall.jpg", mime: "image/jpeg") {
                        photos.append(url)
                    }
                }
                uploadingPhoto = false
                wallItems = []
            }
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
            toastMsg = "昵称不能为空"
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
                Text("认证需提交真实姓名与身份证号，审核通过即同时完成实名认证")
                    .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                inputField("真实姓名", text: $realName)
                inputField("身份证号", text: $idCard)
                inputField("自我介绍", text: $intro)
                AccentButton(title: "提交申请", enabled: !realName.isEmpty && !idCard.isEmpty) {
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
        .navigationTitle("搭子认证")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toast($toastMsg)
    }

    private func inputField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(Theme.textDim))
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
        .navigationTitle("收到的礼物")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
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
                EmptyHint(text: "还没有发布过动态")
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
        .navigationTitle("我的动态")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .confirmationDialog("删除后不可恢复，确定删除这条动态吗？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                guard let m = deleting else { return }
                Task {
                    struct OkResp: Codable { var ok: Bool? }
                    if let _: OkResp = try? await Api.request("/moments/\(m.id)", method: "DELETE") {
                        items.removeAll { $0.id == m.id }
                    }
                    deleting = nil
                }
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
        .task {
            items = (try? await Api.request("/moments/mine")) ?? []
        }
    }

    private func momentCell(_ m: Moment) -> some View {
        let cover = m.type == 2 ? (m.coverUrl ?? "") : (m.images?.first ?? "")
        return ZStack(alignment: .topTrailing) {
            NavigationLink(value: Route.moment(m.id)) {
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
                        Text("赞 \(m.likeCount ?? 0) · 评 \(m.commentCount ?? 0)")
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
                    Text(type == "fans" ? "还没有粉丝" : "还没有关注的人")
                        .font(.system(size: 13)).foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(list) { u in
                                NavigationLink(value: Route.userHome(u.id)) {
                                    HStack(spacing: 12) {
                                        AvatarView(url: u.avatar, size: 46)
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(spacing: 6) {
                                                Text(u.nickname ?? "").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                                                if u.isGuide == true {
                                                    Text("认证").font(.system(size: 10)).foregroundStyle(Theme.accent)
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
                Text("加载中…").font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .fullBg()
        .navigationTitle(type == "fans" ? "粉丝" : "关注")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .task {
            list = (try? await Api.request("/user/follows/list?type=\(type)")) ?? []
        }
    }
}
