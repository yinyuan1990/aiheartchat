import AVKit
import SwiftUI

/// 全屏混合媒体查看器：图片双指缩放（ZoomableImage），视频原生 AVPlayer；左右翻页，滑到哪页播哪页。
/// 大厅 H5「养眼图片」点图 / 点视频经桥（type=viewMedia）走这里。
struct MediaViewerView: View {
    let items: [MediaItemModel]
    let initial: Int
    var onClose: () -> Void
    @State private var page: Int

    init(items: [MediaItemModel], initial: Int, onClose: @escaping () -> Void) {
        self.items = items
        self.initial = initial
        self.onClose = onClose
        _page = State(initialValue: min(max(0, initial), max(0, items.count - 1)))
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $page) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, it in
                    Group {
                        if it.type == "video", let u = URL(string: Api.fullUrl(it.url)) {
                            MediaVideoPage(url: u, active: page == idx)
                        } else {
                            ZoomableImage(url: Api.fullUrl(it.url))
                                .onTapGesture { onClose() }
                        }
                    }
                    .tag(idx)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: items.count > 1 ? .automatic : .never))
            .ignoresSafeArea()

            HStack {
                if items.count > 1 {
                    Text("\(page + 1) / \(items.count)").font(.system(size: 13)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                }
            }
            .overlay(alignment: .trailing) {
                Button { onClose() } label: {
                    Text("×").font(.system(size: 22)).foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(.white.opacity(0.15)))
                }
                .buttonStyle(.plain)
                .padding(.trailing, 16)
            }
            .padding(.top, 8)
        }
        .onAppear { MusicCenter.shared.pause() }
    }
}

/// 查看器里的视频页：当前页自动播、循环；滑走暂停；离开释放
private struct MediaVideoPage: View {
    let url: URL
    let active: Bool
    @State private var player: AVPlayer?
    @State private var looper: Any?

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
            } else {
                ProgressView().tint(.white)
            }
        }
        .onAppear {
            if player == nil {
                let p = AVPlayer(url: url)
                p.actionAtItemEnd = .none
                looper = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { _ in
                    p.seek(to: .zero); p.play()
                }
                player = p
            }
            if active { player?.play() }
        }
        .onChange(of: active) { on in on ? player?.play() : player?.pause() }
        .onDisappear {
            player?.pause()
            if let l = looper as? NSObjectProtocol { NotificationCenter.default.removeObserver(l) }
            player = nil
        }
    }
}
