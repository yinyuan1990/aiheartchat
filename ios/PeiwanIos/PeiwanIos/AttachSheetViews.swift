import AVFoundation
import Photos
import SwiftUI

/// 聊天「+」弹框（Telegram 式）：顶部 × / 相册切换，3 列相册网格（第一格相机），
/// 底部悬浮胶囊切 相册 / 礼物 / 位置 / 通话；选了图后胶囊换成「添加说明 + 发送」。
enum AttachAction {
    case gift, transfer, location, voiceCall, videoCall
}

private let attachMaxPick = 9

struct AttachSheet: View {
    /// 单聊才有礼物 / 通话
    let isSingle: Bool
    let canVideoCall: Bool
    /// 链上钱包转账（单聊、有钱包入口）
    var canTransfer: Bool = false
    let onClose: () -> Void
    let onSendAssets: ([PHAsset], String) -> Void
    /// 拍照 / 系统相册兜底选的图（已是 JPEG）
    let onSendDatas: ([Data], String) -> Void
    let onAction: (AttachAction) -> Void

    @StateObject private var lib = PhotoLibraryModel()
    @State private var selection: [String] = []
    @State private var caption = ""
    @State private var camAuthorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    @State private var showCamera = false
    @State private var showCamDenied = false
    @State private var toastMsg: String?
    @ObservedObject private var call = CallManager.shared

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .bottom) {
                grid
                Group {
                    if selection.isEmpty { tabBar } else { captionBar }
                }
                .padding(.bottom, 8)
                .animation(.easeOut(duration: 0.18), value: selection.isEmpty)
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .toast($toastMsg)
        .onAppear { lib.start() }
        .fullScreenCover(isPresented: $showCamera) {
            CameraCaptureView(
                onImage: { img in
                    showCamera = false
                    guard let data = img.attachJPEG() else { return }
                    let c = caption
                    // 等相机页收起再关弹框，两层同时 dismiss 容易丢一层
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { onSendDatas([data], c) }
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .alert("无法使用相机", isPresented: $showCamDenied) {
            Button("去设置") { openAppSettings() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("请在系统设置中允许「心之音」访问相机")
        }
    }

    // MARK: - 顶部

    private var header: some View {
        ZStack {
            Menu {
                ForEach(lib.albums) { a in
                    Button { lib.select(a) } label: {
                        if a.id == lib.current.id { Label(a.title, systemImage: "checkmark") } else { Text(a.title) }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(lib.current.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.textSub)
                }
            }
            .disabled(!lib.canRead)

            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)
                Spacer()
                if lib.status == .limited {
                    Button("管理") { presentLimitedPicker() }
                        .font(.system(size: 15)).foregroundStyle(Theme.accent)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 18).padding(.bottom, 10)
    }

    // MARK: - 网格

    private var grid: some View {
        let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)
        return ScrollView {
            LazyVGrid(columns: cols, spacing: 2) {
                Button(action: openCamera) {
                    CameraCell(live: camAuthorized && !showCamera && call.phase == .idle)
                }
                .buttonStyle(.plain)

                if lib.canRead {
                    ForEach(0 ..< lib.assets.count, id: \.self) { i in
                        let asset = lib.assets.object(at: i)
                        AssetCell(asset: asset, manager: lib.imageManager,
                                  order: selection.firstIndex(of: asset.localIdentifier)) {
                            toggle(asset)
                        }
                    }
                }
            }
            if lib.status == .denied || lib.status == .restricted {
                deniedTip
            }
            Color.clear.frame(height: 80)
        }
    }

    private var deniedTip: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 36)).foregroundStyle(Theme.textDim)
            Text("允许访问相册后，可以在这里直接选图发送")
                .font(.system(size: 14)).foregroundStyle(Theme.textSub)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("去设置") { openAppSettings() }
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 18).frame(height: 36)
                    .background(Capsule().fill(Theme.accent))
                CompatPhotoPicker(kind: .images, maxCount: attachMaxPick, onPicked: { datas in
                    onSendDatas(datas, caption)
                }) {
                    Text("从系统相册选择")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                        .padding(.horizontal, 18).frame(height: 36)
                        .background(Capsule().fill(Theme.bg3))
                }
            }
        }
        .padding(.horizontal, 24).padding(.top, 36)
    }

    // MARK: - 底部

    private struct Tab: Identifiable {
        let id: String
        let icon: String
        let label: String
        let action: AttachAction?
    }

    private var tabs: [Tab] {
        var t = [Tab(id: "album", icon: "photo.fill", label: "相册", action: nil)]
        if isSingle { t.append(Tab(id: "gift", icon: "gift.fill", label: "礼物", action: .gift)) }
        if canTransfer { t.append(Tab(id: "transfer", icon: "arrow.left.arrow.right", label: "转账", action: .transfer)) }
        t.append(Tab(id: "location", icon: "location.fill", label: "位置", action: .location))
        if isSingle {
            t.append(Tab(id: "voice", icon: "phone.fill", label: "语音通话", action: .voiceCall))
            if canVideoCall { t.append(Tab(id: "video", icon: "video.fill", label: "视频通话", action: .videoCall)) }
        }
        return t
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(tabs) { t in
                let on = t.action == nil
                Button {
                    if let a = t.action { onAction(a) }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: t.icon).font(.system(size: 19))
                        Text(t.label).font(.system(size: 10.5, weight: .medium)).lineLimit(1)
                    }
                    .foregroundStyle(on ? Theme.accent : Theme.text)
                    .frame(width: 64, height: 50)
                    .background(Capsule().fill(on ? Theme.bubbleMine : Color.clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(Capsule().fill(.ultraThinMaterial))
        .background(Capsule().fill(Color.white.opacity(0.75)))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var captionBar: some View {
        HStack(spacing: 10) {
            TextField("", text: $caption, prompt: Text("添加说明…").foregroundColor(Theme.textDim))
                .font(.system(size: 15)).foregroundStyle(Theme.text)
                .padding(.horizontal, 16).frame(height: 44)
                .background(Capsule().fill(.ultraThinMaterial))
                .background(Capsule().fill(Color.white.opacity(0.8)))
                .overlay(Capsule().stroke(Theme.line, lineWidth: 0.5))
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Theme.accent))
                    .overlay(alignment: .topTrailing) {
                        Text("\(selection.count)")
                            .font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Capsule().fill(.white))
                            .overlay(Capsule().stroke(Theme.accent, lineWidth: 1.5))
                            .offset(x: 6, y: -6)
                    }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - 动作

    private func toggle(_ asset: PHAsset) {
        let id = asset.localIdentifier
        if let i = selection.firstIndex(of: id) {
            selection.remove(at: i)
        } else if selection.count >= attachMaxPick {
            toastMsg = "最多选择 \(attachMaxPick) 张"
        } else {
            selection.append(id)
        }
    }

    private func send() {
        let result = PHAsset.fetchAssets(withLocalIdentifiers: selection, options: nil)
        var byId: [String: PHAsset] = [:]
        result.enumerateObjects { a, _, _ in byId[a.localIdentifier] = a }
        let ordered = selection.compactMap { byId[$0] }
        guard !ordered.isEmpty else { return }
        onSendAssets(ordered, caption)
    }

    private func openCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            toastMsg = "当前设备不支持拍照"
            return
        }
        if call.phase != .idle {
            toastMsg = "通话中无法拍照"
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            showCamera = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async {
                    camAuthorized = ok
                    if ok { showCamera = true }
                }
            }
        default:
            showCamDenied = true
        }
    }

    private func presentLimitedPicker() {
        guard let top = topViewController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    }
}

