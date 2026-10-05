import SwiftUI
import AVFoundation
import CoreImage.CIFilterBuiltins

/// 收款码内容格式：peiwan://pay?sid=6位ID
func payQrContent(sid: String) -> String { "peiwan://pay?sid=\(sid)" }

/// 从扫码结果里提取 6 位 ID（兼容 peiwan://pay?sid=xxx 和纯数字）
func parsePaySid(_ text: String) -> String? {
    if let range = text.range(of: #"sid=(\d{6})"#, options: .regularExpression) {
        return String(text[range].dropFirst(4))
    }
    let digits = text.filter(\.isNumber)
    return digits.count == 6 ? digits : nil
}

/// 群邀请码内容格式：peiwan://group?code=8位邀请码
func groupQrContent(code: String) -> String { "peiwan://group?code=\(code)" }

/// 语音房邀请二维码内容：peiwan://vroom?g=群id&t=场次token（扫码免密入群并进房）
func vroomQrContent(groupId: String, token: String) -> String { "peiwan://vroom?g=\(groupId)&t=\(token)" }

/// 从扫码结果里提取语音房邀请（groupId, token）
func parseVroomQr(_ text: String) -> (groupId: String, token: String)? {
    guard text.contains("vroom?"),
          let gRange = text.range(of: #"g=(\d+)"#, options: .regularExpression),
          let tRange = text.range(of: #"t=([A-Za-z0-9]+)"#, options: .regularExpression)
    else { return nil }
    return (String(text[gRange].dropFirst(2)), String(text[tRange].dropFirst(2)))
}

/// 从扫码结果里提取群邀请码（兼容 peiwan://group?code=xxx 和纯码）
func parseGroupCode(_ text: String) -> String? {
    if let range = text.range(of: #"code=([A-Za-z0-9]{6,12})"#, options: .regularExpression) {
        return String(text[range].dropFirst(5)).uppercased()
    }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if t.range(of: #"^[A-Z0-9]{6,12}$"#, options: .regularExpression) != nil { return t }
    return nil
}

/// 从扫码结果里提取邀请名片码（名片二维码内容 https://域名/t/?u=短号）
func parseInviteCode(_ text: String) -> String? {
    guard text.contains("/t/"),
          let range = text.range(of: #"[?&]u=\d{1,19}"#, options: .regularExpression)
    else { return nil }
    return String(text[range].dropFirst(3))
}

/// 看起来像链上钱包地址或收款链接（0x / EIP-681、Solana、波场 T…、TON、solana: / tron: / ton:// 链接）。
/// 这里只粗判，真正的解析（哪条链、币种、金额、备注，格式不对就提示）在钱包网页 /wallet/send?scan= 里统一做。
func looksLikeWalletPayment(_ raw: String) -> Bool {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let patterns = [
        #"^(?i)(ethereum|solana|tron|ton|tonkeeper):"#,
        #"^https://app\.tonkeeper\.com/transfer/"#,
        #"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])"#,
        #"^[1-9A-HJ-NP-Za-km-z]{32,44}$"#,
        #"^[A-Za-z0-9_+/-]{48}$"#,
        #"^-?[01]:[0-9a-fA-F]{64}$"#,
    ]
    for p in patterns where t.range(of: p, options: .regularExpression) != nil { return true }
    return false
}

/// 扫一扫（我的页 / 消息页「+」和搜索框共用）：相机扫到的内容交给 scanHandler
struct ScanFlowModifier: ViewModifier {
    @Binding var isPresented: Bool
    @State private var scanned: String?

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $isPresented) {
                QrScanView(hint: t("qr.scanPrompt")) { text in
                    // 等扫码页收起再处理，免得下一页的弹出 / push 被吞
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { scanned = text }
                }
            }
            .scanHandler($scanned)
    }
}

/// 扫到的二维码统一在这里处理（扫一扫、聊天图片「识别二维码」共用），text 置非 nil 即处理：
/// 邀请名片 → 私聊；语音房邀请 → 免密入群进房；收款码 → 积分转赠页并填好；群邀请码 → 加群；
/// 钱包地址 / 收款链接 → 钱包转账页（自动选链并填好，0x 地址让用户选网络）。
struct ScanHandlerModifier: ViewModifier {
    @Binding var text: String?
    @EnvironmentObject var state: AppState
    @State private var joinCode: ScannedCode?
    @State private var chat: ChatTarget?
    @State private var route: Route?
    @State private var toast: String?

    struct ScannedCode: Identifiable {
        let id = UUID()
        let code: String
    }

    func body(content: Content) -> some View {
        content
            .toast($toast)
            .sheet(item: $joinCode) { s in
                NavStack { JoinGroupView(initialCode: s.code) }
            }
            .fullScreenCover(item: $chat) { t in
                ChatRoomSheet(target: t)
            }
            .routePush($route)
            .onChange(of: text) { v in
                guard let t = v else { return }
                text = nil
                handle(t.trimmingCharacters(in: .whitespacesAndNewlines))
            }
    }

    private func handle(_ text: String) {
        let wallet = looksLikeWalletPayment(text)
        if let code = parseInviteCode(text) {
            openByInvite(code)
        } else if let v = parseVroomQr(text) {
            joinVroomByQr(v.groupId, v.token)
        } else if text.contains("pay?sid=") {
            if let s = parsePaySid(text) { route = .transferTo(s) } else { toast = t("qr.payCodeIncomplete") }
        } else if !wallet, let c = parseGroupCode(text) {
            joinCode = ScannedCode(code: c)
        } else if wallet {
            openWallet(text)
        } else {
            toast = t("qr.unrecognized")
        }
    }

    private func openWallet(_ text: String) {
        Task { @MainActor in
            guard await ChainWallet.visible(state.user) else {
                toast = t("qr.walletUnsupported")
                return
            }
            let enc = text.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            route = .chainWalletPath("/wallet/send?scan=" + enc)
        }
    }

    private func openByInvite(_ code: String) {
        Task {
            struct Peer: Codable { var id: String; var nickname: String? }
            struct Resp: Codable { var conversationId: String; var peer: Peer }
            do {
                let r: Resp = try await Api.request("/im/conversations/open-by-code", method: "POST", body: ["code": code])
                chat = ChatTarget(convId: r.conversationId, convType: 1, targetId: r.peer.id, title: r.peer.nickname ?? "")
            } catch {
                toast = error.localizedDescription
            }
        }
    }

    /// 语音房二维码：免密入群 → 打开群聊 → 自动进房
    private func joinVroomByQr(_ groupId: String, _ token: String) {
        Task {
            struct ScanResp: Codable {
                var groupId: String? = ""
                var conversationId: String? = ""
                var groupName: String? = ""
                var roomActive: Bool? = false
            }
            do {
                let r: ScanResp = try await Api.request("/im/voiceroom/scan", method: "POST", body: [
                    "groupId": groupId,
                    "token": token,
                ])
                guard let convId = r.conversationId, !convId.isEmpty else {
                    toast = t("qr.groupNotFound")
                    return
                }
                chat = ChatTarget(convId: convId, convType: 2, targetId: r.groupId ?? groupId, title: r.groupName ?? t("chat.groupChat"))
                if r.roomActive == true {
                    let micDenied = t("qr.micDenied")
                    AVCaptureDevice.requestAccess(for: .audio) { ok in
                        DispatchQueue.main.async {
                            if ok {
                                VoiceRoomManager.shared.join(groupId: r.groupId ?? groupId)
                            } else {
                                VoiceRoomManager.shared.toastMsg = micDenied
                            }
                        }
                    }
                } else {
                    toast = t("qr.joinedRoomClosed")
                }
            } catch {
                toast = error.localizedDescription
            }
        }
    }
}

extension View {
    func scanFlow(isPresented: Binding<Bool>) -> some View { modifier(ScanFlowModifier(isPresented: isPresented)) }
    func scanHandler(_ text: Binding<String?>) -> some View { modifier(ScanHandlerModifier(text: text)) }
}

/// 生成二维码图片
func makeQRImage(_ text: String, size: CGFloat = 240) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scale = size / output.extent.width
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg)
}

