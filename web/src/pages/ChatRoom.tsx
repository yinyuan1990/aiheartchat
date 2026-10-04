import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, fmtPoints, uploadFile } from '../api';
import { useApp } from '../store';
import { wsManager, MessagePayload, Reaction, ReplyPreview } from '../ws';
import { nearestCity } from '../cities';
import { parseSticker, StickerPayload } from '../stickers';
import { dropLastGrapheme } from '../emojis';
import { EmojiPanel } from '../components/EmojiPanel';
import { StickerView } from '../components/StickerView';
import { AttachSheet, AttachAction } from '../components/AttachSheet';
import { LinkText } from '../components/LinkText';
import { CalloutCard, PayreqCard, PerpCard, TransferCard } from '../components/ChainCards';
import {
  DeleteDialog, FORWARDABLE, ForwardSheet, MenuActions, MsgMenu, PinBar, PinItem,
  ReactionChips, ReplyBar, ReplyQuote, ReportSheet, saveMedia,
} from '../components/MsgActions';
import { AddBotSheet, BotPublic, botInfo, InlineKeyboard, InlineMarkup } from './Bots';
import { dustThen, undust } from '../dust';
import { decodeQrFromImage, ScanIcon } from '../components/QrScanner';
import { ScanFlow } from './ChatList';

/** 消息气泡那一行（不含上面的时间分隔），删除时化成灰 */
const msgEl = (id: string) => document.getElementById(`msg-${id}`)?.querySelector('.bubble-row');

interface MsgItem {
  id: string;
  senderId: string;
  senderNickname: string;
  senderAvatar?: string;
  type: string;
  content: string;
  createdAt: string;
  isRead?: boolean;
  pending?: boolean;
  tempId?: string;
  senderIsBot?: boolean;
  markup?: InlineMarkup | null;
  replyTo?: ReplyPreview | null;
  fwdFrom?: string | null;
  reactions?: Reaction[];
}

/** Web 端点语音/视频弹下载引导 */
function DownloadDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>请下载 App</h3>
        <p>网页版不支持语音与视频通话<br />请下载 App 体验完整功能</p>
        <button className="btn" onClick={() => (location.href = '/site/')}>前往下载</button>
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

