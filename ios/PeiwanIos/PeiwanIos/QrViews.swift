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
                    Text("ID：\(state.user?.shortId ?? "")").font(.system(size: 13)).foregroundStyle(Theme.textSub)
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

            Text("使用「积分转赠 - 扫一扫」扫码给我转积分")
                .font(.system(size: 12)).foregroundStyle(Theme.textDim)

            HStack(spacing: 14) {
                Button {
                    if let img = qrImage {
                        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                        toastMsg = "已保存到相册"
                    }
                } label: {
                    Text("保存")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                        .frame(width: 110, height: 40)
                        .background(Capsule().fill(Theme.bg3))
                }
                if let img = qrImage {
                    Button {
                        ShareSheet.present([img])
                    } label: {
                        Text("分享")
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                            .frame(width: 110, height: 40)
                            .background(Capsule().fill(Theme.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)

            Button("关闭") { dismiss() }
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
    let onResult: (String) -> Void
    @State private var denied = false

    var body: some View {
        ZStack {
            if denied {
                VStack(spacing: 12) {
                    Text("未获得相机权限").font(.system(size: 15)).foregroundStyle(Theme.text)
                    Text("请在系统设置中允许访问相机").font(.system(size: 12)).foregroundStyle(Theme.textDim)
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
                Text("对准对方的收款二维码")
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
