import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ScanIcon } from './QrScanner';

export interface SearchConv {
  id: string;
  type: number;
  peer?: { id: string; nickname: string; avatar: string; isBot?: boolean };
  group?: { id: string; name: string; avatar: string };
  lastMsg?: { type: string; content: string } | null;
  unread: number;
}

/** 消息页里不是会话的固定条目（AI 助手 / 音乐 / 评论通知 / 接单通知），也能被搜到 */
export interface SearchExtra {
  key: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  unread?: number;
  onOpen: () => void;
}

interface MessageHit {
  id: string;
  conversationId: string;
  convType: number;
  targetId: string;
  title: string;
  avatar: string;
  senderNickname: string;
  content: string;
  createdAt: string;
}

interface UserHit {
  id: string;
  nickname: string;
  avatar: string;
  age?: number;
  cityName?: string;
  isBot?: boolean;
  username?: string;
}

type Recent =
  | { kind: 'conv'; id: string }
  | { kind: 'user'; id: string; title: string; avatar: string; subtitle: string; isBot?: boolean }
  | { kind: 'extra'; id: string };

const RECENT_KEY = 'pw_chat_search_recent';
const RECENT_MAX = 20;

function loadRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveRecent(list: Recent[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

export function convTitle(c: SearchConv) {
  return c.type === 1 ? c.peer?.nickname ?? '' : c.group?.name ?? '';
}

function convAvatar(c: SearchConv) {
  return c.type === 1 ? c.peer?.avatar : c.group?.avatar;
}

function previewOf(msg?: SearchConv['lastMsg']) {
  if (!msg) return '';
  switch (msg.type) {
    case 'text': return msg.content.slice(0, 40);
    case 'image': return '[图片]';
    case 'video': return '[视频]';
    case 'sticker': return msg.content.includes('"mp4"') ? '[GIF]' : '[表情]';
    case 'gift': return '[礼物]';
    case 'audio': return '[语音]';
    case 'location': return '[位置]';
    default: return msg.type.startsWith('call') ? '[通话]' : '';
  }
}

function dateText(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 关键词高亮（不区分大小写） */
function Highlight({ text, q }: { text: string; q: string }) {
  const k = q.trim().toLowerCase();
  if (!k) return <>{text}</>;
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(k, i);
    if (at < 0) { out.push(text.slice(i)); break; }
    if (at > i) out.push(text.slice(i, at));
    out.push(<span key={at} className="cs-hl">{text.slice(at, at + k.length)}</span>);
    i = at + k.length;
  }
  return <>{out}</>;
}

function Badge({ n }: { n?: number }) {
  if (!n) return null;
  return <span className="cs-badge">{n > 99 ? '99+' : n}</span>;
}

/**
 * 消息页搜索弹框（Telegram 式）：
 * 空搜索 = 常用联系人横排 + 最近搜索；有关键词 = 聊天（本地会话名 + 全局用户）/ 消息（内容匹配）两栏。
 */
export function ChatSearch({
  convs, extras, onClose, onOpenConv, onOpenUser, onScan,
}: {
  convs: SearchConv[];
  extras: SearchExtra[];
  onClose: () => void;
  onOpenConv: (c: { id: string; type: number; targetId: string; title: string; focusMsgId?: string }) => void;
  /** 搜到的用户：直接打开私聊 */
  onOpenUser: (id: string, nickname: string, isBot?: boolean) => void;
  onScan: () => void;
}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'chats' | 'messages'>('chats');
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [result, setResult] = useState<{ q: string; messages: MessageHit[]; users: UserHit[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyword = q.trim();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!keyword) { setResult(null); setLoading(false); return; }
    setLoading(true);
    let alive = true;
    const t = setTimeout(() => {
      api<{ messages: MessageHit[]; users: UserHit[] }>(`/im/search?q=${encodeURIComponent(keyword)}`)
        .then((r) => { if (alive) setResult({ q: keyword, ...r }); })
        .catch(() => { if (alive) setResult({ q: keyword, messages: [], users: [] }); })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [keyword]);

  const remember = (item: Recent) => {
    const next = [item, ...recent.filter((r) => !(r.kind === item.kind && r.id === item.id))];
    setRecent(next);
    saveRecent(next);
  };

  const openConv = (c: SearchConv, focusMsgId?: string) => {
    remember({ kind: 'conv', id: c.id });
    onOpenConv({ id: c.id, type: c.type, targetId: (c.type === 1 ? c.peer?.id : c.group?.id) ?? '', title: convTitle(c), focusMsgId });
  };
  const openExtra = (e: SearchExtra) => {
    remember({ kind: 'extra', id: e.key });
    e.onOpen();
  };
  const openUser = (u: { id: string; title: string; avatar: string; subtitle: string; isBot?: boolean }) => {
    remember({ kind: 'user', ...u });
    onOpenUser(u.id, u.title, u.isBot);
  };

  const convById = useMemo(() => new Map(convs.map((c) => [c.id, c])), [convs]);
  const extraByKey = useMemo(() => new Map(extras.map((e) => [e.key, e])), [extras]);
  const peerIds = useMemo(() => new Set(convs.filter((c) => c.type === 1).map((c) => c.peer?.id)), [convs]);

  const lower = keyword.toLowerCase();
  const fresh = result && result.q === keyword ? result : null;
  const titleHits = keyword ? convs.filter((c) => convTitle(c).toLowerCase().includes(lower)) : [];
  // 服务端搜到的人（如按 @用户名 搜到的机器人）已经聊过：显示成会话
  const knownHits = (fresh?.users ?? [])
    .filter((u) => peerIds.has(u.id))
    .map((u) => convs.find((c) => c.type === 1 && c.peer?.id === u.id)!)
    .filter((c) => c && !titleHits.includes(c));
  const chatHits = [...titleHits, ...knownHits];
  const extraHits = keyword ? extras.filter((e) => e.title.toLowerCase().includes(lower)) : [];
  const userHits = (fresh?.users ?? []).filter((u) => !peerIds.has(u.id));
  const msgHits = fresh?.messages ?? [];

  const convRow = (c: SearchConv, sub?: ReactNode) => (
    <div key={`c${c.id}`} className="cs-row" onClick={() => openConv(c)}>
      <div className="avatar" style={{ width: 44, height: 44 }}>{convAvatar(c) && <img src={convAvatar(c)} alt="" />}</div>
      <div className="cs-row-main">
        <div className="cs-row-title ellipsis"><Highlight text={convTitle(c)} q={keyword} />{c.type === 2 && <span className="cs-tag">群</span>}{c.peer?.isBot && <span className="bot-tag">机器人</span>}</div>
        <div className="cs-row-sub ellipsis">{sub ?? previewOf(c.lastMsg)}</div>
      </div>
      <Badge n={c.unread} />
    </div>
  );

  const extraRow = (e: SearchExtra) => (
    <div key={`e${e.key}`} className="cs-row" onClick={() => openExtra(e)}>
      <div style={{ width: 44, height: 44, flexShrink: 0 }}>{e.icon}</div>
      <div className="cs-row-main">
        <div className="cs-row-title ellipsis"><Highlight text={e.title} q={keyword} /></div>
        <div className="cs-row-sub ellipsis">{e.subtitle}</div>
      </div>
      <Badge n={e.unread} />
    </div>
  );

  const userRow = (u: { id: string; title: string; avatar: string; subtitle: string; isBot?: boolean }) => (
    <div key={`u${u.id}`} className="cs-row" onClick={() => openUser(u)}>
      <div className="avatar" style={{ width: 44, height: 44 }}>{u.avatar && <img src={u.avatar} alt="" />}</div>
      <div className="cs-row-main">
        <div className="cs-row-title ellipsis"><Highlight text={u.title} q={keyword} />{u.isBot && <span className="bot-tag">机器人</span>}</div>
        <div className="cs-row-sub ellipsis">{u.subtitle}</div>
      </div>
    </div>
  );

  const userSub = (u: UserHit) => (u.isBot ? `@${u.username}` : [u.age ? `${u.age} 岁` : '', u.cityName ?? ''].filter(Boolean).join(' · ') || '用户');

  const top = convs.slice(0, 12);
  const recentRows = recent
    .map((r) => {
      if (r.kind === 'conv') { const c = convById.get(r.id); return c ? convRow(c) : null; }
      if (r.kind === 'extra') { const e = extraByKey.get(r.id); return e ? extraRow(e) : null; }
      return userRow(r);
    })
    .filter(Boolean);

  return (
    <div className="cs-mask">
      <div className="cs-panel">
        <div className="cs-head">
          <div className="cs-input">
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input ref={inputRef} value={q} placeholder="搜索" onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
            {q
              ? <span className="cs-clear" onClick={() => { setQ(''); inputRef.current?.focus(); }}>×</span>
              : <span className="cs-scan" title="扫一扫" onClick={onScan}><ScanIcon size={19} color="currentColor" /></span>}
          </div>
          <span className="cs-close" onClick={onClose}>
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </span>
        </div>

        {keyword && (
          <div className="cs-tabs">
            <span className={tab === 'chats' ? 'on' : ''} onClick={() => setTab('chats')}>聊天</span>
            <span className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>消息{msgHits.length > 0 ? ` ${msgHits.length}` : ''}</span>
          </div>
        )}

        <div className="cs-body no-scrollbar">
          {!keyword && (
            <>
              {top.length > 0 && (
                <div className="cs-top no-scrollbar">
                  {top.map((c) => (
                    <div key={c.id} className="cs-top-item" onClick={() => openConv(c)}>
                      <div className="cs-top-avatar">
                        <div className="avatar" style={{ width: 56, height: 56 }}>{convAvatar(c) && <img src={convAvatar(c)} alt="" />}</div>
                        <Badge n={c.unread} />
                      </div>
                      <div className="cs-top-name ellipsis">{convTitle(c)}</div>
                    </div>
                  ))}
                </div>
              )}
              {recentRows.length > 0 ? (
                <>
                  <div className="cs-section">
                    <span>最近</span>
                    <span className="cs-section-action" onClick={() => { setRecent([]); saveRecent([]); }}>清空</span>
                  </div>
                  {recentRows}
                </>
              ) : (
                <div className="cs-hint">搜索聊天、消息内容和用户</div>
              )}
            </>
          )}

          {keyword && tab === 'chats' && (
            <>
              {extraHits.map(extraRow)}
              {chatHits.map((c) => convRow(c))}
              {userHits.length > 0 && (
                <>
                  <div className="cs-section"><span>全局搜索</span></div>
                  {userHits.map((u) => userRow({ id: u.id, title: u.nickname, avatar: u.avatar, subtitle: userSub(u), isBot: u.isBot }))}
                </>
              )}
              {chatHits.length + extraHits.length + userHits.length === 0 && (
                <div className="cs-hint">{loading ? '搜索中…' : '没有找到相关聊天'}</div>
              )}
            </>
          )}

          {keyword && tab === 'messages' && (
            <>
              {msgHits.map((m) => (
                <div
                  key={m.id}
                  className="cs-row"
                  onClick={() => {
                    const c = convById.get(m.conversationId);
                    if (c) { openConv(c, m.id); return; }
                    onOpenConv({ id: m.conversationId, type: m.convType, targetId: m.targetId, title: m.title, focusMsgId: m.id });
                  }}
                >
                  <div className="avatar" style={{ width: 44, height: 44 }}>{m.avatar && <img src={m.avatar} alt="" />}</div>
                  <div className="cs-row-main">
                    <div className="row" style={{ gap: 8 }}>
                      <span className="cs-row-title grow ellipsis">{m.title}{m.convType === 2 && <span className="cs-tag">群</span>}</span>
                      <span className="small">{dateText(m.createdAt)}</span>
                    </div>
                    <div className="cs-row-sub cs-row-sub2">
                      {m.convType === 2 || m.senderNickname === '我' ? <span className="cs-sender">{m.senderNickname}：</span> : null}
                      <Highlight text={m.content} q={keyword} />
                    </div>
                  </div>
                </div>
              ))}
              {msgHits.length === 0 && <div className="cs-hint">{loading ? '搜索中…' : '没有找到相关消息'}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
