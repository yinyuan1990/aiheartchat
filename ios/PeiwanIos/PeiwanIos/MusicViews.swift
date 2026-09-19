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
 */
final class MusicCenter: ObservableObject {
    static let shared = MusicCenter()

    @Published private(set) var current: MusicTrackModel?
    @Published private(set) var isPlaying = false
    @Published private(set) var buffering = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    private(set) var queue: [MusicTrackModel] = []

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusCancellable: AnyCancellable?
    private var counted = Set<String>()
    private var remoteReady = false

    func setQueue(_ list: [MusicTrackModel]) { queue = list }

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
            self?.step(1)
        }
        statusCancellable = p.publisher(for: \.timeControlStatus).receive(on: DispatchQueue.main).sink { [weak self] s in
            self?.isPlaying = s == .playing
            self?.buffering = s == .waitingToPlayAtSpecifiedRate
        }
        p.play()
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
        if isPlaying { p.pause() } else { p.play() }
    }

    func step(_ delta: Int) {
        guard !queue.isEmpty else { return }
        let idx = queue.firstIndex { $0.id == current?.id } ?? -1
        let next = idx < 0 ? 0 : ((idx + delta) % queue.count + queue.count) % queue.count
        play(queue[next])
    }

    func pause() { player?.pause() }

    func seek(ratio: Double) {
        guard duration > 0 else { return }
        player?.seek(to: CMTime(seconds: max(0, min(1, ratio)) * duration, preferredTimescale: 600))
    }

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
            MPMediaItemPropertyArtist: t.performer ?? "",
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        if let c = t.cover, !c.isEmpty, let img = RemoteImageCache.cache.object(forKey: Api.fullUrl(c) as NSString) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

/// 音乐页（消息页「私聊」tab 置顶入口）：列表 + 底部常驻播放器
struct MusicView: View {
    @StateObject private var center = MusicCenter.shared
    @State private var data: MusicListModel?

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                if let d = data {
                    if d.list.isEmpty {
                        EmptyHint(text: "最近 3 天还没有新歌\n稍后再来看看")
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                Text("只保留最近 3 天 · 共 \(d.list.count) 首")
                                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 2)
                                ForEach(d.list) { t in
                                    Button { center.play(t) } label: { row(t) }
                                        .buttonStyle(.plain)
                                }
                                if center.current != nil { Color.clear.frame(height: 92) }
                            }
                        }
                        .refreshable { await load() }
                    }
                } else {
                    EmptyHint(text: "加载中…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let t = center.current {
                MusicPlayerBar(track: t, subtitle: (t.performer?.isEmpty == false ? t.performer : data?.source?.title) ?? "")
                    .environmentObject(center)
            }
        }
        .fullBg()
        .navigationTitle(data?.source?.title.flatMap { $0.isEmpty ? nil : $0 } ?? "音乐")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func row(_ t: MusicTrackModel) -> some View {
        let active = center.current?.id == t.id
        let playing = active && center.isPlaying
        return HStack(spacing: 12) {
            MusicCover(track: t, size: 52, spinning: playing)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(t.title)
                        .font(.system(size: 15, weight: active ? .semibold : .regular))
                        .foregroundStyle(active ? Theme.accent : Theme.text)
                        .lineLimit(1)
                    if playing { PlayingBars() }
                }
                HStack(spacing: 8) {
                    if let p = t.performer, !p.isEmpty {
                        Text(p).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    Text(fmtDur(Double(t.duration ?? 0)))
                    Text(fmtSize(t.size ?? 0))
                    Text(timeAgo(t.postedAt))
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

    private func load() async {
        if let d: MusicListModel = try? await Api.request("/music") {
            data = d
            center.setQueue(d.list)
        } else if data == nil {
            data = MusicListModel(source: nil, list: [])
        }
    }
}

/// 底部播放器：进度（可拖）+ 上一首 / 播放暂停 / 下一首
struct MusicPlayerBar: View {
    let track: MusicTrackModel
    let subtitle: String
    @EnvironmentObject private var center: MusicCenter

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Theme.bg3).frame(height: 3)
                    Rectangle().fill(Theme.accentGrad)
                        .frame(width: geo.size.width * ratio, height: 3)
                }
                .frame(height: 14, alignment: .top)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onEnded { v in
                    center.seek(ratio: v.location.x / max(1, geo.size.width))
                })
            }
            .frame(height: 14)

            HStack(spacing: 12) {
                MusicCover(track: track, size: 44, spinning: center.isPlaying)
                VStack(alignment: .leading, spacing: 3) {
                    Text(track.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text("\(subtitle.isEmpty ? "" : subtitle + " · ")\(fmtDur(center.position)) / \(fmtDur(center.duration))\(center.buffering ? " · 缓冲中…" : "")")
                        .font(.system(size: 11)).foregroundStyle(Theme.textDim).lineLimit(1)
                }
                Spacer(minLength: 0)
                Button { center.step(-1) } label: {
                    Image(systemName: "backward.end.fill").font(.system(size: 16)).foregroundStyle(Theme.text).frame(width: 36, height: 36)
                }
                Button { center.toggle() } label: {
                    Circle().fill(Theme.accentGrad).frame(width: 42, height: 42)
                        .overlay(Image(systemName: center.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 18, weight: .bold)).foregroundStyle(.white))
                }
                Button { center.step(1) } label: {
                    Image(systemName: "forward.end.fill").font(.system(size: 16)).foregroundStyle(Theme.text).frame(width: 36, height: 36)
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 12)
        }
        .background(Theme.bg2.opacity(0.96))
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var ratio: CGFloat {
        center.duration > 0 ? CGFloat(min(1, center.position / center.duration)) : 0
    }
}

/// 封面：有图用图，没有用渐变圆 + 音符；播放中缓慢旋转
struct MusicCover: View {
    let track: MusicTrackModel
    let size: CGFloat
    let spinning: Bool
    @State private var angle: Double = 0

    var body: some View {
        ZStack {
            Circle().fill(LinearGradient(colors: [Color(red: 0.48, green: 0.36, blue: 1), Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
            if let c = track.cover, !c.isEmpty {
                RemoteImage(url: c)
            } else {
                Image(systemName: "music.note").font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
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
    return String(format: "%d:%02d", v / 60, v % 60)
}

private func fmtSize(_ b: Int) -> String {
    b >= 1_048_576 ? String(format: "%.1f MB", Double(b) / 1_048_576) : "\(b / 1024) KB"
}
