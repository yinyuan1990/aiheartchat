import SwiftUI

/// 遇见列表用户卡片（/user/meet/list）
struct MeetUser: Codable, Identifiable, Hashable {
    var id: String = ""
    var nickname: String? = ""
    var avatar: String? = ""
    var gender: Int? = 0
    var age: Int? = 0
    var cityName: String? = ""
    var isGuide: Bool? = false
    var realnameVerified: Bool? = false
    /// 0-100 平均分，显示时 /20 换算五星
    var ratingAvg: Int? = 0
    var ratingCount: Int? = 0
    var videoPriceFen: Int? = 0
    var online: Bool? = false
    var busy: Bool? = false
    /// 注册 7 天内
    var isNew: Bool? = false
    /// 与我的亲密度分（0.5 粒度）
    var intimacy: Double? = 0
}

/// 主页「遇见」：异性用户卡片流。
/// 子栏：所有 / 新人 / 同城 / 亲密度（亲密度按互动记分倒序）。
struct MeetSectionView: View {
    let city: String
    @EnvironmentObject private var appState: AppState
    @State private var tab = "all"
    @State private var items: [MeetUser] = []
    @State private var loading = false

    var body: some View {
        VStack(spacing: 0) {
            // 子栏胶囊：所有 / 新人 / 同城 / 亲密度
            HStack(spacing: 8) {
                ForEach([("all", "所有"), ("new", "新人"), ("city", "同城"), ("intimacy", "亲密度")], id: \.0) { k, label in
                    let sel = tab == k
                    Button {
                        tab = k
                        Task { await load() }
                    } label: {
                        Text(label)
                            .font(.system(size: 13, weight: sel ? .bold : .regular))
                            .foregroundStyle(sel ? .white : Theme.textSub)
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(Capsule().fill(sel ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.bg2)))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.bottom, 10)

            if items.isEmpty {
                EmptyHint(text: emptyText)
            } else {
                ScrollView {
                    let cols = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                    LazyVGrid(columns: cols, spacing: 10) {
                        ForEach(items) { u in
                            MeetCardView(u: u, showIntimacy: tab == "intimacy")
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 12)
                }
                .refreshable { await load() }
            }
        }
        .task(id: tab) {
            await load()
            // 在线/占线状态兜底：30 秒静默刷新
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await load()
            }
        }
    }

    private var emptyText: String {
        if loading { return "加载中…" }
        switch tab {
        case "intimacy": return "还没有亲密的人\n聊天、视频、点赞评论都会累计亲密度"
        case "city": return "「\(city.isEmpty ? "同城" : city)」还没有人\n切到所有看看"
        default: return "暂时没有人"
        }
    }

    private func load() async {
        loading = items.isEmpty
        var q = "?tab=\(tab)"
        if tab == "city", !city.isEmpty {
            q += "&city=\(city.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? city)"
        }
        if let fresh: [MeetUser] = try? await Api.request("/user/meet/list\(q)") {
            items = fresh
        }
        loading = false
    }
}

/// 遇见卡片：大图 + 徽章 + 底部信息浮层
struct MeetCardView: View {
    let u: MeetUser
    var showIntimacy = false
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationLink(value: Route.userHome(u.id)) {
            ZStack {
                GeometryReader { geo in
                    RemoteImage(url: u.avatar ?? "")
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                }
                // 顶部徽章 + 在线点
                VStack {
                    HStack {
                        if u.isGuide == true || u.realnameVerified == true {
                            badge("已认证", bg: Theme.accent)
                        } else if u.isNew == true {
                            badge("新人", bg: Color(red: 0.42, green: 0.36, blue: 0.91))
                        }
                        Spacer()
                        Circle()
                            .fill(u.online == true ? Theme.success : Theme.textDim)
                            .frame(width: 8, height: 8)
                    }
                    .padding(8)
                    Spacer()
                }
                // 底部信息浮层（渐变压暗保证可读）
                VStack {
                    Spacer()
                    VStack(alignment: .leading, spacing: 5) {
                        Text(u.nickname ?? "")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            // 评分五星换算（0-100 → 5.0）
                            Text("★ \((u.ratingCount ?? 0) > 0 ? String(format: "%.1f", Double(u.ratingAvg ?? 0) / 20.0) : "新")")
                                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warn.opacity(0.85)))
                            if let c = u.cityName, !c.isEmpty {
                                Text(c).font(.system(size: 11)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                            }
                            Spacer()
                            trailingBadge
                        }
                    }
                    .padding(.horizontal, 10).padding(.top, 26).padding(.bottom, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom))
                }
            }
            .aspectRatio(3 / 4, contentMode: .fit)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var trailingBadge: some View {
        if showIntimacy, let s = u.intimacy, s > 0 {
            Text("♥ \(s.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(s)) : String(format: "%.1f", s))")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(0.9)))
        } else if appState.user?.gender == 1, u.gender == 2 {
            // 视频按钮三态：通话中 / 离线置灰 / 可打（显示价格）
            let busyOrange = Color(red: 1, green: 0.67, blue: 0.24)
            let price = u.videoPriceFen ?? 0
            Text(u.busy == true ? "通话中" : price > 0 ? "视频 \(fmtPoints(String(price)))/分" : "视频")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(u.busy == true ? busyOrange.opacity(0.9) : u.online == true ? Theme.accent : Theme.textDim.opacity(0.8)),
                )
                .onTapGesture {
                    guard u.busy != true, u.online == true else { return }
                    startCallWithPermissions(calleeId: u.id, type: 2, name: u.nickname ?? "", avatar: u.avatar ?? "")
                }
        }
    }

    private func badge(_ text: String, bg: Color) -> some View {
        Text(text)
            .font(.system(size: 10)).foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }
}
