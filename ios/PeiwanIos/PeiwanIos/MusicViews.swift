import AVFoundation
import Combine
import MediaPlayer
import SwiftUI

/// 曲目（后端从 Telegram 频道同步，最近 3 天）
struct MusicTrackModel: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let performer: String?
    let duration: Int?
    let size: Int?
    let url: String
    let cover: String?
    let postedAt: String?
    let playCount: Int?
}

struct MusicSourceModel: Codable {
    let title: String?
    let channel: String?
}

struct MusicListModel: Codable {
    let source: MusicSourceModel?
    let list: [MusicTrackModel]
}

/**
 * 全局音乐播放器：单例 AVPlayer，离开音乐页也继续播（边聊边听，后台可播）；
 * 通话 / 语音房 / 动态视频开始时由外部调用 pause() 让位。
 * 消息页顶部「正在播放」栏、播放弹层都读这里的状态。
 */
final class MusicCenter: ObservableObject {
    static let shared = MusicCenter()

    @Published private(set) var data: MusicListModel?
    @Published private(set) var current: MusicTrackModel?
    @Published private(set) var isPlaying = false
    @Published private(set) var buffering = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    /// 倍速 1 / 1.5 / 2
    @Published private(set) var rate: Float = 1
    @Published var shuffle = false
    /// 单曲循环（否则列表循环）
    @Published var repeatOne = false

    var queue: [MusicTrackModel] { data?.list ?? [] }
    var sourceTitle: String { data?.source?.title ?? "" }

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusCancellable: AnyCancellable?
    private var counted = Set<String>()
    private var remoteReady = false

    /// 拉列表（force 重新拉）
    @MainActor
    func load(force: Bool = false) async {
        if data != nil, !force { return }
        if let d: MusicListModel = try? await Api.request("/music") {
            data = d
        } else if data == nil {
            data = MusicListModel(source: nil, list: [])
        }
    }

    /// 点列表项：同一首切换播放/暂停，不同首切歌
    func play(_ t: MusicTrackModel) {
        if current?.id == t.id, let p = player {
            if isPlaying { p.pause() } else { p.play() }
            return
        }
        guard let u = URL(string: Api.fullUrl(t.url)) else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)

        teardownObservers()
        let item = AVPlayerItem(url: u)
        let p = player ?? AVPlayer()
        p.replaceCurrentItem(with: item)
        player = p
        current = t
        position = 0
        duration = Double(t.duration ?? 0)
        buffering = true

        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self else { return }
            self.position = time.seconds.isFinite ? time.seconds : 0
            if let d = p.currentItem?.duration.seconds, d.isFinite, d > 0 { self.duration = d }
            self.isPlaying = p.timeControlStatus == .playing
            self.buffering = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
            self.updateNowPlaying()
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self else { return }
            if self.repeatOne {
                p.seek(to: .zero); p.play()
            } else {
                self.step(1)
            }
        }
        statusCancellable = p.publisher(for: \.timeControlStatus).receive(on: DispatchQueue.main).sink { [weak self] s in
            self?.isPlaying = s == .playing
            self?.buffering = s == .waitingToPlayAtSpecifiedRate
        }
        p.play()
        p.rate = rate
        setupRemoteCommands()
        updateNowPlaying()
        if !counted.contains(t.id) {
            counted.insert(t.id)
            Task { let _: [String: Bool]? = try? await Api.request("/music/\(t.id)/play", method: "POST") }
        }
    }

    func toggle() {
        guard current != nil, let p = player else {
            if let first = queue.first { play(first) }
            return
        }
        if isPlaying { p.pause() } else { p.play(); p.rate = rate }
    }

    func step(_ delta: Int) {
        let q = queue
        guard !q.isEmpty else { return }
        let idx = q.firstIndex { $0.id == current?.id } ?? -1
        var next: Int
        if shuffle, q.count > 1 {
            repeat { next = Int.random(in: 0..<q.count) } while next == idx
        } else {
            next = idx < 0 ? 0 : ((idx + delta) % q.count + q.count) % q.count
        }
        play(q[next])
    }

    func pause() { player?.pause() }

    /// 关闭：停止并收起顶部栏
    func stop() {
        teardownObservers()
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        current = nil
        isPlaying = false
        buffering = false
        position = 0
        duration = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func seek(ratio: Double) {
        guard duration > 0 else { return }
        player?.seek(to: CMTime(seconds: max(0, min(1, ratio)) * duration, preferredTimescale: 600))
    }

    /// 倍速循环 1x → 1.5x → 2x
    func cycleRate() {
        rate = rate == 1 ? 1.5 : rate == 1.5 ? 2 : 1
        if isPlaying { player?.rate = rate }
    }

    var rateLabel: String { rate == 1 ? "1X" : rate == 1.5 ? "1.5X" : "2X" }

    private func teardownObservers() {
        if let o = timeObserver { player?.removeTimeObserver(o) }
        timeObserver = nil
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        endObserver = nil
        statusCancellable = nil
    }

    // MARK: - 锁屏 / 控制中心

    private func setupRemoteCommands() {
        guard !remoteReady else { return }
        remoteReady = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.player?.play(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.player?.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.toggle(); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.step(1); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.step(-1); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let self, let ev = e as? MPChangePlaybackPositionCommandEvent, self.duration > 0 else { return .commandFailed }
            self.seek(ratio: ev.positionTime / self.duration)
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let t = current else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyArtist: t.performer ?? sourceTitle,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? Double(rate) : 0.0,
        ]
        if let c = t.cover, !c.isEmpty, let img = RemoteImageCache.cache.object(forKey: Api.fullUrl(c) as NSString) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

// MARK: - 消息页顶部「正在播放」栏

/// 播放中固定在消息页顶部：暂停 / 标题·艺术家 / 倍速 / 关闭；点中间打开播放弹层
struct NowPlayingBar: View {
    @ObservedObject private var center = MusicCenter.shared
    let onOpen: () -> Void

    var body: some View {
        if let t = center.current {
            HStack(spacing: 4) {
                Button { center.toggle() } label: {
                    Image(systemName: center.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 17)).foregroundStyle(Theme.text).frame(width: 34, height: 34)
                }
                Button(action: onOpen) {
                    VStack(spacing: 1) {
                        Text(t.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                        Text(subtitle(t)).font(.system(size: 11)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                RateChip(label: center.rateLabel) { center.cycleRate() }
                Button { center.stop() } label: {
                    Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).frame(width: 34, height: 34)
                }
            }
            .padding(EdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 8))
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
            .padding(.horizontal, 12).padding(.top, 8)
        }
    }

    private func subtitle(_ t: MusicTrackModel) -> String {
        let base = (t.performer?.isEmpty == false ? t.performer! : (center.sourceTitle.isEmpty ? "未知艺术家" : center.sourceTitle))
        return center.buffering ? base + " · 缓冲中…" : base
    }
}

/// 倍速小标签（虚线框，像 Telegram 的 1X）
struct RateChip: View {
    let label: String
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            Text(label).font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSub)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.textDim, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 播放弹层 / 页面

/// 独立弹层（从消息页顶部栏或入口 sheet 出来）：列表 + 大播放器
struct MusicSheetView: View {
    let onClose: () -> Void
    @ObservedObject private var center = MusicCenter.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(center.sourceTitle.isEmpty ? "音乐" : center.sourceTitle)
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text("只保留最近 3 天" + (center.queue.isEmpty ? "" : " · 共 \(center.queue.count) 首"))
                        .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text).frame(width: 34, height: 34)
                }
            }
            .padding(EdgeInsets(top: 12, leading: 16, bottom: 10, trailing: 8))
            MusicListAndPlayer(showHeadline: false)
        }
        .background(Theme.bg2.ignoresSafeArea())
    }
}

