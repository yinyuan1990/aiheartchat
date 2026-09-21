import { CSSProperties, useCallback, useRef, useState } from 'react';

/** 搜索行右侧的快捷 emoji（Telegram 同款顺序）：贴纸按 emoji 过滤，GIF 当搜索词 */
export const QUICK_EMOJIS = ['❤️', '👍', '👎', '🎉', '👋', '😀', '😢', '😠'];

/** 面板高度：跟键盘差不多，且收起顶部后能完整放 5 行贴纸 */
export function defaultPanelHeight() {
  const w = Math.min(typeof window !== 'undefined' ? window.innerWidth : 375, 480);
  return Math.min(400, Math.max(320, Math.round(w * 0.9)));
}

/** 去掉 emoji 的变体选择符，比较用 */
export function baseEmoji(e: string) {
  return e.replace(/\uFE0F/g, '');
}

/**
 * 内容区滚动方向 → 顶部条 / 底部胶囊是否收起。
 * 往下滚（看更多）收起，往上滚或回到顶部展开；小于阈值的抖动忽略。
 */
export function useScrollChrome() {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  const onScroll = useCallback((el: HTMLElement) => {
    const top = el.scrollTop;
    const delta = top - last.current;
    last.current = top;
    if (top < 12) { setHidden(false); return; }
    if (delta > 8) setHidden(true);
    else if (delta < -8) setHidden(false);
  }, []);
  const reset = useCallback(() => { last.current = 0; setHidden(false); }, []);
  return { hidden, onScroll, reset };
}

/** 可折叠的头部（顶部条 + 搜索行）：hidden 时高度收到 0 */
export function Collapsible({ hidden, height, children }: { hidden: boolean; height: number; children: React.ReactNode }) {
  return (
    <div style={{ height: hidden ? 0 : height, opacity: hidden ? 0 : 1, overflow: 'hidden', transition: 'height .18s ease, opacity .18s ease', flexShrink: 0 }}>
      {children}
    </div>
  );
}

/** 搜索行：🔍 输入 + 快捷 emoji 一排 */
export function SearchRow({ value, onChange, chip, onChip, placeholder = '搜索' }: { value: string; onChange: (v: string) => void; chip: string; onChip: (e: string) => void; placeholder?: string }) {
  return (
    <div className="no-scrollbar" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 6px', overflowX: 'auto', height: 44, boxSizing: 'border-box' }}>
      <div className="row" style={{ background: 'var(--bg-input)', borderRadius: 17, height: 34, padding: '0 10px', gap: 6, flexShrink: 0, minWidth: value ? 200 : 96 }}>
        <span style={{ fontSize: 14, color: 'var(--text-3)' }}>🔍</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ border: 0, outline: 0, background: 'transparent', fontSize: 14, width: value ? 160 : 60, color: 'var(--text)' }}
        />
        {value && <span onClick={() => onChange('')} style={{ fontSize: 13, color: 'var(--text-3)', cursor: 'pointer' }}>✕</span>}
      </div>
      {QUICK_EMOJIS.map((e) => (
        <span
          key={e}
          onClick={() => onChip(chip === e ? '' : e)}
          style={{ fontSize: 20, lineHeight: '34px', width: 34, textAlign: 'center', flexShrink: 0, cursor: 'pointer', borderRadius: 17, background: chip === e ? 'var(--bg-input)' : 'transparent', filter: chip && chip !== e ? 'grayscale(1) opacity(.5)' : undefined }}
        >{e}</span>
      ))}
    </div>
  );
}

/** 分区标题（HOT CHERRY 那种灰色小标题） */
export function SectionTitle({ children, right, style }: { children: React.ReactNode; right?: React.ReactNode; style?: CSSProperties }) {
  return (
    <div className="row" style={{ padding: '10px 12px 4px', ...style }}>
      <span className="small grow" style={{ fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
      {right}
    </div>
  );
}

/** 顶部条上的一个格子（图标 / 封面），expanded 时下面带名字 */
export function BarCell({ active, onClick, title, expanded, badge, dataKey, children }: { active: boolean; onClick: () => void; title?: string; expanded?: boolean; badge?: boolean; dataKey?: string; children: React.ReactNode }) {
  return (
    <div
      title={title}
      data-key={dataKey}
      onClick={onClick}
      style={{ width: expanded ? 56 : 40, height: expanded ? 64 : 40, borderRadius: 10, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, background: active ? 'var(--bg-input)' : 'transparent', cursor: 'pointer', position: 'relative', transition: 'width .15s, height .15s' }}
    >
      <div style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{children}</div>
      {expanded && <span style={{ fontSize: 10, color: 'var(--text-2)', maxWidth: 54, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>}
      {badge && <span style={{ position: 'absolute', right: 2, top: expanded ? 4 : 2, width: 14, height: 14, borderRadius: 7, background: 'var(--accent)', color: '#fff', fontSize: 11, lineHeight: '14px', textAlign: 'center' }}>+</span>}
    </div>
  );
}

/** 顶部横向条：横向拖动时展开成两行（图 5），松手 1.5 秒后收回 */
export function useBarExpand() {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<number>();
  const touch = useCallback(() => {
    setExpanded(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setExpanded(false), 1500);
  }, []);
  const collapse = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setExpanded(false);
  }, []);
  return { expanded, touch, collapse };
}
