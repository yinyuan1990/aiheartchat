import AVFoundation
import SwiftUI

/// 群聊语音房面板（sheet）：成员席位 + 加入/退出/静音
struct VoiceRoomSheet: View {
    let groupId: String
    let groupName: String
    @ObservedObject private var manager = VoiceRoomManager.shared
    @EnvironmentObject var state: AppState

    private var inRoom: Bool { manager.joinedGroupId == groupId }
    private var roomMembers: [VRMember] {
        inRoom ? manager.members : (manager.roomPreview[groupId] ?? [])
    }
    private var isFull: Bool { roomMembers.count >= manager.maxMembers }

    var body: some View {
        VStack(spacing: 18) {
            Capsule().fill(Theme.bg3).frame(width: 36, height: 4).padding(.top, 10)

            VStack(spacing: 4) {
                Text("语音房").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                Text("\(groupName) · \(roomMembers.count)/\(manager.maxMembers) 人")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }

            // 席位：房内成员 + 空位占位
            let cols = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]
            LazyVGrid(columns: cols, spacing: 18) {
                ForEach(roomMembers) { m in
                    VStack(spacing: 6) {
                        ZStack(alignment: .bottomTrailing) {
                            AvatarView(url: m.avatar, size: 56)
                                .overlay(Circle().stroke(m.id == state.user?.id ? Theme.accent : .clear, lineWidth: 2))
                            if m.id == state.user?.id, manager.muted {
                                Image(systemName: "mic.slash.fill")
                                    .font(.system(size: 10)).foregroundStyle(.white)
                                    .frame(width: 18, height: 18)
                                    .background(Circle().fill(Theme.danger))
                            }
                        }
                        Text(m.id == state.user?.id ? "我" : (m.nickname ?? ""))
                            .font(.system(size: 11)).foregroundStyle(Theme.textSub).lineLimit(1)
                    }
                }
                ForEach(0 ..< max(0, manager.maxMembers - roomMembers.count), id: \.self) { _ in
                    VStack(spacing: 6) {
                        Circle().fill(Theme.bg3).frame(width: 56, height: 56)
                            .overlay(Image(systemName: "plus").font(.system(size: 18)).foregroundStyle(Theme.textDim))
                        Text("空位").font(.system(size: 11)).foregroundStyle(Theme.textDim)
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
                        Label(manager.muted ? "已静音" : "静音", systemImage: manager.muted ? "mic.slash.fill" : "mic.fill")
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
                        Text("退出语音房")
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Capsule().fill(Theme.danger))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                // 分享二维码：好友扫码免密入群并直接进房
                if !manager.qrToken.isEmpty {
                    Button {
                        if let img = makeQRImage(vroomQrContent(groupId: groupId, token: manager.qrToken), size: 640) {
                            ShareSheet.present([img])
                        }
                    } label: {
                        Label("分享二维码邀请好友", systemImage: "qrcode")
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                }
            } else {
                AccentButton(
                    title: manager.joining ? "加入中…" : (isFull ? "房间已满" : (roomMembers.isEmpty ? "开启语音房（仅群主）" : "加入语音房")),
                    enabled: !manager.joining && !isFull
                ) {
                    AVCaptureDevice.requestAccess(for: .audio) { ok in
                        DispatchQueue.main.async {
                            if ok {
                                VoiceRoomManager.shared.join(groupId: groupId)
                            } else {
                                VoiceRoomManager.shared.toastMsg = "需要麦克风权限，请在系统设置中开启"
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
            }

            Text(inRoom ? "退出面板不会挂断，可回聊天页继续说话" : "加入后房内成员可实时语音")
                .font(.system(size: 11)).foregroundStyle(Theme.textDim)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg2.ignoresSafeArea())
        .toast($manager.toastMsg)
        .task {
            await manager.refreshInfo(groupId: groupId)
        }
    }
}
