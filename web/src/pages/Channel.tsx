import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { useApp } from '../store';
import { wsManager, MessagePayload } from '../ws';
import { nearestCity } from '../cities';
import { parseSticker, StickerPayload } from '../stickers';
import { dropLastGrapheme } from '../emojis';
import { EmojiPanel } from '../components/EmojiPanel';
import { StickerView } from '../components/StickerView';
import { AttachSheet, AttachAction } from '../components/AttachSheet';
import { LinkText } from '../components/LinkText';
import { dust, dustThen, undust } from '../dust';
import { AudioBubble, GroupShareView } from './ChatRoom';
import { AddBotSheet, InlineKeyboard, InlineMarkup } from './Bots';
import { lang, t } from '../i18n';

/** 频道（kind=2 的群）：频道主发帖，订阅者看帖 + 表情回应 + 评论。帖子就是这个群会话里的消息。 */

export const REACTIONS = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🎉', '👎'];

export interface ChannelInfo {
  id: string;
  name: string;
  avatar: string;
  description: string;
  ownerId: string;
  owner?: { id: string; nickname: string; avatar: string } | null;
  subscribers: number;
  conversationId?: string;
  isMember: boolean;
  role: string | null;
  /** 频道主 / 管理员 */
  canPost: boolean;
  /** 订阅者也能发帖 */
  memberPost?: boolean;
  /** 我能不能发帖（管理员，或开了 memberPost 的订阅者） */
  canSend?: boolean;
  muted: boolean;
  /** 消息保留天数，0 = 永久 */
  retentionDays?: number;
}

interface Post {
  id: string;
  senderId: string;
  senderNickname?: string;
  senderAvatar?: string;
  senderIsBot?: boolean;
  type: string;
  content: string;
  createdAt: string;
  views: number;
  reactions: { emoji: string; count: number }[];
  myReaction: string | null;
  commentCount: number;
  pending?: boolean;
  tempId?: string;
  markup?: InlineMarkup | null;
  memberMsg?: boolean;
}

const postEl = (id: string) => document.querySelector(`[data-mid="${CSS.escape(id)}"]`);

const fmtCount = (n: number) => (n >= 10000 ? (lang() === 'zh' ? `${(n / 10000).toFixed(1)}万` : `${(n / 1000).toFixed(1)}k`) : String(n));

function postTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function PostBody({ p, onImage }: { p: Post; onImage: (url: string) => void }) {
  switch (p.type) {
    case 'image':
      return <img src={p.content} alt="" className="ch-media" onClick={() => onImage(p.content)} />;
    case 'video':
      return <video src={p.content} controls playsInline className="ch-media" style={{ background: '#000' }} />;
    case 'sticker': {
      const s = parseSticker(p.content);
      return s ? <div style={{ padding: '10px 12px 0' }}><StickerView p={s} size={s.format === 'mp4' ? 220 : 140} /></div> : <div className="ch-text">{t('channel.stickerPlaceholder')}</div>;
    }
    case 'audio': {
      let a: any = {};
      try { a = JSON.parse(p.content); } catch { a = { url: p.content }; }
      return <div className="ch-text"><AudioBubble a={a} /></div>;
    }
    case 'location': {
      let loc: any = {};
      try { loc = JSON.parse(p.content); } catch { /* ignore */ }
      return (
        <div className="ch-text" style={{ cursor: 'pointer' }} onClick={() => loc.lat && window.open(`https://uri.amap.com/marker?position=${loc.lng},${loc.lat}`, '_blank')}>
          ◎ {loc.name || loc.address || t('channel.location')}
        </div>
      );
    }
    default:
      return <div className="ch-text"><LinkText text={p.content} /></div>;
  }
}

