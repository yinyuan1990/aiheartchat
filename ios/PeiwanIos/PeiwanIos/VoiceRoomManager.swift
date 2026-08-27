import AVFoundation
import Combine
import Foundation
import WebRTC

/// 语音房成员
struct VRMember: Codable, Identifiable, Equatable {
    let id: String
    var nickname: String? = ""
    var avatar: String? = ""
    /// 静音状态（服务端同步，所有人可见）
    var muted: Bool? = false
}

/**
 * 群聊语音房：每人推一路音频（WHIP），拉房内其他成员的音频（WHEP），
 * 流名 vr_{groupId}_{userId}；成员变化由服务端经 IM WS 广播（op=vroom）。
 * 30 秒心跳保活席位，杀进程/断网 90 秒被服务端剔除。
 * 日志按房间场次上报服务器（管理端「通话日志-语音房」按场次汇总多端日志）。
 */
@MainActor
final class VoiceRoomManager: ObservableObject {
    static let shared = VoiceRoomManager()

    /// 当前所在房间的群 id（nil = 未在任何房内）
    @Published var joinedGroupId: String?
    @Published var members: [VRMember] = []
    @Published var maxMembers = 3
    @Published var muted = false
    @Published var joining = false
    /// 各群房间成员预览（未进房时群聊页入口展示人数），WS vroom 帧实时刷新
    @Published var roomPreview: [String: [VRMember]] = [:]
    @Published var toastMsg: String?
    /// 当前场次的二维码 token（房内成员可分享，扫码免密进房）
    @Published var qrToken = ""
    /// 正在说话的成员 id（每 0.5 秒经 WebRTC 音量统计刷新，驱动声纹动画）
    @Published var speakingIds: Set<String> = []

    private var whipUrl = ""
    private var whepUrl = ""
    /// 房间场次 ID（日志归类用）
    private var roomId = ""
    private var myUserId = ""
    private var factory: RTCPeerConnectionFactory?
    private var pushPc: RTCPeerConnection?
    private var localAudioTrack: RTCAudioTrack?
    /// uid -> 拉流连接
    private var pullPcs: [String: RTCPeerConnection] = [:]
    private var heartbeatTask: Task<Void, Never>?
    private var logFlushTask: Task<Void, Never>?
    private let pcDelegate = VrPcDelegate()

    // ---- 房间日志：本地打印（Xcode 过滤 PeiwanVRoom）+ 按场次上报服务器 ----
    private var logBuf: [String] = []
    private let logTimeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    func vlog(_ s: String) {
        NSLog("[PeiwanVRoom] %@", s)
        logBuf.append("\(logTimeFmt.string(from: Date())) \(s)")
        if logBuf.count > 500 { logBuf.removeFirst(logBuf.count - 500) }
    }

    /// 登录后调用一次：监听 vroom 广播（在房内驱动订阅增减，不在房内刷新入口人数）
    func start(userId: String) {
        myUserId = userId
        _ = WsClient.shared.addListener { [weak self] frame in
            guard frame["op"] as? String == "vroom",
                  let data = frame["data"] as? [String: Any],
                  let groupId = data["groupId"] as? String,
                  let raw = data["members"],
                  let json = try? JSONSerialization.data(withJSONObject: raw),
                  let members = try? JSONDecoder().decode([VRMember].self, from: json)
            else { return }
            let max = data["max"] as? Int ?? 3
            self?.handleRoomUpdate(groupId: groupId, members: members, max: max)
        }
    }

    /// 群聊页打开/语音房面板打开时刷新一次房间状态
    func refreshInfo(groupId: String) async {
        struct InfoResp: Codable { var members: [VRMember]? = []; var max: Int? = 3; var qrToken: String? = "" }
        if let info: InfoResp = try? await Api.request("/im/group/\(groupId)/voiceroom") {
            roomPreview[groupId] = info.members ?? []
            if joinedGroupId == nil { maxMembers = info.max ?? 3 }
            if joinedGroupId == groupId || joinedGroupId == nil { qrToken = info.qrToken ?? "" }
        }
    }

    func memberCount(_ groupId: String) -> Int {
        joinedGroupId == groupId ? members.count : (roomPreview[groupId]?.count ?? 0)
    }

    private func handleRoomUpdate(groupId: String, members: [VRMember], max: Int) {
        roomPreview[groupId] = members
        guard groupId == joinedGroupId else { return }
        maxMembers = max
        let old = Set(self.members.map(\.id))
        let new = Set(members.map(\.id))
        self.members = members
        // 服务端已把我剔除（心跳超时等）→ 本地同步退房
        if !new.contains(myUserId) {
            vlog("kicked by server (not in member list)")
            teardown(reason: "语音房连接超时，已退出")
            return
        }
        for uid in new.subtracting(old) where uid != myUserId { subscribe(uid) }
        for uid in old.subtracting(new) where uid != myUserId { unsubscribe(uid) }
    }

    // MARK: - 进出房

