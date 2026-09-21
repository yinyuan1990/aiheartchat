import { useEffect, useRef, useState } from 'react';
import { searchGifs, StickerPayload, useStickers } from '../../stickers';
import { Collapsible, SearchRow, SectionTitle } from './shared';

const SEARCH_H = 44;

/** GIF 页：没有顶部封面条，只有搜索行；内容 3 列瓦片，热门 / 搜索结果，滚到底自动翻页 */
export function GifPane({ hidden, onScroll, onPick }: { hidden: boolean; onScroll: (el: HTMLElement) => void; onPick: (p: StickerPayload) => void }) {
  const { recentGifs } = useStickers();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('');
  const [items, setItems] = useState<StickerPayload[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const query = (q.trim() || chip).trim();

  // 输入防抖 400ms；chip 立即
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
    }, q.trim() && !chip ? 400 : 0);
    scroller.current?.scrollTo({ top: 0 });
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

  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    onScroll(el);
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) void more();
  };

  const tile = (p: StickerPayload) => (
    <div key={p.id} onClick={() => onPick(p)} style={{ aspectRatio: '1', overflow: 'hidden', background: 'var(--bg-input)', cursor: 'pointer' }}>
      <img src={p.thumb || p.url} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Collapsible hidden={hidden} height={SEARCH_H}>
        <SearchRow value={q} onChange={(v) => { setQ(v); if (v) setChip(''); }} chip={chip} onChip={(c) => { setChip(c); if (c) setQ(''); }} placeholder="搜索 GIF" />
      </Collapsible>
      <div ref={scroller} className="no-scrollbar" onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', paddingBottom: 64 }}>
        {!query && recentGifs.length > 0 && (
          <>
            <SectionTitle>最近使用</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>{recentGifs.map(tile)}</div>
            <SectionTitle>热门</SectionTitle>
          </>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>{items.map(tile)}</div>
        {loading && <div className="empty" style={{ padding: 16, fontSize: 12 }}>{items.length ? '加载更多…' : '正在拉取 GIF，第一次会慢几秒…'}</div>}
        {!loading && !items.length && !error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{query ? '没有找到相关 GIF' : '暂无 GIF'}</div>}
        {error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}
