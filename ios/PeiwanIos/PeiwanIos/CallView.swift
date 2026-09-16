import AVFoundation
import SwiftUI
import WebRTC

/// 通话全屏界面（微信式），由 CallWindow 独立窗口承载
struct CallOverlay: View {
    @ObservedObject private var manager = CallManager.shared

    var body: some View {
        ZStack {
            if manager.phase != .idle {
                content
            } else if let pending = manager.pendingRate {
                // 视频通话结束后男方评分界面
                CallRateView(pending: pending)
            }
            // 独立提示弹框（积分不足等）：盖在最上层，点「知道了」关闭
            if let alert = manager.alertMsg {
                ZStack {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    VStack(spacing: 16) {
                        Text("提示")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.text)
                        Text(alert)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textSub)
                            .multilineTextAlignment(.center)
                            .lineSpacing(5)
                        Button {
                            manager.alertMsg = nil
                        } label: {
                            Text("知道了")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Capsule().fill(Theme.accentGrad))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 4)
                    }
                    .padding(22)
                    .frame(width: 280)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.bg2))
                }
            }
        }
        .overlay(alignment: .top) {
            if let msg = manager.errorMsg {
                Text(msg)
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(Capsule().fill(Color.black.opacity(0.85)))
                    .padding(.top, 60)
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            manager.errorMsg = nil
                        }
                    }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            Color(red: 0.09, green: 0.10, blue: 0.12).ignoresSafeArea()

            switch manager.phase {
            case .idle:
                EmptyView()
            case let .outgoing(_, _, type):
                VStack {
                    Spacer().frame(height: 110)
                    peerHeader(status: type == 2 ? "正在等待对方接受视频通话邀请…" : "正在等待对方接受语音通话邀请…")
                    Spacer()
                    HStack {
                        Spacer()
                        circleButton(icon: "phone.down.fill", label: "取消", bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                            manager.hangup()
                        }
                        Spacer()
                    }
                    .padding(.bottom, 70)
                }
            case let .incoming(_, _, _, type):
                VStack {
                    Spacer().frame(height: 110)
                    peerHeader(status: type == 2 ? "邀请你进行视频通话" : "邀请你进行语音通话")
                    Spacer()
                    HStack {
                        Spacer()
                        circleButton(icon: "phone.down.fill", label: "拒绝", bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                            manager.reject()
                        }
                        Spacer()
                        circleButton(icon: "phone.fill", label: "接听", bg: Color(red: 0.05, green: 0.78, blue: 0.42)) {
                            requestPermissions(video: type == 2) { manager.accept() }
                        }
                        Spacer()
                    }
                    .padding(.bottom, 70)
                }
            case let .active(_, _, type):
                if type == 2 {
                    videoActive
                } else {
                    voiceActive
                }
            }
        }
    }

    // MARK: - 通话中

    private var voiceActive: some View {
        VStack {
            Spacer().frame(height: 110)
            peerHeader(status: timeText)
            Spacer()
            HStack {
                Spacer()
                circleButton(icon: manager.muted ? "mic.slash.fill" : "mic.fill", label: "静音",
                             bg: manager.muted ? .white : Color.white.opacity(0.2),
                             fg: manager.muted ? .black : .white) {
                    manager.toggleMute()
                }
                Spacer()
                circleButton(icon: "phone.down.fill", label: "挂断", bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                    manager.hangup()
                }
                Spacer()
                circleButton(icon: manager.speakerOn ? "speaker.wave.3.fill" : "speaker.fill", label: "免提",
                             bg: manager.speakerOn ? .white : Color.white.opacity(0.2),
                             fg: manager.speakerOn ? .black : .white) {
                    manager.toggleSpeaker()
                }
                Spacer()
            }
            .padding(.bottom, 70)
        }
    }

    /// 小窗交互状态：拖动移动 / 双击与大画面互换 / 「—」缩成小圆点、点小圆点还原
    @State private var swapped = false
    @State private var minimized = false
    @State private var smallPos: CGPoint?          // 小窗左上角（容器坐标），nil = 默认右上
    @State private var dragOffset: CGSize = .zero

    private var videoActive: some View {
        GeometryReader { geo in
            let winSize = minimized ? CGSize(width: 48, height: 48) : CGSize(width: 110, height: 150)
            let margin: CGFloat = 12, topMin: CGFloat = 96, bottomMin: CGFloat = 170
            let clamp: (CGPoint) -> CGPoint = { p in
                CGPoint(
                    x: min(max(p.x, margin), max(margin, geo.size.width - winSize.width - margin)),
                    y: min(max(p.y, topMin), max(topMin, geo.size.height - winSize.height - bottomMin))
                )
            }
            let base = clamp(smallPos ?? CGPoint(x: geo.size.width - 110 - margin, y: topMin + 4))
            let shown = clamp(CGPoint(x: base.x + dragOffset.width, y: base.y + dragOffset.height))

            ZStack(alignment: .topLeading) {
                RTCVideoViewRepresentable(track: swapped ? manager.localVideoTrack : manager.remoteVideoTrack, label: swapped ? "local(big)" : "remote")
                    .ignoresSafeArea()

                VStack {
                    Text(timeText)
                        .font(.system(size: 14)).foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(Capsule().fill(Color.black.opacity(0.4)))
                        .padding(.top, 60)
                    Spacer()
                    videoControls
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // 小窗
                Group {
                    if minimized {
                        Circle().fill(Color.black.opacity(0.55))
                            .overlay(Circle().stroke(Color.white.opacity(0.35), lineWidth: 1))
                            .overlay(Image(systemName: "video.fill").font(.system(size: 16)).foregroundStyle(.white))
                    } else {
                        RTCVideoViewRepresentable(track: swapped ? manager.remoteVideoTrack : manager.localVideoTrack, label: swapped ? "remote(small)" : "local")
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(alignment: .topTrailing) {
                                Button { minimized = true } label: {
                                    Rectangle().fill(.white).frame(width: 10, height: 2)
                                        .frame(width: 22, height: 22)
                                        .background(Circle().fill(Color.black.opacity(0.45)))
                                }
                                .buttonStyle(.plain)
                                .padding(5)
                            }
                            .overlay(alignment: .bottom) {
                                Text("双击切换").font(.system(size: 9)).foregroundStyle(.white.opacity(0.7))
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
                                    .padding(.bottom, 5)
                            }
                    }
                }
                .frame(width: winSize.width, height: winSize.height)
                .contentShape(Rectangle())
                .offset(x: shown.x, y: shown.y)
                .onTapGesture(count: 2) { if !minimized { swapped.toggle() } }
                .onTapGesture { if minimized { minimized = false } }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 4)
                        .onChanged { dragOffset = $0.translation }
                        .onEnded { v in
                            smallPos = clamp(CGPoint(x: base.x + v.translation.width, y: base.y + v.translation.height))
                            dragOffset = .zero
                        }
                )
                .animation(.easeOut(duration: 0.15), value: minimized)
            }
        }
        // 每次进入视频通话都恢复默认布局（CallOverlay 常驻，状态不会自动重置）
        .onAppear { swapped = false; minimized = false; smallPos = nil; dragOffset = .zero }
    }

    /// 视频通话底部按钮行
    private var videoControls: some View {
        HStack {
            Spacer()
            circleButton(icon: manager.muted ? "mic.slash.fill" : "mic.fill", label: "静音",
                         bg: manager.muted ? .white : Color.white.opacity(0.25),
                         fg: manager.muted ? .black : .white) {
                manager.toggleMute()
            }
            Spacer()
            circleButton(icon: manager.cameraOff ? "video.slash.fill" : "video.fill", label: "摄像头",
                         bg: manager.cameraOff ? .white : Color.white.opacity(0.25),
                         fg: manager.cameraOff ? .black : .white) {
                manager.toggleCameraOff()
            }
            Spacer()
            circleButton(icon: "phone.down.fill", label: "挂断", bg: Color(red: 0.98, green: 0.27, blue: 0.27)) {
                manager.hangup()
            }
            Spacer()
            circleButton(icon: "arrow.triangle.2.circlepath.camera.fill", label: "翻转",
                         bg: Color.white.opacity(0.25)) {
                manager.switchCamera()
            }
            Spacer()
        }
        .padding(.bottom, 70)
    }

    // MARK: - 组件

    private var timeText: String {
        String(format: "%02d:%02d", manager.callSeconds / 60, manager.callSeconds % 60)
    }

    private func peerHeader(status: String) -> some View {
        VStack(spacing: 14) {
            AvatarView(url: manager.peerAvatar, size: 96)
            Text(manager.peerName.isEmpty ? "对方" : manager.peerName)
                .font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
            Text(status)
                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.6))
        }
    }

    private func circleButton(icon: String, label: String, bg: Color, fg: Color = .white, action: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 24))
                    .foregroundStyle(fg)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(bg))
            }
            .buttonStyle(.plain)
            Text(label).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
        }
    }
}

