import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { api, fmtPoints } from '../api';
import { CityPickerSheet } from '../components/CityPicker';
import { locateCity } from '../cities';
import { useApp } from '../store';

export interface MomentItem {
  id: string;
  user: { id: string; nickname: string; avatar: string; age: number; isGuide: boolean; online?: boolean; busy?: boolean; videoPriceFen?: number };
  content: string;
  type: number;
  images: string[];
  videoUrl: string;
  coverUrl: string;
  cityName: string;
  likeCount: number;
  commentCount: number;
  liked: boolean;
  isFollowing?: boolean;
  createdAt: string;
}

export function MomentCard({ m, onOpenDetail, onGreet }: { m: MomentItem; onOpenDetail: () => void; onGreet: () => void }) {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const isSelf = me?.id === m.user?.id;
  const [liked, setLiked] = useState(m.liked);
  const [likeCount, setLikeCount] = useState(m.likeCount);
  const [following, setFollowing] = useState(!!m.isFollowing);
  const [fullImage, setFullImage] = useState<string | null>(null);

  const toggleLike = async () => {
    try {
      const r = await api<{ liked: boolean }>(`/moments/${m.id}/like`, { method: 'POST' });
      setLiked(r.liked);
      setLikeCount((c) => c + (r.liked ? 1 : -1));
    } catch {}
  };

  const toggleFollow = async () => {
    try {
      const r = await api<{ following: boolean }>(`/user/${m.user.id}/follow`, { method: 'POST' });
      setFollowing(r.following);
    } catch {}
  };

  return (
    <div data-moment-id={m.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
      {/* 头部：头像 昵称 时间 + 关注 */}
      <div className="row">
        {/* 点头像进入他人主页（自己的动态不跳转） */}
        <div
          className="avatar"
          style={{ width: 42, height: 42, cursor: isSelf ? 'default' : 'pointer' }}
          onClick={() => { if (!isSelf && m.user?.id) nav(`/u/${m.user.id}`); }}
        >
          {m.user?.avatar && <img src={m.user.avatar} alt="" />}
        </div>
        <div className="grow">
          <div style={{ fontSize: 15, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{m.user?.nickname}</span>
            {m.user?.isGuide && <span className="tag tag-accent" style={{ fontSize: 10, padding: '1px 6px' }}>认证</span>}
            {m.cityName && (
              <span style={{ fontSize: 10, color: 'var(--text-3)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 3 }}>{m.cityName}</span>
            )}
          </div>
          <div className="small" style={{ marginTop: 3 }}>{formatAgo(m.createdAt)}</div>
        </div>
        {/* 自己的动态不显示关注/视频通话按钮 */}
        {!isSelf && (
          <>
            <button
              onClick={toggleFollow}
              style={{
                height: 26, padding: '0 12px', borderRadius: 13, fontSize: 12, cursor: 'pointer',
                border: following ? '1px solid #2a2a30' : 'none',
                background: following ? 'transparent' : 'var(--accent-grad)',
                color: following ? 'var(--text-2)' : '#fff',
              }}
            >
              {following ? '已关注' : '关注'}
            </button>
            {/* 视频按钮三态：通话中（占线）/ 离线置灰 / 可打（显示价格） */}
            <button
              onClick={() => {
                if (m.user?.busy) return window.alert('对方正在通话中，请稍后再试');
                if (!m.user?.online) return window.alert('对方不在线');
                window.alert('视频通话请在 App 中使用，请下载 App');
              }}
              style={{
                height: 26, padding: '0 12px', borderRadius: 13, fontSize: 12, cursor: 'pointer', marginLeft: 8,
                border: `1px solid ${m.user?.busy ? 'rgba(255,170,60,0.5)' : m.user?.online ? 'rgba(254,44,85,0.5)' : 'var(--line)'}`,
                background: 'transparent',
                color: m.user?.busy ? '#ffaa3c' : m.user?.online ? 'var(--accent)' : 'var(--text-3)',
              }}
            >
              {m.user?.busy
                ? '通话中'
                : (m.user?.videoPriceFen ?? 0) > 0 ? `视频通话 ${fmtPoints(String(m.user.videoPriceFen))}/分` : '视频通话'}
            </button>
          </>
        )}
      </div>

      {/* 文字点击进详情 */}
      {m.content && (
        <div onClick={onOpenDetail} style={{ cursor: 'pointer', marginTop: 10, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{m.content}</div>
      )}
      {/* 图片点击直接放大查看；说明文字与图片间距 8，无文字时与头部保持 10 */}
      {m.type === 1 && m.images.length > 0 && (
        m.images.length === 1
          ? <img src={m.images[0]} onClick={() => setFullImage(m.images[0])} style={{ maxWidth: '80%', maxHeight: 360, borderRadius: 10, marginTop: m.content ? 8 : 10, display: 'block', cursor: 'zoom-in' }} alt="" />
          : <div className="grid-photos" style={{ marginTop: m.content ? 8 : 10 }}>{m.images.map((url, i) => <img key={i} src={url} onClick={() => setFullImage(url)} style={{ cursor: 'zoom-in' }} alt="" />)}</div>
      )}
      {fullImage && (
        <div
          onClick={() => setFullImage(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <img src={fullImage} style={{ maxWidth: '96vw', maxHeight: '92vh', objectFit: 'contain' }} alt="" />
          <span style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, cursor: 'pointer' }}>×</span>
        </div>
      )}
      {m.type === 2 && m.videoUrl && (
        <video
          src={m.videoUrl}
          poster={m.coverUrl || undefined}
          controls
          playsInline
          onPlay={(e) => {
            // 互斥播放：开播时暂停页面上其它视频
            document.querySelectorAll('video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
          }}
          style={{ width: '100%', borderRadius: 10, marginTop: m.content ? 8 : 10, maxHeight: 400, background: '#000' }}
        />
      )}

      {/* 操作行：左侧 在线状态，右侧 点赞 / 评论 */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 12, gap: 18 }}>
        <span style={{ fontSize: 12, color: m.user?.online ? '#0bd07d' : 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: m.user?.online ? '#0bd07d' : 'var(--text-3)', display: 'inline-block' }} />
          {m.user?.online ? '在线' : '离线'}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className={`muted${liked ? ' accent' : ''}`}
          style={{ cursor: 'pointer', fontSize: 13, color: liked ? 'var(--accent)' : undefined }}
          onClick={toggleLike}
        >
          {liked ? '♥' : '♡'} 点赞{likeCount > 0 ? ` ${likeCount}` : ''}
        </span>
        <span className="muted" style={{ cursor: 'pointer', fontSize: 13 }} onClick={onOpenDetail}>
          评论{m.commentCount > 0 ? ` ${m.commentCount}` : ''}
        </span>
      </div>
    </div>
  );
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

/** 把 2026-08-17 收成 2026 · 08 · 17 */
function artDate(day: string) {
  const p = day.split('-');
  return p.length === 3 ? `${p[0]} · ${p[1]} · ${p[2]}` : day;
}

/** 励志行：一页一句、竖排、左右翻页（男看女生口吻鼓励，女看情感励志） */
function QuoteSection() {
  const PAGE = 30;
  const [list, setList] = useState<{ id: string; day: string; text: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [index, setIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const fetchPage = async (beforeId?: string) => {
    const rows = await api<typeof list>(`/news/quotes${beforeId ? `?beforeId=${beforeId}` : ''}`);
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

  const go = (i: number) => {
    if (i < 0 || i >= list.length) return;
    const el = scroller.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    setIndex(i);
    if (hasMore && i >= list.length - 3) void loadMore();
  };

  if (loaded && list.length === 0) return <div className="empty">今天的励志话正在路上…</div>;

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  return (
    <div className="quote-book">
      <div
        ref={scroller}
        className="quote-pager"
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
          if (i !== index) {
            setIndex(i);
            if (hasMore && i >= list.length - 3) void loadMore();
          }
        }}
      >
        {list.map((q, i) => (
          <div key={q.id} className="quote-page">
            <div className="quote-glow" />
            <div className="quote-mark quote-mark-open">「</div>
            <div className="quote-vline" />
            <div className="quote-text">{q.text}</div>
            <div className="quote-mark quote-mark-close">」</div>
            <div className="quote-meta">
              <span>{artDate(q.day)}</span>
              {q.day === today && <span className="quote-today">今日</span>}
            </div>
            <div className="quote-index">{i + 1} / {list.length}{hasMore ? '+' : ''}</div>
          </div>
        ))}
      </div>
      {list.length > 1 && (
        <>
          {index > 0 && <div className="quote-nav quote-nav-l" onClick={() => go(index - 1)} />}
          {index < list.length - 1 && <div className="quote-nav quote-nav-r" onClick={() => go(index + 1)} />}
        </>
      )}
    </div>
  );
}

/** 抖音模式：全屏竖滑视频（独立拉取视频流） */
function TikTokMode({ onExit, onGreet, startId }: { onExit: () => void; onGreet: (m: MomentItem) => void; startId?: string }) {
  const [items, setItems] = useState<MomentItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const touchY = useRef(0);
  const lastSwitch = useRef(0);

  useEffect(() => {
    api<MomentItem[]>('/moments/feed?onlyVideo=1')
      .then((rows) => {
        setItems(rows);
        const i = startId ? rows.findIndex((r) => r.id === startId) : 0;
        setIndex(i >= 0 ? i : 0);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [startId]);

  const m = items[index];

  // 节流：500ms 内只切一次，避免滚轮惯性连跳
  const go = (dir: 1 | -1) => {
    const now = Date.now();
    if (now - lastSwitch.current < 500) return;
    const next = index + dir;
    if (next >= 0 && next < items.length) {
      lastSwitch.current = now;
      setIndex(next);
    }
  };

  if (!m) {
    return (
      <div className="tiktok" onClick={onExit}>
        <div className="empty" style={{ paddingTop: 200 }}>{loaded ? '暂无视频动态' : '加载中…'}<br />点击返回</div>
      </div>
    );
  }

  return (
    <div
      className="tiktok"
      onTouchStart={(e) => (touchY.current = e.touches[0].clientY)}
      onTouchEnd={(e) => {
        const dy = e.changedTouches[0].clientY - touchY.current;
        if (dy < -60) go(1);
        if (dy > 60) go(-1);
      }}
      onWheel={(e) => {
        if (e.deltaY > 30) go(1);
        if (e.deltaY < -30) go(-1);
      }}
    >
      <video key={m.id} src={m.videoUrl} poster={m.coverUrl || undefined} autoPlay loop playsInline controls={false} />
      <div style={{ position: 'absolute', top: 14, left: 16, color: '#fff', cursor: 'pointer' }} onClick={onExit}>‹ 返回</div>
      <div className="side">
        <div className="avatar" style={{ width: 44, height: 44, border: '1px solid #fff' }}>
          {m.user?.avatar && <img src={m.user.avatar} alt="" />}
        </div>
        <div style={{ cursor: 'pointer' }} onClick={async () => {
          try { await api(`/moments/${m.id}/like`, { method: 'POST' }); } catch {}
        }}>
          <div style={{ fontSize: 22 }}>♥</div>
          {m.likeCount}
        </div>
        <div style={{ cursor: 'pointer' }} onClick={() => onGreet(m)}>私信</div>
      </div>
      <div className="info">
        <div className="name">@{m.user?.nickname}</div>
        <div className="text">{m.content}</div>
      </div>
    </div>
  );
}

const DEFAULT_CITY = '成都';

/** 遇见列表用户卡片（/user/meet/list） */
interface MeetUser {
  id: string;
  nickname: string;
  avatar: string;
  gender: number;
  age: number;
  cityName: string;
  isGuide: boolean;
  realnameVerified: boolean;
  ratingAvg: number;
  ratingCount: number;
  videoPriceFen: number;
  online: boolean;
  busy: boolean;
  isNew: boolean;
  intimacy: number;
}

const MEET_TABS = [
  ['all', '所有'],
  ['new', '新人'],
  ['city', '同城'],
  ['intimacy', '亲密度'],
] as const;

/** 遇见：异性卡片流（所有/新人/同城/亲密度），亲密度按互动记分倒序 */
function MeetSection({ city }: { city: string }) {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [tab, setTab] = useState<string>('all');
  const [items, setItems] = useState<MeetUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = tab === 'city' && city ? `?tab=city&city=${encodeURIComponent(city)}` : `?tab=${tab}`;
    api<MeetUser[]>(`/user/meet/list${q}`)
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tab, city]);

  return (
    <div>
      {/* 子栏胶囊 */}
      <div style={{ display: 'flex', gap: 8, padding: '2px 16px 10px' }}>
        {MEET_TABS.map(([k, label]) => (
          <span
            key={k}
            onClick={() => setTab(k)}
            style={{
              fontSize: 13, cursor: 'pointer', padding: '5px 14px', borderRadius: 15,
              background: tab === k ? 'var(--accent-grad)' : 'var(--bg-card)',
              color: tab === k ? '#fff' : 'var(--text-2)',
              fontWeight: tab === k ? 700 : 400,
            }}
          >
            {label}
          </span>
        ))}
      </div>
      {!loading && items.length === 0 && (
        <div className="empty">
          {tab === 'intimacy'
            ? '还没有亲密的人'
            : tab === 'city' ? `「${city || '同城'}」还没有人` : '暂时没有人'}
          <br />
          {tab === 'intimacy' && <span className="small">聊天、视频、点赞评论都会累计亲密度</span>}
        </div>
      )}
      {/* 两列大图卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '0 12px 12px' }}>
        {items.map((u) => (
          <div
            key={u.id}
            onClick={() => nav(`/u/${u.id}`)}
            style={{ position: 'relative', aspectRatio: '3/4', borderRadius: 14, overflow: 'hidden', background: 'var(--bg-card)', cursor: 'pointer' }}
          >
            {u.avatar && <img src={u.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            {/* 顶部徽章 + 在线点 */}
            <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 5 }}>
              {(u.isGuide || u.realnameVerified) ? (
                <span style={{ fontSize: 10, color: '#fff', background: 'var(--accent)', padding: '2px 7px', borderRadius: 9 }}>已认证</span>
              ) : u.isNew ? (
                <span style={{ fontSize: 10, color: '#fff', background: '#6c5ce7', padding: '2px 7px', borderRadius: 9 }}>新人</span>
              ) : null}
            </div>
            <span style={{ position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: 4, background: u.online ? '#0bd07d' : 'var(--text-3)' }} />
            {/* 底部信息浮层 */}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '26px 10px 9px', background: 'linear-gradient(transparent, rgba(0,0,0,0.8))' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.nickname}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                {/* 评分五星换算（0-100 → 5.0） */}
                <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(255,184,0,0.85)', padding: '1px 6px', borderRadius: 8 }}>
                  ★ {u.ratingCount > 0 ? (u.ratingAvg / 20).toFixed(1) : '新'}
                </span>
                {u.cityName && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.cityName}</span>}
                <span style={{ flex: 1 }} />
                {tab === 'intimacy' && u.intimacy > 0 ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(254,44,85,0.9)', padding: '1px 6px', borderRadius: 8 }}>
                    ♥ {u.intimacy % 1 === 0 ? u.intimacy : u.intimacy.toFixed(1)}
                  </span>
                ) : me?.gender === 1 && u.gender === 2 ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (u.busy) return window.alert('对方正在通话中，请稍后再试');
                      if (!u.online) return window.alert('对方不在线');
                      window.alert('视频通话请在 App 中使用，请下载 App');
                    }}
                    style={{
                      fontSize: 11, fontWeight: 700, color: '#fff', padding: '3px 8px', borderRadius: 10,
                      background: u.busy ? 'rgba(255,170,60,0.9)' : u.online ? 'var(--accent)' : 'rgba(74,74,82,0.8)',
                    }}
                  >
                    {u.busy ? '通话中' : u.videoPriceFen > 0 ? `视频 ${fmtPoints(String(u.videoPriceFen))}/分` : '视频'}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlazaPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<MomentItem[]>([]);
  const [tab, setTab] = useState<'feed' | 'meet' | 'quotes'>('feed');
  const [city, setCity] = useState('');
  const [tiktok, setTiktok] = useState(false);
  const [tiktokStartId, setTiktokStartId] = useState<string | undefined>();
  const [showCity, setShowCity] = useState(false);
  const [loading, setLoading] = useState(true);

  // 定位城市，失败默认成都
  useEffect(() => {
    const saved = localStorage.getItem('pw_city');
    if (saved) {
      setCity(saved);
      return;
    }
    locateCity().then((located) => setCity(located ?? DEFAULT_CITY));
  }, []);

  // 离开广场页（跳详情等路由切换）时停止所有正在播放的视频
  useEffect(() => () => {
    document.querySelectorAll('video').forEach((v) => v.pause());
  }, []);

  useEffect(() => {
    if (tab !== 'feed') return;
    setLoading(true);
    api<MomentItem[]>('/moments/feed')
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tab]);

  const greet = async (m: MomentItem) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${m.user.id}`, { method: 'POST' });
      if (openNativeChat(r.conversationId, 1, m.user.id, m.user.nickname)) return;
      nav(`/chatroom/${r.conversationId}`, { state: { title: m.user.nickname, convType: 1, targetId: m.user.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (tiktok) {
    return <TikTokMode onExit={() => setTiktok(false)} onGreet={greet} startId={tiktokStartId} />;
  }

  return (
    <>
      <div className="top-tabs">
        <span className={`top-tab${tab === 'feed' ? ' active' : ''}`} onClick={() => setTab('feed')}>动态</span>
        <span className={`top-tab${tab === 'meet' ? ' active' : ''}`} onClick={() => setTab('meet')}>遇见</span>
        <span className={`top-tab${tab === 'quotes' ? ' active' : ''}`} onClick={() => setTab('quotes')}>励志行</span>
        <span className="top-right" onClick={() => setShowCity(true)}>{city || '定位中'} ▾</span>
        {/* 视频（抖音模式）入口只属于动态板块 */}
        {tab === 'feed' && (
          <span
            className="top-right"
            style={{ marginLeft: 14 }}
            onClick={() => {
              // 进入视频模式前停止列表内正在播放的视频
              document.querySelectorAll('video').forEach((v) => v.pause());
              const mid = window.innerHeight / 2;
              let best: string | undefined;
              let bestDist = Infinity;
              items.filter((m) => m.type === 2 && m.videoUrl).forEach((m) => {
                const el = document.querySelector(`[data-moment-id="${m.id}"]`);
                if (!el) return;
                const r = el.getBoundingClientRect();
                const dist = Math.abs((r.top + r.bottom) / 2 - mid);
                if (dist < bestDist) { bestDist = dist; best = m.id; }
              });
              setTiktokStartId(best);
              setTiktok(true);
            }}
          >
            视频模式
          </span>
        )}
      </div>
      {tab === 'meet' && <MeetSection city={city} />}
      {tab === 'quotes' && <QuoteSection />}
      {tab === 'feed' && !loading && items.length === 0 && (
        <div className="empty">
          还没有动态
          <br />
          点击底部 + 发布第一条
          <br />
          <span className="small">提示：自己发布的动态仅异性可见，可在「我的-我的动态」查看</span>
        </div>
      )}
      {tab === 'feed' && items.map((m) => (
        <MomentCard key={m.id} m={m} onOpenDetail={() => nav(`/moment/${m.id}`)} onGreet={() => greet(m)} />
      ))}
      {showCity && (
        <CityPickerSheet
          current={city}
          onClose={() => setShowCity(false)}
          onSelect={(selected) => {
            setCity(selected);
            localStorage.setItem('pw_city', selected);
            setShowCity(false);
          }}
        />
      )}
    </>
  );
}
