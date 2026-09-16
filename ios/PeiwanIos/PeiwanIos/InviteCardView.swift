import SwiftUI

struct InviteMine: Codable {
    let code: String
    let link: String
    var clicks30d: Int?
    var invited: Int?
    var recent: [InvitedUser]?
}

struct InvitedUser: Codable, Identifiable {
    let id: String
    var nickname: String?
    var avatar: String?
    var gender: Int?
    var createdAt: String?
}

/// 我的邀请名片：专属网页（yyheart.com/t/?u=短号）链接 + 二维码。
/// 女生发给男生：他下载后自动打开她的主页；男生发给女生：她下载后自动和他成为好友。
struct InviteCardView: View {
    @EnvironmentObject var state: AppState
    @State private var info: InviteMine?
    @State private var error: String?
    @State private var toastMsg: String?

    private var isFemale: Bool { state.user?.gender == 2 }
    private var shareText: String {
        isFemale ? "我在心之音等你，来和我聊聊：" : "我在心之音，想请你来聊聊，你的时间在这里每一分钟都算钱："
    }

    var body: some View {
        Group {
            if let info {
                ScrollView {
                    VStack(spacing: 14) {
                        card(info)
                        HStack(spacing: 10) {
                            stat("\(info.clicks30d ?? 0)", "30 天内被打开")
                            stat("\(info.invited ?? 0)", "成功邀请")
                        }
                        if let recent = info.recent, !recent.isEmpty {
                            VStack(alignment: .leading, spacing: 0) {
                                Text("通过我加入的人").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                    .padding(.top, 6).padding(.bottom, 4)
                                ForEach(recent) { u in
                                    HStack(spacing: 12) {
                                        AvatarView(url: u.avatar ?? "", size: 38)
                                        Text(u.nickname ?? "").font(.system(size: 14)).foregroundStyle(Theme.text)
                                        Spacer()
                                        Text(String((u.createdAt ?? "").prefix(10))).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                                    }
                                    .padding(.vertical, 8)
                                }
                            }
                        }
                        Spacer(minLength: 30)
                    }
                    .padding(16)
                }
            } else if let error {
                EmptyHint(text: error)
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        .navigationTitle("我的邀请名片")
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
        .toast($toastMsg)
        .task {
            do { info = try await Api.request("/app/invite/mine") } catch { self.error = error.localizedDescription }
        }
    }

    @ViewBuilder
    private func card(_ info: InviteMine) -> some View {
        let qr = makeQRImage(info.link, size: 520)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                AvatarView(url: state.user?.avatar ?? "", size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text("心之音 · 专属名片").font(.system(size: 11)).foregroundStyle(Theme.textSub)
                    Text(state.user?.nickname ?? "").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.text)
                    Text("邀请码 \(info.code)").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
            }
            Text(isFemale
                 ? "发给男生：他打开网页能看到你的照片、价格和评分，下载后自动打开你的主页，第一条消息就是你的收入。"
                 : "发给女生：她打开网页能看到你的名片和在这里的收入方式，下载后自动和你成为好友。")
                .font(.system(size: 12)).foregroundStyle(Theme.textSub).lineSpacing(4)
                .padding(.top, 14)

            if let qr {
                HStack {
                    Spacer()
                    Image(uiImage: qr)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 178, height: 178)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 12).fill(.white))
                    Spacer()
                }
                .padding(.top, 16)
            }

            Button {
                UIPasteboard.general.string = info.link
                toastMsg = "链接已复制"
            } label: {
                HStack {
                    Text(info.link.replacingOccurrences(of: "https://", with: ""))
                        .font(.system(size: 13)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer()
                    Text("复制").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.accent)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg3))
            }
            .buttonStyle(.plain)
            .padding(.top, 14)

            HStack(spacing: 10) {
                Button {
                    if let qr {
                        UIImageWriteToSavedPhotosAlbum(qr, nil, nil, nil)
                        toastMsg = "已保存到相册"
                    }
                } label: {
                    Text("保存二维码").font(.system(size: 14)).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity).frame(height: 44)
                        .background(Capsule().fill(Theme.bg3))
                }
                .buttonStyle(.plain)
                Button {
                    ShareSheet.present([shareText + info.link])
                } label: {
                    Text("分享链接").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).frame(height: 44)
                        .background(Capsule().fill(Theme.accent))
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 12)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(LinearGradient(colors: [Color(red: 0.11, green: 0.07, blue: 0.10), Color(red: 0.07, green: 0.07, blue: 0.09)], startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.accent.opacity(0.45), lineWidth: 1))
    }

    private func stat(_ n: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(n).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.text)
            Text(label).font(.system(size: 11)).foregroundStyle(Theme.textSub)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.bg2))
    }
}