    func join(groupId: String) {
        if let cur = joinedGroupId {
            if cur != groupId { toastMsg = "请先退出当前语音房" }
            return
        }
        if joining { return }
        joining = true
        Task {
            struct JoinResp: Codable {
                var members: [VRMember]? = []
                var max: Int? = 3
                var roomId: String? = ""
                var qrToken: String? = ""
                var whipUrl: String? = ""
                var whepUrl: String? = ""
                var stream: String? = ""
            }
            do {
                let resp: JoinResp = try await Api.request("/im/group/\(groupId)/voiceroom/join", method: "POST")
                joinedGroupId = groupId
                members = resp.members ?? []
                maxMembers = resp.max ?? 3
                roomId = resp.roomId ?? ""
                qrToken = resp.qrToken ?? ""
                whipUrl = resp.whipUrl ?? ""
                whepUrl = resp.whepUrl ?? ""
                roomPreview[groupId] = members
                vlog("join ok room=\(roomId) me=\(myUserId) members=[\(members.map(\.id).joined(separator: ","))] max=\(maxMembers)")
                configureAudio()
                try await publish(stream: resp.stream ?? "vr_\(groupId)_\(myUserId)")
                for m in members where m.id != myUserId { subscribe(m.id) }
                startHeartbeat(groupId: groupId)
                startLogFlush(groupId: groupId)
                startSpeakingMonitor()
            } catch {
                vlog("join FAIL: \(error.localizedDescription)")
                toastMsg = error.localizedDescription
                teardown(reason: nil)
            }
            joining = false
        }
    }

    func leave() {
        guard let gid = joinedGroupId else { return }
        vlog("leave: user tapped")
        Task {
            struct Ok: Codable { var ok: Bool? }
            let _: Ok? = try? await Api.request("/im/group/\(gid)/voiceroom/leave", method: "POST")
        }
        teardown(reason: nil)
    }

    func toggleMute() {
        muted.toggle()
        localAudioTrack?.isEnabled = !muted
        vlog("mute=\(muted)")
        // 本地立即更新自己的静音图标，同时上报服务端广播给其他人
        if let idx = members.firstIndex(where: { $0.id == myUserId }) { members[idx].muted = muted }
        if let gid = joinedGroupId {
            let m = muted
            Task {
                struct Ok: Codable { var ok: Bool? }
                let _: Ok? = try? await Api.request("/im/group/\(gid)/voiceroom/mute", method: "POST", body: ["muted": m])
            }
        }
    }

    // MARK: - 媒体

    private func configureAudio() {
        // 语音房期间暂停无声保活，避免音频会话冲突
        SilentAudioKeeper.shared.stop()
        // 必须走 WebRTC 的 RTCAudioSession 配置（同 CallManager，直接用 AVAudioSession 会导致录音单元静默失败）
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        do {
            try rtcSession.setCategory(AVAudioSession.Category.playAndRecord, mode: AVAudioSession.Mode.voiceChat, options: [.defaultToSpeaker])
            try rtcSession.setActive(true)
            vlog("audio session ok, micPermission=\(AVAudioSession.sharedInstance().recordPermission.rawValue)")
        } catch {
            vlog("audio session ERROR: \(error)")
        }
        rtcSession.unlockForConfiguration()
    }

    private func publish(stream: String) async throws {
        let factory = RTCPeerConnectionFactory()
        self.factory = factory
        let rtcConfig = RTCConfiguration()
        rtcConfig.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let push = factory.peerConnection(with: rtcConfig, constraints: constraints, delegate: pcDelegate) else {
            throw ApiError(code: -1, msg: "创建推流连接失败")
        }
        let track = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "audio0")
        track.isEnabled = !muted
        localAudioTrack = track
        let audioInit = RTCRtpTransceiverInit()
        audioInit.direction = .sendOnly
        push.addTransceiver(with: track, init: audioInit)
        pushPc = push

