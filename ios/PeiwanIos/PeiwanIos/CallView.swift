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

    private var videoActive: some View {
        ZStack {
            RTCVideoViewRepresentable(track: manager.remoteVideoTrack, label: "remote")
                .ignoresSafeArea()

            VStack {
                Text(timeText)
                    .font(.system(size: 14)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(Capsule().fill(Color.black.opacity(0.4)))
                    .padding(.top, 60)

                HStack {
                    Spacer()
                    RTCVideoViewRepresentable(track: manager.localVideoTrack, label: "local")
                        .frame(width: 110, height: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .padding(.trailing, 12)
                }
                .padding(.top, 8)

                Spacer()

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
        }
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
        CallManager.shared.startCall(calleeId: calleeId, type: type, name: name, avatar: avatar)
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
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.accent)
                                .frame(width: 34, alignment: .trailing)
                                .monospacedDigit()
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
}
