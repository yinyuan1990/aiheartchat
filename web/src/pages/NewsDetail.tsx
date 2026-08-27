import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { WebPreview } from '../components/WebPreview';

interface NewsItem {
  id: string;
  title: string;
  summary: string;
  tag: string;
  source: string;
  sourceUrl: string;
  createdAt: string;
}

interface NewsArticle extends NewsItem {
  content: string;
  sourceUrl: string;
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function TagChip({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid rgba(254,44,85,0.45)', borderRadius: 4, padding: '1px 5px' }}>{text}</span>
  );
}

/** 花边新闻列表（消息页入口，按性别分流，后端每小时采集更新） */
export function NewsListPage() {
  const PAGE = 20;
  const nav = useNavigate();
  const [list, setList] = useState<NewsItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState<NewsItem | null>(null);

  const fetchPage = async (beforeId?: string) => {
    const rows = await api<NewsItem[]>(`/news${beforeId ? `?beforeId=${beforeId}` : ''}`);
    setHasMore(rows.length >= PAGE);
    setList((prev) => (beforeId ? [...prev, ...rows] : rows));
  };

  useEffect(() => {
    fetchPage().catch(() => {}).finally(() => setLoaded(true));
  }, []);

  const loadMore = async () => {
    if (loadingMore || !list.length) return;
    setLoadingMore(true);
    await fetchPage(list[list.length - 1].id).catch(() => {});
    setLoadingMore(false);
  };

  // 有原文链接直接内部网页打开（与 AI 网页预览共用组件），AI 兜底文（无链接）才走解析详情页
  const open = (n: NewsItem) => {
    if (n.sourceUrl) setPreview(n);
    else nav(`/news/${n.id}`);
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">花边新闻</span>
        <span style={{ width: 20 }} />
      </div>
      <div className="page">
        {loaded && list.length === 0 && <div className="empty">暂无内容，稍后再来看看</div>}
        {list.map((n) => (
          <div key={n.id} style={{ padding: '14px 16px 0', cursor: 'pointer' }} onClick={() => open(n)}>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.5 }}>{n.title}</div>
            {n.summary && (
              <div className="muted" style={{ marginTop: 5, lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {n.summary}
              </div>
            )}
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <TagChip text={n.tag} />
              {n.source && <span className="small">{n.source}</span>}
              <span className="small">{formatAgo(n.createdAt)}</span>
            </div>
            <div style={{ borderBottom: '1px solid var(--line)', marginTop: 14 }} />
          </div>
        ))}
        {hasMore && (
          <div className="small" style={{ textAlign: 'center', padding: 14, cursor: 'pointer', color: 'var(--text-2)' }} onClick={loadMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </div>
        )}
      </div>
      {preview && <WebPreview url={preview.sourceUrl} title={preview.title} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** 花边新闻详情 */
export function NewsDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [article, setArticle] = useState<NewsArticle | null>(null);

  useEffect(() => {
    if (id) api<NewsArticle>(`/news/${id}`).then(setArticle).catch(() => {});
  }, [id]);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">花边新闻</span>
        <span style={{ width: 20 }} />
      </div>
      <div className="page" style={{ padding: '18px 16px 40px' }}>
        {!article ? (
          <div className="empty">加载中…</div>
        ) : (
          <>
            <h2 style={{ fontSize: 21, lineHeight: 1.45, fontWeight: 700 }}>{article.title}</h2>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <TagChip text={article.tag} />
              {article.source && <span className="small">{article.source}</span>}
              <span className="small">{new Date(article.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style={{ marginTop: 18 }}>
              {article.content.split(/\n+/).filter(Boolean).map((p, i) => (
                <p key={i} style={{ fontSize: 15.5, lineHeight: 1.9, color: 'var(--text)', marginBottom: 14, textAlign: 'justify' }}>{p}</p>
              ))}
            </div>
            {article.sourceUrl && (
              <a
                href={article.sourceUrl}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'inline-block', marginTop: 6, fontSize: 13, color: 'var(--accent)' }}
              >
                查看原文 ›
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