        let offer = try await push.offer(for: constraints)
        try await push.setLocalDescription(offer)
        var answer: String?
        for attempt in 0 ..< 3 {
            do {
                answer = try await WhipClient.exchangeSdp(endpoint: whipUrl, stream: stream, offerSdp: offer.sdp)
                vlog("push whip ok attempt=\(attempt)")
                break
            } catch {
                vlog("push whip FAIL attempt=\(attempt): \(error.localizedDescription)")
            }
            if attempt < 2 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        }
        guard let answerSdp = answer else { throw ApiError(code: -1, msg: "语音推流失败") }
        try await push.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answerSdp))
        vlog("push ready stream=\(stream)")
    }

    private func subscribe(_ uid: String) {
        guard let gid = joinedGroupId, pullPcs[uid] == nil, let factory else { return }
        vlog("subscribe uid=\(uid)")
        let rtcConfig = RTCConfiguration()
        rtcConfig.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pull = factory.peerConnection(with: rtcConfig, constraints: constraints, delegate: pcDelegate) else {
            vlog("subscribe ERROR uid=\(uid): create pc failed")
            return
        }
        let recv = RTCRtpTransceiverInit()
        recv.direction = .recvOnly
        pull.addTransceiver(of: .audio, init: recv)
        pullPcs[uid] = pull

        Task {
            do {
                let offer = try await pull.offer(for: constraints)
                try await pull.setLocalDescription(offer)
                var answer: String?
                for attempt in 0 ..< 8 {
                    // 对方可能刚进房还没推完流，失败重试
                    do {
                        answer = try await WhipClient.exchangeSdp(endpoint: whepUrl, stream: "vr_\(gid)_\(uid)", offerSdp: offer.sdp)
                        vlog("pull whep ok uid=\(uid) attempt=\(attempt)")
                        break
                    } catch {
                        vlog("pull whep FAIL uid=\(uid) attempt=\(attempt): \(error.localizedDescription)")
                    }
                    if attempt < 7 { try? await Task.sleep(nanoseconds: 1_500_000_000) }
                    // 已退订/已换连接则放弃
                    guard pullPcs[uid] === pull else { return }
                }
                guard let answerSdp = answer else {
                    vlog("subscribe give up uid=\(uid)")
                    return
                }
                try await pull.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answerSdp))
                vlog("subscribed uid=\(uid)")
            } catch {
                vlog("subscribe ERROR uid=\(uid): \(error.localizedDescription)")
            }
        }
    }

    private func unsubscribe(_ uid: String) {
        vlog("unsubscribe uid=\(uid)")
        pullPcs[uid]?.close()
        pullPcs.removeValue(forKey: uid)
    }

    // MARK: - 说话检测（音量统计驱动声纹动画）

    private var speakTask: Task<Void, Never>?

    private func startSpeakingMonitor() {
        speakTask?.cancel()
        speakTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, self.joinedGroupId != nil, !Task.isCancelled else { return }
                var speaking: Set<String> = []
                if !self.muted, let push = self.pushPc, await Self.audioLevel(push, local: true) > 0.03 {
                    speaking.insert(self.myUserId)
                }
                for (uid, pc) in self.pullPcs {
                    if await Self.audioLevel(pc, local: false) > 0.03 { speaking.insert(uid) }
                }
                if speaking != self.speakingIds { self.speakingIds = speaking }
            }
        }
    }

    /// 读取连接的音量（0~1）：本端取 media-source，远端取 inbound-rtp
    private static func audioLevel(_ pc: RTCPeerConnection, local: Bool) async -> Double {
        await withCheckedContinuation { cont in
            pc.statistics { report in
                var level = 0.0
                for stat in report.statistics.values {
                    let match = local ? stat.type == "media-source" : stat.type == "inbound-rtp"
                    if match, let v = stat.values["audioLevel"] as? NSNumber {
                        level = max(level, v.doubleValue)
                    }
                }
                cont.resume(returning: level)
            }
        }
    }

    // MARK: - 心跳 / 日志上报

    private func startHeartbeat(groupId: String) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            struct HbResp: Codable { var inRoom: Bool? }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self, self.joinedGroupId == groupId, !Task.isCancelled else { return }
                let resp: HbResp? = try? await Api.request("/im/group/\(groupId)/voiceroom/heartbeat", method: "POST")
                if let inRoom = resp?.inRoom, !inRoom {
                    self.vlog("heartbeat: server says not in room, teardown")
                    self.teardown(reason: "语音房连接超时，已退出")
                    return
                }
            }
        }
    }

    private func startLogFlush(groupId: String) {
        logFlushTask?.cancel()
        logFlushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                await self?.flushLogs(groupId: groupId)
            }
        }
    }

    private func flushLogs(groupId: String) async {
        guard !logBuf.isEmpty else { return }
        let lines = logBuf
        logBuf = []
        struct Ok: Codable { var ok: Bool? }
        let _: Ok? = try? await Api.request("/im/group/\(groupId)/voiceroom/log", method: "POST", body: [
            "platform": "ios",
            "lines": lines,
        ])
    }

    private func teardown(reason: String?) {
        let gid = joinedGroupId
        heartbeatTask?.cancel()
        logFlushTask?.cancel()
        speakTask?.cancel()
        speakingIds = []
        pushPc?.close()
        pushPc = nil
        pullPcs.values.forEach { $0.close() }
        pullPcs.removeAll()
        localAudioTrack = nil
        joinedGroupId = nil
        members = []
        muted = false
        roomId = ""
        if let reason { toastMsg = reason }
        vlog("teardown done")
        // 退房后把剩余日志冲刷上报，并恢复无声保活
        if let gid {
            Task { await flushLogs(groupId: gid) }
        }
        SilentAudioKeeper.shared.start()
    }
}

/// 语音房连接代理：仅记录 ICE 状态（音频轨道 WebRTC 自动播放，无需手动挂载）
final class VrPcDelegate: NSObject, RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let names = ["new", "checking", "connected", "completed", "failed", "disconnected", "closed", "count"]
        let name = newState.rawValue < names.count ? names[newState.rawValue] : "\(newState.rawValue)"
        DispatchQueue.main.async { VoiceRoomManager.shared.vlog("ICE state=\(name)") }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
