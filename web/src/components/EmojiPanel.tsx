import { useEffect, useState } from 'react';
import { addRecent, StickerPayload } from '../stickers';
import { StickerStoreSheet } from './StickerStore';
import { EmojiPane } from './emoji-panel/EmojiPane';
import { GifPane } from './emoji-panel/GifPane';
import { StickerPane } from './emoji-panel/StickerPane';
import { EmojiSearchSheet, GifSearchSheet } from './emoji-panel/SearchSheets';
import { defaultPanelHeight, useScrollChrome } from './emoji-panel/shared';

export type PanelMode = 'gif' | 'sticker' | 'emoji';
const MODE_KEY = 'pw_emoji_panel_mode';

/**
 * 表情面板（Telegram 式，三端同一套）：底部悬浮胶囊切 GIF / 贴纸 / 表情 三个模式，
 * 内容往下滚时胶囊和顶部条一起收起、往上滚回来。
 * - 表情：点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 * - 贴纸 / GIF：点了回调 onPick（聊天里即发送，评论里挂到待发区），右 ⚙ 管理我的贴纸
 */
export function EmojiPanel({ onPick, onEmoji, onDelete, onKeyboard, height }: {
  onPick: (p: StickerPayload) => void;
  onEmoji?: (e: string) => void;
  onDelete?: () => void;
  onKeyboard?: () => void;
  height?: number;
}) {
  const [mode, setMode] = useState<PanelMode>(() => {
    const m = localStorage.getItem(MODE_KEY) as PanelMode | null;
    return m === 'gif' || m === 'emoji' || m === 'sticker' ? m : 'sticker';
  });
  /** 底部 sheet：商店 / 管理 / GIF 搜索 / 表情搜索。query 有值 = 从搜索行进来（'' 只聚焦搜索框，emoji 直接带着搜） */
  const [sheet, setSheet] = useState<{ kind: 'store' | 'manage' | 'gif' | 'emoji'; query?: string } | null>(null);
  const { hidden, onScroll, reset } = useScrollChrome();
  const h = height ?? defaultPanelHeight();

  useEffect(() => { reset(); localStorage.setItem(MODE_KEY, mode); }, [mode]);

  const pick = (p: StickerPayload) => {
    onPick(p);
    addRecent(p);
  };

  const modes: [PanelMode, string][] = [['gif', 'GIF'], ['sticker', '贴纸'], ['emoji', '表情']];

  return (
    <div style={{ height: h, position: 'relative', background: 'var(--bg-card)', borderTop: '1px solid var(--line)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
      {mode === 'sticker' && <StickerPane hidden={hidden} onScroll={onScroll} onPick={pick} onStore={(query) => setSheet({ kind: 'store', query })} />}
      {mode === 'gif' && <GifPane hidden={hidden} onScroll={onScroll} onPick={pick} onSearch={(query) => setSheet({ kind: 'gif', query })} />}
      {mode === 'emoji' && <EmojiPane hidden={hidden} onScroll={onScroll} onEmoji={(e) => onEmoji?.(e)} onSearch={(query) => setSheet({ kind: 'emoji', query })} />}

      {/* 底部悬浮：左 🌐（表情模式）/ 胶囊 / 右 ⌫ 或 ⚙ */}
      {mode === 'emoji' && onKeyboard && (
        <div className={`ep-chrome ep-side${hidden ? ' hide' : ''}`} style={{ left: 12 }} title="切回键盘" onClick={onKeyboard}>🌐</div>
      )}
      <div className={`ep-chrome${hidden ? ' hide' : ''}`} style={{ left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div className="ep-pill" style={{ pointerEvents: 'auto' }}>
          {modes.map(([k, label]) => <span key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{label}</span>)}
        </div>
      </div>
      {mode === 'emoji' && onDelete && (
        <div className={`ep-chrome ep-side${hidden ? ' hide' : ''}`} style={{ right: 12 }} title="删除" onClick={onDelete}>⌫</div>
      )}
      {mode === 'sticker' && (
        <div className={`ep-chrome ep-side${hidden ? ' hide' : ''}`} style={{ right: 12, fontSize: 17 }} title="管理我的贴纸" onClick={() => setSheet({ kind: 'manage' })}>⚙</div>
      )}

      {sheet && (sheet.kind === 'store' || sheet.kind === 'manage') && (
        <StickerStoreSheet mode={sheet.kind} initialQuery={sheet.query ?? ''} autoFocus={sheet.query !== undefined} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'gif' && <GifSearchSheet initialQuery={sheet.query ?? ''} onPick={pick} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'emoji' && <EmojiSearchSheet initialQuery={sheet.query ?? ''} onEmoji={(e) => onEmoji?.(e)} onClose={() => setSheet(null)} />}
    </div>
  );
}
