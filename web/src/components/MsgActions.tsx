import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Reaction, ReplyPreview } from '../ws';
import { chainCardPreview } from './ChainCards';

/** 与后端 MSG_REACTIONS 一致；前 7 个是菜单顶上那一排 */
export const MSG_REACTIONS = ['❤️', '👍', '👎', '🔥', '🥰', '👏', '😁', '😂', '😮', '😢', '🎉', '🙏'];

/** 能转发的类型（礼物、通话记录、转账卡片不行；喊单卡片可以），和后端 message.service FORWARDABLE 一致 */
export const FORWARDABLE = new Set(['text', 'image', 'video', 'audio', 'location', 'sticker', 'callout']);

export interface MenuMsg {
  id: string;
  senderId: string;
  senderNickname: string;
  type: string;
  content: string;
  pending?: boolean;
}

/** 消息的简短文字描述（引用条、置顶条、转发预览用） */
export function msgSnippet(type: string, content: string): string {
  switch (type) {
    case 'text': return content.replace(/\s+/g, ' ').slice(0, 60);
    case 'image': return '[图片]';
    case 'video': return '[视频]';
    case 'audio': return '[语音]';
    case 'sticker': return '[表情]';
    case 'location': return '[位置]';
    case 'gift': return '[礼物]';
    case 'transfer':
    case 'callout':
    case 'perp':
    case 'payreq': return chainCardPreview(type, content) ?? '[消息]';
    default: return type.startsWith('call') ? '[通话]' : '[消息]';
  }
}

