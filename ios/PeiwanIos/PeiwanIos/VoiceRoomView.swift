import AVFoundation
import SwiftUI
import UIKit

/// 群聊语音房面板（sheet）：成员席位 + 加入/退出/静音
struct VoiceRoomSheet: View {
    let groupId: String
    let groupName: String
    @ObservedObject private var manager = VoiceRoomManager.shared
    @EnvironmentObject var state: AppState
    @State private var showShare = false

    private var inRoom: Bool { manager.joinedGroupId == groupId }
    private var roomMembers: [VRMember] {
        inRoom ? manager.members : (manager.roomPreview[groupId] ?? [])
    }
    private var isFull: Bool { roomMembers.count >= manager.maxMembers }
    private var joinButtonTitle: String {
        if manager.joining { return t("group.joining") }
        if isFull { return t("voiceRoom.full") }
        return roomMembers.isEmpty ? t("voiceRoom.start") : t("voiceRoom.join")
    }

    var body: some View {
        VStack(spacing: 18) {
            Capsule().fill(Theme.bg3).frame(width: 36, height: 4).padding(.top, 10)

            VStack(spacing: 4) {
                Text(t("chat.menu.voiceRoom")).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                Text(groupName + " · " + t("voiceRoom.occupancy", ["n": roomMembers.count, "max": manager.maxMembers]))
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }

            // 席位：房内成员 + 空位占位
            let cols = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
            LazyVGrid(columns: cols, spacing: 18) {
                ForEach(roomMembers) { m in
                    let speaking = manager.speakingIds.contains(m.id)
                    let isMuted = m.muted == true
                    VStack(spacing: 6) {
                        ZStack(alignment: .bottomTrailing) {
                            AvatarView(url: m.avatar, size: 56)
                                .overlay(
                                    Circle().stroke(
                                        speaking ? Color(red: 0.13, green: 0.78, blue: 0.35) : (m.id == state.user?.id ? Theme.accent : .clear),
                                        lineWidth: 2
                                    )
                                )
                            if isMuted {
                                // 静音角标
                                Image(systemName: "mic.slash.fill")
                                    .font(.system(size: 9, weight: .semibold)).foregroundStyle(.white)
                                    .frame(width: 18, height: 18)
                                    .background(Circle().fill(Color(white: 0.4)))
                                    .overlay(Circle().stroke(Theme.bg2, lineWidth: 1.5))
                            } else if speaking {
                                // 说话中声纹动画角标
                                SpeakingIndicator()
                                    .overlay(Circle().stroke(Theme.bg2, lineWidth: 1.5))
                            }
                        }
                        Text(m.id == state.user?.id ? t("voiceRoom.me") : (m.nickname ?? ""))
                            .font(.system(size: 11))
                            .foregroundStyle(speaking ? Color(red: 0.13, green: 0.78, blue: 0.35) : Theme.textSub)
                            .lineLimit(1)
                    }
                }
                ForEach(0 ..< max(0, manager.maxMembers - roomMembers.count), id: \.self) { _ in
                    VStack(spacing: 6) {
                        Circle().fill(Theme.bg3).frame(width: 56, height: 56)
                            .overlay(Image(systemName: "plus").font(.system(size: 18)).foregroundStyle(Theme.textDim))
                        Text(t("voiceRoom.emptySeat")).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                    }
                }
            }
            .padding(.horizontal, 24)

            Spacer()

            if inRoom {
                HStack(spacing: 14) {
                    Button {
                        manager.toggleMute()
                    } label: {
                        Label(manager.muted ? t("voiceRoom.muted") : t("voiceRoom.mute"), systemImage: manager.muted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(manager.muted ? .white : Theme.text)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Capsule().fill(manager.muted ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.bg3)))
                    }
                    .buttonStyle(.plain)
                    Button {
                        manager.leave()
                    } label: {
                        Text(t("voiceRoom.leave"))
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Capsule().fill(Theme.danger))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                // 分享：独立分享页（卡片 + 保存/发送）
                if !manager.qrToken.isEmpty {
                    Button {
                        showShare = true
                    } label: {
                        Label(t("voiceRoom.shareQr"), systemImage: "qrcode")
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                }
            } else {
                AccentButton(
                    title: joinButtonTitle,
                    enabled: !manager.joining && !isFull
                ) {
                    let micDenied = t("qr.micDenied")
                    AVCaptureDevice.requestAccess(for: .audio) { ok in
                        DispatchQueue.main.async {
                            if ok {
                                VoiceRoomManager.shared.join(groupId: groupId)
                            } else {
                                VoiceRoomManager.shared.toastMsg = micDenied
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
            }

            Text(inRoom ? t("voiceRoom.hintInRoomIos") : t("voiceRoom.hintOutRoom"))
                .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg2.ignoresSafeArea())
        .toast($manager.toastMsg)
        .task {
            await manager.refreshInfo(groupId: groupId)
        }
        .fullScreenCover(isPresented: $showShare) {
            VoiceRoomShareView(groupId: groupId, groupName: groupName)
        }
    }
}

/// 说话中角标：绿色圆底 + 三根跳动的声纹条
struct SpeakingIndicator: View {
    @State private var animate = false
    private let heights: [CGFloat] = [6, 10, 7]

    var body: some View {
        HStack(spacing: 1.5) {
            ForEach(0 ..< 3, id: \.self) { i in
                Capsule()
                    .fill(.white)
                    .frame(width: 2, height: animate ? heights[i] : heights[(i + 1) % 3] * 0.5)
                    .animation(
                        .easeInOut(duration: 0.3).repeatForever(autoreverses: true).delay(Double(i) * 0.1),
                        value: animate
                    )
            }
        }
        .frame(width: 18, height: 18)
        .background(Circle().fill(Color(red: 0.13, green: 0.78, blue: 0.35)))
        .onAppear { animate = true }
    }
}

/// 语音房分享页：卡片预览 + 保存图片 / 分享发送
struct VoiceRoomShareView: View {
    let groupId: String
    let groupName: String
    @ObservedObject private var manager = VoiceRoomManager.shared
    @Environment(\.dismiss) private var dismiss
    @State private var ownerName = ""
    @State private var avatarImage: UIImage?
    @State private var toastMsg: String?

    private var listeners: Int { manager.memberCount(groupId) }
    private var qrImage: UIImage? {
        makeQRImage(vroomQrContent(groupId: groupId, token: manager.qrToken), size: 512)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.textSub)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Theme.bg3))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 20).padding(.top, 16)

            Spacer()
            shareCard
                .padding(.horizontal, 28)
            Spacer()

            HStack(spacing: 14) {
                Button {
                    if let img = renderCardImage() {
                        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                        toastMsg = t("qr.savedToGallery")
                    }
                } label: {
                    Label(t("voiceRoom.saveImage"), systemImage: "square.and.arrow.down")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(Capsule().fill(Theme.bg3))
                }
                .buttonStyle(.plain)
                Button {
                    if let img = renderCardImage() {
                        ShareSheet.present([img])
                    }
                } label: {
                    Label(t("voiceRoom.shareSend"), systemImage: "paperplane.fill")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(Capsule().fill(Theme.accentGrad))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24).padding(.bottom, 30)
        }
        .background(Theme.bg.ignoresSafeArea())
        .toast($toastMsg)
        .task {
            // 群头像 + 群主昵称（卡片展示；头像预下载保证截图时已就绪）
            struct GroupInfo: Codable {
                struct M: Codable { var id: String? = ""; var nickname: String? = ""; var role: String? = "" }
                var avatar: String? = ""
                var members: [M]? = []
            }
            if let g: GroupInfo = try? await Api.request("/im/group/\(groupId)") {
                ownerName = g.members?.first(where: { $0.role == "owner" })?.nickname ?? ""
                if let path = g.avatar, !path.isEmpty, let url = URL(string: Api.fullUrl(path)),
                   let (data, _) = try? await URLSession.shared.data(from: url) {
                    avatarImage = UIImage(data: data)
                }
            }
        }
    }

    /// 分享卡片（白底，供页面预览与截图共用）
    private var shareCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            // 徽标
            HStack(spacing: 5) {
                Image(systemName: "waveform")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                Text(t("chat.menu.voiceRoom"))
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(Color(red: 0.13, green: 0.72, blue: 0.32)))

            // 标题
            Text(t("voiceRoom.cardTitle", ["name": groupName]))
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(.black)
                .lineLimit(2)

            // 群主
            HStack(spacing: 8) {
                Group {
                    if let avatarImage {
                        Image(uiImage: avatarImage).resizable().scaledToFill()
                    } else {
                        Circle().fill(Color(white: 0.9))
                    }
                }
                .frame(width: 34, height: 34)
                .clipShape(Circle())
                Text(ownerName.isEmpty ? groupName : ownerName)
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.black)
                    .lineLimit(1)
                Text(t("voiceRoom.owner"))
                    .font(.system(size: 11)).foregroundStyle(Color(white: 0.45))
            }

