import { useEffect, useState } from 'react';
import { StickerPayload, StickerSet, useStickers } from '../stickers';
import { StickerThumb } from './StickerView';

export const EMOJIS = [
  '😀', '😂', '🥰', '😍', '😘', '😊', '🤔', '😎', '🥺', '😭', '😅', '🙃', '😏', '😴', '🤗', '😡',
  '❤️', '💕', '💔', '👍', '👏', '🙏', '🌹', '🎉', '🔥', '✨', '🙌', '🤝', '💪', '🍻', '🎂', '🌙',
];

type TabKey = 'emoji' | 'recent' | number;

/**
 * 表情面板（三端同一套交互）：顶部横向 tab（emoji / 最近 / 各表情包封面），下面网格。
 * onEmoji 传了才有 emoji tab（插入文字）；onPick 点贴纸。聊天里点即发送，评论里挂到待发评论上。
 */
export function StickerPanel({ onPick, onEmoji, height = 260 }: { onPick: (p: StickerPayload) => void; onEmoji?: (e: string) => void; height?: number }) {
  const { sets, recent } = useStickers();
  const [tab, setTab] = useState<TabKey>(onEmoji ? 'emoji' : recent.length ? 'recent' : sets[0]?.id ?? 'recent');

  // 首次加载完成后若还停在空的「最近」，跳到第一个包
  useEffect(() => {
    if (tab === 'recent' && !recent.length && sets.length && !onEmoji) setTab(sets[0].id);
  }, [sets.length]);

  const current: StickerSet | undefined = typeof tab === 'number' ? sets.find((s) => s.id === tab) : undefined;
  const tabBtn = (key: TabKey, active: boolean, child: JSX.Element, title?: string) => (
    <div
      key={String(key)}
      title={title}
      onClick={() => setTab(key)}
      style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'var(--bg-input)' : 'transparent', cursor: 'pointer', fontSize: 20,
      }}
    >
      {child}
    </div>
  );

  return (
    <div style={{ height, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)', borderTop: '1px solid var(--line)' }} onClick={(e) => e.stopPropagation()}>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 4, padding: '6px 8px', overflowX: 'auto', borderBottom: '1px solid var(--line)' }}>
        {onEmoji && tabBtn('emoji', tab === 'emoji', <span>☺</span>, 'Emoji')}
        {tabBtn('recent', tab === 'recent', <span style={{ fontSize: 17, color: 'var(--text-2)' }}>🕒</span>, '最近使用')}
        {sets.map((s) => tabBtn(s.id, tab === s.id, s.thumb ? <img src={s.thumb} alt="" style={{ width: 28, height: 28, objectFit: 'contain' }} /> : <span style={{ fontSize: 12 }}>{s.title.slice(0, 2)}</span>, s.title))}
      </div>

      <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {tab === 'emoji' && onEmoji && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
            {EMOJIS.map((e) => (
              <span key={e} style={{ textAlign: 'center', fontSize: 24, cursor: 'pointer', padding: '6px 0' }} onClick={() => onEmoji(e)}>{e}</span>
            ))}
          </div>
        )}
        {tab === 'recent' && (
          recent.length
            ? <Grid items={recent} onPick={onPick} />
            : <div className="empty" style={{ padding: 30, fontSize: 13 }}>{sets.length ? '还没用过表情，先从右边的表情包里挑一个' : '表情包还在路上…'}</div>
        )}
        {current && (
          <>
            <div className="small" style={{ padding: '2px 4px 6px' }}>{current.title}</div>
            <Grid items={current.items} onPick={onPick} />
          </>
        )}
        {typeof tab === 'number' && !current && <div className="empty" style={{ padding: 30, fontSize: 13 }}>加载中…</div>}
      </div>
    </div>
  );
}

function Grid({ items, onPick }: { items: StickerPayload[]; onPick: (p: StickerPayload) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
      {items.map((p) => (
        <div key={p.id} style={{ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, cursor: 'pointer' }} onClick={() => onPick(p)}>
          <StickerThumb p={p} size={60} />
        </div>
      ))}
    </div>
  );
}