/// 路由页形式（Route.music），导航栏标题用频道名
struct MusicView: View {
    @ObservedObject private var center = MusicCenter.shared
    var body: some View {
        MusicListAndPlayer(showHeadline: true)
            .fullBg()
            .navigationTitle(center.sourceTitle.isEmpty ? "音乐" : center.sourceTitle)
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// 列表 + 底部大播放器（弹层与页面共用）
struct MusicListAndPlayer: View {
    let showHeadline: Bool
    @ObservedObject private var center = MusicCenter.shared
    @State private var loaded = MusicCenter.shared.data != nil

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if !loaded {
                    EmptyHint(text: "加载中…")
                } else if center.queue.isEmpty {
                    EmptyHint(text: "最近 3 天还没有新歌\n稍后再来看看")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            if showHeadline {
                                Text("只保留最近 3 天 · 共 \(center.queue.count) 首")
                                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 2)
                            }
                            ForEach(center.queue) { t in
                                Button { center.play(t) } label: { row(t) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                    .refreshable { await center.load(force: true) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            BigPlayer()
        }
        .task { await center.load(); loaded = true }
    }

    private func row(_ t: MusicTrackModel) -> some View {
        let active = center.current?.id == t.id
        let playing = active && center.isPlaying
        return HStack(spacing: 12) {
            MusicCover(track: t, size: 48, spinning: playing)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(t.title)
                        .font(.system(size: 15, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? Theme.accent : Theme.text)
                        .lineLimit(1)
                    if playing { PlayingBars() }
                }
                HStack(spacing: 6) {
                    Text(fmtDur(Double(t.duration ?? 0)))
                    if let p = t.performer, !p.isEmpty {
                        Text("· \(p)").lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    Text("· \(fmtSize(t.size ?? 0))")
                    Text("· \(timeAgo(t.postedAt))")
                }
                .font(.system(size: 11)).foregroundStyle(Theme.textDim)
            }
            Spacer(minLength: 0)
            Image(systemName: playing ? "pause.fill" : "play.fill")
                .font(.system(size: 16))
                .foregroundStyle(active ? Theme.accent : Theme.textDim)
                .frame(width: 20)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// 底部大播放器：封面 + 标题/艺术家 / 进度（可拖）+ 时间 + 倍速 / 随机 · 上一首 · 播放 · 下一首 · 循环
struct BigPlayer: View {
    @ObservedObject private var center = MusicCenter.shared

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.line).frame(height: 1)
            VStack(spacing: 0) {
                if let t = center.current {
                    HStack(spacing: 12) {
                        MusicCover(track: t, size: 52, spinning: false, round: false)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(t.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                            Text(t.performer?.isEmpty == false ? t.performer! : "未知艺术家").font(.system(size: 13)).foregroundStyle(Theme.textSub).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.bg3).frame(height: 4)
                            Capsule().fill(Theme.accentGrad).frame(width: max(0, geo.size.width * ratio), height: 4)
                            Circle().fill(.white).frame(width: 12, height: 12)
                                .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
                                .offset(x: max(0, geo.size.width * ratio - 6))
                        }
                        .frame(height: 20)
                        .contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 0).onChanged { v in
                            center.seek(ratio: v.location.x / max(1, geo.size.width))
                        })
                    }
                    .frame(height: 20)
                    .padding(.top, 12)
                    HStack {
                        Text(fmtDur(center.position)).font(.system(size: 11)).foregroundStyle(Theme.textDim).frame(width: 56, alignment: .leading)
                        Spacer()
                        RateChip(label: center.rateLabel) { center.cycleRate() }
                        Spacer()
                        Text(fmtDur(center.duration)).font(.system(size: 11)).foregroundStyle(Theme.textDim).frame(width: 56, alignment: .trailing)
                    }
                    .padding(.top, 2)
                } else {
                    Text("点上面的歌开始播放").font(.system(size: 13)).foregroundStyle(Theme.textSub).padding(.vertical, 6)
                }
                HStack {
                    ctl("shuffle", on: center.shuffle) { center.shuffle.toggle() }
                    Spacer()
                    ctl("backward.end.fill", on: false, size: 22) { center.step(-1) }
                    Spacer()
                    Button { center.toggle() } label: {
                        Circle().fill(Theme.accentGrad).frame(width: 60, height: 60)
                            .overlay(Image(systemName: center.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 26, weight: .bold)).foregroundStyle(.white))
                    }
                    Spacer()
                    ctl("forward.end.fill", on: false, size: 22) { center.step(1) }
                    Spacer()
                    ctl(center.repeatOne ? "repeat.1" : "repeat", on: center.repeatOne) { center.repeatOne.toggle() }
                }
                .padding(.top, 10).padding(.horizontal, 8)
            }
            .padding(EdgeInsets(top: 12, leading: 16, bottom: 14, trailing: 16))
        }
        .background(Theme.bg)
    }

    private var ratio: CGFloat {
        center.duration > 0 ? CGFloat(min(1, center.position / center.duration)) : 0
    }

    private func ctl(_ name: String, on: Bool, size: CGFloat = 20, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name).font(.system(size: size, weight: .semibold))
                .foregroundStyle(on ? Theme.accent : Theme.text)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
    }
}