/** 一条帖子：频道头 + 内容 + 表情回应 + 浏览数 / 时间 + 评论入口 */
function PostCard({ ch, p, onReact, onComments, onImage, onDelete }: {
  ch: ChannelInfo;
  p: Post;
  onReact: (emoji: string) => void;
  onComments: () => void;
  onImage: (url: string) => void;
  onDelete?: () => void;
}) {
  const [picker, setPicker] = useState(false);
  // 频道主 / 机器人发的算频道发帖；订阅者（和其他管理员）发的显示作者
  const byAuthor = p.senderId !== ch.ownerId && !p.senderIsBot && !!p.senderNickname;
  const headAvatar = byAuthor ? p.senderAvatar : ch.avatar;
  return (
    <div className={`ch-post${p.type === 'image' || p.type === 'video' || p.markup ? ' media' : ''}`} style={{ opacity: p.pending ? 0.6 : 1 }} data-mid={p.id}>
      <div className="ch-post-head">
        <div className="avatar" style={{ width: 28, height: 28 }}>{headAvatar && <img src={headAvatar} alt="" />}</div>
        <span className="ellipsis" style={{ fontWeight: 600, fontSize: 14 }}>{byAuthor ? p.senderNickname : ch.name}</span>
        <span className="grow" />
        {onDelete && !p.pending && <span className="small" style={{ cursor: 'pointer' }} onClick={onDelete}>{t('common.delete')}</span>}
      </div>
      <PostBody p={p} onImage={onImage} />
      {p.markup && <InlineKeyboard markup={p.markup} messageId={p.id} />}
      <div className="ch-post-foot">
        <div className="ch-reacts">
          {p.reactions.map((r) => (
            <span key={r.emoji} className={`ch-react${p.myReaction === r.emoji ? ' on' : ''}`} onClick={() => onReact(r.emoji)}>
              {r.emoji} {fmtCount(r.count)}
            </span>
          ))}
          {!p.pending && <span className="ch-react add" onClick={() => setPicker((v) => !v)}>☺+</span>}
        </div>
        <span className="small" style={{ whiteSpace: 'nowrap' }}>
          {p.pending ? t('channel.sending') : <>👁 {fmtCount(p.views)} · {postTime(p.createdAt)}</>}
        </span>
      </div>
      {picker && (
        <div className="ch-picker">
          {REACTIONS.map((e) => (
            <span key={e} className={p.myReaction === e ? 'on' : ''} onClick={() => { setPicker(false); onReact(e); }}>{e}</span>
          ))}
        </div>
      )}
      {!p.pending && (
        <div className="ch-comment-bar" onClick={onComments}>
          <span>💬 {p.commentCount > 0 ? t('channel.commentsN', { n: p.commentCount }) : t('channel.comments')}</span>
          <span>›</span>
        </div>
      )}
    </div>
  );
}

/** 订阅者发的消息：普通聊天气泡（我的在右边），没有评论 / 浏览数 / 表情回应；长按或右键删除 */
function MemberBubble({ p, mine, onImage, onDelete }: { p: Post; mine: boolean; onImage: (url: string) => void; onDelete?: () => void }) {
  const timer = useRef<number>();
  const media = p.type === 'image' || p.type === 'video';
  const askDelete = () => {
    if (onDelete && !p.pending && confirm(t('channel.deleteMessageConfirm'))) onDelete();
  };
  return (
    <div className={`ch-msg${mine ? ' mine' : ''}`} style={{ opacity: p.pending ? 0.6 : 1 }} data-testid="member-msg" data-mid={p.id}>
      {!mine && <div className="avatar" style={{ width: 32, height: 32, flexShrink: 0 }}>{p.senderAvatar && <img src={p.senderAvatar} alt="" />}</div>}
      <div
        className={`ch-msg-bubble${media ? ' media' : ''}`}
        onContextMenu={(e) => { if (onDelete) { e.preventDefault(); askDelete(); } }}
        onTouchStart={() => { timer.current = window.setTimeout(askDelete, 550); }}
        onTouchEnd={() => window.clearTimeout(timer.current)}
        onTouchMove={() => window.clearTimeout(timer.current)}
      >
        {!mine && <div className="ch-msg-name">{p.senderNickname}</div>}
        <PostBody p={p} onImage={onImage} />
        <div className="ch-msg-time">{p.pending ? t('channel.sending') : postTime(p.createdAt)}</div>
      </div>
    </div>
  );
}

