import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { isEmbedded } from '../bridge';
import { PullToRefresh } from '../components/PullToRefresh';

/** 私密树洞帖子（匿名，无作者信息） */
export interface TreeholePost {
  id: string;
  content: string;
  /** 配图（最多 9 张） */
  images: string[];
  /** 0=用户投稿 1=后台录入 2=Telegram 同步 */
  source: number;
  viewCount: number;
  commentCount: number;
  commenters: { avatar: string }[];
  mine: boolean;
  createdAt: string;
}

interface TreeholeComment {
  id: string;
  user: { id: string; nickname: string; avatar: string };
  content: string;
  replyToId: string | null;
  replyToNickname: string;
  createdAt: string;
}

const CHANNEL_NAME = '私密树洞';
const NAME_COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4dd0e1', '#f06292', '#aed581'];

/** 阅读数：1234 → 1.2K，12345 → 1.2万 */
export function fmtCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** 时间：今天只显示 HH:mm，今年显示 M月d日 HH:mm，更早带年份 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function nameColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

/** Telegram 频道式帖子卡：频道名 + 正文 + 阅读/时间 + 评论条 */
const full = (u: string) => (u.startsWith('http') ? u : 'https://api.yyheart.com' + u);

/** 配图：1 张通栏（Telegram 式），2–9 张网格；点图放大 */
function TreeholeImages({ images, onView }: { images: string[]; onView: (i: number) => void }) {
  if (!images?.length) return null;
  if (images.length === 1) {
    return <img className="th-img-single" src={full(images[0])} alt="" onClick={(e) => { e.stopPropagation(); onView(0); }} />;
  }
  return (
    <div className={`th-img-grid ${images.length === 2 || images.length === 4 ? 'c2' : 'c3'}`}>
      {images.map((u, i) => <img key={u} src={full(u)} alt="" onClick={(e) => { e.stopPropagation(); onView(i); }} />)}
    </div>
  );
}

/** 全屏看图：左右翻页 */
function ImageLightbox({ images, index, onClose }: { images: string[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.96)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src={full(images[i])} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      {images.length > 1 && (
        <>
          <span style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 13 }}>{i + 1} / {images.length}</span>
          <span onClick={(e) => { e.stopPropagation(); setI((i - 1 + images.length) % images.length); }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '30%' }} />
          <span onClick={(e) => { e.stopPropagation(); setI((i + 1) % images.length); }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '30%' }} />
        </>
      )}
    </div>
  );
}

function TreeholeCard({ post, clamp, onOpen }: { post: TreeholePost; clamp: boolean; onOpen?: () => void }) {
  const [view, setView] = useState<number | null>(null);
  return (
    <div className="th-card">
      <div className="th-channel">{CHANNEL_NAME}</div>
      <TreeholeImages images={post.images ?? []} onView={setView} />
      {post.content && (
        <div className={`th-content${clamp ? ' clamp' : ''}`} onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
          {post.content}
        </div>
      )}
      {view != null && <ImageLightbox images={post.images} index={view} onClose={() => setView(null)} />}
      <div className="th-meta">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <svg width="13" height="10" viewBox="0 0 24 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round"><path d="M1 8C5 1.5 19 1.5 23 8C19 14.5 5 14.5 1 8Z" /><circle cx="12" cy="8" r="3.4" fill="currentColor" stroke="none" /></svg>
          {fmtCount(post.viewCount)}
        </span>
        <span>{fmtTime(post.createdAt)}</span>
      </div>
      {onOpen && (
        <div className="th-comments-bar" onClick={onOpen}>
          {post.commenters.length > 0 && (
            <div className="th-avatars">
              {post.commenters.map((c, i) => (
                <div key={i} className="avatar">{c.avatar && <img src={c.avatar} alt="" />}</div>
              ))}
            </div>
          )}
          <span className="th-label" style={post.commenters.length ? { marginLeft: 8 } : undefined}>
            {post.commentCount > 0 ? `${post.commentCount} 条评论` : '发表评论'}
          </span>
          <span className="th-chevron">›</span>
        </div>
      )}
    </div>
  );
}