extension View {
    /// 「+」弹框：iOS16 半屏起步、上滑网格展开到全屏（Telegram 手感）；iOS15 普通 sheet
    @ViewBuilder
    func attachSheetDetents() -> some View {
        if #available(iOS 16.0, *) {
            presentationDetents([.fraction(0.64), .large]).presentationDragIndicator(.visible)
        } else {
            self
        }
    }
}

// MARK: - 相册数据

struct AttachAlbum: Identifiable {
    let id: String
    let title: String
    let collection: PHAssetCollection?

    static let recent = AttachAlbum(id: "recent", title: "最近项目", collection: nil)
}

final class PhotoLibraryModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published var albums: [AttachAlbum] = [.recent]
    @Published var current = AttachAlbum.recent
    @Published var assets = PHFetchResult<PHAsset>()
    let imageManager = PHCachingImageManager()
    private var observing = false

    var canRead: Bool { status == .authorized || status == .limited }

    func start() {
        if canRead {
            load()
        } else if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
                DispatchQueue.main.async {
                    self.status = s
                    if self.canRead { self.load() }
                }
            }
        }
    }

    deinit {
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    func select(_ a: AttachAlbum) {
        current = a
        reloadAssets()
    }

    private func load() {
        if !observing {
            PHPhotoLibrary.shared().register(self)
            observing = true
        }
        reloadAssets()
        reloadAlbums()
    }

    private static var imageOptions: PHFetchOptions {
        let o = PHFetchOptions()
        o.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return o
    }

    private func reloadAssets() {
        if let c = current.collection {
            assets = PHAsset.fetchAssets(in: c, options: Self.imageOptions)
        } else {
            assets = PHAsset.fetchAssets(with: Self.imageOptions)
        }
    }

    private func reloadAlbums() {
        DispatchQueue.global(qos: .userInitiated).async {
            var list: [AttachAlbum] = [.recent]
            func add(_ result: PHFetchResult<PHAssetCollection>) {
                result.enumerateObjects { c, _, _ in
                    guard PHAsset.fetchAssets(in: c, options: PhotoLibraryModel.imageOptions).count > 0 else { return }
                    list.append(AttachAlbum(id: c.localIdentifier, title: c.localizedTitle ?? "相册", collection: c))
                }
            }
            for sub: PHAssetCollectionSubtype in [.smartAlbumFavorites, .smartAlbumSelfPortraits, .smartAlbumScreenshots, .smartAlbumLivePhotos] {
                add(PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: sub, options: nil))
            }
            add(PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil))
            DispatchQueue.main.async { self.albums = list }
        }
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        DispatchQueue.main.async {
            if let d = changeInstance.changeDetails(for: self.assets) {
                self.assets = d.fetchResultAfterChanges
            }
        }
    }
}