/** 频道资料：头像 / 名称 / 简介（频道主可改）、订阅数、分享、静音、退订 / 删除 */
function ChannelInfoSheet({ ch, onClose, onChanged, onExit }: { ch: ChannelInfo; onClose: () => void; onChanged: (c: ChannelInfo) => void; onExit: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ch.name);
  const [desc, setDesc] = useState(ch.description);
  const [share, setShare] = useState(false);
  const [bots, setBots] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async (body: Record<string, string | boolean>) => {
    try {
      onChanged(await api<ChannelInfo>(`/im/channel/${ch.id}`, { method: 'PUT', body }));
      setEditing(false);
    } catch (e: any) {
      alert(e.message);
    }
  };
  const changeAvatar = async (file?: File) => {
    if (!file) return;
    try {
      await save({ avatar: await uploadFile('image', file) });
    } catch (e: any) {
      alert(e.message || t('common.uploadFailed'));
    }
  };
  const toggleMute = async () => {
    try {
      const r = await api<{ muted: boolean }>(`/im/channel/${ch.id}/mute`, { method: 'POST', body: { muted: !ch.muted } });
      onChanged({ ...ch, muted: r.muted });
    } catch (e: any) {
      alert(e.message);
    }
  };
  const clearAll = async () => {
    if (!confirm(t('channel.clearAllConfirm'))) return;
    try {
      const r = await api<{ deleted: number }>(`/im/channel/${ch.id}/clear`, { method: 'POST' });
      alert(r.deleted ? t('channel.clearedN', { n: r.deleted }) : t('channel.noMessages'));
      onClose();
    } catch (e: any) {
      alert(e.message);
    }
  };
  const leave = async () => {
    const owner = ch.role === 'owner';
    if (!confirm(owner ? t('channel.deleteConfirm') : t('channel.unsubscribeConfirm'))) return;
    try {
      await api(`/im/channel/${ch.id}/${owner ? 'delete' : 'unsubscribe'}`, { method: 'POST' });
      onExit();
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" style={{ maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        {share ? (
          <GroupShareView groupId={ch.id} channel onBack={() => setShare(false)} />
        ) : (
          <>
            <div style={{ textAlign: 'center' }}>
              <div className="avatar" style={{ width: 72, height: 72, margin: '0 auto', cursor: ch.canPost ? 'pointer' : 'default' }} onClick={() => ch.canPost && fileRef.current?.click()}>
                {ch.avatar && <img src={ch.avatar} alt="" />}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => changeAvatar(e.target.files?.[0])} />
              {editing ? (
                <>
                  <input className="input" style={{ marginTop: 12 }} value={name} maxLength={50} placeholder={t('channel.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
                  <textarea className="input" style={{ height: 90, resize: 'none' }} value={desc} maxLength={500} placeholder={t('channel.descPlaceholder')} onChange={(e) => setDesc(e.target.value)} />
                  <div className="row">
                    <button className="btn-sm ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
                    <span className="grow" />
                    <button className="btn-sm" onClick={() => save({ name, description: desc })}>{t('common.save')}</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 10 }}>{ch.name}</div>
                  <div className="small" style={{ marginTop: 4 }}>{t('channel.subscribers', { n: fmtCount(ch.subscribers) })} · {t('channel.ownedBy', { name: ch.owner?.nickname ?? '' })}</div>
                  {ch.description && <div style={{ fontSize: 14, marginTop: 12, whiteSpace: 'pre-wrap', textAlign: 'left', lineHeight: 1.6 }}>{ch.description}</div>}
                  {!!ch.retentionDays && <div className="small" style={{ marginTop: 10 }} data-testid="retention-tip">{t('channel.retentionTip', { n: ch.retentionDays })}</div>}
                </>
              )}
            </div>
            {!editing && (
              <div style={{ marginTop: 16, borderTop: '1px solid var(--line)' }}>
                {ch.canPost && <div className="ch-menu" onClick={() => setEditing(true)}>{t('channel.editInfo')}</div>}
                {ch.canPost && (
                  <div className="ch-menu row" onClick={() => save({ memberPost: !ch.memberPost })}>
                    <span className="grow">{t('channel.memberPost')}</span>
                    <span className={`switch${ch.memberPost ? ' on' : ''}`} data-testid="member-post-switch" />
                  </div>
                )}
                {ch.isMember && <div className="ch-menu" onClick={() => setShare(true)}>{t('channel.shareMenu')}</div>}
                {ch.role === 'owner' && <div className="ch-menu" onClick={() => setBots(true)}>{t('channel.botsMenu')}</div>}
                {ch.isMember && ch.role !== 'owner' && <div className="ch-menu" onClick={toggleMute}>{ch.muted ? t('channel.unmute') : t('channel.mute')}</div>}
                {ch.role === 'owner' && <div className="ch-menu" style={{ color: 'var(--danger)' }} onClick={clearAll} data-testid="clear-all">{t('channel.clearAll')}</div>}
                {ch.isMember && <div className="ch-menu" style={{ color: 'var(--danger)' }} onClick={leave}>{ch.role === 'owner' ? t('channel.delete') : t('channel.unsubscribe')}</div>}
              </div>
            )}
          </>
        )}
      </div>
      {bots && <AddBotSheet groupId={ch.id} channel onClose={() => setBots(false)} />}
    </div>
  );
}

