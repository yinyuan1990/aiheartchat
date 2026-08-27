import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints } from '../api';

interface GiftWallItem {
  id: number;
  name: string;
  icon: string;
  price: string;
  count: number;
}

/** 礼物墙：显示全部礼物，数量 0 灰显 */
export function GiftsReceivedPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<GiftWallItem[]>([]);

  useEffect(() => {
    api<GiftWallItem[]>('/gifts/received').then(setItems).catch(() => {});
  }, []);

  const total = items.reduce((s, g) => s + g.count, 0);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">礼物墙</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar page-pad">
        <div className="muted" style={{ marginBottom: 14 }}>共收到 {total} 个礼物</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {items.map((g) => (
            <div
              key={g.id}
              style={{
                background: 'var(--bg-card)', borderRadius: 12, padding: '16px 8px 12px',
                textAlign: 'center', opacity: g.count > 0 ? 1 : 0.35,
              }}
            >
              <img src={g.icon} style={{ width: 52, height: 52, objectFit: 'contain' }} alt="" />
              <div style={{ fontSize: 13, marginTop: 6 }}>{g.name}</div>
              <div className="small" style={{ marginTop: 2 }}>{fmtPoints(g.price)} 积分</div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: g.count > 0 ? 'var(--accent)' : 'var(--text-3)' }}>
                × {g.count}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
