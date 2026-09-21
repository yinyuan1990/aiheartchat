import { useEffect, useMemo, useRef, useState } from 'react';
import { addRecentEmoji, EmojiItem, searchEmojis, useEmojis } from '../../emojis';
import { BarCell, Collapsible, SearchRow, SectionTitle, useBarExpand } from './shared';

const BAR_H = 52;
const SEARCH_H = 44;

/** 表情页：顶部 🕒 + 8 个分类图标，搜索行（关键词搜 emoji），内容 8 列按分类分区 */
export function EmojiPane({ hidden, onScroll, onEmoji }: { hidden: boolean; onScroll: (el: HTMLElement) => void; onEmoji: (e: string) => void }) {
  const { groups, recent } = useEmojis();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('');
  const [active, setActive] = useState('recent');
  const scroller = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const { expanded, touch, collapse } = useBarExpand();

  const query = q.trim() || chip;
  const results = useMemo(() => (query ? searchEmojis(groups, query) : []), [groups, query]);

  const handleScroll = () => {
    const el = scroller.current;
    if (!el) return;
    onScroll(el);
    if (query) return;
    const top = el.scrollTop + 8;
    let cur = 'recent';
    sections.current.forEach((node, key) => { if (node.offsetTop <= top) cur = key; });
    if (cur !== active) setActive(cur);
  };

  useEffect(() => {
    bar.current?.querySelector<HTMLElement>(`[data-key="${active}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);

  const jump = (key: string) => {
    collapse();
    setQ(''); setChip('');
    const node = sections.current.get(key);
    if (node && scroller.current) scroller.current.scrollTo({ top: node.offsetTop, behavior: 'smooth' });
    setActive(key);
  };

  const pick = (e: string) => {
    onEmoji(e);
    addRecentEmoji(e);
  };

  const grid = (items: string[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', padding: '0 6px' }}>
      {items.map((e, i) => (
        <span key={`${e}-${i}`} onClick={() => pick(e)} style={{ textAlign: 'center', fontSize: 26, lineHeight: '42px', cursor: 'pointer', borderRadius: 8, userSelect: 'none' }}>{e}</span>
      ))}
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
          <BarCell dataKey="recent" active={active === 'recent' && !query} onClick={() => jump('recent')} title="最近使用" expanded={expanded}>
            <span style={{ fontSize: 18, color: 'var(--text-2)' }}>🕒</span>
          </BarCell>
          {groups.map((g) => (
            <BarCell key={g.key} dataKey={g.key} active={active === g.key && !query} onClick={() => jump(g.key)} title={g.name} expanded={expanded}>
              <span style={{ fontSize: 20, filter: active === g.key ? undefined : 'grayscale(1) opacity(.7)' }}>{g.icon}</span>
            </BarCell>
          ))}
        </div>
        <SearchRow value={q} onChange={setQ} chip={chip} onChip={setChip} placeholder="搜索表情" />
      </Collapsible>

      <div ref={scroller} className="no-scrollbar" onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', position: 'relative', paddingBottom: 64 }}>
        {query ? (
          results.length ? grid(results.map((r: EmojiItem) => r[0])) : <div className="empty" style={{ padding: 30, fontSize: 13 }}>没有匹配的表情</div>
        ) : (
          <>
            <div ref={(n) => { if (n) sections.current.set('recent', n); }}>
              {recent.length > 0 && <><SectionTitle>最近使用</SectionTitle>{grid(recent)}</>}
            </div>
            {groups.map((g) => (
              <div key={g.key} ref={(n) => { if (n) sections.current.set(g.key, n); else sections.current.delete(g.key); }}>
                <SectionTitle>{g.name}</SectionTitle>
                {grid(g.items.map((it) => it[0]))}
              </div>
            ))}
            {!groups.length && <div className="empty" style={{ padding: 30, fontSize: 13 }}>加载中…</div>}
          </>
        )}
      </div>
    </div>
  );
}
