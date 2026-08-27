import SwiftUI

/// 花边新闻文章（列表项与详情共用，列表接口不返回 content）
struct NewsArticleModel: Codable, Identifiable {
    let id: String
    let title: String
    let summary: String?
    let tag: String?
    let content: String?
    let source: String?
    let sourceUrl: String?
    let createdAt: String?
}

/// 标签小徽章
private struct NewsTag: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.accent.opacity(0.45), lineWidth: 1))
    }
}

/// 励志行：一页一句、竖排、左右翻页（男看女生口吻鼓励，女看情感励志）
struct QuotesSectionView: View {
    struct QuoteItem: Codable, Identifiable {
        let id: String
        let day: String
        let text: String
    }

    @State private var items: [QuoteItem] = []
    @State private var loaded = false
    @State private var hasMore = false
    @State private var page = 0

    /// 与后端约定一致：按东八区算“今天”
    private var todayCN: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(secondsFromGMT: 8 * 3600)
        return f.string(from: Date())
    }

    var body: some View {
        Group {
            if loaded, items.isEmpty {
                EmptyHint(text: "今天的励志话正在路上…")
            } else {
                TabView(selection: $page) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { i, q in
                        QuotePageView(q: q, index: i, total: items.count, hasMore: hasMore, today: todayCN)
                            .tag(i)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .onChange(of: page) { _, i in
                    if hasMore, i >= items.count - 3 { Task { await loadMore() } }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await load(); loaded = true }
    }

    private func load() async {
        if let fresh: [QuoteItem] = try? await Api.request("/news/quotes") {
            items = fresh
            hasMore = fresh.count >= 30
        }
    }

    private func loadMore() async {
        guard let last = items.last else { return }
        if let more: [QuoteItem] = try? await Api.request("/news/quotes?beforeId=\(last.id)") {
            items += more
            hasMore = more.count >= 30
        } else {
            hasMore = false
        }
    }
}

/// 单页：竖排一句 + 书卷装饰
private struct QuotePageView: View {
    let q: QuotesSectionView.QuoteItem
    let index: Int
    let total: Int
    let hasMore: Bool
    let today: String

    private var artDay: String {
        let p = q.day.split(separator: "-").map(String.init)
        return p.count == 3 ? "\(p[0]) · \(p[1]) · \(p[2])" : q.day
    }

    /// 每列最多 11 字，从右往左排
    private var columns: [String] {
        let chars = Array(q.text)
        guard !chars.isEmpty else { return [] }
        let per = 11
        return stride(from: 0, to: chars.count, by: per).map {
            String(chars[$0 ..< min($0 + per, chars.count)])
        }
    }

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [Theme.accent.opacity(0.10), .clear],
                center: .center, startRadius: 20, endRadius: 220,
            )
            .frame(width: 260, height: 340)
            .allowsHitTesting(false)

            Rectangle()
                .fill(
                    LinearGradient(colors: [.clear, Theme.accent.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom),
                )
                .frame(width: 1)
                .padding(.vertical, 90)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 56)
                .allowsHitTesting(false)

            HStack(alignment: .top, spacing: 22) {
                ForEach(Array(columns.reversed().enumerated()), id: \.offset) { _, col in
                    VStack(spacing: 8) {
                        ForEach(Array(col.enumerated()), id: \.offset) { _, ch in
                            Text(String(ch))
                                .font(.custom("Songti SC", size: 22))
                                .foregroundStyle(Theme.text.opacity(0.92))
                        }
                    }
                }
            }

            VStack {
                HStack {
                    Spacer()
                    Text("「")
                        .font(.custom("Songti SC", size: 42))
                        .foregroundStyle(Theme.accent.opacity(0.38))
                        .padding(.trailing, 36).padding(.top, 28)
                }
                Spacer()
                HStack {
                    Text("」")
                        .font(.custom("Songti SC", size: 42))
                        .foregroundStyle(Theme.accent.opacity(0.38))
                        .padding(.leading, 36).padding(.bottom, 8)
                    Spacer()
                }
                HStack(spacing: 10) {
                    Text(artDay)
                        .font(.custom("Songti SC", size: 12))
                        .foregroundStyle(Theme.textSub)
                        .tracking(3)
                    if q.day == today {
                        Text("今日")
                            .font(.custom("Songti SC", size: 11))
                            .foregroundStyle(Theme.accent)
                            .tracking(2)
                    }
                }
                Text("\(index + 1) / \(total)\(hasMore ? "+" : "")")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textDim)
                    .tracking(2)
                    .padding(.top, 8).padding(.bottom, 22)
            }
        }
    }
}