/** 大厅「私密树洞」tab：信息流 + 右下角发布按钮 */
export function TreeholeFeed() {
  const nav = useNavigate();
  const [posts, setPosts] = useState<TreeholePost[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 频道式排序：最新在最底部，进入时停在底部；顶部「加载更早」时保持当前阅读位置不跳
  const anchorRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<'bottom' | { keepHeight: number } | null>(null);
  const scroller = () => (anchorRef.current?.closest('.page') as HTMLElement | null);

  const load = async (more = false) => {
    const before = more && posts.length ? `?beforeId=${posts[posts.length - 1].id}` : '';
    try {
      const list = await api<TreeholePost[]>(`/treehole${before}`);
      const el = scroller();
      pendingScroll.current = more ? { keepHeight: el?.scrollHeight ?? 0 } : 'bottom';
      setPosts((prev) => (more ? [...prev, ...list] : list));
      setHasMore(list.length >= 20);
    } catch {
      /* 保持已有内容 */
    } finally {
      setLoaded(true);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const el = scroller();
    const p = pendingScroll.current;
    if (!el || !p) return;
    pendingScroll.current = null;
    if (p === 'bottom') el.scrollTop = el.scrollHeight;
    else el.scrollTop += el.scrollHeight - p.keepHeight;
  }, [posts]);

  return (
    <PullToRefresh onRefresh={() => load()}>
      <div ref={anchorRef} />
      {hasMore && (
        <div className="hint" style={{ cursor: 'pointer', padding: '10px 0 14px' }} onClick={() => { setLoadingMore(true); load(true); }}>
          {loadingMore ? '加载中…' : '查看更早的树洞'}
        </div>
      )}
      {[...posts].reverse().map((p) => (
        <TreeholeCard key={p.id} post={p} clamp onOpen={() => nav(`/treehole/${p.id}`)} />
      ))}
      {loaded && posts.length === 0 && (
        <div className="empty">树洞还是空的<br />说点只想让陌生人听见的话吧<br /><span className="small">下拉可刷新</span></div>
      )}
      <div style={{ height: 72 }} />
      <button
        className="th-fab"
        style={{ bottom: isEmbedded() ? 'calc(20px + env(safe-area-inset-bottom))' : 'calc(74px + env(safe-area-inset-bottom))' }}
        onClick={() => nav('/treehole/publish')}
      >
        ✎ 写树洞
      </button>
    </PullToRefresh>
  );
}

/** 树洞详情：帖子 + 讨论（评论）+ 底部输入 */
export function TreeholeDetailPage() {
  const nav = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [post, setPost] = useState<TreeholePost | null>(null);
  const [comments, setComments] = useState<TreeholeComment[]>([]);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; nickname: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(''), 1600);
  };

  const loadComments = () => api<TreeholeComment[]>(`/treehole/${id}/comments`).then(setComments).catch(() => {});

  useEffect(() => {
    api<TreeholePost>(`/treehole/${id}`)
      .then(setPost)
      .catch((e) => {
        alert(e.message);
        nav(-1);
      });
    loadComments();
  }, [id]);

  const send = async () => {
    const content = input.trim();
    if (!content) return;
    setBusy(true);
    try {
      await api(`/treehole/${id}/comments`, { method: 'POST', body: { content, replyToId: replyTo?.id } });
      setInput('');
      setReplyTo(null);
      await loadComments();
      setPost((p) => (p ? { ...p, commentCount: p.commentCount + 1 } : p));
      // 滚到底部看到自己的评论
      setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }), 50);
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('删除这条树洞？评论也会一起消失')) return;
    try {
      await api(`/treehole/${id}`, { method: 'DELETE' });
      nav(-1);
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const startReply = (c: TreeholeComment) => {
    setReplyTo({ id: c.id, nickname: c.user.nickname });
    inputRef.current?.focus();
  };

  if (!post) return <div className="app"><div className="empty">加载中…</div></div>;

  return (
    <div className="app">
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">{post.commentCount > 0 ? `${post.commentCount} 条评论` : CHANNEL_NAME}</span>
        {post.mine ? <span className="action" style={{ color: 'var(--text-2)' }} onClick={remove}>删除</span> : <span style={{ width: 40 }} />}
      </div>

      <div ref={listRef} className="page no-scrollbar" style={{ padding: '0 14px' }}>
        <TreeholeCard post={post} clamp={false} />

        <div className="th-divider"><span>{comments.length > 0 ? '讨论已开始' : '还没有人评论，来说第一句'}</span></div>

        {comments.map((c) => (
          <div key={c.id} className="th-comment">
            <div className="avatar">{c.user.avatar && <img src={c.user.avatar} alt="" />}</div>
            <div className="bubble">
              <div className="name" style={{ color: nameColor(c.user.id) }}>{c.user.nickname}</div>
              <div className="text">
                {c.replyToNickname && <span style={{ color: '#5aa9ff' }}>@{c.replyToNickname} </span>}
                {c.content}
              </div>
              <div className="time">
                <span className="reply" onClick={() => startReply(c)}>回复</span>
                {fmtTime(c.createdAt)}
              </div>
            </div>
          </div>
        ))}
        <div style={{ height: 12 }} />
      </div>

      {replyTo && (
        <div className="row" style={{ padding: '6px 16px' }}>
          <span className="small grow">回复 <span className="accent">@{replyTo.nickname}</span></span>
          <span className="small" style={{ cursor: 'pointer' }} onClick={() => setReplyTo(null)}>取消</span>
        </div>
      )}

      <div className="row" style={{ padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--line)', gap: 8 }}>
        <input
          ref={inputRef}
          className="input grow"
          style={{ marginBottom: 0, padding: '10px 14px' }}
          value={input}
          maxLength={500}
          placeholder={replyTo ? `回复 @${replyTo.nickname}` : '说点什么…（评论会显示你的昵称）'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn-sm" disabled={busy || !input.trim()} onClick={send}>发送</button>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/** 匿名发布树洞 */
export function TreeholePublishPage() {
  const nav = useNavigate();
  const [content, setContent] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const MAX = 3000;
  const canSubmit = !busy && !uploading && (content.trim().length >= 5 || images.length > 0);

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 9 - images.length)) {
        const url = await uploadFile('image', f);
        setImages((prev) => [...prev, url]);
      }
    } catch (e: any) {
      setToast(e.message || '上传失败');
      setTimeout(() => setToast(''), 1600);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    const text = content.trim();
    if (text.length < 5 && images.length === 0) {
      setToast('至少写 5 个字，或配一张图');
      setTimeout(() => setToast(''), 1600);
      return;
    }
    setBusy(true);
    try {
      await api('/treehole', { method: 'POST', body: { content: text, images } });
      sessionStorage.setItem('hall_tab', 'treehole');
      nav(-1);
    } catch (e: any) {
      setToast(e.message);
      setTimeout(() => setToast(''), 1600);
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹ 取消</span>
        <span className="title">写树洞</span>
        <span className="action" style={!canSubmit ? { opacity: 0.4 } : undefined} onClick={() => canSubmit && submit()}>发布</span>
      </div>
      <div className="page no-scrollbar" style={{ padding: '4px 16px' }}>
        <textarea
          className="input"
          autoFocus
          value={content}
          maxLength={MAX}
          onChange={(e) => setContent(e.target.value)}
          placeholder="把想说却无处说的话放进树洞…"
          style={{ minHeight: 200, lineHeight: 1.7, fontSize: 15 }}
        />
        <div className="th-pick">
          {images.map((u) => <img key={u} src={full(u)} alt="" onClick={() => setImages(images.filter((x) => x !== u))} />)}
          {images.length < 9 && (
            <label>{uploading ? '…' : '+'}<input type="file" accept="image/*" multiple hidden onChange={(e) => pick(e.target.files)} /></label>
          )}
        </div>
        <div className="row">
          <span className="small grow">匿名发布：其他人只能看到内容，不会显示你的昵称和头像</span>
          <span className="small">{content.length} / {MAX}</span>
        </div>
      </div>
      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
