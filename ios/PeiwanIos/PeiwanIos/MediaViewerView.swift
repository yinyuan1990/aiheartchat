import AVKit
import SwiftUI

/// 全屏混合媒体查看器（像 Telegram / 抖音）：**上下滑切帖子**，**左右滑切同一帖里的多张图**；
/// 图片双指缩放（ZoomableImage），视频原生 AVPlayer，滑到哪个播哪个；点图片关闭。
/// 大厅 H5「养眼图片」点图 / 点视频经桥（type=viewMedia，groups/group/index）走这里。
struct MediaViewerView: View {
    let groups: [[MediaItemModel]]
    let initialGroup: Int
    let initialIndex: Int
    var onClose: () -> Void
    @State private var group: Int
    /// 每条帖子内当前第几张
    @State private var indexes: [Int]

    init(groups: [[MediaItemModel]], initialGroup: Int, initialIndex: Int, onClose: @escaping () -> Void) {
        let gs = groups.filter { !$0.isEmpty }
        self.groups = gs
        let g = min(max(0, initialGroup), max(0, gs.count - 1))
        self.initialGroup = g
        self.initialIndex = initialIndex
        self.onClose = onClose
        _group = State(initialValue: g)
        var idx = Array(repeating: 0, count: gs.count)
        if gs.indices.contains(g) { idx[g] = min(max(0, initialIndex), gs[g].count - 1) }
        _indexes = State(initialValue: idx)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                Color.black.ignoresSafeArea()
                // 竖向翻页：TabView 只有横向分页，整体旋转 90° 再把每页转回来（iOS 15 可用的标准做法）
                TabView(selection: $group) {
                    ForEach(Array(groups.enumerated()), id: \.offset) { g, items in
                        MediaGroupPage(
                            items: items,
                            index: Binding(get: { indexes[g] }, set: { indexes[g] = $0 }),
                            active: group == g,
                            onClose: onClose
                        )
                        .frame(width: geo.size.width, height: geo.size.height)
                        .rotationEffect(.degrees(90))
                        .tag(g)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .frame(width: geo.size.height, height: geo.size.width)
                .rotationEffect(.degrees(-90))
                .frame(width: geo.size.width, height: geo.size.height)

                HStack {
                    Text(counter).font(.system(size: 13)).foregroundStyle(.white).frame(maxWidth: .infinity)
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
        }
        .ignoresSafeArea()
        .onAppear { MusicCenter.shared.pause() }
    }

    private var counter: String {
        var s = ""
        if groups.count > 1 { s += "\(group + 1) / \(groups.count) 条" }
        let n = groups.indices.contains(group) ? groups[group].count : 0
        if n > 1 { s += (s.isEmpty ? "" : " · ") + "\(indexes[group] + 1) / \(n)" }
        return s
    }
}

/// 一条帖子：横向翻页看多张图 / 视频
private struct MediaGroupPage: View {
    let items: [MediaItemModel]
    @Binding var index: Int
    let active: Bool
    let onClose: () -> Void

    var body: some View {
        TabView(selection: $index) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                Group {
                    if it.type == "video", let u = URL(string: Api.fullUrl(it.url)) {
                        MediaVideoPage(url: u, active: active && index == i)
                    } else {
                        ZoomableImage(url: Api.fullUrl(it.url))
                            .onTapGesture { onClose() }
                    }
                }
                .tag(i)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: items.count > 1 ? .automatic : .never))
        .background(Color.black)
    }
}

/// 查看器里的视频页：滑到就播、循环；滑走暂停；离开释放
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
