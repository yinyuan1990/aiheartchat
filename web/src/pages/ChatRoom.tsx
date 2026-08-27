import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, fmtPoints, uploadFile } from '../api';
import { useApp } from '../store';
import { wsManager, MessagePayload } from '../ws';
import { nearestCity } from '../cities';

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

/** 群分享面板：二维码 + 邀请码 + 密码设置（群主/管理员） */
function GroupShareView({ groupId, onBack }: { groupId: string; onBack: () => void }) {
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
        {share.hasPassword ? '扫码或输码后需输入密码才能加入' : '扫码或输入邀请码即可加入'}
      </div>
      {qrUrl && <img src={qrUrl} alt="群二维码" style={{ width: 200, height: 200, borderRadius: 12, background: '#fff', padding: 8 }} />}
      <div
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, margin: '12px auto 0', padding: '8px 14px', background: 'var(--bg-input)', borderRadius: 8, cursor: 'pointer' }}
        onClick={() => { navigator.clipboard?.writeText(share.code); alert('邀请码已复制'); }}
      >
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3 }}>{share.code}</span>
        <span className="accent" style={{ fontSize: 12 }}>复制</span>
      </div>

      {share.canEdit && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
            {([['none', '无密码'], ['pwd', '有密码']] as const).map(([k, label]) => (
              <span
                key={k}
                onClick={() => setMode(k)}
                style={{
                  padding: '6px 16px', borderRadius: 14, fontSize: 13, cursor: 'pointer',
                  background: mode === k ? 'var(--accent-grad)' : 'var(--bg-input)',
                  color: mode === k ? '#fff' : 'var(--text-2)',
                }}
              >{label}</span>
            ))}
          </div>
          {mode === 'pwd' && (
            <input className="input" placeholder="设置入群密码" value={pwd} maxLength={20} style={{ marginTop: 10 }} onChange={(e) => setPwd(e.target.value)} />
          )}
          <button className="btn mt12" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存设置'}</button>
        </div>
      )}

      <button className="btn btn-ghost mt12" onClick={onBack}>返回</button>
    </div>
  );
}

/** 群信息面板：成员查看、邀请、踢人、退群/解散 */
function GroupInfoSheet({ groupId, onClose, onExit }: { groupId: string; onClose: () => void; onExit: () => void }) {
  const me = useApp((s) => s.user);
  const [info, setInfo] = useState<any>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [people, setPeople] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = () => api<any>(`/im/group/${groupId}`).then(setInfo).catch(() => {});
  useEffect(() => { load(); }, [groupId]);

  const myRole: string = info?.members?.find((m: any) => m.id === me?.id)?.role ?? 'member';

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
function AudioBubble({ a }: { a: any }) {
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
    <span className="row" style={{ gap: 8, cursor: 'pointer' }} onClick={toggle}>
      <span className={`voice-bars${playing ? ' playing' : ''}`}>
        <span /><span /><span />
      </span>
      <span>语音 {a.duration ? `${a.duration}"` : ''}</span>
    </span>
  );
}

