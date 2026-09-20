import { useState } from 'react';
import { addMine, removeMine, reorderMine, StickerSet, useStickers } from '../stickers';
import { StickerView } from './StickerView';

const KIND: Record<string, string> = { static: '静态', animated: '动态', video: '动态' };

/**
 * 表情商店（全屏覆盖层，从面板「+」进来）：上半「我的表情」可置顶 / 移除，下半「全部」可添加。
 * 库里的包由后台维护；用户只决定自己面板里有哪些、什么顺序。
 */
export function StickerStore({ onClose }: { onClose: () => void }) {
  const { sets, mine, mineIds } = useStickers();
  const [busy, setBusy] = useState<number | null>(null);
  const others = sets.filter((s) => !mineIds.includes(s.id));

  const run = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e: any) { alert(e.message); } finally { setBusy(null); }
  };

  const row = (s: StickerSet, actions: JSX.Element) => (
    <div key={s.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        {s.thumb ? <img src={s.thumb} alt="" style={{ width: 44, height: 44, objectFit: 'contain', flexShrink: 0 }} /> : <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--bg-input)' }} />}
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
          <div className="small">{s.items.length} 张 · {KIND[s.kind] ?? ''}</div>
        </div>
        {actions}
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto' }}>
        {s.items.slice(0, 8).map((p) => <StickerView key={p.id} p={p} size={52} autoplay={false} />)}
      </div>
    </div>
  );

  const btn = (label: string, onClick: () => void, primary = false, disabled = false) => (
    <button
      className={primary ? 'btn-sm' : 'btn-sm ghost'}
      style={{ flexShrink: 0, padding: '6px 14px' }}
      disabled={disabled}
      onClick={onClick}
    >{label}</button>
  );

  return (
    <div className="app" style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'var(--bg)' }} onClick={(e) => e.stopPropagation()}>
      <div className="navbar">
        <span className="back" onClick={onClose}>‹</span>
        <span className="title">表情商店</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar" style={{ padding: 0 }}>
        <div className="small" style={{ padding: '12px 16px 4px', fontWeight: 600 }}>我的表情（{mine.length}）</div>
        {mine.length === 0 && <div className="empty" style={{ padding: '18px 16px', fontSize: 13 }}>还没有添加表情包，从下面挑几个</div>}
        {mine.map((s, i) => row(s, (
          <div className="row" style={{ gap: 6 }}>
            {i > 0 && btn('置顶', () => run(s.id, () => reorderMine([s.id, ...mineIds.filter((x) => x !== s.id)])), false, busy === s.id)}
            {btn('移除', () => run(s.id, () => removeMine(s.id)), false, busy === s.id)}
          </div>
        )))}

        <div className="small" style={{ padding: '18px 16px 4px', fontWeight: 600 }}>全部表情包（{sets.length}）</div>
        {others.length === 0 && sets.length > 0 && <div className="empty" style={{ padding: '18px 16px', fontSize: 13 }}>都已经添加了</div>}
        {sets.length === 0 && <div className="empty" style={{ padding: '18px 16px', fontSize: 13 }}>表情包还在路上…</div>}
        {others.map((s) => row(s, btn('添加', () => run(s.id, () => addMine(s.id)), true, busy === s.id)))}
        <div style={{ height: 30 }} />
      </div>
    </div>
  );
}