/// 我的收款二维码
struct MyQrCodeView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var toastMsg: String?

    private var qrImage: UIImage? {
        guard let sid = state.user?.shortId else { return nil }
        return makeQRImage(payQrContent(sid: sid), size: 640)
    }

    var body: some View {
        VStack(spacing: 18) {
            HStack(spacing: 10) {
                AvatarView(url: state.user?.avatar ?? "", size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.user?.nickname ?? "").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(t("me.id", ["id": state.user?.shortId ?? ""])).font(.system(size: 13)).foregroundStyle(Theme.textSub)
                }
                Spacer()
            }
            .padding(.horizontal, 24)

            if let img = qrImage {
                Image(uiImage: img)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 240, height: 240)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 14).fill(.white))
            }

            Text(t("transfer.qrHint"))
                .font(.system(size: 12)).foregroundStyle(Theme.textDim)

            HStack(spacing: 14) {
                Button {
                    if let img = qrImage {
                        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                        toastMsg = t("qr.savedToGallery")
                    }
                } label: {
                    Text(t("common.save"))
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                        .frame(width: 110, height: 40)
                        .background(Capsule().fill(Theme.bg3))
                }
                if let img = qrImage {
                    Button {
                        ShareSheet.present([img])
                    } label: {
                        Text(t("common.share"))
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                            .frame(width: 110, height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)

            Button(t("common.close")) { dismiss() }
                .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                .padding(.top, 2)
        }
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .toast($toastMsg)
    }
}

/// 扫一扫（扫收款码）
struct QrScanView: View {
    @Environment(\.dismiss) private var dismiss
    var hint: String? = nil
    let onResult: (String) -> Void
    @State private var denied = false

    var body: some View {
        ZStack {
            if denied {
                VStack(spacing: 12) {
                    Text(t("qr.noCameraPermission")).font(.system(size: 15)).foregroundStyle(Theme.text)
                    Text(t("qr.allowCameraHint")).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
            } else {
                QrCameraView { text in
                    onResult(text)
                    dismiss()
                }
                .ignoresSafeArea()

                // 取景框
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Theme.accent, lineWidth: 2)
                    .frame(width: 230, height: 230)
                Text(hint ?? t("transfer.scanHint"))
                    .font(.system(size: 13)).foregroundStyle(.white)
                    .padding(.top, 300)
            }

            VStack {
                HStack {
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(Color.black.opacity(0.4)))
                    }
                    .padding(.trailing, 18)
                    .padding(.top, 8)
                }
                Spacer()
            }
        }
        .background(Color.black)
        .task {
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            if status == .notDetermined {
                denied = !(await AVCaptureDevice.requestAccess(for: .video))
            } else {
                denied = status != .authorized
            }
        }
    }
}

/// 相机取景 + 二维码识别
private struct QrCameraView: UIViewControllerRepresentable {
    let onFound: (String) -> Void

    func makeUIViewController(context: Context) -> QrCameraController {
        let vc = QrCameraController()
        vc.onFound = onFound
        return vc
    }

    func updateUIViewController(_ vc: QrCameraController, context: Context) {}
}

final class QrCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFound: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var found = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.stopRunning()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !found,
              let obj = objects.first as? AVMetadataMachineReadableCodeObject,
              let text = obj.stringValue else { return }
        found = true
        onFound?(text)
    }
}