enum AttachMedia {
    /// 相册原图按长边 1600 降采样后出 JPEG（iCloud 上的原图会先下载）
    static func jpegData(_ asset: PHAsset) async -> Data? {
        let opts = PHImageRequestOptions()
        opts.deliveryMode = .highQualityFormat
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = true
        let target = CGSize(width: 1600, height: 1600)
        return await withCheckedContinuation { cont in
            PHImageManager.default().requestImage(for: asset, targetSize: target, contentMode: .aspectFit, options: opts) { img, _ in
                cont.resume(returning: img?.attachJPEG())
            }
        }
    }
}

extension UIImage {
    /// 长边压到 1600 再出 JPEG；方向已由 UIImage 处理好
    func attachJPEG(maxSide: CGFloat = 1600) -> Data? {
        let longest = max(size.width, size.height)
        guard longest > maxSide else { return jpegData(compressionQuality: 0.8) }
        let scale = maxSide / longest
        let newSize = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let img = UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
        return img.jpegData(compressionQuality: 0.8)
    }
}

// MARK: - 格子

private struct AssetCell: View {
    let asset: PHAsset
    let manager: PHCachingImageManager
    let order: Int?
    let onTap: () -> Void

    @State private var image: UIImage?
    @State private var requestId: PHImageRequestID?

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                ZStack {
                    Theme.bg3
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    }
                }
                .clipped()
                .scaleEffect(order == nil ? 1 : 0.88)
            }
            .clipped()
            .overlay(alignment: .topTrailing) { badge.padding(6) }
            .contentShape(Rectangle())
            .onTapGesture(perform: onTap)
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: order)
            .onAppear(perform: load)
            .onDisappear(perform: cancel)
            .onChange(of: asset.localIdentifier) { _ in load() }
    }

    private var badge: some View {
        ZStack {
            Circle().fill(order == nil ? Color.black.opacity(0.18) : Theme.accent)
            Circle().stroke(Color.white, lineWidth: 1.5)
            if let order {
                Text("\(order + 1)").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
            }
        }
        .frame(width: 24, height: 24)
        .shadow(color: .black.opacity(0.25), radius: 2)
    }

    private func load() {
        cancel()
        let opts = PHImageRequestOptions()
        opts.deliveryMode = .opportunistic
        opts.resizeMode = .fast
        opts.isNetworkAccessAllowed = true
        let px = 130 * UIScreen.main.scale
        requestId = manager.requestImage(for: asset, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: opts) { img, _ in
            if let img { image = img }
        }
    }

    private func cancel() {
        if let requestId { manager.cancelImageRequest(requestId) }
        requestId = nil
    }
}

private struct CameraCell: View {
    let live: Bool

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if live { CameraPreview() } else { Color(white: 0.12) }
            }
            .overlay {
                Image(systemName: "camera.fill")
                    .font(.system(size: 24)).foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.4), radius: 3)
            }
            .clipped()
            .contentShape(Rectangle())
    }
}

/// 相机格的实时取景（后置摄像头，只预览不拍）
private struct CameraPreview: UIViewRepresentable {
    func makeUIView(context: Context) -> CameraPreviewUIView {
        let v = CameraPreviewUIView()
        v.start()
        return v
    }

    func updateUIView(_ uiView: CameraPreviewUIView, context: Context) {}

    static func dismantleUIView(_ uiView: CameraPreviewUIView, coordinator: ()) {
        uiView.stop()
    }
}

final class CameraPreviewUIView: UIView {
    private static let queue = DispatchQueue(label: "attach.camera.preview")
    private let session = AVCaptureSession()

    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    func start() {
        backgroundColor = UIColor(white: 0.12, alpha: 1)
        guard let layer = layer as? AVCaptureVideoPreviewLayer else { return }
        layer.videoGravity = .resizeAspectFill
        layer.session = session
        let s = session
        Self.queue.async {
            if s.inputs.isEmpty {
                guard let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                      let input = try? AVCaptureDeviceInput(device: dev) else { return }
                s.beginConfiguration()
                s.sessionPreset = .medium
                if s.canAddInput(input) { s.addInput(input) }
                s.commitConfiguration()
            }
            if !s.isRunning { s.startRunning() }
        }
    }

    func stop() {
        let s = session
        Self.queue.async {
            if s.isRunning { s.stopRunning() }
        }
    }
}

/// 系统相机拍照
private struct CameraCaptureView: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraCaptureView
        init(_ parent: CameraCaptureView) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onImage(img) } else { parent.onCancel() }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}

// MARK: - 工具

private func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
    }
}

private func topViewController() -> UIViewController? {
    guard let scene = UIApplication.shared.connectedScenes
        .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
        let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
    else { return nil }
    var top = root
    while let presented = top.presentedViewController { top = presented }
    return top
}
