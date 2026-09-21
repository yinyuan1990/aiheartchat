import { useEffect, useRef, useState } from 'react';
import { searchGifs, StickerPayload, useStickers } from '../../stickers';
import { Collapsible, SearchRow, SectionTitle } from './shared';

const SEARCH_H = 44;

/**
 * GIF 页：没有顶部封面条，只有搜索行；内容 3 列瓦片（最近使用 + 热门），滚到底自动翻页。
 * 搜索行整条是按钮：和贴纸页一样弹搜索 sheet（onSearch("") 聚焦输入框；点快捷 emoji 带着它去搜）。
 */
export function GifPane({ hidden, onScroll, onPick, onSearch }: { hidden: boolean; onScroll: (el: HTMLElement) => void; onPick: (p: StickerPayload) => void; onSearch: (q: string) => void }) {
  const { recentGifs } = useStickers();
  const [items, setItems] = useState<StickerPayload[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // 热门
  useEffect(() => {
    const id = ++seq.current;
    (async () => {
      setLoading(true); setError('');
      try {
        const r = await searchGifs('', '');
        if (id !== seq.current) return;
        setItems(r.items); setNext(r.next);
      } catch (e: any) {
        if (id === seq.current) setError(e.message || '加载失败');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    })();
  }, []);

  const more = async () => {
    if (loading || !next) return;
    const id = seq.current;
    setLoading(true);
    try {
      const r = await searchGifs('', next);
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
        <SearchRow value="" onChange={() => {}} chip="" onChip={(e) => onSearch(e)} placeholder="搜索 GIF" onTap={() => onSearch('')} />
      </Collapsible>
      <div ref={scroller} className="no-scrollbar" onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', paddingBottom: 64 }}>
        {recentGifs.length > 0 && (
          <>
            <SectionTitle>最近使用</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>{recentGifs.map(tile)}</div>
          </>
        )}
        <SectionTitle>热门</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>{items.map(tile)}</div>
        {loading && <div className="empty" style={{ padding: 16, fontSize: 12 }}>{items.length ? '加载更多…' : '正在拉取 GIF，第一次会慢几秒…'}</div>}
        {!loading && !items.length && !error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>暂无 GIF</div>}
        {error && <div className="empty" style={{ padding: 30, fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}
