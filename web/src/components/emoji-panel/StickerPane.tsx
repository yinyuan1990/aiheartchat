import { useEffect, useRef, useState } from 'react';
import { addMine, StickerPayload, useStickers } from '../../stickers';
import { StickerView } from '../StickerView';
import { BarCell, Collapsible, SearchRow, SectionTitle, useBarExpand } from './shared';

const BAR_H = 52;
const SEARCH_H = 44;

/**
 * 贴纸页：顶部条（⊕ 商店 / 🕒 最近 / 我的包封面… / 库里没加的带 +）+ 搜索行，
 * 内容是所有包连续滚动、每包一个标题分区；滚到哪个包顶部封面跟着亮。
 * 搜索行整条是按钮：和「+」一样弹表情商店 sheet（聚焦搜索框）；点快捷 emoji 带着它去搜。
 */
export function StickerPane({ hidden, onScroll, onPick, onStore }: { hidden: boolean; onScroll: (el: HTMLElement) => void; onPick: (p: StickerPayload) => void; onStore: (query?: string) => void }) {
  const { sets, mine, mineIds, recent } = useStickers();
  const [active, setActive] = useState<string>('recent');
  const [adding, setAdding] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const { expanded, touch, collapse } = useBarExpand();

  const others = sets.filter((s) => !mineIds.includes(s.id));

  // 滚动：通知外层收起/展开 + 算当前分区
  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    onScroll(el);
    const top = el.scrollTop + 8;
    let cur = 'recent';
    sections.current.forEach((node, key) => { if (node.offsetTop <= top) cur = key; });
    if (cur !== active) setActive(cur);
  };

  // 当前封面滚到可见
  useEffect(() => {
    const cell = bar.current?.querySelector<HTMLElement>(`[data-key="${active}"]`);
    cell?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);

  const jump = (key: string) => {
    collapse();
    const el = scroller.current;
    const node = sections.current.get(key);
    if (!el || !node) return;
    el.scrollTo({ top: node.offsetTop, behavior: 'smooth' });
    setActive(key);
  };

  const add = async (id: number) => {
    setAdding(id);
    try { await addMine(id); } catch (e: any) { alert(e.message); } finally { setAdding(null); }
  };

  const grid = (items: StickerPayload[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, padding: '0 8px' }}>
      {items.map((p) => (
        <div key={p.id} style={{ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, cursor: 'pointer' }} onClick={() => onPick(p)}>
          <StickerView p={p} size={62} />
        </div>
      ))}
    </div>
  );

  const section = (key: string, title: string, items: StickerPayload[]) => (
    <div key={key} ref={(n) => { if (n) sections.current.set(key, n); else sections.current.delete(key); }}>
      <SectionTitle>{title}</SectionTitle>
      {grid(items)}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Collapsible hidden={hidden} height={BAR_H + SEARCH_H}>
        <div
          ref={bar}
          className="no-scrollbar"
          onTouchStart={touch}
          onTouchMove={touch}
          onWheel={touch}
          onScroll={touch}
          style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 6px 0', overflowX: 'auto', height: expanded ? BAR_H + 24 : BAR_H, boxSizing: 'border-box', transition: 'height .15s', position: 'relative', zIndex: 2, background: 'var(--bg-card)' }}
        >
          <BarCell active={false} onClick={() => onStore()} title="表情商店" expanded={expanded}>
            <span style={{ width: 26, height: 26, borderRadius: 13, border: '1.5px solid var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: 'var(--text-2)', lineHeight: 1 }}>+</span>
          </BarCell>
          <BarCell dataKey="recent" active={active === 'recent'} onClick={() => jump('recent')} title="最近使用" expanded={expanded}>
            <span style={{ fontSize: 18, color: 'var(--text-2)' }}>🕒</span>
          </BarCell>
          {mine.map((s) => (
            <BarCell key={s.id} dataKey={`s${s.id}`} active={active === `s${s.id}`} onClick={() => jump(`s${s.id}`)} title={s.title} expanded={expanded}>
              {s.thumb ? <img src={s.thumb} alt="" style={{ width: 28, height: 28, objectFit: 'contain' }} draggable={false} /> : <span style={{ fontSize: 11 }}>{s.title.slice(0, 2)}</span>}
            </BarCell>
          ))}
          {others.slice(0, 12).map((s) => (
            <BarCell key={`o${s.id}`} active={false} onClick={() => add(s.id)} title={s.title} expanded={expanded} badge>
              {s.thumb ? <img src={s.thumb} alt="" style={{ width: 28, height: 28, objectFit: 'contain', opacity: adding === s.id ? 0.4 : 1 }} draggable={false} /> : <span style={{ fontSize: 11 }}>{s.title.slice(0, 2)}</span>}
            </BarCell>
          ))}
        </div>
        <SearchRow value="" onChange={() => {}} chip="" onChip={(e) => onStore(e)} placeholder="搜索" onTap={() => onStore('')} />
      </Collapsible>

      <div ref={scroller} className="no-scrollbar" onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', position: 'relative', paddingBottom: 64 }}>
        {recent.length > 0 && section('recent', '最近使用', recent)}
        {!recent.length && (
          <div ref={(n) => { if (n) sections.current.set('recent', n); }} className="empty" style={{ padding: '18px 16px 6px', fontSize: 12 }}>
            {mine.length ? '还没用过贴纸，往下挑一个' : '还没有贴纸包'}
          </div>
        )}
        {mine.map((s) => section(`s${s.id}`, s.title, s.items))}
        {!mine.length && (
          <div className="empty" style={{ padding: '10px 16px 30px' }}>
            <button className="btn-sm" onClick={() => onStore()}>去表情商店添加</button>
          </div>
        )}
      </div>
    </div>
  );
}
