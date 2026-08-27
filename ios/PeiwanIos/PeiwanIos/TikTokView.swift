import AVKit
import SwiftUI

/// 抖音模式：全屏竖向翻页浏览视频动态
struct TikTokView: View {
    var startId: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Moment] = []
    @State private var currentId: String?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            if items.isEmpty {
                VStack {
                    Spacer()
                    Text("暂无视频动态").font(.system(size: 14)).foregroundStyle(.white.opacity(0.6))
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                // iOS 16 兼容：旋转 TabView 实现竖向整页翻页（scrollPosition/paging 是 iOS 17 API）
                GeometryReader { geo in
                    TabView(selection: $currentId) {
                        ForEach(items) { m in
                            // 只播当前停留页，避免懒加载预创建的页面提前出声
                            TikTokPage(m: m, playing: currentId == m.id)
                                .frame(width: geo.size.width, height: geo.size.height)
                                .rotationEffect(.degrees(-90))
                                .frame(width: geo.size.height, height: geo.size.width)
                                .tag(Optional(m.id))
                        }
                    }
                    .frame(width: geo.size.height, height: geo.size.width)
                    .rotationEffect(.degrees(90), anchor: .topLeading)
                    .offset(x: geo.size.width)
                    .tabViewStyle(.page(indexDisplayMode: .never))
                }
                .ignoresSafeArea()
            }

            Button {
                dismiss()
            } label: {
                Text("×").font(.system(size: 24)).foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(.white.opacity(0.15)))
            }
            .buttonStyle(.plain)
            .padding(.top, 54).padding(.leading, 16)
        }
        .task {
            items = (try? await Api.request("/moments/feed?onlyVideo=1")) ?? []
            if currentId == nil {
                currentId = startId.flatMap { sid in items.first(where: { $0.id == sid })?.id } ?? items.first?.id
            }
        }
    }
}

/// 单页：视频循环播放 + 作者信息 + 点赞
private struct TikTokPage: View {
    let m: Moment
    let playing: Bool
    @EnvironmentObject private var appState: AppState
    @State private var player: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?
    @State private var liked = false
    @State private var likeCount = 0
    @State private var inited = false

    var body: some View {
        ZStack {
            if let player {
                VideoPlayer(player: player)
                    .disabled(true)
                    .ignoresSafeArea()
                    .onTapGesture {
                        if player.timeControlStatus == .playing { player.pause() } else { player.play() }
                    }
            } else {
                Color.black
            }

            // 底部信息层
            VStack {
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            AvatarView(url: m.user?.avatar, size: 40)
                            Text(m.user?.nickname ?? "").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                            if let city = m.cityName, !city.isEmpty {
                                Text(city).font(.system(size: 11)).foregroundStyle(.white.opacity(0.7))
                            }
                        }
                        if let content = m.content, !content.isEmpty {
                            Text(content).font(.system(size: 14)).foregroundStyle(.white.opacity(0.9)).lineLimit(2)
                        }
                    }
                    Spacer()
                    // 右侧操作
                    VStack(spacing: 18) {
                        Button {
                            Task {
                                if let r: LikeResp = try? await Api.request("/moments/\(m.id)/like", method: "POST") {
                                    let nl = r.liked ?? !liked
                                    liked = nl; likeCount += nl ? 1 : -1
                                }
                            }
                        } label: {
                            VStack(spacing: 4) {
                                Image(systemName: liked ? "heart.fill" : "heart")
                                    .font(.system(size: 30))
                                    .foregroundStyle(liked ? Theme.accent : .white)
                                Text("\(likeCount)").font(.system(size: 12)).foregroundStyle(.white)
                            }
                        }
                        .buttonStyle(.plain)
                        // 视频通话仅男方可发起；对方离线置灰
                        if appState.user?.gender == 1 {
                            let peerOnline = m.user?.online == true
                            Button {
                                if peerOnline, let u = m.user {
                                    startCallWithPermissions(calleeId: u.id, type: 2, name: u.nickname ?? "", avatar: u.avatar ?? "")
                                }
                            } label: {
                                VStack(spacing: 4) {
                                    Image(systemName: "video.fill").font(.system(size: 26))
                                        .foregroundStyle(peerOnline ? .white : .white.opacity(0.35))
                                    Text(peerOnline ? "视频通话" : "对方离线").font(.system(size: 11))
                                        .foregroundStyle(peerOnline ? .white : .white.opacity(0.35))
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(!peerOnline)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 50)
            }
        }
        .onAppear {
            if !inited {
                liked = m.liked ?? false
                likeCount = m.likeCount ?? 0
                inited = true
            }
            ensurePlayer()
            if playing {
                player?.seek(to: .zero)
                player?.play()
            }
        }
        .onChange(of: playing) { p in
            // 翻页时旧页立即静音、新页开播
            ensurePlayer()
            if p {
                player?.seek(to: .zero)
                player?.play()
            } else {
                player?.pause()
            }
        }
        .onDisappear {
            player?.pause()
        }
    }

    private func ensurePlayer() {
        if player == nil, let v = m.videoUrl, let url = URL(string: Api.fullUrl(v)) {
            let item = AVPlayerItem(url: url)
            item.preferredForwardBufferDuration = 2
            let p = AVQueuePlayer()
            p.automaticallyWaitsToMinimizeStalling = false
            p.isMuted = false
            // AVPlayerLooper：系统级无缝循环（比播完 seek 回零更顺滑）
            looper = AVPlayerLooper(player: p, templateItem: item)
            player = p
        }
    }
}