/** 群分享面板：二维码 + 邀请码 + 密码设置（群主/管理员；频道没有密码） */
export function GroupShareView({ groupId, onBack, channel }: { groupId: string; onBack: () => void; channel?: boolean }) {
  const [share, setShare] = useState<any>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [mode, setMode] = useState<'none' | 'pwd'>('none');
  const [pwd, setPwd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<any>(`/im/group/${groupId}/share`).then((s) => {
      setShare(s);
      setMode(s.hasPassword ? 'pwd' : 'none');
      setPwd(s.password || '');
    }).catch((e: any) => alert(e.message));
  }, [groupId]);

  useEffect(() => {
    if (!share?.code) return;
    import('qrcode').then((QRCode) =>
      QRCode.toDataURL(`peiwan://group?code=${share.code}`, { width: 480, margin: 1 }).then(setQrUrl),
    ).catch(() => {});
  }, [share?.code]);

  const save = async () => {
    if (mode === 'pwd' && !pwd.trim()) { alert('请输入密码'); return; }
    setSaving(true);
    try {
      const s = await api<any>(`/im/group/${groupId}/share`, { method: 'POST', body: { password: mode === 'pwd' ? pwd.trim() : '' } });
      setShare(s);
      alert('已保存');
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };

  if (!share) return <div className="empty" style={{ padding: 30 }}>加载中…</div>;

  return (
    <div style={{ textAlign: 'center' }}>
      <div className="small" style={{ marginBottom: 12 }}>
        {channel ? '扫码或输入邀请码即可订阅' : share.hasPassword ? '扫码或输码后需输入密码才能加入' : '扫码或输入邀请码即可加入'}
      </div>
      {qrUrl && <img src={qrUrl} alt="二维码" style={{ width: 200, height: 200, borderRadius: 12, background: '#fff', padding: 8 }} />}
      <div
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, margin: '12px auto 0', padding: '8px 14px', background: 'var(--bg-input)', borderRadius: 8, cursor: 'pointer' }}
        onClick={() => { navigator.clipboard?.writeText(share.code); alert('邀请码已复制'); }}
      >
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3 }}>{share.code}</span>
        <span className="accent" style={{ fontSize: 12 }}>复制</span>
      </div>

      {share.canEdit && !channel && (
        <div style={{ marginTop: 16 }}>
          {/* 模式切换 + 行内小保存按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {([['none', '无密码'], ['pwd', '有密码']] as const).map(([k, label]) => (
              <span
                key={k}
                onClick={() => setMode(k)}
                style={{
                  padding: '5px 14px', borderRadius: 13, fontSize: 12, cursor: 'pointer',
                  background: mode === k ? 'var(--accent-grad)' : 'var(--bg-input)',
                  color: mode === k ? '#fff' : 'var(--text-2)',
                }}
              >{label}</span>
            ))}
            <span className="grow" />
            <span
              onClick={() => !saving && save()}
              style={{ padding: '5px 16px', borderRadius: 13, fontSize: 12, cursor: 'pointer', background: 'var(--accent-grad)', color: '#fff' }}
            >{saving ? '保存中…' : '保存'}</span>
          </div>
          {mode === 'pwd' && (
            <input className="input" placeholder="设置入群密码" value={pwd} maxLength={20} style={{ marginTop: 10, marginBottom: 0 }} onChange={(e) => setPwd(e.target.value)} />
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 10 }}>
        <span className="small" style={{ cursor: 'pointer' }} onClick={onBack}>‹ {channel ? '返回' : '返回群信息'}</span>
      </div>
    </div>
  );
}

/** 群信息面板：成员查看、邀请、踢人、退群/解散 */
function GroupInfoSheet({ groupId, onClose, onExit }: { groupId: string; onClose: () => void; onExit: () => void }) {
  const me = useApp((s) => s.user);
  const [info, setInfo] = useState<any>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [people, setPeople] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const avatarFileRef = useRef<HTMLInputElement>(null);

  const load = () => api<any>(`/im/group/${groupId}`).then(setInfo).catch(() => {});
  useEffect(() => { load(); }, [groupId]);

  const myRole: string = info?.members?.find((m: any) => m.id === me?.id)?.role ?? 'member';
  const canEditInfo = myRole === 'owner' || myRole === 'admin';

  /** 群主/管理员换群头像：选图 → 上传 → 更新群资料 */
  const changeAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const url = await uploadFile('image', file);
      await api(`/im/group/${groupId}`, { method: 'PUT', body: { avatar: url } });
      load();
    } catch (e: any) {
      alert(e.message || '修改失败');
    }
  };

  const openInvite = async () => {
    const list = await api<any[]>('/guide/discover').catch(() => []);
    const memberIds = new Set((info?.members ?? []).map((m: any) => m.id));
    setPeople((list as any[]).filter((p) => !memberIds.has(p.id)));
    setSelected(new Set());
    setShowInvite(true);
  };

  const invite = async () => {
    if (selected.size === 0) return;
    try {
      await api(`/im/group/${groupId}/invite`, { method: 'POST', body: { userIds: [...selected] } });
      setShowInvite(false);
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const kick = async (userId: string, nickname: string) => {
    if (!confirm(`移出成员 ${nickname}？`)) return;
    try {
      await api(`/im/group/${groupId}/kick/${userId}`, { method: 'POST' });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const leaveOrDissolve = async () => {
    const isOwner = myRole === 'owner';
    if (!confirm(isOwner ? '确定解散该群？' : '确定退出该群？')) return;
    try {
      await api(`/im/group/${groupId}/${isOwner ? 'dissolve' : 'leave'}`, { method: 'POST' });
      onExit();
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (!info) return null;

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" style={{ maxHeight: '78vh', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        {/* 右上角分享入口 */}
        {!showShare && !showInvite && (
          <span
            className="accent"
            style={{ position: 'absolute', top: 16, right: 18, fontSize: 13, cursor: 'pointer' }}
            onClick={() => setShowShare(true)}
          >分享</span>
        )}
        {/* 群头像（群主/管理员点击可换） */}
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <div
            className="avatar"
            onClick={() => canEditInfo && avatarFileRef.current?.click()}
            style={{ width: 56, height: 56, margin: '0 auto', cursor: canEditInfo ? 'pointer' : 'default' }}
          >
            {info.avatar && <img src={info.avatar} alt="" />}
          </div>
          {canEditInfo && <div className="small" style={{ marginTop: 4, fontSize: 11 }}>点头像可修改</div>}
          <input ref={avatarFileRef} type="file" accept="image/*" hidden onChange={(e) => changeAvatar(e.target.files?.[0])} />
        </div>
        <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 4 }}>{info.name}</div>
        <div className="small" style={{ textAlign: 'center', marginBottom: 14 }}>共 {info.members?.length ?? 0} 人</div>

        {showShare ? (
          <GroupShareView groupId={groupId} onBack={() => setShowShare(false)} />
        ) : !showInvite ? (
          <>
            {/* 成员网格 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
              {(info.members ?? []).map((m: any) => (
                <div key={m.id} style={{ textAlign: 'center', position: 'relative' }}>
                  <div className="avatar" style={{ width: 48, height: 48, margin: '0 auto' }}>
                    {m.avatar && <img src={m.avatar} alt="" />}
                  </div>
                  <div className="small ellipsis" style={{ marginTop: 4 }}>
                    {m.nickname}{m.role === 'owner' && <span className="accent"> 主</span>}
                  </div>
                  {m.isBot && <div style={{ fontSize: 10, color: '#2f7cf6' }}>机器人</div>}
                  {myRole === 'owner' && m.role !== 'owner' && (
                    <span
                      onClick={() => kick(m.id, m.nickname)}
                      style={{ position: 'absolute', top: -4, right: 2, width: 18, height: 18, borderRadius: 9, background: 'var(--bg-input)', color: 'var(--text-2)', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    >×</span>
                  )}
                </div>
              ))}
              {/* 邀请入口 */}
              <div style={{ textAlign: 'center', cursor: 'pointer' }} onClick={openInvite}>
                <div style={{ width: 48, height: 48, margin: '0 auto', borderRadius: 24, border: '1px dashed #333', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 20 }}>+</div>
                <div className="small" style={{ marginTop: 4 }}>邀请</div>
              </div>
              {canEditInfo && (
                <div style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => setShowBots(true)}>
                  <div style={{ width: 48, height: 48, margin: '0 auto', borderRadius: 24, border: '1px dashed #2f7cf6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2f7cf6', fontSize: 13 }}>Bot</div>
                  <div className="small" style={{ marginTop: 4 }}>机器人</div>
                </div>
              )}
            </div>

            {info.notice && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="small">群公告</div>
                <div style={{ fontSize: 14, marginTop: 4 }}>{info.notice}</div>
              </div>
            )}

            <button className="btn btn-ghost mt12" style={{ color: 'var(--danger)', marginTop: 18 }} onClick={leaveOrDissolve}>
              {myRole === 'owner' ? '解散群聊' : '退出群聊'}
            </button>
          </>
        ) : (
          <>
            <div className="small" style={{ marginBottom: 10 }}>选择要邀请的人</div>
            {people.length === 0 && <div className="empty" style={{ padding: 20 }}>暂无可邀请的用户</div>}
            {people.map((p) => (
              <div key={p.id} className="row" style={{ padding: '8px 0', cursor: 'pointer' }} onClick={() => {
                const next = new Set(selected);
                next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                setSelected(next);
              }}>
                <div className="avatar" style={{ width: 36, height: 36 }}>
                  {p.avatar && <img src={p.avatar} alt="" />}
                </div>
                <div className="grow">{p.nickname}</div>
                <span style={{ color: selected.has(p.id) ? 'var(--accent)' : 'var(--text-3)' }}>
                  {selected.has(p.id) ? '已选' : '选择'}
                </span>
              </div>
            ))}
            <div className="row mt12">
              <button className="btn-sm ghost" onClick={() => setShowInvite(false)}>返回</button>
              <span className="grow" />
              <button className="btn-sm" onClick={invite}>邀请（{selected.size}）</button>
            </div>
          </>
        )}
      </div>
      {showBots && <AddBotSheet groupId={groupId} onClose={() => setShowBots(false)} onChanged={load} />}
    </div>
  );
}

/** 礼物面板（单聊） */
function GiftSheet({ toUserId, onClose, onSent }: { toUserId: string; onClose: () => void; onSent: () => void }) {
  const [gifts, setGifts] = useState<any[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [balance, setBalance] = useState('0');
  const [sentTip, setSentTip] = useState('');

  useEffect(() => {
    api<any[]>('/gifts').then(setGifts).catch(() => {});
    api<any>('/wallet').then((w) => setBalance(w.balance)).catch(() => {});
  }, []);

  const send = async () => {
    if (selected == null) return;
    try {
      await api('/gifts/send', { method: 'POST', body: { toUserId, giftId: selected } });
      onSent();
      // 送出后不关面板，刷新余额，可连续赠送
      api<any>('/wallet').then((w) => setBalance(w.balance)).catch(() => {});
      setSentTip('已送出');
      setTimeout(() => setSentTip(''), 1500);
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', fontWeight: 600 }}>送礼物</div>
        <div className="gift-grid">
          {gifts.map((g) => (
            <div key={g.id} className={`gift-item${selected === g.id ? ' selected' : ''}`} onClick={() => setSelected(g.id)}>
              <img src={g.icon} alt="" style={{ width: 42, height: 42, display: 'block', margin: '0 auto 4px' }} />
              <div style={{ fontSize: 12 }}>{g.name}</div>
              <div className="price">{fmtPoints(g.price)} 积分</div>
            </div>
          ))}
        </div>
        <div className="row">
          <span className="muted grow">余额 {fmtPoints(balance)} 积分</span>
          {sentTip && <span style={{ color: 'var(--accent)', fontSize: 13, marginRight: 10 }}>{sentTip}</span>}
          <button className="btn-sm" onClick={send}>赠送</button>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 语音气泡：播放中声条跳动 */
export function AudioBubble({ a }: { a: any }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    const audio = new Audio(a.url);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    audio.play().then(() => setPlaying(true)).catch(() => {});
  };

  return (
    <span className="row no-menu" style={{ gap: 8, cursor: 'pointer' }} onClick={toggle}>
      <span className={`voice-bars${playing ? ' playing' : ''}`}>
        <span /><span /><span />
      </span>
      <span>语音 {a.duration ? `${a.duration}"` : ''}</span>
    </span>
  );
}

/** 点这些元素走它们自己的逻辑（看大图、播放、点链接等），不弹消息菜单 */
const NO_MENU = 'a,img,video,audio,.no-menu,.bot-kb,.react-chips,.reply-quote';

function MsgBubble({ m, mine, convType, myId, onImage, onMenu, onReact, onJump }: {
  m: MsgItem; mine: boolean; convType: number; myId?: string;
  onImage: (url: string) => void;
  onMenu: (x: number, y: number) => void;
  onReact: (emoji: string) => void;
  onJump: (id: string) => void;
}) {
  const press = useRef<ReturnType<typeof setTimeout>>();
  const pressed = useRef(false);
  const isMedia = m.type === 'image' || m.type === 'video' || m.type === 'sticker' || m.type === 'transfer' || m.type === 'callout' || m.type === 'payreq' || m.type === 'perp';
  let body: JSX.Element;
  switch (m.type) {
    case 'image':
      body = <img src={m.content} alt="" style={{ cursor: 'pointer' }} onClick={() => onImage(m.content)} />;
      break;
    case 'sticker': {
      const p = parseSticker(m.content);
      // GIF 比贴纸大一号、带圆角；贴纸不画气泡底
      body = p ? <StickerView p={p} size={p.format === 'mp4' ? 220 : 140} /> : <span>[表情]</span>;
      break;
    }
    case 'video':
      body = <video src={m.content} controls playsInline style={{ background: '#000' }} />;
      break;
    case 'audio': {
      let a: any = {};
      try { a = JSON.parse(m.content); } catch { a = { url: m.content }; }
      body = <AudioBubble a={a} />;
      break;
    }
    case 'location': {
      let loc: any = {};
      try { loc = JSON.parse(m.content); } catch {}
      body = (
        <span
          className="row no-menu"
          style={{ gap: 8, cursor: 'pointer' }}
          onClick={() => loc.lat && window.open(`https://uri.amap.com/marker?position=${loc.lng},${loc.lat}`, '_blank')}
        >
          <span style={{ fontSize: 16 }}>◎</span>
          <span>{loc.name || loc.address || '位置'}</span>
        </span>
      );
      break;
    }
    case 'gift': {
      let gift: any = {};
      try { gift = JSON.parse(m.content); } catch {}
      body = (
        <span className="row" style={{ gap: 10 }}>
          {gift.icon && <img src={gift.icon} style={{ width: 42, height: 42, borderRadius: 8 }} alt="" />}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontWeight: 500 }}>{mine ? '送出' : '收到'}「{gift.name ?? '礼物'}」</span>
            <span style={{ fontSize: 12, opacity: 0.9 }}>{fmtPoints(gift.price)} 积分</span>
          </span>
        </span>
      );
      break;
    }
    case 'transfer':
      body = <TransferCard content={m.content} mine={mine} />;
      break;
    case 'callout':
      body = <CalloutCard content={m.content} />;
      break;
    case 'perp':
      body = <PerpCard id={m.id} content={m.content} />;
      break;
    case 'payreq':
      body = <PayreqCard content={m.content} mine={mine} />;
      break;
    default:
      if (m.type === 'call' || m.type.startsWith('call')) {
        let c: any = {};
        try { c = JSON.parse(m.content); } catch {}
        const label = c.callType === 2 ? '视频通话' : '语音通话';
        const dur = c.duration ?? 0;
        const text = c.result === 'end'
          ? `${label} ${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(dur % 60).padStart(2, '0')}`
          : c.result === 'reject' ? `${label} 已拒绝` : `${label} 已取消`;
        body = <span className="row" style={{ gap: 8 }}><span style={{ fontSize: 15 }}>{c.callType === 2 ? '▣' : '✆'}</span><span>{text}</span></span>;
      } else {
        body = <LinkText text={m.content} style={{ whiteSpace: 'pre-wrap' }} />;
      }
  }
  const avatar = (
    <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0 }}>
      {m.senderAvatar && <img src={m.senderAvatar} alt="" />}
    </div>
  );

  return (
    <div className={`bubble-row${mine ? ' mine' : ''}`} style={{ gap: 8, alignItems: 'flex-start' }}>
      {!mine && avatar}
      <div
        className="bubble-wrap"
        onClick={(e) => {
          if (pressed.current) { pressed.current = false; return; }
          if ((e.target as Element).closest(NO_MENU)) return;
          onMenu(e.clientX, e.clientY);
        }}
        onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          pressed.current = false;
          press.current = setTimeout(() => { pressed.current = true; onMenu(t.clientX, t.clientY); }, 450);
        }}
        onTouchMove={() => clearTimeout(press.current)}
        onTouchEnd={() => clearTimeout(press.current)}
      >
        {/* 对齐 iOS：只显示对方昵称，自己的不显示 */}
        {!mine && <div className="small" style={{ marginBottom: 3 }}>{m.senderNickname}{m.senderIsBot && convType === 2 && <span className="bot-tag">机器人</span>}</div>}
        <div className={`bubble ${mine ? 'mine' : 'theirs'}${isMedia ? ' media' : ''}`} style={{ opacity: m.pending ? 0.6 : 1 }}>
          {m.fwdFrom && <div className="fwd-from">转发自 {m.fwdFrom}</div>}
          {m.replyTo && <ReplyQuote r={m.replyTo} onClick={() => onJump(m.replyTo!.id)} />}
          {body}
        </div>
        {m.markup && <InlineKeyboard markup={m.markup} messageId={m.id} />}
        <ReactionChips reactions={m.reactions} myId={myId} onToggle={onReact} />
        <div className="msg-meta" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
          {m.pending && <span>发送中…</span>}
          {mine && convType === 1 && !m.pending && <span className={m.isRead ? '' : 'accent'}>{m.isRead ? '已读' : '未读'}</span>}
        </div>
      </div>
      {mine && avatar}
    </div>
  );
}

