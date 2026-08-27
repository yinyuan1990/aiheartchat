import AVFoundation
import Combine
import Foundation
import SwiftUI
import UIKit
import UserNotifications
import WebRTC

struct CallConfig: Codable {
    var width = 640
    var height = 480
    var fps = 30
    var bitrate = 800
    var srsServer = ""
    var whipUrl = ""
    var whepUrl = ""
}

struct CallerBrief: Codable {
    let id: String
    let nickname: String
    let avatar: String
}

enum CallPhase: Equatable {
    case idle
    /// 主叫等待接听
    case outgoing(callId: String, peerId: String, type: Int)
    /// 被叫收到邀请
    case incoming(callId: String, callerId: String, callerName: String, type: Int)
    /// 通话中
    case active(callId: String, peerId: String, type: Int)
}

/**
 * 一对一通话管理：信令走后端 REST + IM WS，媒体走 SRS WebRTC。
 * 双方各推一路流（WHIP）拉对方一路流（WHEP），流名 live/{callId}_{userId}。
 * 通话 UI 由独立 UIWindow 承载（CallWindow），保证盖在任何弹层之上。
 */
/// 通话日志缓冲：独立于主 actor，NSLock 保证线程安全（WebRTC 回调线程也会写）
private enum CallLogStore {
    static var buf: [String] = []
    static var callId: String?
    static var flushScheduled = false
    static let lock = NSLock()
    static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}

@MainActor
final class CallManager: ObservableObject {
    static let shared = CallManager()

    @Published var phase: CallPhase = .idle { didSet { CallWindow.shared.update() } }
    @Published var localVideoTrack: RTCVideoTrack?
    @Published var remoteVideoTrack: RTCVideoTrack?
    /// 呼叫失败提示（对方不在线等），UI 展示后置空
    @Published var errorMsg: String? { didSet { CallWindow.shared.update() } }

    /// 视频通话结束后男方待评分（挂断后弹评分界面）
    struct PendingRate {
        let callId: String
        let peerId: String
        let peerName: String
        let peerAvatar: String
    }
    @Published var pendingRate: PendingRate? { didSet { CallWindow.shared.update() } }

    /// 评分完成后要打开的女方主页 userId（RootView 监听后全屏展示并清空）
    @Published var openUserHome: String?

    /// 对方已完成推流（published 信令）：收到后才订阅，保证订阅晚于发布
    private var peerPublished = false

    // 对方信息（微信式界面展示）
    @Published var peerName = ""
    @Published var peerAvatar = ""
    // 通话控制状态
    @Published var muted = false
    @Published var speakerOn = false
    @Published var cameraOff = false
    @Published var callSeconds = 0

    private var config = CallConfig()
    private var myUserId = ""
    private var myGender = 0
    private var factory: RTCPeerConnectionFactory?
    private var pushPc: RTCPeerConnection?
    private var pullPc: RTCPeerConnection?
    private var capturer: RTCCameraVideoCapturer?
    private var localAudioTrack: RTCAudioTrack?
    private var cameraPosition: AVCaptureDevice.Position = .front
    private var timer: Timer?
    private let pullDelegate = PullPcDelegate(tag: "pull")
    private let pushDelegate = PullPcDelegate(tag: "push")

    // ---- 通话日志：本地打印（Xcode 控制台过滤 PeiwanCall）+ 缓冲上报服务器（后台按 callId 汇总排查） ----
    // nonisolated：WebRTC 回调在后台线程直接调用，线程安全由 CallLogStore 的锁保证，与主 actor 无关

    nonisolated static func clog(_ s: String) {
        NSLog("[PeiwanCall] %@", s)
        CallLogStore.lock.lock()
        CallLogStore.buf.append("\(CallLogStore.timeFmt.string(from: Date())) \(s)")
        if CallLogStore.buf.count > 500 { CallLogStore.buf.removeFirst(CallLogStore.buf.count - 500) }
        CallLogStore.lock.unlock()
        scheduleLogFlush()
    }

