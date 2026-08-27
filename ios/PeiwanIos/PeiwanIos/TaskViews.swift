import SwiftUI

private let taskStatus: [Int: (String, Color)] = [
    0: ("待接单", Theme.warn), 1: ("进行中", Theme.success),
    2: ("已完成", Theme.textSub), 3: ("已取消", Theme.textDim), 4: ("仲裁中", Theme.accent),
]

struct TaskStatusTag: View {
    let status: Int
    var body: some View {
        let (t, c) = taskStatus[status] ?? ("未知", Theme.textSub)
        Text(t).font(.system(size: 11)).foregroundStyle(c)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
    }
}

struct TaskCardView: View {
    let t: TaskOrder
    var body: some View {
        NavigationLink(value: Route.task(t.id)) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(t.title ?? "").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        TaskStatusTag(status: t.status ?? 0)
                    }
                    Text("\(t.cityName ?? "") · \(t.address ?? "")").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    Text("\(t.applyCount ?? 0) 人已报名").font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Spacer()
                Text(fmtPoints(t.reward)).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.accent)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }
}

/// 接单大厅（女生）
struct TaskHallView: View {
    @State private var items: [TaskOrder] = []
    var body: some View {
        Group {
            if items.isEmpty { EmptyHint(text: "暂无可接约单") }
            else { ScrollView { LazyVStack(spacing: 0) { ForEach(items) { TaskCardView(t: $0) } } } }
        }
        .fullBg()
        .navigationTitle("接单大厅")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .task { items = (try? await Api.request("/tasks/hall")) ?? [] }
    }
}

/// 我的约单 / 我的接单
struct TaskMineView: View {
    @EnvironmentObject var state: AppState
    @State private var items: [TaskOrder] = []
    private var isFemale: Bool { state.user?.gender == 2 }
    var body: some View {
        Group {
            if items.isEmpty { EmptyHint(text: "暂无记录") }
            else { ScrollView { LazyVStack(spacing: 0) { ForEach(items) { TaskCardView(t: $0) } } } }
        }
        .fullBg()
        .navigationTitle(isFemale ? "我的接单" : "我的约单")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .task { items = (try? await Api.request(isFemale ? "/tasks/taken" : "/tasks/mine")) ?? [] }
    }
}

/// 发布约单（男生）
struct TaskPostView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var meetAt = Date().addingTimeInterval(3600)
    @State private var city = ""
    @State private var address = ""
    @State private var reward = ""
    @State private var toastMsg: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                inputField("做什么，如 周末陪逛展", text: $title)
                DatePicker("时间", selection: $meetAt, in: Date()...)
                    .datePickerStyle(.compact)
                    .foregroundStyle(Theme.textSub)
                    .tint(Theme.accent)
                    .colorScheme(.dark)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                HStack {
                    TextField("", text: $city, prompt: Text("城市").foregroundColor(Theme.textDim))
                        .foregroundStyle(Theme.text)
                    Button("定位") {
                        CityLocator.shared.detect { name in
                            DispatchQueue.main.async { if let name { city = name } }
                        }
                    }
                    .font(.system(size: 13)).foregroundStyle(Theme.accent)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                inputField("地点", text: $address)
                TextField("", text: $reward, prompt: Text("报酬（积分）").foregroundColor(Theme.textDim))
                    .keyboardType(.decimalPad)
                    .foregroundStyle(Theme.text)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                AccentButton(title: "托管发布", enabled: !title.isEmpty && !city.isEmpty && !address.isEmpty && !reward.isEmpty) { post() }
                    .padding(.top, 6)
                Text("报酬冻结托管，完成后打给对方；发布后自动推送给同城用户")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle("发布约单")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toast($toastMsg)
    }

    private func inputField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundColor(Theme.textDim))
            .foregroundStyle(Theme.text)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
    }

    private func post() {
        Task {
            let iso = ISO8601DateFormatter().string(from: meetAt)
            let fen = toFen(reward)
            do {
                struct Empty: Codable { var id: String? }
                let _: Empty = try await Api.request("/tasks", method: "POST", body: [
                    "title": title, "meetAt": iso,
                    "cityCode": city, "cityName": city,
                    "address": address, "reward": "\(fen)",
                ])
                dismiss()
            } catch {
                toastMsg = error.localizedDescription
            }
        }
    }
}