/// 封面：有图用图，没有用渐变 + 音符；播放中缓慢旋转
struct MusicCover: View {
    let track: MusicTrackModel
    let size: CGFloat
    let spinning: Bool
    var round: Bool = true
    @State private var angle: Double = 0

    var body: some View {
        // 圆角 = 边长一半即圆形，避免 iOS 16 才有的 AnyShape
        let shape = RoundedRectangle(cornerRadius: round ? size / 2 : 10)
        ZStack {
            shape.fill(LinearGradient(colors: [Color(red: 0.48, green: 0.36, blue: 1), Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
            if let c = track.cover, !c.isEmpty {
                RemoteImage(url: c)
            } else {
                Image(systemName: "music.note").font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .rotationEffect(.degrees(angle))
        .onAppear { if spinning { spin() } }
        .onChange(of: spinning) { on in
            if on { spin() } else { withAnimation(.linear(duration: 0.2)) { angle = angle.truncatingRemainder(dividingBy: 360) } }
        }
    }

    private func spin() {
        angle = angle.truncatingRemainder(dividingBy: 360)
        withAnimation(.linear(duration: 8).repeatForever(autoreverses: false)) { angle += 360 }
    }
}

/// 正在播放的三根跳动小条
struct PlayingBars: View {
    @State private var on = false
    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1).fill(Theme.accent)
                    .frame(width: 3, height: on ? [12, 5, 9][i] : [4, 12, 6][i])
                    .animation(.easeInOut(duration: 0.45 + Double(i) * 0.08).repeatForever(autoreverses: true), value: on)
            }
        }
        .frame(height: 12)
        .onAppear { on = true }
    }
}

private func fmtDur(_ s: Double) -> String {
    let v = Int(max(0, s.isFinite ? s : 0))
    return v >= 3600 ? String(format: "%d:%02d:%02d", v / 3600, (v % 3600) / 60, v % 60) : String(format: "%d:%02d", v / 60, v % 60)
}

private func fmtSize(_ b: Int) -> String {
    b >= 1_048_576 ? String(format: "%.1f MB", Double(b) / 1_048_576) : "\(b / 1024) KB"
}
