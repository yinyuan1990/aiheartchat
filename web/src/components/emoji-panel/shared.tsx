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

/** 🔍 图标（线条，和 Telegram 一致） */
export function SearchIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" />
    </svg>
  );
}

/**
 * 搜索行（Telegram 图）：一整条圆角胶囊，左边 🔍「搜索」，右边一排**虚化**的快捷 emoji。
 * - 贴纸页传 onTap：整条胶囊是个按钮（和「+」一样弹表情商店 sheet 并聚焦搜索），点快捷 emoji 直接带着它去搜；
 * - 表情 / GIF 页不传：点胶囊变成输入框就地搜，快捷 emoji 点亮一个当过滤词。
 */
export function SearchRow({ value, onChange, chip, onChip, placeholder = '搜索', onTap }: {
  value: string; onChange: (v: string) => void; chip: string; onChip: (e: string) => void; placeholder?: string; onTap?: () => void;
}) {
  const [focus, setFocus] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = !onTap && (focus || !!value);
  const chipStyle = (e: string): CSSProperties => ({
    fontSize: 19, lineHeight: '30px', width: 30, textAlign: 'center', flexShrink: 0, cursor: 'pointer', borderRadius: 15,
    background: chip === e ? 'var(--bg-card)' : 'transparent',
    // 虚化：灰度 + 半透明，被选中的那个才恢复彩色
    filter: chip === e ? undefined : 'grayscale(1)',
    opacity: chip === e ? 1 : 0.45,
    transition: 'opacity .15s',
  });
  return (
    <div style={{ padding: '4px 10px 8px', height: 44, boxSizing: 'border-box' }}>
      <div
        className="row"
        onClick={() => { if (onTap) onTap(); else { setFocus(true); inputRef.current?.focus(); } }}
        style={{ background: 'var(--bg-input)', borderRadius: 18, height: 32, padding: '0 6px 0 12px', gap: 6, cursor: 'text', overflow: 'hidden' }}
      >
        <span style={{ color: 'var(--text-3)', display: 'flex', flexShrink: 0 }}><SearchIcon /></span>
        {onTap ? (
          <span style={{ fontSize: 14, color: 'var(--text-3)', flexShrink: 0 }}>{placeholder}</span>
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder={placeholder}
            style={{ border: 0, outline: 0, background: 'transparent', fontSize: 14, color: 'var(--text)', width: editing ? undefined : 44, flex: editing ? 1 : undefined, minWidth: 0 }}
          />
        )}
        {editing ? (
          <span onClick={(e) => { e.stopPropagation(); onChange(''); onChip(''); setFocus(false); inputRef.current?.blur(); }} style={{ fontSize: 13, color: 'var(--text-3)', cursor: 'pointer', padding: '0 6px' }}>✕</span>
        ) : (
          <div className="no-scrollbar" style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto', overflowX: 'auto', flex: 1, justifyContent: 'flex-end' }}>
            {QUICK_EMOJIS.map((e) => (
              <span key={e} onClick={(ev) => { ev.stopPropagation(); onChip(chip === e ? '' : e); }} style={chipStyle(e)}>{e}</span>
            ))}
          </div>
        )}
      </div>
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
