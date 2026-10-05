import SwiftUI

private func taskStatus(_ s: Int) -> (String, Color) {
    switch s {
    case 0: return (t("task.status.pending"), Theme.warn)
    case 1: return (t("task.status.ongoing"), Theme.success)
    case 2: return (t("task.status.completed"), Theme.textSub)
    case 3: return (t("task.status.cancelled"), Theme.textDim)
    case 4: return (t("task.status.arbitrating"), Theme.accent)
    default: return (t("task.status.unknown"), Theme.textSub)
    }
}

struct TaskStatusTag: View {
    let status: Int
    var body: some View {
        let (label, c) = taskStatus(status)
        Text(label).font(.system(size: 11)).foregroundStyle(c)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bg3))
    }
}

struct TaskCardView: View {
    let t: TaskOrder
    var body: some View {
        RouteLink(.task(t.id)) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(t.title ?? "").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        TaskStatusTag(status: t.status ?? 0)
                    }
                    Text("\(t.cityName ?? "") · \(t.address ?? "")").font(.system(size: 12)).foregroundStyle(Theme.textSub)
                    Text(PeiwanIos.t("task.card.applyCount", ["n": t.applyCount ?? 0])).font(.system(size: 11)).foregroundStyle(Theme.textDim)
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
            if items.isEmpty { EmptyHint(text: t("task.hall.empty")) }
            else { ScrollView { LazyVStack(spacing: 0) { ForEach(items) { TaskCardView(t: $0) } } } }
        }
        .fullBg()
        .navigationTitle(t("task.hall.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
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
            if items.isEmpty { EmptyHint(text: t("task.mine.empty")) }
            else { ScrollView { LazyVStack(spacing: 0) { ForEach(items) { TaskCardView(t: $0) } } } }
        }
        .fullBg()
        .navigationTitle(isFemale ? t("me.myTasksGuide") : t("me.myTasks"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
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
                inputField(t("task.post.titleHint"), text: $title)
                DatePicker(t("task.post.time"), selection: $meetAt, in: Date()...)
                    .datePickerStyle(.compact)
                    .foregroundStyle(Theme.textSub)
                    .tint(Theme.accent)
                    .colorScheme(.light)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                HStack {
                    TextField("", text: $city, prompt: Text(t("task.post.city")).foregroundColor(Theme.textDim))
                        .foregroundStyle(Theme.text)
                    Button(t("profile.locate")) {
                        CityLocator.shared.detect { name in
                            DispatchQueue.main.async { if let name { city = name } }
                        }
                    }
                    .font(.system(size: 13)).foregroundStyle(Theme.accent)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                inputField(t("task.post.place"), text: $address)
                TextField("", text: $reward, prompt: Text(t("task.post.reward")).foregroundColor(Theme.textDim))
                    .keyboardType(.decimalPad)
                    .foregroundStyle(Theme.text)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                AccentButton(title: t("task.post.submit"), enabled: !title.isEmpty && !city.isEmpty && !address.isEmpty && !reward.isEmpty) { post() }
                    .padding(.top, 6)
                Text(t("task.post.hint"))
                    .font(.system(size: 12)).foregroundStyle(Theme.textSub)
            }
            .padding(16)
        }
        .fullBg()
        .navigationTitle(t("task.post.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
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
                        let meetTime = String((detail.meetAt ?? "").replacingOccurrences(of: "T", with: " ").prefix(16))
                        let rewardText = t("task.detail.rewardLabel") + t("task.pointsN", ["n": fmtPoints(detail.reward)]) + t("task.detail.escrowed")
                        Text(t("task.detail.time", ["time": meetTime]))
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        Text(t("task.detail.place", ["city": detail.cityName ?? "", "address": detail.address ?? ""]))
                            .font(.system(size: 13)).foregroundStyle(Theme.textSub)
                        Text(rewardText)
                            .font(.system(size: 13)).foregroundStyle(Theme.accent)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))

                    if isFemale && detail.status == 0 && detail.isOwner != true {
                        TextField("", text: $msg, prompt: Text(t("task.detail.applyMsg")).foregroundColor(Theme.textDim))
                            .foregroundStyle(Theme.text)
                            .padding(14)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.bg2))
                        AccentButton(title: t("task.detail.apply")) {
                            Task {
                                do {
                                    struct Empty: Codable { var id: String? }
                                    let _: Empty = try await Api.request("/tasks/\(taskId)/apply", method: "POST", body: ["message": msg])
                                    toastMsg = t("task.detail.applyOk")
                                    await load()
                                } catch { toastMsg = error.localizedDescription }
                            }
                        }
                    }

                    if detail.isOwner == true && detail.status == 0 {
                        Text(t("task.detail.applicants", ["n": detail.applies?.count ?? 0]))
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
                                        Text(t("task.detail.choose")).font(.system(size: 13)).foregroundStyle(.white)
                                            .padding(.horizontal, 14).padding(.vertical, 6)
                                            .background(Capsule().fill(Theme.accent))
                                    }
                                    .buttonStyle(.plain)
                                } else if a.status == 1 {
                                    Text(t("task.detail.chosen")).font(.system(size: 12)).foregroundStyle(Theme.success)
                                }
                            }
                            .padding(.vertical, 8)
                        }
                        AccentButton(title: t("task.detail.cancel")) { act("/tasks/\(taskId)/cancel") }
                            .padding(.top, 10)
                    }

                    if detail.isOwner == true && detail.status == 1 {
                        AccentButton(title: t("task.detail.finish")) { act("/tasks/\(taskId)/finish") }
                            .padding(.top, 10)
                    }
                }
                .padding(16)
            }
        }
        .fullBg()
        .navigationTitle(t("task.detail.title"))
        .navigationBarTitleDisplayMode(.inline)
        .compatNavBarBackground(Theme.bg)
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