/// 约单详情
struct TaskDetailView: View {
    let taskId: String
    @EnvironmentObject var state: AppState
    @State private var d: TaskDetailData?
    @State private var msg = ""
    @State private var toastMsg: String?

    private var isFemale: Bool { state.user?.gender == 2 }

    var body: some View {
        ScrollView {
            if let detail = d {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Text(detail.title ?? "").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
                            TaskStatusTag(status: detail.status ?? 0)
                        }
                        Text("时间：\(String((detail.meetAt ?? "").replacingOccurrences(of: "T", with: " ").prefix(16)))")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        Text("地点：\(detail.cityName ?? "") · \(detail.address ?? "")")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        Text("报酬：\(fmtPoints(detail.reward)) 积分（已托管）")
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                    if isFemale && detail.status == 0 && detail.isOwner != true {
                        TextField("", text: $msg, prompt: Text("报名留言（可选）").foregroundColor(Theme.textDim))
                            .foregroundStyle(Theme.text)
                            .padding(14)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                        AccentButton(title: "报名接单") {
                            Task {
                                do {
                                    struct Empty: Codable { var id: String? }
                                    let _: Empty = try await Api.request("/tasks/\(taskId)/apply", method: "POST", body: ["message": msg])
                                    toastMsg = "报名成功"
                                    await load()
                                } catch { toastMsg = error.localizedDescription }
                            }
                        }
                    }

                    if detail.isOwner == true && detail.status == 0 {
                        Text("报名列表（\(detail.applies?.count ?? 0)）")
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                            .padding(.vertical, 4)
                        ForEach(detail.applies ?? []) { a in
                            HStack(spacing: 10) {
                                AvatarView(url: a.user?.avatar, size: 42)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(a.user?.nickname ?? "").font(.system(size: 14)).foregroundStyle(Theme.text)
                                    if let m = a.message, !m.isEmpty {
                                        Text(m).font(.system(size: 12)).foregroundStyle(Theme.textSub)
                                    }
                                }
                                Spacer()
                                if a.status == 0 {
                                    Button {
                                        act("/tasks/\(taskId)/choose/\(a.id)")
                                    } label: {
                                        Text("选TA").font(.system(size: 13)).foregroundStyle(.white)
                                            .padding(.horizontal, 14).padding(.vertical, 6)
                                            .background(Capsule().fill(Theme.accent))
                                    }
                                    .buttonStyle(.plain)
                                } else if a.status == 1 {
                                    Text("已选中").font(.system(size: 12)).foregroundStyle(Theme.success)
                                }
                            }
                            .padding(.vertical, 8)
                        }
                        AccentButton(title: "取消约单") { act("/tasks/\(taskId)/cancel") }
                            .padding(.top, 10)
                    }

                    if detail.isOwner == true && detail.status == 1 {
                        AccentButton(title: "确认完成并结算") { act("/tasks/\(taskId)/finish") }
                            .padding(.top, 10)
                    }
                }
                .padding(16)
            }
        }
        .fullBg()
        .navigationTitle("约单详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toast($toastMsg)
        .task { await load() }
    }

    private func load() async {
        d = try? await Api.request("/tasks/\(taskId)")
    }

    private func act(_ path: String) {
        Task {
            do {
                struct Empty: Codable { var ok: Bool? }
                let _: Empty = try await Api.request(path, method: "POST")
                await load()
            } catch { toastMsg = error.localizedDescription }
        }
    }
}
