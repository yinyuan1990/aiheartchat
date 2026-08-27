import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtPoints } from '../api';
import { useApp } from '../store';

interface HomeProfile {
  id: string;
  nickname: string;
  avatar: string;
  gender: number;
  age: number;
  cityName: string;
  signature: string;
  isGuide: boolean;
  following: number;
  fans: number;
  isFollowing: boolean;
  /** 五维度均分（0-100），展示词：真实度/配合度/腿型/曲线/肤质 */
  rating?: { avg: number; count: number; photo?: number; obedience?: number; legs?: number; chest?: number; skin?: number } | null;
  answerRate?: number | null;
  videoPriceActualFen?: number;
  online?: boolean;
  busy?: boolean;
  realnameVerified?: boolean;
  /** 照片墙（最多 8 张） */
  albums?: { id: string; type: number; url: string }[];
}

/** 认证徽章 chip：圆形 ✓ 图标 + 标签，已认证玫红、未认证置灰 */
/** 认证信息行：简约风，勾 + 文字，无背景 */
function CertLine({ label, verified }: { label: string; verified: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: verified ? 'var(--accent)' : 'var(--text-3)' }}>✓</span>
      <span style={{ fontSize: 13, color: verified ? 'var(--text)' : 'var(--text-3)' }}>{verified ? label : `${label}（未认证）`}</span>
    </span>
  );
}

interface MomentItem {
  id: string;
  type: number;
  content: string;
  images: string[];
  videoUrl: string;
  coverUrl: string;
  likeCount: number;
  commentCount: number;
  createdAt: string;
}

const fmtDate = (s: string) => (s && s.length >= 10 ? `${s.slice(5, 7)}月${s.slice(8, 10)}日` : '');

