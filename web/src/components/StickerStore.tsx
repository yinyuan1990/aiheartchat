import { useEffect, useMemo, useRef, useState } from 'react';
import { addMine, removeMine, reorderMine, StickerPayload, StickerSet, useStickers } from '../stickers';
import { baseEmoji, SearchIcon } from './emoji-panel/shared';
import { StickerView } from './StickerView';

const KIND: Record<string, string> = { static: '静态', animated: '动态', video: '动态' };

/**
 * 表情商店 / 我的贴纸管理（底部弹出的半屏 sheet）。
 * store：搜索 + 全部包（每行前 6 张预览 + 添加 / 已添加）——Telegram 图 7 那种；
 * manage：我的包 置顶 / 移除（从胶囊右边 ⚙ 进来）。
 * 搜索：按包名，或按贴纸 emoji（面板搜索行的快捷 emoji 直接带进来）；搜 emoji 时预览只放命中的贴纸。
 * 库里的包由后台维护；用户只决定自己面板里有哪些、什么顺序。
 */
export function StickerStoreSheet({ mode, initialQuery = '', autoFocus = false, onClose }: { mode: 'store' | 'manage'; initialQuery?: string; autoFocus?: boolean; onClose: () => void }) {
  const { sets, mine, mineIds } = useStickers();
  const [busy, setBusy] = useState<number | null>(null);
  const [q, setQ] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => inputRef.current?.focus(), 80); }, [autoFocus]);

  const run = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e: any) { alert(e.message); } finally { setBusy(null); }
  };

  const list = useMemo((): { set: StickerSet; preview: StickerPayload[] }[] => {
    const words = q.trim().toLowerCase();
    const src = mode === 'manage' ? mine : sets;
    if (!words) return src.map((s) => ({ set: s, preview: s.items.slice(0, 6) }));
    const wb = baseEmoji(words);
    return src.flatMap((s) => {
      const hit = s.items.filter((p) => baseEmoji(p.emoji).includes(wb));
      if (hit.length) return [{ set: s, preview: hit.slice(0, 6) }];
      if (s.title.toLowerCase().includes(words)) return [{ set: s, preview: s.items.slice(0, 6) }];
      return [];
    });
  }, [q, sets, mine, mode]);

  const btn = (label: string, onClick: () => void, primary: boolean, disabled: boolean) => (
    <button className={primary ? 'btn-sm' : 'btn-sm ghost'} style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 15 }} disabled={disabled} onClick={onClick}>{label}</button>
  );

  const row = (s: StickerSet, preview: StickerPayload[], actions: JSX.Element) => (
    <div key={s.id} style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
          <div className="small">{s.items.length} 张贴图 · {KIND[s.kind] ?? ''}</div>
        </div>
        {actions}
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 10, marginTop: 10, overflowX: 'auto' }}>
        {preview.map((p) => <StickerView key={p.id} p={p} size={64} autoplay={false} />)}
      </div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.35)' }} onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="sheet-up"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '86%', background: 'var(--bg)', borderRadius: '16px 16px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="row" style={{ padding: '12px 12px 8px', gap: 10 }}>
          <div className="row grow" style={{ background: 'var(--bg-input)', borderRadius: 10, height: 36, padding: '0 10px', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', display: 'flex' }}><SearchIcon size={15} /></span>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === 'store' ? '搜索贴纸' : '搜索我的贴纸'} style={{ border: 0, outline: 0, background: 'transparent', fontSize: 15, flex: 1, color: 'var(--text)' }} />
            {q && <span onClick={() => { setQ(''); inputRef.current?.focus(); }} style={{ fontSize: 13, color: 'var(--text-3)', cursor: 'pointer' }}>✕</span>}
          </div>
          <span className="accent" style={{ fontSize: 16, cursor: 'pointer', flexShrink: 0 }} onClick={onClose}>完成</span>
        </div>
        <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
          {mode === 'manage' && <div className="small" style={{ padding: '4px 16px 0' }}>我的贴纸（{mine.length}）· 拖不动？用置顶调顺序</div>}
          {mode === 'manage' && list.map(({ set: s, preview }, i) => row(s, preview, (
            <div className="row" style={{ gap: 6 }}>
              {i > 0 && !q && btn('置顶', () => run(s.id, () => reorderMine([s.id, ...mineIds.filter((x) => x !== s.id)])), false, busy === s.id)}
              {btn('移除', () => run(s.id, () => removeMine(s.id)), false, busy === s.id)}
            </div>
          )))}
          {mode === 'store' && list.map(({ set: s, preview }) => {
            const added = mineIds.includes(s.id);
            return row(s, preview, added
              ? btn('已添加', () => run(s.id, () => removeMine(s.id)), false, busy === s.id)
              : btn('添加', () => run(s.id, () => addMine(s.id)), true, busy === s.id));
          })}
          {!list.length && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{sets.length ? '没有匹配的贴纸包' : '表情包还在路上…'}</div>}
          <div style={{ height: 30 }} />
        </div>
      </div>
    </div>
  );
}
