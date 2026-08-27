import Combine
import SwiftUI

/// 他人主页：顶部大图 hero + 圆角资料卡（关于我/我的动态 tab）+ 底部操作栏
struct UserHomeView: View {
    let userId: String
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var p: HomeProfile?
    @State private var moments: [Moment] = []
    @State private var following = false
    @State private var tab = 0
    @State private var chatTarget: ChatTarget?
    @State private var showGift = false
    @State private var toast: String?
    @State private var wallImage: String?
    /// hero 轮播当前页（自动轮播用）
    @State private var heroIdx = 0

    private let busyOrange = Color(red: 1, green: 0.67, blue: 0.24)

    var body: some View {
        Group {
            if let p {
                content(p)
            } else {
                Text("加载中…").font(.system(size: 13)).foregroundStyle(Theme.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .fullBg()
        .toolbar(.hidden, for: .navigationBar)
        .ignoresSafeArea(edges: .top)
        .fullScreenCover(item: $chatTarget) { t in
            ChatRoomSheet(target: t)
        }
        .sheet(isPresented: $showGift) {
            GiftSheetView(toUserId: userId)
        }
        .fullScreenCover(isPresented: Binding(get: { wallImage != nil }, set: { if !$0 { wallImage = nil } })) {
            let urls = (p?.albums ?? []).filter { ($0.type ?? 1) == 1 }.map(\.url)
            ImageViewerView(images: urls, initial: max(0, urls.firstIndex(of: wallImage ?? "") ?? 0)) { wallImage = nil }
        }
        .overlay(alignment: .top) {
            if let t = toast {
                Text(t)
                    .font(.system(size: 13)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(Capsule().fill(Color.black.opacity(0.85)))
                    .padding(.top, 60)
                    .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { toast = nil } }
            }
        }
        .task {
            p = try? await Api.request("/user/\(userId)")
            following = p?.isFollowing == true
            moments = (try? await Api.request("/moments/user/\(userId)")) ?? []
        }
    }

    private func fmtDate(_ s: String?) -> String {
        guard let s, s.count >= 10 else { return "" }
        let mm = String(s[s.index(s.startIndex, offsetBy: 5)..<s.index(s.startIndex, offsetBy: 7)])
        let dd = String(s[s.index(s.startIndex, offsetBy: 8)..<s.index(s.startIndex, offsetBy: 10)])
        return "\(mm)月\(dd)日"
    }

    @ViewBuilder
    private func content(_ p: HomeProfile) -> some View {
        let isFemale = p.gender == 2
        let canVideo = appState.user?.gender == 1 && isFemale
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero(p, isFemale: isFemale)
                    // 圆角资料卡
                    VStack(alignment: .leading, spacing: 0) {
                        // tab 行 + 关注按钮
                        HStack(alignment: .center, spacing: 24) {
                            tabLabel("关于我", selected: tab == 0) { tab = 0 }
                            tabLabel("我的动态", selected: tab == 1) { tab = 1 }
                            Spacer()
                            Button {
                                Task {
                                    struct FollowR: Codable { var following: Bool? }
                                    if let r: FollowR = try? await Api.request("/user/\(userId)/follow", method: "POST") {
                                        following = r.following ?? !following
                                    }
                                }
                            } label: {
                                Text(following ? "已关注" : "＋ 关注")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(following ? Theme.textSub : .white)
                                    .padding(.horizontal, 18).padding(.vertical, 8)
                                    .background(
                                        Capsule().fill(
                                            following
                                                ? AnyShapeStyle(Theme.bg3)
                                                : AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .leading, endPoint: .trailing))
                                        )
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 18)
                        .padding(.bottom, 18)

                        if tab == 0 {
                            aboutSection(p, isFemale: isFemale)
                        } else {
                            momentsSection(p)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20))
                    .offset(y: -20)
                }
                .padding(.bottom, 90)
            }

            bottomBar(p, canVideo: canVideo)
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Text("‹").font(.system(size: 24)).foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(.black.opacity(0.35)))
            }
            .buttonStyle(.plain)
            .padding(.leading, 12)
            .padding(.top, 54)
        }
    }

    // ===== 顶部大图 hero：头像 + 照片墙横滑轮播 =====
    private func hero(_ p: HomeProfile, isFemale: Bool) -> some View {
        let heroImages: [String] = {
            var urls = [p.avatar ?? ""] + (p.albums ?? []).filter { ($0.type ?? 1) == 1 }.map(\.url)
            urls = urls.filter { !$0.isEmpty }
            var seen = Set<String>()
            return urls.filter { seen.insert($0).inserted }
        }()
        return GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                if heroImages.isEmpty {
                    Theme.bg2
                } else {
                    TabView(selection: $heroIdx) {
                        ForEach(Array(heroImages.enumerated()), id: \.offset) { i, url in
                            RemoteImage(url: url)
                                .aspectRatio(contentMode: .fill)
                                .frame(width: geo.size.width, height: geo.size.height)
                                .clipped()
                                .tag(i)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: heroImages.count > 1 ? .automatic : .never))
                    .frame(width: geo.size.width, height: geo.size.height)
                    // 自动轮播：3.5 秒翻页
                    .onReceive(Timer.publish(every: 3.5, on: .main, in: .common).autoconnect()) { _ in
                        guard heroImages.count > 1 else { return }
                        withAnimation { heroIdx = (heroIdx + 1) % heroImages.count }
                    }
                }
                LinearGradient(
                    stops: [.init(color: .clear, location: 0), .init(color: .clear, location: 0.55), .init(color: Theme.bg.opacity(0.9), location: 1)],
                    startPoint: .top, endPoint: .bottom
                )
                .allowsHitTesting(false)
                VStack(alignment: .leading, spacing: 4) {
                    if isFemale, let rate = p.answerRate, rate >= 0 {
                        HStack(alignment: .lastTextBaseline, spacing: 0) {
                            Text("\(rate)").font(.system(size: 26, weight: .bold)).foregroundStyle(.white)
                            Text(" % 接通率").font(.system(size: 12)).foregroundStyle(.white.opacity(0.75))
                        }
                    }
                    if isFemale, let price = p.videoPriceActualFen, price > 0 {
                        HStack(alignment: .lastTextBaseline, spacing: 0) {
                            Text(fmtPoints(String(price))).font(.system(size: 26, weight: .bold)).foregroundStyle(.white)
                            Text(" 积分/分钟").font(.system(size: 12)).foregroundStyle(.white.opacity(0.75))
                        }
                    }
                }
                .padding(.leading, 16)
                .padding(.bottom, 34)
            }
        }
        .aspectRatio(0.82, contentMode: .fit)
    }

    // ===== 关于我 =====
    @ViewBuilder
    private func aboutSection(_ p: HomeProfile, isFemale: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(p.nickname ?? "").font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.text)
                let stColor: Color = p.busy == true ? busyOrange : p.online == true ? Theme.success : Theme.textDim
                let stText = p.busy == true ? "通话中" : p.online == true ? "在线" : "离线"
                Text("● \(stText)").font(.system(size: 11)).foregroundStyle(stColor)
            }
            HStack(spacing: 6) {
                Text("\(p.gender == 1 ? "男" : "女") \(p.age ?? 0)")
                    .font(.system(size: 11))
                    .foregroundStyle(p.gender == 1 ? Color(red: 0.43, green: 0.7, blue: 1) : Color(red: 1, green: 0.48, blue: 0.58))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(.white.opacity(0.07)))
                if let city = p.cityName, !city.isEmpty {
                    Text(city).font(.system(size: 11)).foregroundStyle(Theme.textSub)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(.white.opacity(0.07)))
                }
            }
            .padding(.top, 8)
            if let sig = p.signature, !sig.isEmpty {
                Text(sig).font(.system(size: 13)).foregroundStyle(Theme.textSub).lineSpacing(5).padding(.top, 12)
            }
            HStack(spacing: 24) {
                statCell("\(p.following ?? 0)", "关注", Theme.text)
                statCell("\(p.fans ?? 0)", "粉丝", Theme.text)
            }
            .padding(.top, 16)
            // ===== 评分：星级总分 + 五维度方格，最高维度渐变高亮 =====
            if isFemale, let r = p.rating, (r.count ?? 0) > 0 {
                let star = Double(r.avg ?? 0) / 20.0
                let filled = min(max(Int(star.rounded()), 0), 5)
                // 按分从高到低排成 3+2 方格，第一格（她最突出的）用渐变填充
                let dims: [(String, Int)] = [
                    ("真实度", r.photo ?? 0), ("配合度", r.obedience ?? 0),
                    ("腿型", r.legs ?? 0), ("曲线", r.chest ?? 0), ("肤质", r.skin ?? 0),
                ].sorted { $0.1 > $1.1 }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text("评分").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                        Text(String(repeating: "★", count: filled) + String(repeating: "☆", count: 5 - filled))
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                        Text(String(format: "%.1f", star)).font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.accent)
                        Text("\(r.count ?? 0)次评价").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                    HStack(spacing: 8) {
                        ForEach(0..<3, id: \.self) { i in
                            ratingCell(dims[i].0, dims[i].1, best: i == 0 && dims[i].1 > 0)
                        }
                    }
                    HStack(spacing: 8) {
                        ForEach(3..<5, id: \.self) { i in
                            ratingCell(dims[i].0, dims[i].1, best: false)
                        }
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 18)
            }
            // 照片墙（最多 8 张）
            let wall = (p.albums ?? []).filter { ($0.type ?? 1) == 1 }
            if !wall.isEmpty {
                Text("照片墙").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                    .padding(.top, 18)
                let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                LazyVGrid(columns: cols, spacing: 8) {
                    ForEach(wall) { a in
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(RemoteImage(url: a.url).aspectRatio(contentMode: .fill))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .onTapGesture { wallImage = a.url }
                    }
                }
                .padding(.top, 8)
            }
            // 认证信息：简约行，无背景卡
            VStack(alignment: .leading, spacing: 10) {
                Text("认证信息").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                HStack(spacing: 18) {
                    certLine("平台认证", verified: p.isGuide == true)
                    if isFemale {
                        certLine("实名认证", verified: p.realnameVerified == true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 18)
        }
        .padding(.horizontal, 16)
    }

    // ===== 我的动态：列表式 =====
    @ViewBuilder
    private func momentsSection(_ p: HomeProfile) -> some View {
        if moments.isEmpty {
            Text("暂无动态").font(.system(size: 13)).foregroundStyle(Theme.textDim)
                .frame(maxWidth: .infinity).padding(40)
        }
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(moments) { m in
                NavigationLink(value: Route.moment(m.id)) {
                    momentRow(m, profile: p)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func momentRow(_ m: Moment, profile p: HomeProfile) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                AvatarView(url: p.avatar, size: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.nickname ?? "").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(fmtDate(m.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
            }
            if let c = m.content, !c.isEmpty {
                Text(c).font(.system(size: 15)).foregroundStyle(Theme.text).lineSpacing(5)
                    .multilineTextAlignment(.leading)
                    .padding(.top, 10)
            }
            // 媒体：单图/视频大图（2/3 宽 3:4），两图/三图等分方格铺满整行
            let thumbs: [String] = m.type == 2 ? [m.coverUrl ?? ""].filter { !$0.isEmpty } : Array((m.images ?? []).prefix(3))
            if thumbs.count == 1 {
                ZStack {
                    RemoteImage(url: thumbs[0])
                        .aspectRatio(contentMode: .fill)
                        .frame(width: (UIScreen.main.bounds.width - 32) * 0.66, height: (UIScreen.main.bounds.width - 32) * 0.66 / 0.75)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    if m.type == 2 {
                        Text("▶").font(.system(size: 18)).foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Circle().fill(.black.opacity(0.45)))
                    }
                }
                .padding(.top, 10)
            } else if thumbs.count > 1 {
                HStack(spacing: 6) {
                    ForEach(thumbs, id: \.self) { u in
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(RemoteImage(url: u).aspectRatio(contentMode: .fill))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                .padding(.top, 10)
            }
            HStack(spacing: 18) {
                Text("♡ \(m.likeCount ?? 0)").font(.system(size: 13)).foregroundStyle(Theme.textSub)
                Text("评论 \(m.commentCount ?? 0)").font(.system(size: 13)).foregroundStyle(Theme.textSub)
            }
            .padding(.top, 10)
            Rectangle().fill(Theme.line).frame(height: 0.5).padding(.top, 14)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    // ===== 底部操作栏 =====
    private func bottomBar(_ p: HomeProfile, canVideo: Bool) -> some View {
        HStack(spacing: 12) {
            Button {
                Task {
                    if let t = await openChatWith(userId: userId, nickname: p.nickname ?? "") {
                        chatTarget = t
                    }
                }
            } label: {
                Text("聊天").font(.system(size: 12)).foregroundStyle(Theme.text)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Theme.bg2))
            }
            .buttonStyle(.plain)

            Button { showGift = true } label: {
                Text("礼物").font(.system(size: 12)).foregroundStyle(Theme.accent2)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Theme.bg2))
            }
            .buttonStyle(.plain)

            if canVideo {
                let busy = p.busy == true
                let online = p.online == true
                Button {
                    if busy { toast = "对方正在通话中，请稍后再试"; return }
                    if !online { toast = "对方不在线"; return }
                    CallManager.shared.startCall(calleeId: userId, type: 2, name: p.nickname ?? "", avatar: p.avatar ?? "")
                } label: {
                    let priceFen = p.videoPriceActualFen ?? 0
                    let mainColor: Color = busy ? busyOrange : !online ? Theme.textDim : .white
                    VStack(spacing: 1) {
                        Text(busy ? "通话中" : "视频聊天")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(mainColor)
                        if !busy {
                            if !online {
                                Text("对方离线").font(.system(size: 10)).foregroundStyle(Theme.textDim)
                            } else if priceFen > 0 {
                                Text("\(fmtPoints(String(priceFen)))积分/分钟")
                                    .font(.system(size: 10)).foregroundStyle(.white.opacity(0.85))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(
                        Capsule().fill(
                            busy || !online
                                ? AnyShapeStyle(Theme.bg3)
                                : AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .leading, endPoint: .trailing))
                        )
                    )
                }
                .buttonStyle(.plain)
            } else {
                Button {
                    Task {
                        if let t = await openChatWith(userId: userId, nickname: p.nickname ?? "") {
                            chatTarget = t
                        }
                    }
                } label: {
                    Text("发消息")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(Capsule().fill(LinearGradient(colors: [Theme.accent, Theme.accent2], startPoint: .leading, endPoint: .trailing)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .background(
            LinearGradient(colors: [.clear, Theme.bg.opacity(0.95), Theme.bg], startPoint: .top, endPoint: .bottom)
        )
    }

    /// 认证信息行：简约风，勾 + 文字，无背景
    private func certLine(_ label: String, verified: Bool) -> some View {
        HStack(spacing: 5) {
            Text("✓").font(.system(size: 13, weight: .bold)).foregroundStyle(verified ? Theme.accent : Theme.textDim)
            Text(verified ? label : "\(label)（未认证）")
                .font(.system(size: 13)).foregroundStyle(verified ? Theme.text : Theme.textDim)
        }
    }

    private func tabLabel(_ text: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Text(text)
                    .font(.system(size: selected ? 16 : 15, weight: selected ? .bold : .regular))
                    .foregroundStyle(selected ? Theme.text : Theme.textSub)
                RoundedRectangle(cornerRadius: 2)
                    .fill(selected ? Theme.accent : .clear)
                    .frame(width: 20, height: 3)
            }
        }
        .buttonStyle(.plain)
    }

    /// 五维度评分方格：分值大字 + 维度名小字；best=最高分渐变填充
    private func ratingCell(_ label: String, _ score: Int, best: Bool) -> some View {
        VStack(spacing: 2) {
            Text(String(format: "%.1f", Double(score) / 20.0))
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(best ? .white : Theme.text)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(best ? Color.white.opacity(0.9) : Theme.textSub)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(
            best ? AnyShapeStyle(Theme.accentGrad) : AnyShapeStyle(Color.white.opacity(0.06)),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }

    private func statCell(_ value: String, _ label: String, _ color: Color) -> some View {
        HStack(alignment: .bottom, spacing: 4) {
            Text(value).font(.system(size: 16, weight: .bold)).foregroundStyle(color)
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.textDim)
        }
    }
}