    /// 当前绑定的通话 callId（加锁读取）
    nonisolated static var currentLogCallId: String? {
        CallLogStore.lock.lock()
        defer { CallLogStore.lock.unlock() }
        return CallLogStore.callId
    }

    /// 关联当前 callId（callId 已知后才能上报，之前的日志一并带上）
    nonisolated static func bindLogCall(_ callId: String) {
        CallLogStore.lock.lock()
        CallLogStore.callId = callId
        CallLogStore.lock.unlock()
        scheduleLogFlush()
    }

    private nonisolated static func scheduleLogFlush() {
        CallLogStore.lock.lock()
        if CallLogStore.flushScheduled { CallLogStore.lock.unlock(); return }
        CallLogStore.flushScheduled = true
        CallLogStore.lock.unlock()
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            CallLogStore.lock.lock()
            CallLogStore.flushScheduled = false
            CallLogStore.lock.unlock()
            await flushLogs()
        }
    }

    nonisolated static func flushLogs() async {
        CallLogStore.lock.lock()
        guard let callId = CallLogStore.callId, !CallLogStore.buf.isEmpty else { CallLogStore.lock.unlock(); return }
        let lines = CallLogStore.buf
        CallLogStore.buf.removeAll()
        CallLogStore.lock.unlock()
        struct OkResp: Decodable { let ok: Bool? }
        let _: OkResp? = try? await Api.request("/call/log", method: "POST", body: [
            "callId": callId,
            "platform": "ios",
            "lines": lines,
        ])
    }

    /// 登录后调用一次：监听 WS 通话信令
    func start(userId: String, gender: Int = 0) {
        myUserId = userId
        myGender = gender
        // 来电通知权限（后台来电经本地通知提醒）
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        if factory == nil {
            RTCInitializeSSL()
            factory = RTCPeerConnectionFactory(
                encoderFactory: RTCDefaultVideoEncoderFactory(),
                decoderFactory: RTCDefaultVideoDecoderFactory()
            )
        }
        WsClient.shared.addListener { [weak self] frame in
            guard frame["op"] as? String == "call",
                  let event = frame["event"] as? String,
                  let data = frame["data"] as? [String: Any] else { return }
            self?.onSignal(event: event, data: data)
        }
    }

    private func onSignal(event: String, data: [String: Any]) {
        switch event {
        case "invite":
            guard phase == .idle,
                  let callId = data["callId"] as? String,
                  let type = (data["type"] as? Int) ?? Int(data["type"] as? String ?? ""),
                  let caller = data["caller"] as? [String: Any] else { return }
            if let cfg = data["config"] as? [String: Any],
               let json = try? JSONSerialization.data(withJSONObject: cfg),
               let parsed = try? JSONDecoder().decode(CallConfig.self, from: json) {
                config = parsed
            }
            peerName = (caller["nickname"] as? String) ?? ""
            peerAvatar = (caller["avatar"] as? String) ?? ""
            peerPublished = false
            Self.bindLogCall(callId)
            Self.clog("signal invite received type=\(type) callId=\(callId)")
            phase = .incoming(
                callId: callId,
                callerId: (caller["id"] as? String) ?? "",
                callerName: peerName,
                type: type
            )
            notifyIncomingCallIfBackground(type: type)
        case "accept":
            if case let .outgoing(callId, peerId, type) = phase {
                phase = .active(callId: callId, peerId: peerId, type: type)
                startTimer()
                Task { await startMedia(callId: callId, peerId: peerId, type: type) }
            }
        case "published":
            if let callId = data["callId"] as? String, callId == Self.currentLogCallId {
                Self.clog("signal peer published")
                peerPublished = true
            }
        case "reject", "cancel", "end":
            // 服务端强制挂断（积分不足/连接中断）会带 reason，展示给用户
            if let reason = data["reason"] as? String, !reason.isEmpty {
                Self.clog("call force-ended by server: \(reason)")
                errorMsg = reason
            }
            teardown()
        default:
            break
        }
    }

    // MARK: - 操作

    func startCall(calleeId: String, type: Int, name: String = "", avatar: String = "") {
        peerName = name
        peerAvatar = avatar
        Task {
            // 视频通话本地预检：余额不够 1 分钟直接提示，不发起呼叫（服务端仍有权威校验兜底）
            if type == 2 {
                struct WalletResp: Codable { var balance: String? }
                struct PeerPrice: Codable { var videoPriceActualFen: Int? }
                let wallet: WalletResp? = try? await Api.request("/wallet")
                let peer: PeerPrice? = try? await Api.request("/user/\(calleeId)")
                if let balStr = wallet?.balance, let balance = Int(balStr),
                   let price = peer?.videoPriceActualFen, price > 0, balance < price {
                    Self.clog("local precheck insufficient: balance=\(balance) price/min=\(price)")
                    errorMsg = "积分不足，视频通话需 \(fmtPoints(String(price))) 积分/分钟"
                    return
                }
            }
            // 头像缺失时补拉对方资料（微信式界面需要展示）
            if avatar.isEmpty {
                struct Brief: Codable { var nickname: String? = ""; var avatar: String? = "" }
                if let p: Brief = try? await Api.request("/user/\(calleeId)") {
                    if peerName.isEmpty { peerName = p.nickname ?? "" }
                    peerAvatar = p.avatar ?? ""
                }
            }
            do {
                struct InviteResp: Decodable {
                    let callId: String
                    let config: CallConfig
                }
                let resp: InviteResp = try await Api.request("/call/invite", method: "POST", body: [
                    "calleeId": calleeId,
                    "type": type,
                ])
                config = resp.config
                peerPublished = false
                Self.bindLogCall(resp.callId)
                Self.clog("invite sent type=\(type) callId=\(resp.callId)")
                phase = .outgoing(callId: resp.callId, peerId: calleeId, type: type)
            } catch {
                errorMsg = error.localizedDescription
                teardown()
            }
        }
    }

    func accept() {
        guard case let .incoming(callId, callerId, _, type) = phase else { return }
        removeCallNotification()
        Task {
            do {
                struct AcceptResp: Decodable {
                    let callId: String
                    let config: CallConfig
                }
                let resp: AcceptResp = try await Api.request("/call/\(callId)/accept", method: "POST")
                config = resp.config
                phase = .active(callId: callId, peerId: callerId, type: type)
                startTimer()
                await startMedia(callId: callId, peerId: callerId, type: type)
            } catch {
                errorMsg = error.localizedDescription
                teardown()
            }
        }
    }

    func reject() {
        guard case let .incoming(callId, _, _, _) = phase else { return }
        Task {
            struct OkResp: Decodable { let ok: Bool }
            let _: OkResp? = try? await Api.request("/call/\(callId)/reject", method: "POST")
            teardown()
        }
    }

    func hangup() {
        let (callId, path): (String?, String) = {
            switch phase {
            case let .outgoing(id, _, _): return (id, "cancel")
            case let .active(id, _, _): return (id, "end")
            default: return (nil, "")
            }
        }()
        Task {
            if let callId {
                struct AnyResp: Decodable {}
                let _: AnyResp? = try? await Api.request("/call/\(callId)/\(path)", method: "POST")
            }
            teardown()
        }
    }

    // MARK: - 通话控制（微信式）

    func toggleMute() {
        muted.toggle()
        localAudioTrack?.isEnabled = !muted
    }

    func toggleSpeaker() {
        speakerOn.toggle()
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(speakerOn ? .speaker : .none)
    }

    /** 关闭/打开自己的画面（声音不受影响，对方看到黑屏） */
    func toggleCameraOff() {
        cameraOff.toggle()
        localVideoTrack?.isEnabled = !cameraOff
    }

    func switchCamera() {
        guard let capturer else { return }
        cameraPosition = cameraPosition == .front ? .back : .front
        guard let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == cameraPosition }) else { return }
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        if let format = formats.min(by: { dimensionDiff($0) < dimensionDiff($1) }) {
            capturer.startCapture(with: device, format: format, fps: config.fps)
        }
    }

    /// App 在后台时用本地通知提醒来电（点通知回前台即见来电界面）
    private func notifyIncomingCallIfBackground(type: Int) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState != .active else { return }
            let content = UNMutableNotificationContent()
            content.title = self.peerName.isEmpty ? "来电" : self.peerName
            content.body = type == 2 ? "邀请你进行视频通话" : "邀请你进行语音通话"
            content.sound = .defaultRingtone
            content.interruptionLevel = .timeSensitive
            let req = UNNotificationRequest(identifier: "incoming_call", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }
    }

    private func removeCallNotification() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["incoming_call"])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["incoming_call"])
    }

    private func startTimer() {
        callSeconds = 0
        DispatchQueue.main.async { [weak self] in
            self?.timer?.invalidate()
            self?.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                guard let self else { return }
                self.callSeconds += 1
                // 每 5 秒上报 RTP 统计：定位"无画面"是发送端没出帧还是接收端没收到帧
                if self.callSeconds % 5 == 0 { self.logStats() }
            }
        }
    }

    /// 双端 RTP 统计打点：push 看编码/发送，pull 看接收/解码
    private func logStats() {
        pushPc?.statistics { report in
            let parts = report.statistics.values.filter { $0.type == "outbound-rtp" }.map { s -> String in
                let v = s.values
                return "\(v["kind"] ?? "?" as NSObject): bytesSent=\(v["bytesSent"] ?? 0 as NSObject) pktsSent=\(v["packetsSent"] ?? 0 as NSObject) framesEncoded=\(v["framesEncoded"] ?? 0 as NSObject) fps=\(v["framesPerSecond"] ?? 0 as NSObject)"
            }
            if !parts.isEmpty { Self.clog("stats push \(parts.joined(separator: " | "))") }
        }
        pullPc?.statistics { report in
            let parts = report.statistics.values.filter { $0.type == "inbound-rtp" }.map { s -> String in
                let v = s.values
                return "\(v["kind"] ?? "?" as NSObject): bytesRecv=\(v["bytesReceived"] ?? 0 as NSObject) pktsRecv=\(v["packetsReceived"] ?? 0 as NSObject) framesRecv=\(v["framesReceived"] ?? 0 as NSObject) framesDecoded=\(v["framesDecoded"] ?? 0 as NSObject) fps=\(v["framesPerSecond"] ?? 0 as NSObject)"
            }
            if !parts.isEmpty { Self.clog("stats pull \(parts.joined(separator: " | "))") }
        }
    }

    // MARK: - 媒体

    private func startMedia(callId: String, peerId: String, type: Int) async {
        guard let factory else { return }
        do {
            Self.clog("startMedia begin type=\(type) callId=\(callId) peerId=\(peerId)")
            // 后台接听（点通知进来）时等待回到前台再初始化音频，否则麦克风会静默启动失败
            for _ in 0..<20 {
                let active = await MainActor.run { UIApplication.shared.applicationState == .active }
                if active { break }
                Self.clog("waiting foreground...")
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            // 通话期间暂停无声保活，避免音频会话冲突（通话音频本身可后台保活）
            SilentAudioKeeper.shared.stop()
            // 必须走 WebRTC 的 RTCAudioSession 配置（直接用 AVAudioSession 会绕过
            // WebRTC 会话管理，导致录音单元静默不启动 → 对方听不到声音）
            let rtcSession = RTCAudioSession.sharedInstance()
            rtcSession.lockForConfiguration()
            do {
                if type == 2 {
                    try rtcSession.setCategory(AVAudioSession.Category.playAndRecord, mode: AVAudioSession.Mode.videoChat, options: [.defaultToSpeaker])
                    speakerOn = true
                } else {
                    try rtcSession.setCategory(AVAudioSession.Category.playAndRecord, mode: AVAudioSession.Mode.voiceChat, options: [])
                    speakerOn = false
                }
                try rtcSession.setActive(true)
                Self.clog("rtc audio session ok, micPermission=\(AVAudioSession.sharedInstance().recordPermission.rawValue)")
            } catch {
                Self.clog("rtc audio session ERROR: \(error)")
            }
            rtcSession.unlockForConfiguration()

            let rtcConfig = RTCConfiguration()
            rtcConfig.sdpSemantics = .unifiedPlan
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

            // 推流
            let push = factory.peerConnection(with: rtcConfig, constraints: constraints, delegate: pushDelegate)!
            let audioTrack = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "audio0")
            localAudioTrack = audioTrack
            let audioInit = RTCRtpTransceiverInit()
            audioInit.direction = .sendOnly
            push.addTransceiver(with: audioTrack, init: audioInit)

            if type == 2 {
                let videoSource = factory.videoSource()
                let capturer = RTCCameraVideoCapturer(delegate: videoSource)
                self.capturer = capturer
                let videoTrack = factory.videoTrack(with: videoSource, trackId: "video0")
                localVideoTrack = videoTrack
                // 男方默认关闭自己画面（我的页可改默认），女方始终默认开启
                if myGender == 1 && !UserDefaults.standard.bool(forKey: "camDefaultOn") {
                    cameraOff = true
                    videoTrack.isEnabled = false
                    Self.clog("male camera default OFF")
                }
                let videoInit = RTCRtpTransceiverInit()
                videoInit.direction = .sendOnly
                let transceiver = push.addTransceiver(with: videoTrack, init: videoInit)

                // 码率后台可调
                if let sender = transceiver?.sender {
                    let params = sender.parameters
                    params.encodings.forEach { $0.maxBitrateBps = NSNumber(value: config.bitrate * 1000) }
                    sender.parameters = params
                }

                cameraPosition = .front
                if let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }) {
                    let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
                    let target = formats.min(by: { dimensionDiff($0) < dimensionDiff($1) })
                    if let format = target {
                        // fps 不能超过所选格式支持的上限，否则采集会启动失败（不出帧）
                        let maxFps = format.videoSupportedFrameRateRanges.map { Int($0.maxFrameRate) }.max() ?? config.fps
                        let fps = min(config.fps, maxFps)
                        let dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                        try await capturer.startCapture(with: device, format: format, fps: fps)
                        Self.clog("capture started \(dim.width)x\(dim.height)@\(fps) (maxFps=\(maxFps))")
                    } else {
                        Self.clog("capture ERROR: no supported format")
                    }
                } else {
                    Self.clog("capture ERROR: no front camera device")
                }
            }
            pushPc = push

            let pushOffer = try await push.offer(for: constraints)
            try await push.setLocalDescription(pushOffer)
            // 推流带重试（网络抖动/SRS 短暂不可用）
            var pushAnswer: String?
            for attempt in 0..<3 {
                do {
                    pushAnswer = try await WhipClient.exchangeSdp(endpoint: config.whipUrl, stream: "\(callId)_\(myUserId)", offerSdp: pushOffer.sdp)
                    Self.clog("push whip ok attempt=\(attempt)")
                    break
                } catch {
                    Self.clog("push whip FAIL attempt=\(attempt): \(error.localizedDescription)")
                }
                if attempt < 2 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            }
            guard let pushAnswerSdp = pushAnswer else { throw ApiError(code: -1, msg: "推流失败") }
            try await push.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: pushAnswerSdp))
            Self.clog("push setRemote ok")

            // 通知对方"我已推流"（经信令长连接），对方收到后才订阅我的流
            struct OkResp: Decodable { let ok: Bool? }
            let notified: OkResp? = try? await Api.request("/call/\(callId)/published", method: "POST")
            if notified == nil { Self.clog("published notify FAIL") }

            // 等对方推流完成再订阅（10 秒超时兜底直接订阅，配合零流量看门狗）
            var waitedMs = 0
            while !peerPublished && waitedMs < 10_000 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                waitedMs += 100
            }
            Self.clog("peer published=\(peerPublished), subscribing")

            // 拉流：对方的音视频
            try await setupPull(callId: callId, peerId: peerId, type: type)
            Self.clog("media setup complete")
            // SRS 会接受"发布者还没推流"时的 WHEP 订阅（ICE 也能通）但之后永远不给这个订阅者转发 RTP，
            // 导致概率性无画面/无声音（谁先订阅谁黑屏）。看门狗检测零流量并重新订阅。
            startPullWatchdog(callId: callId, peerId: peerId, type: type)
        } catch {
            Self.clog("startMedia ERROR: \(error)")
            errorMsg = "媒体连接失败，请重试"
            hangup()
        }
    }

    /// 建立（或重建）拉流连接并完成 WHEP 订阅；远端轨道通过 delegate 的 didAdd receiver 回调获取
    private func setupPull(callId: String, peerId: String, type: Int) async throws {
        guard let factory else { return }
        pullPc?.close()
        remoteVideoTrack = nil
        let rtcConfig = RTCConfiguration()
        rtcConfig.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let pull = factory.peerConnection(with: rtcConfig, constraints: constraints, delegate: pullDelegate)!
        let recvAudio = RTCRtpTransceiverInit()
        recvAudio.direction = .recvOnly
        pull.addTransceiver(of: .audio, init: recvAudio)
        if type == 2 {
            let recvVideo = RTCRtpTransceiverInit()
            recvVideo.direction = .recvOnly
            let t = pull.addTransceiver(of: .video, init: recvVideo)
            // 初始占位，delegate 回调到达后会覆盖为真实轨道
            remoteVideoTrack = t?.receiver.track as? RTCVideoTrack
        }
        pullPc = pull

        let pullOffer = try await pull.offer(for: constraints)
        try await pull.setLocalDescription(pullOffer)
        // 对方可能尚未推流完成（accept 后双方并行建流），拉流失败时重试
        var pullAnswer: String?
        for attempt in 0..<10 {
            do {
                pullAnswer = try await WhipClient.exchangeSdp(endpoint: config.whepUrl, stream: "\(callId)_\(peerId)", offerSdp: pullOffer.sdp)
                Self.clog("pull whep ok attempt=\(attempt)")
                break
            } catch {
                Self.clog("pull whep FAIL attempt=\(attempt): \(error.localizedDescription)")
            }
            if attempt < 9 { try? await Task.sleep(nanoseconds: 1_500_000_000) }
        }
        guard let answer = pullAnswer else { throw ApiError(code: -1, msg: "拉流失败") }
        try await pull.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer))
        Self.clog("pull setRemote ok")
    }

    private var pullWatchTask: Task<Void, Never>?

    /// 拉流零流量看门狗：订阅后 4 秒仍一个字节没收到则重新 WHEP 订阅（最多 4 次）
    private func startPullWatchdog(callId: String, peerId: String, type: Int) {
        pullWatchTask?.cancel()
        pullWatchTask = Task { [weak self] in
            var resubs = 0
            while resubs < 4, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let self, !Task.isCancelled, case .active = self.phase, let pc = self.pullPc else { return }
                let bytes = await self.pullBytesReceived(pc)
                if bytes > 0 {
                    Self.clog("pull media flowing bytes=\(bytes)")
                    return
                }
                resubs += 1
                Self.clog("pull NO media, resubscribe #\(resubs)")
                do {
                    try await self.setupPull(callId: callId, peerId: peerId, type: type)
                } catch {
                    Self.clog("resubscribe FAIL: \(error.localizedDescription)")
                }
            }
        }
    }

    private func pullBytesReceived(_ pc: RTCPeerConnection) async -> Int64 {
        await withCheckedContinuation { cont in
            pc.statistics { report in
                let total = report.statistics.values.filter { $0.type == "inbound-rtp" }
                    .compactMap { ($0.values["bytesReceived"] as? NSNumber)?.int64Value }
                    .reduce(0, +)
                cont.resume(returning: total)
            }
        }
    }

    private func dimensionDiff(_ format: AVCaptureDevice.Format) -> Int {
        let dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return abs(Int(dim.width) - config.width) + abs(Int(dim.height) - config.height)
    }

    private func teardown() {
        // 男方视频通话接通后挂断 → 弹评分界面（在状态重置前捕获）
        if case let .active(callId, peerId, type) = phase, type == 2,
           myGender == 1, callSeconds > 0 {
            pendingRate = PendingRate(callId: callId, peerId: peerId, peerName: peerName, peerAvatar: peerAvatar)
        }
        removeCallNotification()
        pullWatchTask?.cancel()
        pullWatchTask = nil
        timer?.invalidate()
        timer = nil
        callSeconds = 0
        muted = false
        speakerOn = false
        cameraOff = false
        if let capturer {
            Task { await capturer.stopCapture() }
        }
        capturer = nil
        pushPc?.close()
        pushPc = nil
        pullPc?.close()
        pullPc = nil
        localVideoTrack = nil
        remoteVideoTrack = nil
        localAudioTrack = nil
        peerPublished = false
        phase = .idle
        // 通话结束恢复无声保活
        SilentAudioKeeper.shared.start()
        // 挂断后把剩余日志立即冲刷上报（保留 callId 以便补传）
        Self.clog("teardown done")
        Task { await Self.flushLogs() }
    }
}

