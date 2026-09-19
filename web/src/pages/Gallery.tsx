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

/** 灯箱里的一个视频：滚到可见才播、滑走暂停 */
function LightboxVideo({ m }: { m: GalleryMedia }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.intersectionRatio > 0.6) el.play().catch(() => {}); else el.pause(); });
    }, { threshold: [0, 0.6] });
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return <video ref={ref} src={full(m.url)} poster={m.cover ? full(m.cover) : undefined} controls playsInline loop onClick={(e) => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%' }} />;
}

/**
 * 网页灯箱（浏览器用；App 内走原生查看器）：
 * 上下滑切帖子、左右滑切同一帖里的多张图（scroll-snap），视频滑到就播；点空白关闭。
 */
function MediaLightbox({ groups, group, index, onClose }: { groups: GalleryMedia[][]; group: number; index: number; onClose: () => void }) {
  const outer = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ g: group, i: index });

  // 打开时定位到点开的那条 / 那张
  useEffect(() => {
    const o = outer.current;
    if (!o) return;
    o.scrollTop = group * o.clientHeight;
    const row = o.children[group] as HTMLElement | undefined;
    if (row) row.scrollLeft = index * row.clientWidth;
  }, []);

  const onScroll = () => {
    const o = outer.current;
    if (!o) return;
    const g = Math.round(o.scrollTop / o.clientHeight);
    const row = o.children[g] as HTMLElement | undefined;
    const i = row ? Math.round(row.scrollLeft / row.clientWidth) : 0;
    if (g !== pos.g || i !== pos.i) setPos({ g, i });
  };

  const cur = groups[pos.g] ?? [];
  return (
    <div className="gl-lightbox" ref={outer} onScroll={onScroll} onClick={onClose}>
      {groups.map((items, g) => (
        <div key={g} className="gl-lb-row" onScroll={onScroll}>
          {items.map((m, i) => (
            <div key={i} className="gl-lb-cell">
              {m.type === 'video' ? <LightboxVideo m={m} /> : <img src={full(m.url)} alt="" loading={Math.abs(g - pos.g) <= 1 ? 'eager' : 'lazy'} />}
            </div>
          ))}
        </div>
      ))}
      <span onClick={onClose} className="gl-lb-close">×</span>
      <span className="gl-lb-counter">
        {groups.length > 1 && <>{pos.g + 1} / {groups.length} 条</>}
        {cur.length > 1 && <>{groups.length > 1 ? ' · ' : ''}{pos.i + 1} / {cur.length}</>}
      </span>
    </div>
  );
}

/** 灯箱要打开的位置：第几条帖子的第几个媒体 */
type OpenPos = { g: number; i: number };

function GalleryCard({ post, channel, onOpen }: { post: GalleryPost; channel: string; onOpen: (i: number) => void }) {
  const open = (i: number) => onOpen(i);
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
    </div>
  );
}

/**
 * 大厅「养眼图片」tab（名称后台可改，男女分开）：按性别分流的图片/视频流。
 * 像 Telegram 聊天记录：**最新的在最底部**，打开自动滚到底；往上滑到顶附近自动加载更早的（保持视口不跳）；下拉刷新拉最新。
 */
export function GalleryFeed() {
  const [data, setData] = useState<GalleryList | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const topSentinel = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 首次加载 / 刷新后需要滚到底 */
  const scrollToBottom = useRef(false);
  /** 往上加载更早内容前记录的滚动高度，加载后按增量补回，画面不跳 */
  const prependAnchor = useRef<{ top: number; height: number } | null>(null);
  /** 首次滚到底完成前不触发「加载更早」，避免顶部哨兵一出现就连着翻页 */
  const ready = useRef(false);

  const scroller = () => (rootRef.current?.closest('.page') as HTMLElement | null);

  const load = async () => {
    const d = await api<GalleryList>('/gallery').catch(() => null);
    scrollToBottom.current = true;
    if (d) { setData(d); setHasMore(d.list.length >= 20); }
    else setData({ title: '养眼图片', days: 3, source: null, list: [] });
  };
  const loadOlder = async () => {
    if (loadingMore || !hasMore || !data?.list.length) return;
    setLoadingMore(true);
    const s = scroller();
    if (s) prependAnchor.current = { top: s.scrollTop, height: s.scrollHeight };
    const last = data.list[data.list.length - 1].id; // 接口按 id 倒序，末尾是最早的
    const d = await api<GalleryList>(`/gallery?beforeId=${last}`).catch(() => null);
    if (d) {
      setData((prev) => (prev ? { ...prev, list: [...prev.list, ...d.list] } : d));
      setHasMore(d.list.length >= 20);
    }
    setLoadingMore(false);
  };

  useEffect(() => { load(); }, []);

  // 数据变化后：首次/刷新 → 滚到底；往上加载 → 补回高度增量
  useEffect(() => {
    const s = scroller();
    if (!s || !data) return;
    if (scrollToBottom.current) {
      scrollToBottom.current = false;
      // 图片懒加载会撑高，连续几帧滚到底
      let n = 0;
      const tick = () => { s.scrollTop = s.scrollHeight; if (++n < 6) requestAnimationFrame(tick); else ready.current = true; };
      requestAnimationFrame(tick);
    } else if (prependAnchor.current) {
      const a = prependAnchor.current;
      prependAnchor.current = null;
      s.scrollTop = a.top + (s.scrollHeight - a.height);
    }
  }, [data]);

  // 滚到顶附近自动加载更早的
  useEffect(() => {
    const el = topSentinel.current;
    if (!el) return;
    const ob = new IntersectionObserver((es) => { if (ready.current && es.some((e) => e.isIntersecting)) loadOlder(); }, { rootMargin: '300px' });
    ob.observe(el);
    return () => ob.disconnect();
  }, [data, hasMore, loadingMore]);

  // 渲染顺序：最早 → 最新（最新在最底部）
  const ordered = data ? [...data.list].reverse() : [];

  // 查看器：把整个信息流的媒体按显示顺序交过去，上下滑就能连着看
  const [view, setView] = useState<OpenPos | null>(null);
  const openAt = (g: number, i: number) => {
    const groups: NativeMediaItem[][] = ordered.map((p) => p.media.map((m) => ({ type: m.type, url: full(m.url), cover: m.cover ? full(m.cover) : undefined })));
    if (viewNativeMedia(groups, g, i)) return; // App 内：原生全屏查看器
    setView({ g, i });
  };

  return (
    <PullToRefresh onRefresh={load}>
      {view && <MediaLightbox groups={ordered.map((p) => p.media)} group={view.g} index={view.i} onClose={() => setView(null)} />}
      <div ref={rootRef}>
        {!data && <div className="empty">加载中…</div>}
        {data && data.list.length === 0 && <div className="empty">最近 {data.days} 天还没有内容<br />稍后再来看看</div>}
        <div ref={topSentinel} style={{ height: 1 }} />
        {loadingMore && <div className="small" style={{ textAlign: 'center', padding: 12 }}>加载更早的…</div>}
        {data && data.list.length > 0 && !hasMore && (
          <div className="small" style={{ textAlign: 'center', padding: '6px 0 8px' }}>只保留最近 {data.days} 天 · 已经是最早的了</div>
        )}
        {/* 卡片不显示频道名（频道名多带引流字样），与 Telegram 帖子样式一致 */}
        {ordered.map((p, g) => <GalleryCard key={p.id} post={p} channel="" onOpen={(i) => openAt(g, i)} />)}
      </div>
    </PullToRefresh>
  );
}