/// 花边新闻列表页（消息页入口）
struct NewsListView: View {
    var body: some View {
        NewsSectionView()
            .fullBg()
            .navigationTitle("花边新闻")
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// 花边新闻列表（按性别分流，后端每小时采集更新）
struct NewsSectionView: View {
    @State private var items: [NewsArticleModel] = []
    @State private var loaded = false
    @State private var hasMore = false
    /// 有原文链接直接内部网页打开（与 AI 网页预览共用组件），AI 兜底文（无链接）才走解析详情页
    @State private var preview: NewsArticleModel?

    var body: some View {
        Group {
            if loaded, items.isEmpty {
                EmptyHint(text: "暂无内容\n稍后再来看看")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { n in
                            if let u = n.sourceUrl, URL(string: u) != nil {
                                Button { preview = n } label: { newsRow(n) }
                                    .buttonStyle(.plain)
                            } else {
                                NavigationLink(value: Route.newsDetail(n.id)) { newsRow(n) }
                                    .buttonStyle(.plain)
                            }
                        }
                        if hasMore {
                            Text("加载中…")
                                .font(.system(size: 12)).foregroundStyle(Theme.textDim)
                                .padding(14)
                                .onAppear { Task { await loadMore() } }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .task { await load(); loaded = true }
        .fullScreenCover(item: $preview) { n in
            WebPreviewSheet(url: URL(string: n.sourceUrl ?? ""), title: n.title)
        }
    }

    private func newsRow(_ n: NewsArticleModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(n.title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.leading)
            if let s = n.summary, !s.isEmpty {
                Text(s)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSub)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.top, 5)
            }
            HStack(spacing: 8) {
                if let t = n.tag, !t.isEmpty { NewsTag(text: t) }
                if let s = n.source, !s.isEmpty {
                    Text(s).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                }
                Text(timeAgo(n.createdAt))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textDim)
            }
            .padding(.top, 8)
            Rectangle().fill(Theme.line).frame(height: 1).padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 14)
    }

    private func load() async {
        if let fresh: [NewsArticleModel] = try? await Api.request("/news") {
            items = fresh
            hasMore = fresh.count >= 20
        }
    }

    private func loadMore() async {
        guard let last = items.last else { return }
        if let more: [NewsArticleModel] = try? await Api.request("/news?beforeId=\(last.id)") {
            items += more
            hasMore = more.count >= 20
        } else {
            hasMore = false
        }
    }
}

/// 热点文章详情
struct NewsDetailView: View {
    let newsId: String
    @State private var article: NewsArticleModel?

    var body: some View {
        Group {
            if let a = article {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(a.title)
                            .font(.system(size: 21, weight: .bold))
                            .foregroundStyle(Theme.text)
                        HStack(spacing: 8) {
                            if let t = a.tag, !t.isEmpty { NewsTag(text: t) }
                            if let s = a.source, !s.isEmpty {
                                Text(s).font(.system(size: 11)).foregroundStyle(Theme.textDim)
                            }
                            Text(timeAgo(a.createdAt))
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textDim)
                        }
                        .padding(.top, 10)
                        let paragraphs = (a.content ?? "")
                            .components(separatedBy: "\n")
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, p in
                            Text(p)
                                .font(.system(size: 15.5))
                                .foregroundStyle(Theme.text)
                                .lineSpacing(9)
                                .padding(.top, 14)
                        }
                        if let u = a.sourceUrl, let url = URL(string: u), !u.isEmpty {
                            Link("查看原文 ›", destination: url)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.accent)
                                .padding(.top, 10)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 40)
                }
            } else {
                EmptyHint(text: "加载中…")
            }
        }
        .fullBg()
        .navigationTitle("热点")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            article = try? await Api.request("/news/\(newsId)")
        }
    }
}
