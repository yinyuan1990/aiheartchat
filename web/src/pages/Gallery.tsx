import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { viewNativeMedia, type NativeMediaItem } from '../bridge';
import { PullToRefresh } from '../components/PullToRefresh';
import { fmtCount, fmtTime } from './Treehole';

export interface GalleryMedia {
  type: 'image' | 'video';
  url: string;
  cover?: string;
  w: number;
  h: number;
  duration?: number;
  size: number;
}

interface GalleryPost {
  id: string;
  text: string;
  media: GalleryMedia[];
  viewCount: number;
  postedAt: string;
}

interface GalleryList {
  title: string;
  days: number;
  source: { title: string } | null;
  list: GalleryPost[];
}

const full = (u: string) => (u.startsWith('http') ? u : 'https://api.yyheart.com' + u);

function fmtDur(s?: number): string {
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 单元格：图片直接显示；视频显示封面 + 左上时长 + 中间播放键。全部懒加载 */
function Cell({ m, onOpen, style }: { m: GalleryMedia; onOpen: () => void; style?: React.CSSProperties }) {
  const src = m.type === 'video' ? (m.cover ? full(m.cover) : '') : full(m.url);
  return (
    <div className="gl-cell" style={style} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <div className="gl-cell-blank" />}
      {m.type === 'video' && (
        <>
          <span className="gl-dur">{fmtDur(m.duration) || '视频'}</span>
          <span className="gl-play">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Telegram 式相册拼贴：1 张按原比例通栏；2 张两列；3 张上一大下两小；4 张 2×2；
 * 5 张以上：首行 2 张、其余每行 3 张。单元格统一正方形裁切。
 */
function Mosaic({ media, onOpen }: { media: GalleryMedia[]; onOpen: (i: number) => void }) {
  const n = media.length;
  if (n === 0) return null;
  if (n === 1) {
    const m = media[0];
    const ratio = m.w && m.h ? Math.min(1.5, Math.max(0.62, m.w / m.h)) : 1;
    return <Cell m={m} onOpen={() => onOpen(0)} style={{ aspectRatio: String(ratio), maxHeight: 480 }} />;
  }
  // 6 列网格：span 6 = 整行，3 = 半行，2 = 三分之一
  const spans: number[] = [];
  if (n === 2) spans.push(3, 3);
  else if (n === 3) spans.push(6, 3, 3);
  else if (n === 4) spans.push(3, 3, 3, 3);
  else {
    spans.push(3, 3);
    let rest = n - 2;
    while (rest > 0) {
      if (rest === 4) { spans.push(3, 3, 3, 3); rest = 0; }
      else if (rest === 2) { spans.push(3, 3); rest = 0; }
      else if (rest === 1) { spans.push(6); rest = 0; }
      else { spans.push(2, 2, 2); rest -= 3; }
    }
  }
  return (
    <div className="gl-grid">
      {media.map((m, i) => (
        <Cell key={i} m={m} onOpen={() => onOpen(i)} style={{ gridColumn: `span ${spans[i] ?? 2}`, aspectRatio: spans[i] === 6 ? '16 / 10' : '1' }} />
      ))}
    </div>
  );
}

/** 网页灯箱（浏览器用；App 内走原生查看器）：左右点击翻页，视频用 <video controls> */
function MediaLightbox({ items, index, onClose }: { items: GalleryMedia[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const m = items[i];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.96)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {m.type === 'video' ? (
        <video key={m.url} src={full(m.url)} poster={m.cover ? full(m.cover) : undefined} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      ) : (
        <img key={m.url} src={full(m.url)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      )}
      <span onClick={onClose} style={{ position: 'absolute', top: 'calc(12px + env(safe-area-inset-top))', right: 14, width: 34, height: 34, borderRadius: 17, background: 'rgba(255,255,255,0.15)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>×</span>
      {items.length > 1 && (
        <>
          <span style={{ position: 'absolute', top: 'calc(20px + env(safe-area-inset-top))', left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 13 }}>{i + 1} / {items.length}</span>
          <span onClick={(e) => { e.stopPropagation(); setI((i - 1 + items.length) % items.length); }} style={{ position: 'absolute', left: 0, top: 80, bottom: 80, width: '28%' }} />
          <span onClick={(e) => { e.stopPropagation(); setI((i + 1) % items.length); }} style={{ position: 'absolute', right: 0, top: 80, bottom: 80, width: '28%' }} />
        </>
      )}
    </div>
  );
}

function GalleryCard({ post, channel }: { post: GalleryPost; channel: string }) {
  const [view, setView] = useState<number | null>(null);
  const open = (i: number) => {
    const items: NativeMediaItem[] = post.media.map((m) => ({ type: m.type, url: full(m.url), cover: m.cover ? full(m.cover) : undefined }));
    // App 内：原生全屏查看器（缩放 / 原生播放器）；浏览器：网页灯箱
    if (viewNativeMedia(items, i)) return;
    setView(i);
  };
  return (
    <div className="th-card gl-card">
      {channel && <div className="th-channel">{channel}</div>}
      <Mosaic media={post.media} onOpen={open} />
      {post.text && <div className="th-content" style={{ marginTop: 8 }}>{post.text}</div>}
      <div className="th-meta">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <svg width="13" height="10" viewBox="0 0 24 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round"><path d="M1 8C5 1.5 19 1.5 23 8C19 14.5 5 14.5 1 8Z" /><circle cx="12" cy="8" r="3.4" fill="currentColor" stroke="none" /></svg>
          {fmtCount(post.viewCount)}
        </span>
        <span>{fmtTime(post.postedAt)}</span>
      </div>
      {view != null && <MediaLightbox items={post.media} index={view} onClose={() => setView(null)} />}
    </div>
  );
}

/** 大厅「养眼图片」tab（名称后台可改）：按性别分流的图片/视频流，下拉刷新 + 滚到底自动加载 */
export function GalleryFeed() {
  const [data, setData] = useState<GalleryList | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = async () => {
    const d = await api<GalleryList>('/gallery').catch(() => null);
    if (d) { setData(d); setHasMore(d.list.length >= 20); }
    else setData({ title: '养眼图片', days: 3, source: null, list: [] });
  };
  const loadMore = async () => {
    if (loadingMore || !hasMore || !data?.list.length) return;
    setLoadingMore(true);
    const last = data.list[data.list.length - 1].id;
    const d = await api<GalleryList>(`/gallery?beforeId=${last}`).catch(() => null);
    if (d) {
      setData((prev) => (prev ? { ...prev, list: [...prev.list, ...d.list] } : d));
      setHasMore(d.list.length >= 20);
    }
    setLoadingMore(false);
  };

  useEffect(() => { load(); }, []);

  // 滚到底自动加载下一页
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const ob = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '400px' });
    ob.observe(el);
    return () => ob.disconnect();
  }, [data, hasMore, loadingMore]);

  return (
    <PullToRefresh onRefresh={load}>
      {!data && <div className="empty">加载中…</div>}
      {data && data.list.length === 0 && <div className="empty">最近 {data.days} 天还没有内容<br />稍后再来看看</div>}
      {data && data.list.length > 0 && (
        <div className="small" style={{ padding: '6px 0 8px' }}>只保留最近 {data.days} 天</div>
      )}
      {/* 卡片不显示频道名（频道名多带引流字样），与 Telegram 帖子样式一致 */}
      {data?.list.map((p) => <GalleryCard key={p.id} post={p} channel="" />)}
      <div ref={sentinel} style={{ height: 1 }} />
      {loadingMore && <div className="small" style={{ textAlign: 'center', padding: 12 }}>加载中…</div>}
    </PullToRefresh>
  );
}