/// 发起呼叫（含权限申请），type: 1=语音 2=视频
func startCallWithPermissions(calleeId: String, type: Int, name: String = "", avatar: String = "") {
    requestPermissions(video: type == 2) {
        // 权限回调在后台线程，显式切回主 actor 调用通话管理器
        Task { @MainActor in
            CallManager.shared.startCall(calleeId: calleeId, type: type, name: name, avatar: avatar)
        }
    }
}

private func requestPermissions(video: Bool, onGranted: @escaping () -> Void) {
    AVCaptureDevice.requestAccess(for: .audio) { audioOk in
        guard audioOk else {
            DispatchQueue.main.async { CallManager.shared.errorMsg = "需要麦克风权限，请在系统设置中开启" }
            return
        }
        if video {
            AVCaptureDevice.requestAccess(for: .video) { videoOk in
                guard videoOk else {
                    DispatchQueue.main.async { CallManager.shared.errorMsg = "需要摄像头权限，请在系统设置中开启" }
                    return
                }
                DispatchQueue.main.async(execute: onGranted)
            }
        } else {
            DispatchQueue.main.async(execute: onGranted)
        }
    }
}

/// 视频通话结束后男方评分界面：5 个维度各 0-100 分，平均分为最终得分
struct CallRateView: View {
    let pending: CallManager.PendingRate
    @State private var scores: [Double] = Array(repeating: 80, count: 5)
    @State private var busy = false

