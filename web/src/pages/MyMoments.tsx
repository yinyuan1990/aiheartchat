import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { MomentItem } from './Plaza';

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

const TEXT_BG = [
  'linear-gradient(135deg, #2b0d16, #4a1626)',
  'linear-gradient(135deg, #101a2e, #1c2f52)',
  'linear-gradient(135deg, #241436, #3b2158)',
];

export function MyMomentsPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<MomentItem[]>([]);

  useEffect(() => {
    api<MomentItem[]>('/moments/mine').then(setItems).catch(() => {});
  }, []);

  async function remove(e: React.MouseEvent, m: MomentItem) {
    e.stopPropagation();
    if (!window.confirm('删除后不可恢复，确定删除这条动态吗？')) return;
    try {
      await api(`/moments/${m.id}`, { method: 'DELETE' });
      setItems((list) => list.filter((it) => it.id !== m.id));
    } catch {
      /* 静默 */
    }
  }

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">我的动态</span>
        <span className="action" onClick={() => nav('/publish')}>发布</span>
      </div>
      <div className="page no-scrollbar" style={{ padding: '12px 12px 24px' }}>
        {items.length === 0 && <div className="empty">还没发布过动态<br />点右上角发布第一条</div>}

        {/* 双列瀑布 */}
        <div style={{ columnCount: 2, columnGap: 8 }}>
          {items.map((m, idx) => {
            const cover = m.type === 2 ? (m.coverUrl || '') : (m.images[0] ?? '');
            return (
              <div
                key={m.id}
                onClick={() => nav(`/moment/${m.id}`)}
                style={{
                  breakInside: 'avoid', marginBottom: 8, borderRadius: 12, overflow: 'hidden',
                  background: 'var(--bg-card)', cursor: 'pointer',
                }}
              >
                {/* 封面 */}
                {cover ? (
                  <div style={{ position: 'relative' }}>
                    <img src={cover} style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover' }} alt="" />
                    {m.type === 2 && (
                      <span style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>视频</span>
                    )}
                    {m.type === 1 && m.images.length > 1 && (
                      <span style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>{m.images.length} 图</span>
                    )}
                  </div>
                ) : m.type === 2 ? (
                  <div style={{ position: 'relative', height: 150, background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <video src={m.videoUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
                    <span style={{ position: 'absolute', color: '#fff', fontSize: 24 }}>▶</span>
                  </div>
                ) : (
                  /* 纯文字：渐变卡 */
                  <div style={{
                    minHeight: 120, padding: 16, display: 'flex', alignItems: 'center',
                    background: TEXT_BG[idx % TEXT_BG.length],
                  }}>
                    <div style={{
                      fontSize: 15, lineHeight: 1.7, color: '#fff',
                      display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {m.content}
                    </div>
                  </div>
                )}

                {/* 文字与数据 */}
                <div style={{ padding: '10px 12px' }}>
                  {cover && m.content && (
                    <div style={{
                      fontSize: 13, lineHeight: 1.5, marginBottom: 6,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {m.content}
                    </div>
                  )}
                  <div className="row" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    <span className="grow">{formatAgo(m.createdAt)}{m.cityName ? ` · ${m.cityName}` : ''}</span>
                    <span>赞 {m.likeCount} · 评 {m.commentCount}</span>
                  </div>
                  <div style={{ marginTop: 8, textAlign: 'right' }}>
                    <span
                      onClick={(e) => remove(e, m)}
                      style={{ fontSize: 12, color: 'var(--danger, #ff4d4f)', padding: '3px 10px', borderRadius: 10, background: 'rgba(255,77,79,0.12)' }}
                    >
                      删除
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