/** 他人主页：顶部大图 hero + 圆角资料卡（关于我/我的动态 tab）+ 底部操作栏 */
export function UserHomePage() {
  const nav = useNavigate();
  const { id } = useParams<{ id: string }>();
  const me = useApp((s) => s.user);
  const [p, setP] = useState<HomeProfile | null>(null);
  const [moments, setMoments] = useState<MomentItem[]>([]);
  const [following, setFollowing] = useState(false);
  const [tab, setTab] = useState(0);
  const [giftOpen, setGiftOpen] = useState(false);
  const [gifts, setGifts] = useState<any[]>([]);
  const [selGift, setSelGift] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const [wallImage, setWallImage] = useState<string | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    api<HomeProfile>(`/user/${id}`).then((r) => { setP(r); setFollowing(r.isFollowing); }).catch(() => {});
    api<MomentItem[]>(`/moments/user/${id}`).then(setMoments).catch(() => {});
  }, [id]);

  // hero 自动轮播：3.5 秒翻页
  useEffect(() => {
    if (!p) return;
    const n = new Set([p.avatar, ...(p.albums ?? []).filter((a) => a.type === 1).map((a) => a.url)].filter(Boolean)).size;
    if (n <= 1) return;
    const t = setInterval(() => {
      const el = heroRef.current;
      if (!el) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % n;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 3500);
    return () => clearInterval(t);
  }, [p]);

  const showToast = (t: string) => { setToast(t); setTimeout(() => setToast(''), 2000); };

  const toggleFollow = async () => {
    try {
      const r = await api<{ following: boolean }>(`/user/${id}/follow`, { method: 'POST' });
      setFollowing(r.following);
    } catch (e: any) { showToast(e.message); }
  };

  const openChat = async () => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${id}`, { method: 'POST' });
      nav(`/chatroom/${r.conversationId}`, { state: { title: p?.nickname, convType: 1, targetId: id } });
    } catch (e: any) { showToast(e.message); }
  };

  const openGifts = async () => {
    setGiftOpen(true);
    if (gifts.length === 0) api<any[]>('/gifts').then(setGifts).catch(() => {});
  };

  const sendGift = async () => {
    if (selGift == null) return showToast('请选择礼物');
    try {
      await api('/gifts/send', { method: 'POST', body: { toUserId: id, giftId: selGift } });
      showToast('已送出');
    } catch (e: any) { showToast(e.message); }
  };

  if (!p) return <div className="app"><div className="empty">加载中…</div></div>;
  const isFemale = p.gender === 2;
  const canVideo = me?.gender === 1 && isFemale;
  // hero 轮播图：头像 + 照片墙（去重去空）
  const heroImages = [...new Set([p.avatar, ...(p.albums ?? []).filter((a) => a.type === 1).map((a) => a.url)].filter(Boolean))] as string[];

  const videoSub = p.busy
    ? ''
    : !p.online
      ? '对方离线'
      : (p.videoPriceActualFen ?? 0) > 0
        ? `${fmtPoints(String(p.videoPriceActualFen))}积分/分钟`
        : '';

  return (
    <div className="app">
      {toast && (
        <div style={{
          position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 300,
          background: 'rgba(20,20,24,0.95)', border: '1px solid var(--line)', padding: '8px 16px', borderRadius: 10, fontSize: 13,
        }}>{toast}</div>
      )}

      <div className="page" style={{ paddingBottom: 90 }}>
        {/* ===== 顶部大图 hero：头像 + 照片墙横滑轮播 ===== */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: '0.82', background: 'var(--bg-card)', overflow: 'hidden' }}>
          <div
            ref={heroRef}
            className="no-scrollbar"
            onScroll={(e) => {
              const el = e.currentTarget;
              setHeroIdx(Math.round(el.scrollLeft / el.clientWidth));
            }}
            style={{
              display: 'flex', width: '100%', height: '100%',
              overflowX: 'auto', scrollSnapType: 'x mandatory',
            }}
          >
            {heroImages.map((url) => (
              <img
                key={url} src={url} alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', flexShrink: 0, scrollSnapAlign: 'start' }}
              />
            ))}
          </div>
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'linear-gradient(180deg, transparent 55%, rgba(10,10,12,0.9) 100%)',
          }} />
          {/* 页码圆点（多图才显示） */}
          {heroImages.length > 1 && (
            <div style={{ position: 'absolute', bottom: 30, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 5, pointerEvents: 'none' }}>
              {heroImages.map((_, i) => (
                <span key={i} style={{
                  width: i === heroIdx ? 7 : 5, height: i === heroIdx ? 7 : 5, borderRadius: '50%',
                  background: i === heroIdx ? '#fff' : 'rgba(255,255,255,0.4)',
                }} />
              ))}
            </div>
          )}
          <div
            onClick={() => nav(-1)}
            style={{
              position: 'absolute', top: 14, left: 12, width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, color: '#fff', cursor: 'pointer',
            }}
          >‹</div>
          {/* 左下叠层：接通率 / 视频价格（仅女生） */}
          <div style={{ position: 'absolute', left: 16, bottom: 34, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {isFemale && p.answerRate != null && p.answerRate >= 0 && (
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <b style={{ fontSize: 26, color: '#fff' }}>{p.answerRate}</b>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>&nbsp;% 接通率</span>
              </div>
            )}
            {isFemale && (p.videoPriceActualFen ?? 0) > 0 && (
              <div style={{ display: 'flex', alignItems: 'baseline' }}>
                <b style={{ fontSize: 26, color: '#fff' }}>{fmtPoints(String(p.videoPriceActualFen))}</b>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>&nbsp;积分/分钟</span>
              </div>
            )}
          </div>
        </div>

        {/* ===== 圆角资料卡 ===== */}
        <div style={{ marginTop: -20, borderRadius: '20px 20px 0 0', background: 'var(--bg)', position: 'relative' }}>
          {/* tab 行 + 关注按钮 */}
          <div className="row" style={{ padding: '18px 16px', gap: 24, alignItems: 'center' }}>
            {(['关于我', '我的动态'] as const).map((t, i) => (
              <div key={t} onClick={() => setTab(i)} style={{ cursor: 'pointer', textAlign: 'center' }}>
                <div style={{
                  fontSize: tab === i ? 16 : 15, fontWeight: tab === i ? 700 : 400,
                  color: tab === i ? 'var(--text)' : 'var(--text-2)',
                }}>{t}</div>
                <div style={{
                  width: 20, height: 3, borderRadius: 2, margin: '5px auto 0',
                  background: tab === i ? 'var(--accent)' : 'transparent',
                }} />
              </div>
            ))}
            <div className="grow" />
            <button
              onClick={toggleFollow}
              style={{
                border: 'none', borderRadius: 999, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: following ? 'var(--bg-input)' : 'linear-gradient(90deg, var(--accent), #ff6b81)',
                color: following ? 'var(--text-2)' : '#fff',
              }}
            >
              {following ? '已关注' : '＋ 关注'}
            </button>
          </div>

          {tab === 0 ? (
            /* ===== 关于我 ===== */
            <div style={{ padding: '0 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.nickname}
                <span style={{ fontSize: 11, fontWeight: 400, color: p.busy ? '#ffaa3c' : p.online ? 'var(--success)' : 'var(--text-3)' }}>
                  ● {p.busy ? '通话中' : p.online ? '在线' : '离线'}
                </span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <span className="tag" style={{ fontSize: 11, color: p.gender === 1 ? '#6db3ff' : '#ff7a95' }}>
                  {p.gender === 1 ? '男' : '女'} {p.age}
                </span>
                {p.cityName && <span className="tag" style={{ fontSize: 11 }}>{p.cityName}</span>}
              </div>
              {p.signature && <div className="muted" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6 }}>{p.signature}</div>}
              <div className="row" style={{ gap: 24, marginTop: 16 }}>
                <span style={{ fontSize: 13 }}><b style={{ fontSize: 16 }}>{p.following}</b> <span className="muted">关注</span></span>
                <span style={{ fontSize: 13 }}><b style={{ fontSize: 16 }}>{p.fans}</b> <span className="muted">粉丝</span></span>
              </div>
              {/* ===== 评分：星级总分 + 五维度方格，最高维度渐变高亮 ===== */}
              {isFemale && p.rating && p.rating.count > 0 && (() => {
                const star = p.rating.avg / 20;
                const filled = Math.min(Math.max(Math.round(star), 0), 5);
                // 按分从高到低排成 3+2 方格，第一格（她最突出的）用渐变填充
                const dims = ([
                  ['真实度', p.rating.photo ?? 0],
                  ['配合度', p.rating.obedience ?? 0],
                  ['腿型', p.rating.legs ?? 0],
                  ['曲线', p.rating.chest ?? 0],
                  ['肤质', p.rating.skin ?? 0],
                ] as [string, number][]).sort((a, b) => b[1] - a[1]);
                return (
                  <div style={{ marginTop: 18 }}>
                    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>评分</span>
                      <span style={{ fontSize: 13, color: 'var(--accent)' }}>{'★'.repeat(filled)}{'☆'.repeat(5 - filled)}</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)' }}>{star.toFixed(1)}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{p.rating.count}次评价</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
                      {dims.map(([label, score], i) => {
                        const best = i === 0 && score > 0;
                        return (
                          <div key={label} style={{
                            borderRadius: 10, padding: '10px 0', textAlign: 'center',
                            background: best ? 'var(--accent-grad)' : 'rgba(255,255,255,0.06)',
                          }}>
                            <div style={{ fontSize: 16, fontWeight: 700, color: best ? '#fff' : 'var(--text)' }}>{(score / 20).toFixed(1)}</div>
                            <div style={{ fontSize: 11, marginTop: 2, color: best ? 'rgba(255,255,255,0.9)' : 'var(--text-2)' }}>{label}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              {/* 照片墙（最多 8 张） */}
              {(p.albums ?? []).filter((a) => a.type === 1).length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>照片墙</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 8 }}>
                    {(p.albums ?? []).filter((a) => a.type === 1).map((a) => (
                      <div
                        key={a.id}
                        onClick={() => setWallImage(a.url)}
                        style={{ aspectRatio: '1', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-card)', cursor: 'pointer' }}
                      >
                        <img src={a.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* 认证信息：简约行，无背景卡 */}
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>认证信息</div>
                <div className="row" style={{ gap: 18, marginTop: 10 }}>
                  <CertLine label="平台认证" verified={p.isGuide} />
                  {isFemale && <CertLine label="实名认证" verified={!!p.realnameVerified} />}
                </div>
              </div>
            </div>
          ) : (
            /* ===== 我的动态：列表式 ===== */
            <div>
              {moments.length === 0 && <div className="empty" style={{ padding: 40 }}>暂无动态</div>}
              {moments.map((m) => {
                const thumbs = m.type === 2 ? [m.coverUrl].filter(Boolean) : m.images.slice(0, 3);
                return (
                  <div
                    key={m.id}
                    onClick={() => nav(`/moment/${m.id}`)}
                    style={{ padding: '6px 16px 14px', cursor: 'pointer', borderBottom: '0.5px solid var(--line)' }}
                  >
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <div className="avatar" style={{ width: 38, height: 38 }}>
                        {p.avatar && <img src={p.avatar} alt="" />}
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{p.nickname}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{fmtDate(m.createdAt)}</div>
                      </div>
                    </div>
                    {m.content && <div style={{ fontSize: 15, lineHeight: 1.6, marginTop: 10 }}>{m.content}</div>}
                    {/* 媒体：单图/视频大图（2/3 宽 3:4），两图/三图等分方格铺满整行 */}
                    {thumbs.length === 1 && (
                      <div style={{ position: 'relative', width: '66%', aspectRatio: '3/4', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-card)', marginTop: 10 }}>
                        <img src={thumbs[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        {m.type === 2 && (
                          <span style={{
                            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.45)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#fff',
                          }}>▶</span>
                        )}
                      </div>
                    )}
                    {thumbs.length > 1 && (
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${thumbs.length}, 1fr)`, gap: 6, marginTop: 10 }}>
                        {thumbs.map((u) => (
                          <div key={u} style={{ aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-card)' }}>
                            <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="row" style={{ gap: 18, marginTop: 10 }}>
                      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>♡ {m.likeCount}</span>
                      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>评论 {m.commentCount}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ===== 底部操作栏 ===== */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100,
        display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px 14px',
        background: 'linear-gradient(180deg, transparent, rgba(10,10,12,0.95) 40%, var(--bg))',
        maxWidth: 520, margin: '0 auto',
      }}>
        <div
          onClick={openChat}
          style={{
            width: 48, height: 48, borderRadius: '50%', background: 'var(--bg-card)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, cursor: 'pointer',
          }}
        >聊天</div>
        <div
          onClick={openGifts}
          style={{
            width: 48, height: 48, borderRadius: '50%', background: 'var(--bg-card)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#ff6b81', cursor: 'pointer',
          }}
        >礼物</div>
        {canVideo ? (
          <button
            onClick={() => {
              if (p.busy) return showToast('对方正在通话中，请稍后再试');
              if (!p.online) return showToast('对方不在线');
              window.alert('视频通话请在 App 中使用，请下载 App');
            }}
            style={{
              flex: 1, height: 48, border: 'none', borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
              background: p.busy || !p.online ? 'var(--bg-input)' : 'linear-gradient(90deg, var(--accent), #ff6b81)',
              color: p.busy ? '#ffaa3c' : !p.online ? 'var(--text-3)' : '#fff',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
            }}
          >
            <span style={{ lineHeight: 1.2 }}>{p.busy ? '通话中' : '视频聊天'}</span>
            {videoSub && (
              <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.85, lineHeight: 1.2 }}>{videoSub}</span>
            )}
          </button>
        ) : (
          <button
            onClick={openChat}
            style={{
              flex: 1, height: 48, border: 'none', borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
              background: 'linear-gradient(90deg, var(--accent), #ff6b81)', color: '#fff',
            }}
          >
            发消息
          </button>
        )}
      </div>

      {/* 照片墙大图查看 */}
      {wallImage && (
        <div
          onClick={() => setWallImage(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <img src={wallImage} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      )}

      {/* 送礼物面板 */}
      {giftOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'flex-end' }}
          onClick={() => setGiftOpen(false)}
        >
          <div
            style={{ width: '100%', background: 'var(--bg-card)', borderRadius: '16px 16px 0 0', padding: 16, maxHeight: '60vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>送礼物给 {p.nickname}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {gifts.map((g) => (
                <div
                  key={g.id}
                  onClick={() => setSelGift(g.id)}
                  style={{
                    textAlign: 'center', padding: '10px 4px', borderRadius: 10, cursor: 'pointer',
                    border: selGift === g.id ? '1px solid var(--accent)' : '1px solid transparent',
                    background: selGift === g.id ? 'rgba(254,44,85,0.08)' : 'transparent',
                  }}
                >
                  <img src={g.icon} alt="" style={{ width: 40, height: 40 }} />
                  <div style={{ fontSize: 12, marginTop: 4 }}>{g.name}</div>
                  <div className="small" style={{ color: 'var(--accent)' }}>{fmtPoints(g.price)}</div>
                </div>
              ))}
            </div>
            <button className="btn" style={{ width: '100%', marginTop: 14 }} onClick={sendGift}>赠送</button>
          </div>
        </div>
      )}
    </div>
  );
}