/// SRS WHIP/WHEP 信令：POST offer SDP，返回 answer SDP
enum WhipClient {
    static func exchangeSdp(endpoint: String, stream: String, offerSdp: String) async throws -> String {
        guard let url = URL(string: "\(endpoint)?app=live&stream=\(stream)") else {
            throw ApiError(code: -1, msg: "SRS 地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        req.httpBody = offerSdp.data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300,
              let sdp = String(data: data, encoding: .utf8), !sdp.isEmpty else {
            throw ApiError(code: -1, msg: "SRS 信令失败")
        }
        // SRS 在流未就绪等情况下会返回 200 + JSON 错误体，必须校验是合法 SDP
        guard sdp.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("v=0") else {
            throw ApiError(code: -1, msg: "SRS 返回非 SDP 应答")
        }
        return sdp
    }
}

/// 拉流/推流连接代理：远端轨道到达 + ICE 状态日志
final class PullPcDelegate: NSObject, RTCPeerConnectionDelegate {
    private let tag: String
    init(tag: String) { self.tag = tag }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        CallManager.clog("\(tag) didAdd receiver kind=\(rtpReceiver.track?.kind ?? "nil")")
        if tag == "pull", let track = rtpReceiver.track as? RTCVideoTrack {
            DispatchQueue.main.async {
                CallManager.shared.remoteVideoTrack = track
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let names = ["new", "checking", "connected", "completed", "failed", "disconnected", "closed", "count"]
        let name = newState.rawValue < names.count ? names[newState.rawValue] : "\(newState.rawValue)"
        CallManager.clog("\(tag) ICE state=\(name)")
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// 空闲时点击穿透（仅显示错误 toast 时不挡操作）；评分界面（挂断后 phase 已是 idle）需要接收触摸
private final class PassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        let manager = CallManager.shared
        return (manager.phase == .idle && manager.pendingRate == nil) ? nil : view
    }
}

/// 通话悬浮窗：独立 UIWindow，永远盖在所有页面（含 fullScreenCover）之上
final class CallWindow {
    static let shared = CallWindow()
    private var window: UIWindow?

    func update() {
        DispatchQueue.main.async {
            let manager = CallManager.shared
            let needShow = manager.phase != .idle || manager.errorMsg != nil || manager.pendingRate != nil
            if needShow {
                if self.window == nil {
                    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
                    let w = PassthroughWindow(windowScene: scene)
                    let host = UIHostingController(rootView: CallOverlay())
                    host.view.backgroundColor = .clear
                    w.rootViewController = host
                    w.windowLevel = .alert + 1
                    w.isHidden = false
                    self.window = w
                }
            } else {
                self.window?.isHidden = true
                self.window = nil
            }
        }
    }
}