            // 加入条件 / 收听人数
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(t("voiceRoom.joinCondition")).font(.system(size: 12)).foregroundStyle(Color(white: 0.55))
                    Text(t("voiceRoom.scanToJoinShort")).font(.system(size: 17, weight: .semibold)).foregroundStyle(.black)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 5) {
                    Text(t("chat.menu.voiceRoom")).font(.system(size: 12)).foregroundStyle(Color(white: 0.55))
                    Text(t("voiceRoom.listenersIos", ["n": max(listeners, 1)])).font(.system(size: 17, weight: .semibold)).foregroundStyle(.black)
                }
            }
            .padding(.top, 2)

            Rectangle().fill(Color(white: 0.92)).frame(height: 1)

            // 底部：品牌 + 二维码
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(t("app.name")).font(.system(size: 19, weight: .bold)).foregroundStyle(.black)
                    Text(t("voiceRoom.scanToJoin")).font(.system(size: 12)).foregroundStyle(Color(white: 0.55))
                }
                Spacer()
                if let qrImage {
                    Image(uiImage: qrImage)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 92, height: 92)
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.96)))
                }
            }
        }
        .padding(22)
        .background(RoundedRectangle(cornerRadius: 22).fill(.white))
    }

    /// 卡片渲染为图片（iOS15 兼容：UIHostingController 挂临时窗口截图）
    private func renderCardImage() -> UIImage? {
        let width: CGFloat = 340
        let host = UIHostingController(rootView: shareCard.frame(width: width))
        let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        guard size.height > 0 else { return nil }
        host.view.bounds = CGRect(origin: .zero, size: size)
        host.view.backgroundColor = .clear
        let window = UIWindow(frame: host.view.bounds)
        window.rootViewController = host
        window.isHidden = false
        host.view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }
}