export function ChatRoomPage() {
  const { id: conversationId } = useParams<{ id: string }>();
  const location = useLocation();
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const state = (location.state ?? {}) as { title?: string; convType?: number; targetId?: string; focusMsgId?: string; isBot?: boolean };

  const [messages, setMessages] = useState<MsgItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [bot, setBot] = useState<BotPublic | null>(null);
  // 合约喊单卡片：告诉服务端这个聊天里在看哪些卡片，它每 3 秒推实时状态（PerpCard 收 perpTick）
  const perpIds = messages.filter((m) => m.type === 'perp' && !m.id.startsWith('t_')).map((m) => m.id).join(',');
  useEffect(() => {
    if (conversationId && perpIds) wsManager.perpWatch(conversationId, perpIds.split(','));
  }, [conversationId, perpIds]);
  useEffect(() => () => void (conversationId && wsManager.perpUnwatch(conversationId)), [conversationId]);
  const [showCmds, setShowCmds] = useState(false);
  const [input, setInput] = useState('');
  const [showDownload, setShowDownload] = useState(false);
  const [showGift, setShowGift] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showSticker, setShowSticker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fullImage, setFullImage] = useState<string | null>(null);
  /** 大图里认出的二维码，交给 ScanFlow 统一处理 */
  const [scanText, setScanText] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [toast, setToast] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  // 从搜索结果 / 引用 / 置顶跳过来：定位到该消息并闪一下，之后照常滚到底
  const focusId = useRef<string | null>(state.focusMsgId ?? null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const [menu, setMenu] = useState<{ m: MsgItem; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<MsgItem | null>(null);
  const replyRef = useRef<MsgItem | null>(null);
  replyRef.current = replyTo;
  const [pins, setPins] = useState<PinItem[]>([]);
  const [pinIdx, setPinIdx] = useState(0);
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  const [forwardIds, setForwardIds] = useState<string[] | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [groupRoles, setGroupRoles] = useState<Record<string, string>>({});
  const myRole = (me && groupRoles[me.id]) || 'member';
  const isGroupAdmin = state.convType === 2 && (myRole === 'owner' || myRole === 'admin');
  const canPin = state.convType === 1 || isGroupAdmin;

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2000);
  };

  const loadPins = () => {
    if (!conversationId) return;
    api<PinItem[]>(`/im/conversations/${conversationId}/pins`).then((l) => { setPins(l); setPinIdx(0); }).catch(() => {});
  };

  const flash = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1600);
    return true;
  };

  /** 跳到某条消息：不在当前列表就按 aroundId 重新拉一段 */
  const jumpTo = async (id: string) => {
    if (flash(id)) return;
    try {
      focusId.current = id;
      const list = await api<MsgItem[]>(`/im/messages?conversationId=${conversationId}&aroundId=${id}`);
      if (!list.some((m) => m.id === id)) {
        focusId.current = null;
        showToast('原消息已不存在');
        return;
      }
      setMessages(list);
      setTimeout(() => { if (focusId.current === id && flash(id)) focusId.current = null; }, 80);
    } catch {
      focusId.current = null;
    }
  };

  useEffect(() => {
    if (!conversationId) return;
    const around = state.focusMsgId ? `&aroundId=${state.focusMsgId}` : '';
    api<MsgItem[]>(`/im/messages?conversationId=${conversationId}${around}`).then((list) => {
      // 列表回来之前就发出 / 收到的消息不能被覆盖掉
      setMessages((prev) => {
        const ids = new Set(list.map((m) => m.id));
        return [...list, ...prev.filter((m) => !ids.has(m.id))];
      });
      setLoaded(true);
      const last = list[list.length - 1];
      if (last) wsManager.markRead(conversationId, last.id);
      if (state.convType === 1 && state.targetId && (state.isBot || list.some((m) => m.senderIsBot && m.senderId === state.targetId))) {
        botInfo(state.targetId).then(setBot);
      }
    }).catch(() => setLoaded(true));
    loadPins();
    if (state.convType === 2 && state.targetId) {
      api<any>(`/im/group/${state.targetId}`)
        .then((g) => setGroupRoles(Object.fromEntries((g?.members ?? []).map((x: any) => [x.id, x.role]))))
        .catch(() => {});
    }

    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'msg') {
        const m = frame.data as MessagePayload;
        if (m.conversationId === conversationId) {
          setMessages((prev) => [...prev, m]);
          wsManager.markRead(conversationId, m.id);
          if (m.senderIsBot && state.convType === 1 && m.senderId === state.targetId) botInfo(m.senderId).then(setBot);
        }
      } else if (frame.op === 'msg_edit' && frame.data?.conversationId === conversationId) {
        const d = frame.data;
        setMessages((prev) => prev.map((m) => (m.id === d.msgId ? { ...m, content: d.content ?? m.content, markup: d.markup } : m)));
      } else if (frame.op === 'msg_delete' && frame.data?.conversationId === conversationId) {
        const mid = String(frame.data.msgId);
        setPins((prev) => prev.filter((p) => p.id !== mid));
        dustThen([msgEl(mid)], () => setMessages((prev) => prev.filter((m) => m.id !== mid)));
      } else if (frame.op === 'msg_reactions' && frame.data?.conversationId === conversationId) {
        const d = frame.data;
        setMessages((prev) => prev.map((m) => (m.id === d.msgId ? { ...m, reactions: d.reactions } : m)));
      } else if (frame.op === 'msg_pin' && frame.data?.conversationId === conversationId) {
        loadPins();
      } else if (frame.op === 'conv_cleared') {
        // 有人清空了记录（单聊=全部，群聊=其发送的消息）：重新拉取同步
        if (frame.data?.conversationId === conversationId) {
          api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`)
            .then((list) => setMessages(list))
            .catch(() => {});
        }
      } else if (frame.op === 'ack') {
        setMessages((prev) => prev.map((m) => (
          m.tempId === frame.tempId ? { ...m, id: frame.msgId, createdAt: frame.createdAt, pending: false } : m
        )));
      } else if (frame.op === 'error') {
        // 发送被后端拒绝（如积分不足）：提示并撤回乐观显示的消息
        setMessages((prev) => prev.filter((m) => !(m.pending && (frame.tempId ? m.tempId === frame.tempId : true))));
        showToast(frame.msg ?? '发送失败');
      } else if (frame.op === 'read' && frame.conversationId === conversationId) {
        // 对方已读：把我发出的、id 不大于回执 msgId 的消息标记为已读
        const readUpTo = BigInt(frame.msgId);
        setMessages((prev) => prev.map((m) => {
          if (m.pending || !me || m.senderId !== me.id) return m;
          try {
            return BigInt(m.id) <= readUpTo ? { ...m, isRead: true } : m;
          } catch {
            return m;
          }
        }));
      }
    });
  }, [conversationId]);

  useEffect(() => {
    if (focusId.current) {
      if (!messages.length) return;
      const id = focusId.current;
      focusId.current = null;
      if (flash(id)) return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendRaw = (msgType: string, content: string) => {
    if (!state.targetId || !me) return;
    // 一次回复只挂在紧接着发的第一条上（多图连发时后面的不带）
    const r = replyRef.current;
    replyRef.current = null;
    if (r) setReplyTo(null);
    const tempId = wsManager.send((state.convType as 1 | 2) ?? 1, state.targetId, msgType, content, r?.id);
    setMessages((prev) => [...prev, {
      id: tempId, tempId, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar,
      type: msgType, content, createdAt: new Date().toISOString(), pending: true,
      replyTo: r ? {
        id: r.id, senderId: r.senderId, senderNickname: r.senderNickname, type: r.type,
        content: r.type === 'text' ? r.content.slice(0, 100) : r.type === 'image' ? r.content : '',
      } : null,
    }]);
  };

  // ---------- 长按菜单 ----------

  const react = async (msgId: string, emoji: string) => {
    try {
      const r = await api<{ reactions: Reaction[] }>(`/im/messages/${msgId}/react`, { method: 'POST', body: { emoji } });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, reactions: r.reactions } : m)));
    } catch (e: any) {
      showToast(e.message || '操作失败');
    }
  };

  const togglePin = async (msgId: string, pin: boolean) => {
    try {
      await api(`/im/messages/${msgId}/pin`, { method: 'POST', body: { pin } });
      loadPins();
      showToast(pin ? '已置顶' : '已取消置顶');
    } catch (e: any) {
      showToast(e.message || '操作失败');
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => showToast('已复制')).catch(() => showToast('复制失败'));
  };

  const isMine = (m: MsgItem) => !!me && m.senderId === me.id;
  /** 能否「为双方删除」：自己的或群管理员，礼物不行 */
  const canDeleteForAll = (m: MsgItem) => m.type !== 'gift' && (isMine(m) || isGroupAdmin);

  const menuActions = (m: MsgItem): MenuActions => ({
    onReact: (e) => react(m.id, e),
    onReply: () => { setReplyTo(m); setShowSticker(false); setTimeout(() => inputRef.current?.focus(), 0); },
    onCopy: m.type === 'text' ? () => copyText(m.content) : undefined,
    onSave: m.type === 'image' || m.type === 'video' ? () => saveMedia(m.content, m.type) : undefined,
    onPin: canPin ? () => togglePin(m.id, !pins.some((p) => p.id === m.id)) : undefined,
    onForward: FORWARDABLE.has(m.type) ? () => setForwardIds([m.id]) : undefined,
    onReport: !isMine(m) ? () => setReportId(m.id) : undefined,
    onDelete: () => setDeleteIds([m.id]),
    onSelect: () => setSelecting(new Set([m.id])),
  });

  const doDelete = async (forAll: boolean) => {
    const ids = deleteIds ?? [];
    setDeleteIds(null);
    // 确认后立刻开始化成灰（和接口并行），失败再放回来
    const els = ids.map(msgEl);
    const anim = new Promise<void>((resolve) => dustThen(els, resolve));
    try {
      await api('/im/messages/delete', { method: 'POST', body: { conversationId, ids, forAll } });
      setSelecting(null);
      await anim;
      setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    } catch (e: any) {
      undust(els);
      showToast(e.message || '删除失败');
    }
  };

  const selected = selecting ? messages.filter((m) => selecting.has(m.id)) : [];
  const toggleSelect = (id: string) => setSelecting((s) => {
    if (!s) return s;
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const copySelected = () => {
    const texts = selected.filter((m) => m.type === 'text');
    if (!texts.length) return showToast('选中的消息里没有文字');
    copyText(texts.map((m) => (state.convType === 2 ? `${m.senderNickname}：${m.content}` : m.content)).join('\n'));
    setSelecting(null);
  };
  const forwardSelected = () => {
    const ok = selected.filter((m) => FORWARDABLE.has(m.type)).map((m) => m.id);
    if (!ok.length) return showToast('礼物、通话记录不能转发');
    if (ok.length < selected.length) showToast('礼物、通话记录不会被转发');
    setForwardIds(ok);
  };

  const send = () => {
    const content = input.trim();
    if (!content) return;
    sendRaw('text', content);
    setInput('');
    setShowCmds(false);
  };

  const sendCommand = (cmd: string) => {
    sendRaw('text', `/${cmd}`);
    setInput('');
    setShowCmds(false);
  };

  // 机器人私聊：输入 / 开头时按前缀过滤命令菜单
  const cmdFilter = input.startsWith('/') ? input.slice(1).toLowerCase() : null;
  const cmdList = (bot?.commands ?? []).filter((c) => cmdFilter === null || c.command.toLowerCase().startsWith(cmdFilter));
  const cmdOpen = !!bot && cmdList.length > 0 && (showCmds || (cmdFilter !== null && !input.includes(' ')));

  /** 贴纸 / GIF：点即发（Telegram 式）；「最近使用」由面板自己记 */
  const sendSticker = (p: StickerPayload) => {
    sendRaw('sticker', JSON.stringify(p));
  };

  /** 「+」弹框选的图 / 视频：按顺序逐个上传发送，说明文字最后单独发一条 */
  const sendMedia = async (files: File[], caption: string) => {
    let failed = 0;
    for (const file of files) {
      try {
        const isVideo = file.type.startsWith('video');
        const url = await uploadFile(isVideo ? 'video' : 'image', file);
        sendRaw(isVideo ? 'video' : 'image', url);
      } catch {
        failed++;
      }
    }
    if (caption.trim()) sendRaw('text', caption.trim());
    if (failed) showToast(`${failed} 个文件发送失败`);
  };

  const handleAttach = (a: AttachAction) => {
    if (a === 'gift') setShowGift(true);
    else if (a === 'location') sendLocation();
    else setShowDownload(true);
  };

  const sendLocation = () => {
    if (!navigator.geolocation) return alert('当前环境不支持定位');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        sendRaw('location', JSON.stringify({ lat: latitude, lng: longitude, name: nearestCity(latitude, longitude) }));
      },
      () => alert('定位失败，请允许定位权限'),
    );
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">{state.title ?? '聊天'}{bot && <span className="bot-tag">机器人</span>}</span>
        <span
          className="action"
          style={{ color: 'var(--text-2)' }}
          onClick={async () => {
            const tip = state.convType === 1
              ? '清空后双方的聊天记录都将删除，不可恢复。确定清空吗？'
              : '将删除我在本群发送的全部消息，所有成员都将不再看到。确定清空吗？';
            if (!window.confirm(tip)) return;
            try {
              await api(`/im/conversations/${conversationId}/clear`, { method: 'POST' });
              const list = await api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`);
              setMessages(list);
            } catch (e: any) {
              alert(e.message);
            }
          }}
        >
          清空
        </span>
        {state.convType === 2 && (
          <span className="action" onClick={() => setShowGroupInfo(true)}>群信息</span>
        )}
      </div>
      {pins.length > 0 && (
        <PinBar
          pins={pins}
          index={pinIdx}
          canUnpin={canPin}
          onJump={() => { jumpTo(pins[pinIdx % pins.length].id); setPinIdx((i) => (i + 1) % pins.length); }}
          onUnpin={() => { const p = pins[pinIdx % pins.length]; if (confirm('取消置顶这条消息？')) togglePin(p.id, false); }}
        />
      )}

      <div className="page page-pad" onClick={() => { setShowSticker(false); setShowCmds(false); }}>
        {bot && loaded && messages.length === 0 && (
          <div className="bot-intro">
            <div className="avatar" style={{ width: 64, height: 64, margin: '0 auto' }}>{bot.avatar && <img src={bot.avatar} alt="" />}</div>
            <div style={{ fontWeight: 700, fontSize: 17, marginTop: 10 }}>{bot.name}</div>
            <div className="small" style={{ marginTop: 2 }}>@{bot.username}</div>
            <div style={{ fontSize: 14, marginTop: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6, textAlign: 'left' }}>{bot.description || '这是一个机器人，点下面的「开始」和它聊天'}</div>
          </div>
        )}
        {messages.map((m, i) => {
          // 微信式时间分隔条：与上一条间隔超 5 分钟显示
          const prev = i > 0 ? new Date(messages[i - 1].createdAt).getTime() : 0;
          const cur = new Date(m.createdAt).getTime();
          const showTime = !!m.createdAt && !Number.isNaN(cur) && (i === 0 || cur - prev > 5 * 60 * 1000);
          return (
            <div key={m.tempId ?? m.id} id={`msg-${m.id}`} className={flashId === m.id ? 'msg-flash' : undefined}>
              {showTime && (
                <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-3)', padding: '8px 0' }}>
                  {formatTime(m.createdAt)}
                </div>
              )}
              {selecting ? (
                <div className="sel-row" onClick={() => !m.pending && toggleSelect(m.id)}>
                  <span className={`sel-circle${selecting.has(m.id) ? ' on' : ''}`}>{selecting.has(m.id) ? '✓' : ''}</span>
                  <MsgBubble m={m} mine={isMine(m)} convType={state.convType ?? 1} myId={me?.id} onImage={() => {}} onMenu={() => {}} onReact={() => {}} onJump={() => {}} />
                </div>
              ) : (
                <MsgBubble
                  m={m}
                  mine={isMine(m)}
                  convType={state.convType ?? 1}
                  myId={me?.id}
                  onImage={setFullImage}
                  onMenu={(x, y) => !m.pending && setMenu({ m, x, y })}
                  onReact={(e) => react(m.id, e)}
                  onJump={jumpTo}
                />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 底部输入区（微信式，对齐 iOS）：输入框 + 圆形加号呼出功能面板，发送键仅有文字时出现 */}
      {selecting ? (
        <div className="sel-bar">
          <span onClick={() => setSelecting(null)}>取消</span>
          <span className="grow small" style={{ cursor: 'default' }}>已选 {selecting.size} 条</span>
          <span className={selected.length ? '' : 'off'} onClick={() => selected.length && copySelected()}>拷贝</span>
          <span className={selected.length ? '' : 'off'} onClick={() => selected.length && forwardSelected()}>转发</span>
          <span className={selected.length ? '' : 'off'} style={selected.length ? { color: 'var(--danger)' } : undefined} onClick={() => selected.length && setDeleteIds(selected.map((m) => m.id))}>删除</span>
        </div>
      ) : bot && loaded && messages.length === 0 ? (
        <div className="ch-bottom"><span className="accent" style={{ fontWeight: 600 }} onClick={() => sendCommand('start')}>开始</span></div>
      ) : (
      <div style={{ background: 'var(--bg-card)', position: 'relative' }}>
        {replyTo && <ReplyBar m={replyTo} onCancel={() => setReplyTo(null)} />}
        {cmdOpen && (
          <div className="bot-cmds">
            {cmdList.map((c) => (
              <div key={c.command} onClick={() => sendCommand(c.command)}><b>/{c.command}</b><span className="small">{c.description}</span></div>
            ))}
          </div>
        )}
        <div className="row" style={{ padding: 8, gap: 8 }}>
          {bot && bot.commands.length > 0 && (
            <span
              title="命令菜单"
              style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: showCmds ? 'rgba(47,124,246,0.15)' : 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#2f7cf6', fontSize: 18, fontWeight: 700 }}
              onClick={() => { setShowCmds((v) => !v); setShowSticker(false); }}
            >/</span>
          )}
          <input
            ref={inputRef}
            className="input grow"
            style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
            value={input}
            placeholder="发消息"
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setShowSticker(false)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <span
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: showSticker ? '#ffe1e7' : 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: showSticker ? 'var(--accent)' : 'var(--text-2)', fontSize: 22 }}
            onClick={() => setShowSticker((v) => !v)}
          >☺</span>
          <span
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)', fontSize: 20 }}
            onClick={() => { setShowAttach(true); setShowSticker(false); }}
          >+</span>
          {input.trim() && (
            <button className="btn-sm" style={{ height: 40, borderRadius: 20, flexShrink: 0 }} onClick={send}>发送</button>
          )}
        </div>
        {showSticker && (
          <EmojiPanel
            onPick={sendSticker}
            onEmoji={(e) => setInput((v) => v + e)}
            onDelete={() => setInput((v) => dropLastGrapheme(v))}
            onKeyboard={() => { setShowSticker(false); inputRef.current?.focus(); }}
          />
        )}
      </div>
      )}

      {showAttach && (
        <AttachSheet
          isSingle={state.convType === 1 && !bot}
          canVideoCall={me?.gender === 1}
          onClose={() => setShowAttach(false)}
          onSend={sendMedia}
          onAction={handleAttach}
        />
      )}
      {toast && (
        <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 200, background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 14, padding: '10px 18px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {toast}
        </div>
      )}
      {fullImage && (
        <div
          className="mask"
          style={{ background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setFullImage(null)}
        >
          <img src={fullImage} alt="" style={{ maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain' }} />
          <span
            style={{ position: 'fixed', top: 16, right: 16, width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >×</span>
          <span
            onClick={async (e) => {
              e.stopPropagation();
              if (qrBusy) return;
              setQrBusy(true);
              const text = await decodeQrFromImage(fullImage).catch(() => null);
              setQrBusy(false);
              if (!text) return showToast('图片里没有认出二维码');
              setFullImage(null);
              setScanText(text);
            }}
            style={{ position: 'fixed', bottom: 48, left: '50%', transform: 'translateX(-50%)', padding: '9px 16px', borderRadius: 20, background: 'rgba(255,255,255,0.18)', color: '#fff', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <ScanIcon size={16} color="#fff" />
            {qrBusy ? '识别中…' : '识别二维码'}
          </span>
        </div>
      )}
      {scanText && <ScanFlow text={scanText} onClose={() => setScanText(null)} />}
      {menu && (
        <MsgMenu
          m={menu.m}
          mine={isMine(menu.m)}
          convType={state.convType ?? 1}
          myReaction={menu.m.reactions?.find((r) => me && r.userIds.includes(me.id))?.emoji}
          pinned={pins.some((p) => p.id === menu.m.id)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={menuActions(menu.m)}
        />
      )}
      {deleteIds && (
        <DeleteDialog
          count={deleteIds.length}
          canForAll={messages.filter((m) => deleteIds.includes(m.id)).every(canDeleteForAll)}
          convType={state.convType ?? 1}
          peerName={state.title}
          onConfirm={doDelete}
          onClose={() => setDeleteIds(null)}
        />
      )}
      {forwardIds && conversationId && (
        <ForwardSheet
          fromConversationId={conversationId}
          ids={forwardIds}
          onClose={() => setForwardIds(null)}
          onDone={(tip, convIds) => {
            setForwardIds(null);
            setSelecting(null);
            showToast(tip);
            if (convIds.includes(conversationId)) {
              api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`).then(setMessages).catch(() => {});
            }
          }}
        />
      )}
      {reportId && (
        <ReportSheet msgId={reportId} onClose={() => setReportId(null)} onDone={(tip) => { setReportId(null); showToast(tip); }} />
      )}
      {showDownload && <DownloadDialog onClose={() => setShowDownload(false)} />}
      {showGift && state.targetId && (
        <GiftSheet toUserId={state.targetId} onClose={() => setShowGift(false)} onSent={() => {}} />
      )}
      {showGroupInfo && state.convType === 2 && state.targetId && (
        <GroupInfoSheet
          groupId={state.targetId}
          onClose={() => setShowGroupInfo(false)}
          onExit={() => nav('/chat', { replace: true })}
        />
      )}
    </div>
  );
}
