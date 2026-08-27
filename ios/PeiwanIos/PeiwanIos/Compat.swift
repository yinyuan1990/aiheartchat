import Combine
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// iOS 15 兼容层：最低部署版本降到 15.6 后，NavigationStack / PhotosPicker /
// ShareLink / toolbarBackground / presentationDetents / 多行 TextField 等
// iOS 16 专属 API 统一在这里做降级。

// MARK: - 导航容器

/// iOS16 用 NavigationStack；iOS15 退回 NavigationView（stack 风格）
struct NavStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        if #available(iOS 16.0, *) {
            NavigationStack { content() }
        } else {
            NavigationView { content() }.navigationViewStyle(.stack)
        }
    }
}

/// 延迟构建目的页：iOS15 的 NavigationLink 会预创建目的视图，包一层避免性能与副作用问题
struct LazyView<Content: View>: View {
    let build: () -> Content
    init(_ build: @autoclosure @escaping () -> Content) { self.build = build }
    var body: some View { build() }
}

// MARK: - 兼容修饰符

extension View {
    /// iOS16 的导航栏背景色；iOS15 由 App 启动时的全局 UINavigationBarAppearance 兜底
    @ViewBuilder
    func compatNavBarBackground(_ color: Color) -> some View {
        if #available(iOS 16.0, *) {
            toolbarBackground(color, for: .navigationBar)
        } else {
            self
        }
    }

    /// iOS16 的半高弹层；iOS15 退回普通 sheet
    @ViewBuilder
    func compatDetents(height: CGFloat) -> some View {
        if #available(iOS 16.0, *) {
            presentationDetents([.height(height)])
        } else {
            self
        }
    }

    /// iOS16.4 的 sheet 背景色；低版本退回给内容自身铺底色
    @ViewBuilder
    func compatSheetBackground(_ color: Color) -> some View {
        if #available(iOS 16.4, *) {
            presentationBackground(color)
        } else {
            background(color.ignoresSafeArea())
        }
    }

    /// View 级字距（TextField 等非 Text 视图）：iOS16+ 生效，iOS15 忽略
    @ViewBuilder
    func compatTracking(_ value: CGFloat) -> some View {
        if #available(iOS 16.0, *) {
            tracking(value)
        } else {
            self
        }
    }
}

/// iOS15 的导航栏没有 toolbarBackground，可在 App 启动时调用一次设置全局外观
func setupCompatNavBarAppearance() {
    if #unavailable(iOS 16.0) {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Theme.bg)
        appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
    }
}

// MARK: - 多行输入框

/// iOS16 的竖向多行 TextField；iOS15 退回单行输入
struct CompatVerticalTextField: View {
    @Binding var text: String
    let prompt: Text
    /// 行数范围（仅 iOS16+ 生效，lineLimit(_:) 范围版本是 16+ API）
    var lineRange: ClosedRange<Int>?

    var body: some View {
        if #available(iOS 16.0, *) {
            if let lineRange {
                TextField("", text: $text, prompt: prompt, axis: .vertical)
                    .lineLimit(lineRange)
            } else {
                TextField("", text: $text, prompt: prompt, axis: .vertical)
            }
        } else {
            TextField("", text: $text, prompt: prompt)
        }
    }
}

// MARK: - 不等角圆角矩形（替代 iOS16 的 UnevenRoundedRectangle）