function MsgBubble({ m, mine, convType, onImage }: { m: MsgItem; mine: boolean; convType: number; onImage: (url: string) => void }) {
  const isMedia = m.type === 'image' || m.type === 'video';
  let body: JSX.Element;
  switch (m.type) {
    case 'image':
      body = <img src={m.content} alt="" style={{ cursor: 'pointer' }} onClick={() => onImage(m.content)} />;
      break;
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
          className="row"
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
        body = <span>{m.content}</span>;
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
      <div className="bubble-wrap">
        {/* 对齐 iOS：只显示对方昵称，自己的不显示 */}
        {!mine && <div className="small" style={{ marginBottom: 3 }}>{m.senderNickname}</div>}
        <div className={`bubble ${mine ? 'mine' : 'theirs'}${isMedia ? ' media' : ''}`} style={{ opacity: m.pending ? 0.6 : 1 }}>{body}</div>
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
  const state = (location.state ?? {}) as { title?: string; convType?: number; targetId?: string };

  const [messages, setMessages] = useState<MsgItem[]>([]);
  const [input, setInput] = useState('');
  const [showDownload, setShowDownload] = useState(false);
  const [showGift, setShowGift] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [fullImage, setFullImage] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2000);
  };

  useEffect(() => {
    if (!conversationId) return;
    api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`).then((list) => {
      setMessages(list);
      const last = list[list.length - 1];
      if (last) wsManager.markRead(conversationId, last.id);
    }).catch(() => {});

    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'msg') {
        const m = frame.data as MessagePayload;
        if (m.conversationId === conversationId) {
          setMessages((prev) => [...prev, m]);
          wsManager.markRead(conversationId, m.id);
        }
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendRaw = (msgType: string, content: string) => {
    if (!state.targetId || !me) return;
    const tempId = wsManager.send((state.convType as 1 | 2) ?? 1, state.targetId, msgType, content);
    setMessages((prev) => [...prev, {
      id: tempId, tempId, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar,
      type: msgType, content, createdAt: new Date().toISOString(), pending: true,
    }]);
  };

  const send = () => {
    const content = input.trim();
    if (!content) return;
    sendRaw('text', content);
    setInput('');
  };

  const sendMedia = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const isVideo = file.type.startsWith('video');
      const url = await uploadFile(isVideo ? 'video' : 'image', file);
      sendRaw(isVideo ? 'video' : 'image', url);
    } catch (e: any) {
      alert(e.message);
    }
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
        <span className="title">{state.title ?? '聊天'}</span>
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

      <div className="page page-pad" onClick={() => setShowPanel(false)}>
        {messages.map((m, i) => {
          // 微信式时间分隔条：与上一条间隔超 5 分钟显示
          const prev = i > 0 ? new Date(messages[i - 1].createdAt).getTime() : 0;
          const cur = new Date(m.createdAt).getTime();
          const showTime = !!m.createdAt && !Number.isNaN(cur) && (i === 0 || cur - prev > 5 * 60 * 1000);
          return (
            <div key={m.tempId ?? m.id}>
              {showTime && (
                <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-3)', padding: '8px 0' }}>
                  {formatTime(m.createdAt)}
                </div>
              )}
              <MsgBubble m={m} mine={!!me && m.senderId === me.id} convType={state.convType ?? 1} onImage={setFullImage} />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 底部输入区（微信式，对齐 iOS）：输入框 + 圆形加号呼出功能面板，发送键仅有文字时出现 */}
      <div style={{ background: 'var(--bg-card)' }}>
        <div className="row" style={{ padding: 8, gap: 8 }}>
          <input
            className="input grow"
            style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
            value={input}
            placeholder="发消息"
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setShowPanel(false)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <span
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)', fontSize: 20 }}
            onClick={() => setShowPanel((v) => !v)}
          >+</span>
          {input.trim() && (
            <button className="btn-sm" style={{ height: 40, borderRadius: 20, flexShrink: 0 }} onClick={send}>发送</button>
          )}
        </div>
        {showPanel && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '12px 12px 20px' }}>
            {([
              ['▦', '相册', () => { setShowPanel(false); fileRef.current?.click(); }],
              ['◎', '位置', () => { setShowPanel(false); sendLocation(); }],
              ...(state.convType === 1 ? [
                ['✆', '语音通话', () => { setShowPanel(false); setShowDownload(true); }],
                ...(me?.gender === 1 ? [['▣', '视频通话', () => { setShowPanel(false); setShowDownload(true); }]] : []),
                ['❀', '礼物', () => { setShowPanel(false); setShowGift(true); }],
              ] : []),
            ] as [string, string, () => void][]).map(([icon, label, act]) => (
              <div key={label} style={{ textAlign: 'center', cursor: 'pointer' }} onClick={act}>
                <div style={{ width: 56, height: 56, margin: '0 auto', borderRadius: 14, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>{icon}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6 }}>{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => sendMedia(e.target.files)} />
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
        </div>
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
