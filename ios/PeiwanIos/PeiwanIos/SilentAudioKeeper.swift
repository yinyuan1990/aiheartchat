import AVFoundation
import Foundation

/**
 * iOS 保活：循环播放无声音频 + Background Modes(audio)，
 * 使 App 退后台后进程与 socket 保持存活，能实时收到消息与来电。
 * 通话期间暂停（通话自身的音频会话已能保活），结束后恢复。
 */
final class SilentAudioKeeper {
    static let shared = SilentAudioKeeper()
    private var player: AVAudioPlayer?

    func start() {
        guard player == nil else { return }
        let session = AVAudioSession.sharedInstance()
        // mixWithOthers：不打断用户正在听的音乐
        try? session.setCategory(.playback, options: [.mixWithOthers])
        try? session.setActive(true)

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("silence.wav")
        if !FileManager.default.fileExists(atPath: url.path) {
            try? Self.silentWavData().write(to: url)
        }
        player = try? AVAudioPlayer(contentsOf: url)
        player?.numberOfLoops = -1
        player?.volume = 0
        player?.play()
    }

    func stop() {
        player?.stop()
        player = nil
    }

    /// 生成 1 秒 16bit/8kHz 单声道静音 WAV
    private static func silentWavData() -> Data {
        let sampleRate: UInt32 = 8000
        let dataSize: UInt32 = sampleRate * 2
        var d = Data()
        func append(_ s: String) { d.append(s.data(using: .ascii)!) }
        func append32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func append16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        append("RIFF"); append32(36 + dataSize); append("WAVE")
        append("fmt "); append32(16); append16(1); append16(1)
        append32(sampleRate); append32(sampleRate * 2); append16(2); append16(16)
        append("data"); append32(dataSize)
        d.append(Data(count: Int(dataSize)))
        return d
    }
}