function fmtReadAt(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface MenuActions {
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy?: () => void;
  onSave?: () => void;
  onPin?: () => void;
  onForward?: () => void;
  onReport?: () => void;
  onDelete: () => void;
  onSelect: () => void;
}

/**
 * 长按 / 点消息弹出的菜单（Telegram 式）：顶上一排表情，自己的消息显示已读时间，下面按类型给操作。
 * 各操作是否出现由调用方按类型决定（传 undefined 就不显示）。
 */
export function MsgMenu({
  m, mine, convType, myReaction, pinned, x, y, onClose, actions,
}: {
  m: MenuMsg; mine: boolean; convType: number; myReaction?: string; pinned: boolean;
  x: number; y: number; onClose: () => void; actions: MenuActions;
}) {
  const [expand, setExpand] = useState(false);
  const [readInfo, setReadInfo] = useState<any>(null);
  const [showReaders, setShowReaders] = useState(false);

  useEffect(() => {
    if (!mine || m.pending) return;
    api<any>(`/im/messages/${m.id}/readers`).then(setReadInfo).catch(() => {});
  }, [m.id]);

  const W = 250;
  const left = Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y - 40, window.innerHeight - 420));
  const run = (fn?: () => void) => () => { onClose(); fn?.(); };

  const items: [string, (() => void) | undefined, boolean?][] = [
    ['回复', actions.onReply],
    ['拷贝', actions.onCopy],
    ['保存', actions.onSave],
    [pinned ? '取消置顶' : '置顶', actions.onPin],
    ['转发', actions.onForward],
    ['举报', actions.onReport],
    ['删除', actions.onDelete, true],
    ['选择', actions.onSelect],
  ];

  return (
    <div className="msg-menu-mask" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="msg-menu" style={{ left, top, width: W }} onClick={(e) => e.stopPropagation()}>
        <div className={`react-row${expand ? ' expanded' : ''}`}>
          {(expand ? MSG_REACTIONS : MSG_REACTIONS.slice(0, 7)).map((e) => (
            <span key={e} className={myReaction === e ? 'on' : ''} onClick={run(() => actions.onReact(e))}>{e}</span>
          ))}
          {!expand && <span className="more" title="更多表情" onClick={() => setExpand(true)}>⌄</span>}
        </div>
        <div className="msg-menu-list">
          {readInfo && convType === 1 && (
            <div className="read-line">{readInfo.read ? `✓✓ ${readInfo.readAt ? fmtReadAt(readInfo.readAt) + ' ' : ''}已读` : '✓ 未读'}</div>
          )}
          {readInfo && convType === 2 && (
            <>
              <div className="read-line" style={{ cursor: readInfo.count ? 'pointer' : 'default' }} onClick={() => readInfo.count && setShowReaders((v) => !v)}>
                ✓✓ {readInfo.count ? `${readInfo.count} 人已读` : '还没人读'}{readInfo.count ? (showReaders ? ' ⌃' : ' ›') : ''}
              </div>
              {showReaders && (
                <div className="readers">
                  {readInfo.users.map((u: any) => (
                    <div key={u.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
                      <div className="avatar" style={{ width: 22, height: 22 }}>{u.avatar && <img src={u.avatar} alt="" />}</div>
                      <span className="ellipsis" style={{ fontSize: 13 }}>{u.nickname}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {items.filter(([, fn]) => !!fn).map(([label, fn, danger]) => (
            <div key={label} className={`msg-menu-item${danger ? ' danger' : ''}`} onClick={run(fn)}>{label}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 气泡下方的表情回应小胶囊，点一下切换自己的回应 */
export function ReactionChips({ reactions, myId, onToggle }: { reactions?: Reaction[]; myId?: string; onToggle: (emoji: string) => void }) {
  if (!reactions?.length) return null;
  return (
    <div className="react-chips">
      {reactions.map((r) => (
        <span key={r.emoji} className={myId && r.userIds.includes(myId) ? 'mine' : ''} onClick={(e) => { e.stopPropagation(); onToggle(r.emoji); }}>
          {r.emoji} {r.count}
        </span>
      ))}
    </div>
  );
}

/** 气泡里的引用块；点了跳到原消息 */
export function ReplyQuote({ r, onClick }: { r: ReplyPreview; onClick: () => void }) {
  return (
    <div className="reply-quote no-menu" onClick={(e) => { e.stopPropagation(); if (!r.deleted) onClick(); }}>
      {r.deleted ? (
        <div className="small">原消息已删除</div>
      ) : (
        <>
          <div className="name">{r.senderNickname}</div>
          <div className="row" style={{ gap: 6 }}>
            {r.type === 'image' && r.content && <img src={r.content} alt="" />}
            <span className="ellipsis">{r.type === 'text' ? r.content : msgSnippet(r.type, '')}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** 输入框上方「回复 xxx」条 */
export function ReplyBar({ m, onCancel }: { m: MenuMsg; onCancel: () => void }) {
  return (
    <div className="reply-bar">
      <span className="bar-icon">↩</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="name">回复 {m.senderNickname}</div>
        <div className="ellipsis small">{msgSnippet(m.type, m.content)}</div>
      </div>
      <span className="close" onClick={onCancel}>×</span>
    </div>
  );
}

export interface PinItem extends ReplyPreview { pinnedAt: string }

/** 顶部置顶条：点一下跳到这条，再点轮到下一条（新的在前） */
export function PinBar({ pins, index, canUnpin, onJump, onUnpin }: {
  pins: PinItem[]; index: number; canUnpin: boolean; onJump: () => void; onUnpin: () => void;
}) {
  const p = pins[index % pins.length];
  if (!p) return null;
  return (
    <div className="pin-bar" onClick={onJump}>
      <div className="pin-ticks">{pins.slice(0, 5).map((x, i) => <i key={x.id} className={i === index % pins.length ? 'on' : ''} />)}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="name">置顶消息{pins.length > 1 ? ` #${(index % pins.length) + 1}` : ''}</div>
        <div className="ellipsis small">{p.type === 'text' ? p.content : msgSnippet(p.type, '')}</div>
      </div>
      {canUnpin && <span className="close" title="取消置顶" onClick={(e) => { e.stopPropagation(); onUnpin(); }}>×</span>}
    </div>
  );
}

/** 删除确认（Telegram 式）：自己的消息可勾选「同时为对方删除」 */
export function DeleteDialog({ count, canForAll, convType, peerName, onConfirm, onClose }: {
  count: number; canForAll: boolean; convType: number; peerName?: string;
  onConfirm: (forAll: boolean) => void; onClose: () => void;
}) {
  const [forAll, setForAll] = useState(true);
  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" style={{ textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
        <h3>删除{count > 1 ? ` ${count} 条` : ''}消息？</h3>
        {canForAll ? (
          <label className="row" style={{ gap: 8, fontSize: 14, margin: '6px 0 18px', cursor: 'pointer' }}>
            <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} />
            {convType === 1 ? `同时为 ${peerName || '对方'} 删除` : '为所有人删除'}
          </label>
        ) : (
          <p style={{ textAlign: 'left' }}>只会在你这边删除，对方仍能看到。</p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18 }}>
          <span style={{ cursor: 'pointer', color: 'var(--text-2)' }} onClick={onClose}>取消</span>
          <span style={{ cursor: 'pointer', color: 'var(--danger)', fontWeight: 600 }} onClick={() => onConfirm(canForAll && forAll)}>删除</span>
        </div>
      </div>
    </div>
  );
}

const REPORT_REASONS = ['垃圾广告', '色情低俗', '诈骗', '辱骂骚扰', '违法违规', '其他'];

export function ReportSheet({ msgId, onClose, onDone }: { msgId: string; onClose: () => void; onDone: (tip: string) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const submit = async (reason: string) => {
    try {
      const r = await api<any>(`/im/messages/${msgId}/report`, { method: 'POST', body: { reason } });
      onDone(r?.duplicated ? '已经举报过了，我们会尽快处理' : '已举报，我们会尽快处理');
    } catch (e: any) {
      onDone(e.message || '举报失败');
    }
  };
  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 10 }}>举报这条消息</div>
        {!other ? (
          REPORT_REASONS.map((r) => (
            <div key={r} className="sheet-item" onClick={() => (r === '其他' ? setOther(true) : submit(r))}>{r}</div>
          ))
        ) : (
          <>
            <textarea className="input" rows={3} maxLength={200} placeholder="说说是什么问题" value={text} onChange={(e) => setText(e.target.value)} style={{ resize: 'none' }} />
            <button className="btn" disabled={!text.trim()} onClick={() => submit(`其他：${text.trim()}`)}>提交</button>
          </>
        )}
      </div>
    </div>
  );
}

interface ConvLite {
  id: string;
  type: number;
  peer?: { id: string; nickname: string; avatar: string; isBot?: boolean };
  group?: { id: string; name: string; avatar: string; kind?: number };
}

/** 转发：选会话（最多 10 个），按原消息顺序发过去 */
export function ForwardSheet({ fromConversationId, ids, onClose, onDone }: {
  fromConversationId: string; ids: string[]; onClose: () => void; onDone: (tip: string, convIds: string[]) => void;
}) {
  const [convs, setConvs] = useState<ConvLite[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ConvLite[]>('/im/conversations').then((l) => setConvs(l.filter((c) => c.peer || c.group))).catch(() => {});
  }, []);

  const name = (c: ConvLite) => c.peer?.nickname ?? c.group?.name ?? '';
  const shown = convs.filter((c) => !q.trim() || name(c).toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? p : [...p, id]));

  const send = async () => {
    const targets = picked.map((id) => convs.find((c) => c.id === id)!).map((c) => ({
      convType: c.type === 1 ? 1 : 2,
      targetId: c.type === 1 ? c.peer!.id : c.group!.id,
    }));
    setBusy(true);
    try {
      const r = await api<{ results: { ok: boolean; error?: string }[] }>('/im/messages/forward', {
        method: 'POST', body: { fromConversationId, ids, targets },
      });
      const failed = r.results.filter((x) => !x.ok);
      onDone(failed.length ? `${failed.length} 个会话转发失败：${failed[0].error ?? ''}` : '已转发', picked);
    } catch (e: any) {
      onDone(e.message || '转发失败', []);
    }
    setBusy(false);
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" style={{ maxHeight: '75vh' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 10 }}>转发{ids.length > 1 ? ` ${ids.length} 条消息` : ''}到…</div>
        <input className="input" placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 && <div className="empty" style={{ padding: 20 }}>没有会话</div>}
        {shown.map((c) => (
          <div key={c.id} className="row fwd-item" onClick={() => toggle(c.id)}>
            <div className="avatar" style={{ width: 38, height: 38 }}>{(c.peer?.avatar || c.group?.avatar) && <img src={c.peer?.avatar || c.group?.avatar} alt="" />}</div>
            <div className="grow ellipsis">
              {name(c)}
              {c.group && <span className="small"> · {c.group.kind === 2 ? '频道' : '群'}</span>}
              {c.peer?.isBot && <span className="bot-tag">机器人</span>}
            </div>
            <span className={`sel-circle${picked.includes(c.id) ? ' on' : ''}`}>{picked.includes(c.id) ? '✓' : ''}</span>
          </div>
        ))}
        <div style={{ position: 'sticky', bottom: -16, background: 'var(--bg-card)', padding: '10px 0 0' }}>
          <button className="btn" disabled={!picked.length || busy} onClick={send}>{busy ? '发送中…' : `发送${picked.length ? `（${picked.length}）` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}

/** 保存图片 / 视频：能拿到文件就下载，跨域拿不到就新开页 */
export async function saveMedia(url: string, type: string) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const ext = (url.split('?')[0].match(/\.(\w{2,5})$/)?.[1]) ?? (type === 'video' ? 'mp4' : 'jpg');
    a.download = `${type}_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