    private let dims = ["真实度", "配合度", "腿型", "曲线", "肤质"]

    var body: some View {
        ZStack {
            Color(red: 0.09, green: 0.10, blue: 0.12).ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer().frame(height: 70)
                AvatarView(url: pending.peerAvatar, size: 72)
                Text(pending.peerName.isEmpty ? "对方" : pending.peerName)
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                    .padding(.top, 10)
                Text("本次视频通话体验如何？")
                    .font(.system(size: 13)).foregroundStyle(.white.opacity(0.6))
                    .padding(.top, 4)

                VStack(spacing: 14) {
                    ForEach(dims.indices, id: \.self) { i in
                        HStack(spacing: 10) {
                            Text(dims[i])
                                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.85))
                                .frame(width: 92, alignment: .leading)
                            Slider(value: $scores[i], in: 0...100, step: 1)
                                .tint(Theme.accent)
                            Text("\(Int(scores[i]))")
                                .font(.system(size: 14, weight: .bold)).monospacedDigit()
                                .foregroundStyle(Theme.accent)
                                .frame(width: 34, alignment: .trailing)
                        }
                    }
                }
                .padding(.horizontal, 28).padding(.top, 26)

                Spacer()

                Button {
                    guard !busy else { return }
                    busy = true
                    Task {
                        struct RateOk: Codable { var ok: Bool?; var avg: Int? }
                        do {
                            let _: RateOk = try await Api.request("/call/rate", method: "POST", body: [
                                "callId": pending.callId,
                                "photo": Int(scores[0]),
                                "obedience": Int(scores[1]),
                                "legs": Int(scores[2]),
                                "chest": Int(scores[3]),
                                "skin": Int(scores[4]),
                            ])
                        } catch {}
                        CallManager.shared.pendingRate = nil
                        // 评分完成后留在女方个人主页
                        CallManager.shared.openUserHome = pending.peerId
                    }
                } label: {
                    Text(busy ? "提交中…" : "提交评分")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(Capsule().fill(Theme.accent))
                }
                .padding(.horizontal, 28)

                Button {
                    CallManager.shared.pendingRate = nil
                    // 跳过评分同样留在女方个人主页
                    CallManager.shared.openUserHome = pending.peerId
                } label: {
                    Text("跳过")
                        .font(.system(size: 14)).foregroundStyle(.white.opacity(0.5))
                        .padding(8)
                }
                .padding(.top, 8)
                Spacer().frame(height: 30)
            }
        }
    }
}

struct RTCVideoViewRepresentable: UIViewRepresentable {
    let track: RTCVideoTrack?
    var label: String = ""

    func makeCoordinator() -> Coordinator { Coordinator(label: label) }

    final class Coordinator: NSObject, RTCVideoViewDelegate {
        var boundTrack: RTCVideoTrack?
        private let label: String
        init(label: String) { self.label = label }

        // 首帧到达（或分辨率变化）时触发：确认解码帧真正送到了渲染器
        func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
            CallManager.clog("renderer[\(label)] frame size=\(Int(size.width))x\(Int(size.height))")
        }
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        // 轨道变化时重新绑定渲染器（先解绑旧轨道，避免重复/失效绑定）
        guard context.coordinator.boundTrack !== track else { return }
        context.coordinator.boundTrack?.remove(view)
        track?.add(view)
        context.coordinator.boundTrack = track
    }

    /// 小窗缩小 / 通话结束离开视图树时解绑轨道，避免渲染器一直挂在 track 上
    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.boundTrack?.remove(view)
        coordinator.boundTrack = nil
    }
}