/// 四角半径可各自指定的圆角矩形，参数命名与 UnevenRoundedRectangle 对齐
struct CompatUnevenRounded: Shape {
    var topLeadingRadius: CGFloat = 0
    var bottomLeadingRadius: CGFloat = 0
    var bottomTrailingRadius: CGFloat = 0
    var topTrailingRadius: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let maxRadius = min(rect.width, rect.height) / 2
        let tl = min(topLeadingRadius, maxRadius)
        let bl = min(bottomLeadingRadius, maxRadius)
        let br = min(bottomTrailingRadius, maxRadius)
        let tr = min(topTrailingRadius, maxRadius)
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + tl, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - tr, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - tr, y: rect.minY + tr), radius: tr,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addArc(center: CGPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + bl, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + tl))
        p.addArc(center: CGPoint(x: rect.minX + tl, y: rect.minY + tl), radius: tl,
                 startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

// MARK: - 系统分享（替代 ShareLink）

enum ShareSheet {
    /// 弹出系统分享面板（UIActivityViewController，iOS15 可用）
    static func present(_ items: [Any]) {
        guard let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
            let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
        else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // iPad 需要锚点
        vc.popoverPresentationController?.sourceView = top.view
        vc.popoverPresentationController?.sourceRect = CGRect(
            x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1
        )
        top.present(vc, animated: true)
    }
}

// MARK: - 相册选择（替代 PhotosPicker，基于 iOS14+ 的 PHPickerViewController）

enum PickMediaKind {
    case images
    case videos
}

/// 相册选择按钮：点击弹系统相册，选完主线程回调。
/// 图片走 onPicked（JPEG Data），视频走 onPickedFiles（拷贝到临时目录的文件 URL，避免大视频整读内存）。
struct CompatPhotoPicker<Label: View>: View {
    let kind: PickMediaKind
    var maxCount: Int = 1
    var onPicked: ([Data]) -> Void = { _ in }
    var onPickedFiles: ([URL]) -> Void = { _ in }
    @ViewBuilder let label: () -> Label

    init(kind: PickMediaKind, maxCount: Int = 1,
         onPicked: @escaping ([Data]) -> Void = { _ in },
         onPickedFiles: @escaping ([URL]) -> Void = { _ in },
         @ViewBuilder label: @escaping () -> Label)
    {
        self.kind = kind
        self.maxCount = maxCount
        self.onPicked = onPicked
        self.onPickedFiles = onPickedFiles
        self.label = label
    }

    @State private var showing = false

    var body: some View {
        Button { showing = true } label: { label() }
            .buttonStyle(.plain)
            .sheet(isPresented: $showing) {
                PhPickerSheet(kind: kind, maxCount: maxCount,
                              onPicked: onPicked, onPickedFiles: onPickedFiles)
                    .ignoresSafeArea()
            }
    }
}

private struct PhPickerSheet: UIViewControllerRepresentable {
    let kind: PickMediaKind
    let maxCount: Int
    let onPicked: ([Data]) -> Void
    let onPickedFiles: ([URL]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = kind == .images ? .images : .videos
        config.selectionLimit = maxCount
        let vc = PHPickerViewController(configuration: config)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhPickerSheet
        init(_ parent: PhPickerSheet) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let kind = parent.kind
            let doneData = parent.onPicked
            let doneFiles = parent.onPickedFiles
            picker.dismiss(animated: true)
            guard !results.isEmpty else { return }

            // 逐个异步加载，保持选择顺序，全部完成后主线程回调
            let group = DispatchGroup()
            var dataSlots = [Data?](repeating: nil, count: results.count)
            var fileSlots = [URL?](repeating: nil, count: results.count)
            let lock = NSLock()
            for (i, result) in results.enumerated() {
                group.enter()
                if kind == .images {
                    guard result.itemProvider.canLoadObject(ofClass: UIImage.self) else {
                        group.leave()
                        continue
                    }
                    result.itemProvider.loadObject(ofClass: UIImage.self) { object, _ in
                        if let image = object as? UIImage,
                           let data = image.jpegData(compressionQuality: 0.8)
                        {
                            lock.lock(); dataSlots[i] = data; lock.unlock()
                        }
                        group.leave()
                    }
                } else {
                    // 系统给的临时文件在回调返回后会被删除，先拷贝到自己的临时目录
                    result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                        if let url {
                            let copy = FileManager.default.temporaryDirectory
                                .appendingPathComponent("pick_\(UUID().uuidString).mp4")
                            try? FileManager.default.removeItem(at: copy)
                            if (try? FileManager.default.copyItem(at: url, to: copy)) != nil {
                                lock.lock(); fileSlots[i] = copy; lock.unlock()
                            }
                        }
                        group.leave()
                    }
                }
            }
            group.notify(queue: .main) {
                if kind == .images {
                    let datas = dataSlots.compactMap { $0 }
                    if !datas.isEmpty { doneData(datas) }
                } else {
                    let urls = fileSlots.compactMap { $0 }
                    if !urls.isEmpty { doneFiles(urls) }
                }
            }
        }
    }
}