/** 频道页 /channel/:id（id = 群 id）：订阅前也能预览 */
export function ChannelPage() {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [ch, setCh] = useState<ChannelInfo | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [input, setInput] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showSticker, setShowSticker] = useState(false);
  const [fullImage, setFullImage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const convRef = useRef<string | undefined>(undefined);
  const stickBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    api<ChannelInfo>(`/im/channel/${id}`)
      .then((c) => {
        if (!alive) return;
        convRef.current = c.conversationId;
        setCh(c);
        return api<Post[]>(`/im/channel/${id}/posts`).then((list) => {
          if (!alive) return;
          setPosts((prev) => [...list, ...prev.filter((p) => !list.some((x) => x.id === p.id))]);
          setHasMore(list.length >= 30);
          const last = list[list.length - 1];
          if (c.isMember && last && c.conversationId) wsManager.markRead(c.conversationId, last.id);
        });
      })
      .catch((e: any) => alive && setError(e.message || t('channel.notFound')));

    wsManager.connect();
    const off = wsManager.on((frame) => {
      const conv = convRef.current;
      if (!conv) return;
      if (frame.op === 'msg') {
        const m = frame.data as MessagePayload;
        if (m.conversationId !== conv) return;
        stickBottom.current = true;
        setPosts((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, { ...m, views: 1, reactions: [], myReaction: null, commentCount: 0 }]));
        wsManager.markRead(conv, m.id);
      } else if (frame.op === 'ack') {
        setPosts((prev) => prev.map((p) => (p.tempId === frame.tempId ? { ...p, id: frame.msgId, createdAt: frame.createdAt, pending: false } : p)));
      } else if (frame.op === 'error') {
        setPosts((prev) => prev.filter((p) => !(p.pending && p.tempId === frame.tempId)));
        alert(frame.msg ?? t('channel.sendFailed'));
      } else if (frame.op === 'channel_stats' && frame.data?.conversationId === conv) {
        const d = frame.data;
        setPosts((prev) => prev.map((p) => (p.id === d.msgId ? { ...p, reactions: d.reactions, commentCount: d.commentCount } : p)));
      } else if ((frame.op === 'channel_post_deleted' || frame.op === 'msg_delete') && frame.data?.conversationId === conv) {
        const mid = String(frame.data.msgId);
        dustThen([postEl(mid)], () => setPosts((prev) => prev.filter((p) => p.id !== mid)));
      } else if (frame.op === 'channel_purged' && frame.data?.conversationId === conv) {
        const max = BigInt(frame.data.maxId);
        const gone = (id: string) => /^\d+$/.test(id) && BigInt(id) <= max;
        const els = Array.from(document.querySelectorAll<HTMLElement>('[data-mid]')).filter((e) => gone(e.dataset.mid ?? ''));
        dustThen(els, () => setPosts((prev) => prev.filter((p) => p.pending || !gone(p.id))));
      } else if (frame.op === 'channel_info' && frame.data?.groupId === id) {
        api<ChannelInfo>(`/im/channel/${id}`).then((c) => alive && setCh(c)).catch(() => {});
      } else if (frame.op === 'msg_edit' && frame.data?.conversationId === conv) {
        const d = frame.data;
        setPosts((prev) => prev.map((p) => (p.id === d.msgId ? { ...p, content: d.content ?? p.content, markup: d.markup } : p)));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [id]);

  useEffect(() => {
    if (stickBottom.current) bottomRef.current?.scrollIntoView();
  }, [posts.length]);

  const loadMore = async () => {
    const first = posts.find((p) => !p.pending);
    if (!first) return;
    stickBottom.current = false;
    const older = await api<Post[]>(`/im/channel/${id}/posts?beforeId=${first.id}`).catch(() => []);
    setHasMore(older.length >= 30);
    setPosts((prev) => [...older, ...prev]);
  };

  const subscribe = async () => {
    try {
      const c = await api<ChannelInfo>(`/im/channel/${id}/subscribe`, { method: 'POST' });
      convRef.current = c.conversationId;
      setCh(c);
      const last = posts[posts.length - 1];
      if (last && c.conversationId) wsManager.markRead(c.conversationId, last.id);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const toggleMute = async () => {
    if (!ch) return;
    const r = await api<{ muted: boolean }>(`/im/channel/${id}/mute`, { method: 'POST', body: { muted: !ch.muted } }).catch(() => null);
    if (r) setCh({ ...ch, muted: r.muted });
  };

  const react = async (p: Post, emoji: string) => {
    try {
      const r = await api<{ reactions: Post['reactions']; myReaction: string | null }>(`/im/channel/posts/${p.id}/react`, { method: 'POST', body: { emoji } });
      setPosts((prev) => prev.map((x) => (x.id === p.id ? { ...x, reactions: r.reactions, myReaction: r.myReaction } : x)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const deletePost = async (p: Post) => {
    if (!confirm(t('channel.deletePostConfirm'))) return;
    // 确认后立刻开始化成灰（和接口并行），失败再放回来
    const el = postEl(p.id);
    const anim = dust(el);
    try {
      await api(`/im/channel/posts/${p.id}/delete`, { method: 'POST' });
      await anim;
      setPosts((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e: any) {
      undust([el]);
      alert(e.message);
    }
  };

  const sendRaw = (type: string, content: string) => {
    if (!me || !ch) return;
    stickBottom.current = true;
    const tempId = wsManager.send(2, ch.id, type, content);
    setPosts((prev) => [...prev, { id: tempId, tempId, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar, type, content, createdAt: new Date().toISOString(), views: 1, reactions: [], myReaction: null, commentCount: 0, pending: true, memberMsg: !ch.canPost }]);
  };
  const send = () => {
    const text = input.trim();
    if (!text) return;
    sendRaw('text', text);
    setInput('');
  };
  const sendMedia = async (files: File[], caption: string) => {
    let failed = 0;
    for (const f of files) {
      try {
        const video = f.type.startsWith('video');
        sendRaw(video ? 'video' : 'image', await uploadFile(video ? 'video' : 'image', f));
      } catch {
        failed++;
      }
    }
    if (caption.trim()) sendRaw('text', caption.trim());
    if (failed) alert(t('channel.filesFailed', { n: failed }));
  };
  const handleAttach = (a: AttachAction) => {
    if (a !== 'location') return;
    if (!navigator.geolocation) return alert(t('channel.geoUnsupported'));
    navigator.geolocation.getCurrentPosition(
      (pos) => sendRaw('location', JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: nearestCity(pos.coords.latitude, pos.coords.longitude) })),
      () => alert(t('channel.geoFailed')),
    );
  };

  if (error) {
    return (
      <div className="app">
        <div className="navbar"><span className="back" onClick={() => nav(-1)}>‹</span><span className="title">{t('channel.title')}</span><span style={{ width: 40 }} /></div>
        <div className="empty">{error}</div>
      </div>
    );
  }
  if (!ch) return <div className="app"><div className="empty">{t('common.loading')}</div></div>;
  const canSend = ch.canSend ?? ch.canPost;

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <div className="row grow" style={{ gap: 10, minWidth: 0, cursor: 'pointer' }} onClick={() => setShowInfo(true)}>
          <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0 }}>{ch.avatar && <img src={ch.avatar} alt="" />}</div>
          <div style={{ minWidth: 0 }}>
            <div className="ellipsis" style={{ fontWeight: 600, fontSize: 15 }}>{ch.name}</div>
            <div className="small">{t('channel.subscribers', { n: fmtCount(ch.subscribers) })}</div>
          </div>
        </div>
        <span className="action" onClick={() => setShowInfo(true)}>···</span>
      </div>

      <div className="page ch-page no-scrollbar" onClick={() => setShowSticker(false)}>
        {hasMore && posts.length > 0 && <div className="small" style={{ textAlign: 'center', padding: 10, cursor: 'pointer' }} onClick={loadMore}>{t('channel.loadEarlier')}</div>}
        {posts.length === 0 && (
          <div className="empty">{canSend ? t('channel.emptyCanPost') : t('channel.emptyNoPosts')}</div>
        )}
        {posts.map((p) => p.memberMsg ? (
          <MemberBubble
            key={p.tempId ?? p.id}
            p={p}
            mine={p.senderId === me?.id}
            onImage={setFullImage}
            onDelete={ch.canPost || p.senderId === me?.id ? () => deletePost(p) : undefined}
          />
        ) : (
          <PostCard
            key={p.tempId ?? p.id}
            ch={ch}
            p={p}
            onReact={(e) => react(p, e)}
            onImage={setFullImage}
            onComments={() => nav(`/channel/post/${p.id}`, { state: { channelName: ch.name, canAdmin: ch.canPost } })}
            onDelete={ch.canPost || p.senderId === me?.id ? () => deletePost(p) : undefined}
          />
        ))}
        <div ref={bottomRef} style={{ height: 8 }} />
      </div>

      {canSend ? (
        <div style={{ background: 'var(--bg-card)' }}>
          <div className="row" style={{ padding: 8, gap: 8 }}>
            <input
              ref={inputRef}
              className="input grow"
              style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
              value={input}
              placeholder={ch.canPost ? t('channel.postPlaceholder') : t('channel.messagePlaceholder')}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setShowSticker(false)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <span className="ch-round" style={showSticker ? { background: '#ffe1e7', color: 'var(--accent)' } : undefined} onClick={() => setShowSticker((v) => !v)}>☺</span>
            <span className="ch-round" onClick={() => { setShowAttach(true); setShowSticker(false); }}>+</span>
            {input.trim() && <button className="btn-sm" style={{ height: 40, borderRadius: 20 }} onClick={send}>{t('common.send')}</button>}
          </div>
          {showSticker && (
            <EmojiPanel
              onPick={(s: StickerPayload) => sendRaw('sticker', JSON.stringify(s))}
              onEmoji={(e) => setInput((v) => v + e)}
              onDelete={() => setInput((v) => dropLastGrapheme(v))}
              onKeyboard={() => { setShowSticker(false); inputRef.current?.focus(); }}
            />
          )}
        </div>
      ) : (
        <div className="ch-bottom">
          {ch.isMember ? (
            <span onClick={toggleMute}>{ch.muted ? t('channel.unmute') : t('channel.mute')}</span>
          ) : (
            <span className="accent" style={{ fontWeight: 600 }} onClick={subscribe}>{t('channel.subscribe')}</span>
          )}
        </div>
      )}

      {showAttach && (
        <AttachSheet isSingle={false} canVideoCall={false} onClose={() => setShowAttach(false)} onSend={sendMedia} onAction={handleAttach} />
      )}
      {showInfo && (
        <ChannelInfoSheet
          ch={ch}
          onClose={() => setShowInfo(false)}
          onChanged={setCh}
          onExit={() => nav('/chat', { replace: true })}
        />
      )}
      {fullImage && (
        <div className="mask" style={{ background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setFullImage(null)}>
          <img src={fullImage} alt="" style={{ maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain' }} />
        </div>
      )}
    </div>
  );
}

interface Comment {
  id: string;
  user?: { id: string; nickname: string; avatar: string };
  content: string;
  sticker: StickerPayload | null;
  replyToNickname: string;
  createdAt: string;
}

/** 帖子评论页 /channel/post/:msgId */
export function ChannelCommentsPage() {
  const { msgId = '' } = useParams<{ msgId: string }>();
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const state = (useLocation().state ?? {}) as { channelName?: string; canAdmin?: boolean };
  const [list, setList] = useState<Comment[] | null>(null);
  const [input, setInput] = useState('');
  const [sticker, setSticker] = useState<StickerPayload | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; nickname: string } | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => api<Comment[]>(`/im/channel/posts/${msgId}/comments`).then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [msgId]);

  const send = async () => {
    const content = input.trim();
    if (!content && !sticker) return;
    setBusy(true);
    try {
      await api(`/im/channel/posts/${msgId}/comments`, { method: 'POST', body: { content, stickerId: sticker?.id, replyToId: replyTo?.id } });
      setInput('');
      setSticker(null);
      setReplyTo(null);
      setShowEmoji(false);
      load();
    } catch (e: any) {
      alert(e.message);
    }
    setBusy(false);
  };

  const remove = async (c: Comment) => {
    if (!confirm(t('channel.deleteCommentConfirm'))) return;
    try {
      await api(`/im/channel/comments/${c.id}/delete`, { method: 'POST' });
      setList((prev) => (prev ?? []).filter((x) => x.id !== c.id));
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">{list ? t('channel.commentsN', { n: list.length }) : t('channel.comments')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar" style={{ padding: '0 16px' }} onClick={() => setShowEmoji(false)}>
        {state.channelName && <div className="small" style={{ padding: '10px 0' }}>{t('channel.postOf', { name: state.channelName })}</div>}
        {list === null && <div className="empty">{t('common.loading')}</div>}
        {list?.length === 0 && <div className="empty" style={{ padding: 30 }}>{t('channel.noComments')}</div>}
        {(list ?? []).map((c) => (
          <div key={c.id} className="row" style={{ padding: '10px 0', alignItems: 'flex-start', borderBottom: '1px solid var(--line)' }}>
            <div className="avatar" style={{ width: 34, height: 34, cursor: 'pointer' }} onClick={() => c.user && nav(`/u/${c.user.id}`)}>
              {c.user?.avatar && <img src={c.user.avatar} alt="" />}
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="small" style={{ fontWeight: 600, color: 'var(--text)' }}>{c.user?.nickname}</span>
                <span className="small">{postTime(c.createdAt)}</span>
                <span className="grow" />
                <span className="small accent" style={{ cursor: 'pointer' }} onClick={() => { setReplyTo({ id: c.id, nickname: c.user?.nickname ?? '' }); inputRef.current?.focus(); }}>{t('channel.reply')}</span>
                {(c.user?.id === me?.id || state.canAdmin) && <span className="small" style={{ cursor: 'pointer' }} onClick={() => remove(c)}>{t('common.delete')}</span>}
              </div>
              {(c.content || c.replyToNickname) && (
                <div style={{ fontSize: 14, marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {c.replyToNickname && <span className="accent">@{c.replyToNickname} </span>}
                  <LinkText text={c.content ?? ''} />
                </div>
              )}
              {c.sticker && <StickerView p={c.sticker} size={96} style={{ marginTop: 4 }} />}
            </div>
          </div>
        ))}
        <div style={{ height: 16 }} />
      </div>

      {(replyTo || sticker) && (
        <div className="row" style={{ padding: '6px 16px', gap: 10, borderTop: '1px solid var(--line)' }}>
          {sticker && (
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <StickerView p={sticker} size={56} />
              <span onClick={() => setSticker(null)} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>×</span>
            </span>
          )}
          <span className="small grow">{replyTo && <>{t('channel.replyingTo')} <span className="accent">@{replyTo.nickname}</span></>}</span>
          {replyTo && <span className="small" style={{ cursor: 'pointer' }} onClick={() => setReplyTo(null)}>{t('common.cancel')}</span>}
        </div>
      )}
      <div className="row" style={{ padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--line)', gap: 8 }}>
        <span style={{ fontSize: 22, cursor: 'pointer', color: showEmoji ? 'var(--accent)' : 'inherit' }} onClick={() => setShowEmoji((v) => !v)}>☺</span>
        <input
          ref={inputRef}
          className="input grow"
          style={{ marginBottom: 0, padding: '10px 14px' }}
          value={input}
          maxLength={500}
          placeholder={replyTo ? t('channel.replyPlaceholder', { name: replyTo.nickname }) : t('channel.commentPlaceholder')}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setShowEmoji(false)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn-sm" disabled={busy || (!input.trim() && !sticker)} onClick={send}>{t('common.send')}</button>
      </div>
      {showEmoji && (
        <EmojiPanel onPick={setSticker} onEmoji={(e) => setInput((v) => v + e)} onDelete={() => setInput((v) => dropLastGrapheme(v))} onKeyboard={() => { setShowEmoji(false); inputRef.current?.focus(); }} />
      )}
    </div>
  );
}

interface ChannelListItem {
  id: string;
  name: string;
  avatar: string;
  description: string;
  ownerNickname: string;
  subscribers: number;
  isMember: boolean;
}

function CameraIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.7l1.3-2h5l1.3 2h1.7A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  );
}

/** 创建频道弹层 */
export function CreateChannelSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ChannelInfo) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [avatar, setAvatar] = useState('');
  const [memberPost, setMemberPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<{ owned: number; limit: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const left = quota ? Math.max(0, quota.limit - quota.owned) : null;

  useEffect(() => {
    api<{ owned: number; limit: number }>('/im/channel/quota').then(setQuota).catch(() => {});
  }, []);

  const pick = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      setAvatar(await uploadFile('image', f));
    } catch (e: any) {
      alert(e.message || t('common.uploadFailed'));
    }
    setBusy(false);
  };
  const create = async () => {
    if (!name.trim()) return alert(t('channel.nameRequired'));
    setBusy(true);
    try {
      onCreated(await api<ChannelInfo>('/im/channel', { method: 'POST', body: { name: name.trim(), description: desc.trim(), avatar, memberPost } }));
    } catch (e: any) {
      alert(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet sheet-up cc-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cc-grab" />
        <div className="cc-top">
          <span className="cc-cancel" onClick={onClose}>{t('common.cancel')}</span>
          <span className="cc-title">{t('channel.newTitle')}</span>
          <span className="cc-cancel" style={{ visibility: 'hidden' }}>{t('common.cancel')}</span>
        </div>

        <div className="cc-avatar-wrap">
          <div className="cc-avatar" onClick={() => !busy && fileRef.current?.click()}>
            {avatar ? <img src={avatar} alt="" /> : name.trim() ? <span>{Array.from(name.trim())[0]}</span> : <CameraIcon size={30} />}
            {busy && <div className="cc-avatar-busy">{t('channel.uploading')}</div>}
            <div className="cc-avatar-badge"><CameraIcon size={14} /></div>
          </div>
          <span className="cc-avatar-tip" onClick={() => !busy && fileRef.current?.click()}>{avatar ? t('channel.changeAvatar') : t('channel.setAvatar')}</span>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>

        <div className="cc-group">
          <div className="cc-field">
            <input placeholder={t('channel.namePlaceholder')} value={name} maxLength={50} autoFocus onChange={(e) => setName(e.target.value)} />
            {name && <span className="cc-count">{Array.from(name).length}/50</span>}
          </div>
          <div className="cc-field">
            <textarea placeholder={t('channel.descOptional')} rows={3} value={desc} maxLength={500} onChange={(e) => setDesc(e.target.value)} />
            {desc && <span className="cc-count">{desc.length}/500</span>}
          </div>
        </div>
        <div className="cc-caption">{t('channel.descCaption')}</div>

        <div className="cc-group">
          <div className="cc-row" onClick={() => setMemberPost((v) => !v)}>
            <span className="cc-row-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" /></svg>
            </span>
            <span className="grow">{t('channel.memberPost')}</span>
            <span className={`switch${memberPost ? ' on' : ''}`} data-testid="create-member-post" />
          </div>
        </div>
        <div className="cc-caption">
          {memberPost ? t('channel.memberPostOnTip') : t('channel.memberPostOffTip')}
        </div>

        <button className="btn cc-submit" disabled={busy || !name.trim() || left === 0} onClick={create}>{t('channel.createSubmit')}</button>
        {quota && (
          <div className="cc-quota" data-testid="channel-quota">
            {left === 0 ? t('channel.quotaFull', { n: quota.limit }) : t('channel.quotaLeft', { left: left ?? 0, n: quota.limit })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 发现频道 /channels：按订阅数排，可搜索，右上角创建 */
export function ChannelsPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [list, setList] = useState<ChannelListItem[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      api<ChannelListItem[]>(`/im/channel/list${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(setList).catch(() => setList([]));
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [q]);

  const subscribe = async (c: ChannelListItem) => {
    try {
      await api(`/im/channel/${c.id}/subscribe`, { method: 'POST' });
      setList((prev) => (prev ?? []).map((x) => (x.id === c.id ? { ...x, isMember: true, subscribers: x.subscribers + 1 } : x)));
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">{t('channel.discover')}</span>
        <span className="action" onClick={() => setShowCreate(true)}>{t('common.create')}</span>
      </div>
      <div className="page no-scrollbar">
        <div style={{ padding: '8px 16px' }}>
          <input className="input" style={{ marginBottom: 0, borderRadius: 18 }} placeholder={t('channel.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {list === null && <div className="empty">{t('common.loading')}</div>}
        {list?.length === 0 && <div className="empty">{q ? t('channel.noResults') : t('channel.emptyList')}</div>}
        {(list ?? []).map((c) => (
          <div key={c.id} className="cl-row" onClick={() => nav(`/channel/${c.id}`)}>
            <div className="avatar" style={{ width: 54, height: 54 }}>{c.avatar && <img src={c.avatar} alt="" />}</div>
            <div className="cl-row-main">
              <div className="cl-row-top">
                <span className="cl-row-title ellipsis">{c.name}</span>
                <span className="small" style={{ flexShrink: 0 }}>{t('channel.subscribersShort', { n: fmtCount(c.subscribers) })}</span>
              </div>
              <div className="cl-row-sub">
                <span className="ellipsis">{c.description || t('channel.ownedBy', { name: c.ownerNickname })}</span>
                <span
                  className={`ch-sub-btn${c.isMember ? ' on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); if (!c.isMember) subscribe(c); else nav(`/channel/${c.id}`); }}
                >{c.isMember ? t('channel.subscribed') : t('channel.subscribe')}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {showCreate && (
        <CreateChannelSheet
          onClose={() => setShowCreate(false)}
          onCreated={(c) => { setShowCreate(false); nav(`/channel/${c.id}`); }}
        />
      )}
    </div>
  );
}
