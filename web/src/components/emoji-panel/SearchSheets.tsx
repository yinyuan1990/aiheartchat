import { useEffect, useMemo, useRef, useState } from 'react';
import { addRecentEmoji, searchEmojis, useEmojis } from '../../emojis';
import { searchGifs, StickerPayload } from '../../stickers';
import { baseEmoji, QUICK_EMOJIS, SearchIcon } from './shared';

/**
 * 搜索 sheet 外壳（和表情商店 sheet 同一套）：顶部搜索框（自动聚焦）+「完成」，
 * 下面一行快捷 emoji（点了当搜索词），再下面是各自的结果区。GIF / 表情两个搜索都从这里走，和贴纸「点搜索弹框」一致。
 */
function SheetShell({ placeholder, query, onQuery, onClose, children }: { placeholder: string; query: string; onQuery: (q: string) => void; onClose: () => void; children: React.ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80); }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.35)' }} onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="sheet-up"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '86%', background: 'var(--bg)', borderRadius: '16px 16px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="row" style={{ padding: '12px 12px 6px', gap: 10 }}>
          <div className="row grow" style={{ background: 'var(--bg-input)', borderRadius: 10, height: 36, padding: '0 10px', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', display: 'flex' }}><SearchIcon size={15} /></span>
            <input ref={inputRef} value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} style={{ border: 0, outline: 0, background: 'transparent', fontSize: 15, flex: 1, color: 'var(--text)' }} />
            {query && <span onClick={() => { onQuery(''); inputRef.current?.focus(); }} style={{ fontSize: 13, color: 'var(--text-3)', cursor: 'pointer' }}>✕</span>}
          </div>
          <span className="accent" style={{ fontSize: 16, cursor: 'pointer', flexShrink: 0 }} onClick={onClose}>完成</span>
        </div>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 4, padding: '2px 12px 8px', overflowX: 'auto' }}>
          {QUICK_EMOJIS.map((e) => {
            const on = baseEmoji(query.trim()) === baseEmoji(e);
            return (
              <span key={e} onClick={() => onQuery(on ? '' : e)} style={{ fontSize: 22, lineHeight: '36px', width: 36, textAlign: 'center', flexShrink: 0, cursor: 'pointer', borderRadius: 18, background: on ? 'var(--bg-input)' : 'transparent', filter: on ? undefined : 'grayscale(1)', opacity: on ? 1 : 0.5 }}>{e}</span>
            );
          })}
        </div>
        <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

/** GIF 搜索 sheet：输入防抖 400ms，快捷 emoji 立即；3 列瓦片，滚到底翻页；点了 GIF 回调并关闭 */
export function GifSearchSheet({ initialQuery, onPick, onClose }: { initialQuery: string; onPick: (p: StickerPayload) => void; onClose: () => void }) {
  const [q, setQ] = useState(initialQuery);
  const [items, setItems] = useState<StickerPayload[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const query = q.trim();

  useEffect(() => {
    const id = ++seq.current;
    const t = window.setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const r = await searchGifs(query, '');
        if (id !== seq.current) return;
        setItems(r.items); setNext(r.next);
        // 首次搜索后端还在后台补齐时结果会少，3 秒后再拉一次
        if (r.items.length < 10 && r.next !== '') {
          window.setTimeout(async () => {
            if (id !== seq.current) return;
            const r2 = await searchGifs(query, '').catch(() => r);
            if (id === seq.current && r2.items.length > r.items.length) { setItems(r2.items); setNext(r2.next); }
          }, 3000);
        }
      } catch (e: any) {
        if (id === seq.current) setError(e.message || '加载失败');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, QUICK_EMOJIS.includes(query) || !query ? 0 : 400);
    return () => window.clearTimeout(t);
  }, [query]);

  const more = async () => {
    if (loading || !next) return;
    const id = seq.current;
    setLoading(true);
    try {
      const r = await searchGifs(query, next);
      if (id !== seq.current) return;
      const seen = new Set(items.map((p) => p.id));
      setItems([...items, ...r.items.filter((p) => !seen.has(p.id))]);
      setNext(r.next);
    } catch { /* 下次滚动再试 */ } finally {
      if (id === seq.current) setLoading(false);
    }
  };

  return (
    <SheetShell placeholder="搜索 GIF" query={q} onQuery={setQ} onClose={onClose}>
      <div onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) void more(); }} style={{ height: '100%', overflowY: 'auto' }} className="no-scrollbar">
        {!query && <div className="small" style={{ padding: '2px 12px 6px' }}>热门</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>
          {items.map((p) => (
            <div key={p.id} onClick={() => { onPick(p); onClose(); }} style={{ aspectRatio: '1', overflow: 'hidden', background: 'var(--bg-input)', cursor: 'pointer' }}>
              <img src={p.thumb || p.url} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          ))}
        </div>
        {loading && <div className="empty" style={{ padding: 16, fontSize: 12 }}>{items.length ? '加载更多…' : '正在拉取 GIF，第一次会慢几秒…'}</div>}
        {!loading && !items.length && !error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{query ? '没有找到相关 GIF' : '暂无 GIF'}</div>}
        {error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{error}</div>}
        <div style={{ height: 30 }} />
      </div>
    </SheetShell>
  );
}

/** 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起 */
export function EmojiSearchSheet({ initialQuery, onEmoji, onClose }: { initialQuery: string; onEmoji: (e: string) => void; onClose: () => void }) {
  const { groups, recent } = useEmojis();
  const [q, setQ] = useState(initialQuery);
  const query = q.trim();
  const results = useMemo(() => (query ? searchEmojis(groups, query).map((r) => r[0]) : recent), [groups, query, recent]);

  return (
    <SheetShell placeholder="搜索表情" query={q} onQuery={setQ} onClose={onClose}>
      {!query && recent.length > 0 && <div className="small" style={{ padding: '2px 12px 4px' }}>最近使用</div>}
      {results.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', padding: '0 6px' }}>
          {results.map((e, i) => (
            <span key={`${e}-${i}`} onClick={() => { onEmoji(e); addRecentEmoji(e); }} style={{ textAlign: 'center', fontSize: 26, lineHeight: '42px', cursor: 'pointer', userSelect: 'none' }}>{e}</span>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ padding: 30, fontSize: 13 }}>{query ? '没有匹配的表情' : '输入关键词搜表情，比如「笑」「猫」「爱心」'}</div>
      )}
      <div style={{ height: 30 }} />
    </SheetShell>
  );
}
