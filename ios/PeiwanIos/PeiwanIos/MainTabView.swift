import SwiftUI

/// 主壳：广场 / 大厅 / + / 消息 / 我的（抖音式文字底栏）
struct MainTabView: View {
    @State private var tab = 0
    @State private var showPublish = false
    @State private var meKey = 0
    @State private var unreadTotal = 0
    @ObservedObject private var tabBarVis = TabBarVisibility.shared

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                PlazaView().opacity(tab == 0 ? 1 : 0).allowsHitTesting(tab == 0)
                HallView().opacity(tab == 1 ? 1 : 0).allowsHitTesting(tab == 1)
                MessagesView().opacity(tab == 2 ? 1 : 0).allowsHitTesting(tab == 2)
                // 每次切到「我的」重建刷新（余额/资料保持最新）
                MeView().id(meKey).opacity(tab == 3 ? 1 : 0).allowsHitTesting(tab == 3)
            }
            .frame(maxHeight: .infinity)

            // 有子页面被 push 时隐藏底栏（全屏沉浸）
            if tabBarVis.depth <= 0 {
                bottomBar
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .fullScreenCover(isPresented: $showPublish) {
            PublishView()
        }
        .task {
            await refreshUnread()
            _ = WsClient.shared.addListener { frame in
                let op = frame["op"] as? String
                if op == "msg" || op == "notify" {
                    Task { await refreshUnread() }
                }
            }
        }
        .onChange(of: tab) { _ in
            // 切换页面停止列表内正在播放的视频
            FeedVideoCenter.pauseCurrent()
            Task { await refreshUnread() }
        }
        .onChange(of: showPublish) { shown in
            if shown { FeedVideoCenter.pauseCurrent() }
        }
    }

    /// 未读总数（私聊+群聊+评论+接单）
    private func refreshUnread() async {
        let convs: [ConversationItem] = (try? await Api.request("/im/conversations")) ?? []
        let n: UnreadCounts = (try? await Api.request("/notifications/unread")) ?? UnreadCounts()
        unreadTotal = convs.reduce(0) { $0 + ($1.unread ?? 0) } + (n.comment ?? 0) + (n.task ?? 0)
    }

    private var bottomBar: some View {
        HStack(spacing: 0) {
            tabItem("广场", 0)
            tabItem("大厅", 1)
            Button { showPublish = true } label: {
                Text("+")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 30)
                    .background(RoundedRectangle(cornerRadius: 9).fill(Theme.accentGrad))
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            tabItem("消息", 2, badge: unreadTotal)
            tabItem("我的", 3)
        }
        .padding(.top, 10)
        .padding(.bottom, 4)
        .background(Theme.bg2.ignoresSafeArea(edges: .bottom))
    }

    private func tabItem(_ label: String, _ idx: Int, badge: Int = 0) -> some View {
        Button {
            if idx == 3 && tab != 3 { meKey += 1 }
            tab = idx
        } label: {
            ZStack(alignment: .topTrailing) {
                Text(label)
                    .font(.system(size: 15, weight: tab == idx ? .bold : .regular))
                    .foregroundStyle(tab == idx ? Theme.text : Theme.textSub)
                if badge > 0 {
                    // 未读角标（红色正圆数字）
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .font(.system(size: 9)).foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 15, minHeight: 15)
                        .background(Capsule().fill(Theme.accent))
                        .offset(x: 16, y: -8)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}
