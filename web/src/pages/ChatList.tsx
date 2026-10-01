import { ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { api, uploadFile } from '../api';
import { wsManager } from '../ws';
import { MusicSheet, NowPlayingBar } from './Music';
import { ChatSearch, SearchExtra } from '../components/ChatSearch';
import { parseGroupCode, parseInviteCode, QrScanner, ScanIcon } from '../components/QrScanner';

interface ConversationItem {
  id: string;
  type: number;
  peer?: { id: string; nickname: string; avatar: string; gender: number };
  group?: { id: string; name: string; avatar: string };
  lastMsg?: { type: string; content: string; createdAt: string } | null;
  unread: number;
  lastMsgAt: string;
}

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  refId: string;
  isRead: boolean;
  createdAt: string;
}

type NoticeKind = 'comment' | 'task';

interface NoticeSummary {
  unread: number;
  last: { title: string; body: string; createdAt: string } | null;
}

const NOTICE_META: Record<NoticeKind, { title: string; grad: string; icon: ReactNode }> = {
  comment: {
    title: '评论通知',
    grad: 'linear-gradient(135deg, #ff9a3c, #fe2c55)',
    icon: <svg width={26} height={26} viewBox="0 0 24 24" fill="#fff"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.6 3.4 6.1L4.6 21l4.3-2.3c1 .2 2 .3 3.1.3 5.5 0 10-3.6 10-8s-4.5-8-10-8z" /></svg>,
  },
  task: {
    title: '接单通知',
    grad: 'linear-gradient(135deg, #2fb5ff, #4c6fff)',
    icon: <svg width={24} height={24} viewBox="0 0 24 24" fill="#fff"><path d="M9 3h6a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v4H2V8a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2zm0 3h6V5H9v1zM2 14h8v1a2 2 0 0 0 4 0v-1h8v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5z" /></svg>,
  },
};

const AI_ICON = <div className="cl-icon" style={{ background: 'var(--accent-grad)', fontSize: 17, fontWeight: 800, letterSpacing: 1 }}>AI</div>;
const MUSIC_ICON = (
  <div className="cl-icon" style={{ background: 'linear-gradient(135deg, #7b5cff, #fe2c55)' }}>
    <svg width={26} height={26} viewBox="0 0 24 24" fill="#fff"><path d="M9 3v10.55A4 4 0 1 0 11 17V7h5a3 3 0 0 0 3-3V3H9z" /></svg>
  </div>
);

function previewText(msg?: ConversationItem['lastMsg']): string {
  if (!msg) return '';
  switch (msg.type) {
    case 'text': return msg.content.slice(0, 30);
    case 'image': return '[图片]';
    case 'video': return '[视频]';
    case 'sticker': return msg.content.includes('"mp4"') ? '[GIF]' : '[表情]';
    case 'gift': return '[礼物]';
    case 'audio': return '[语音]';
    case 'location': return '[位置]';
    default: return msg.type.startsWith('call') ? '[通话]' : '';
  }
}

function timeText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 建群弹层 */
function CreateGroupSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (convId: string, name: string, groupId: string) => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [uploading, setUploading] = useState(false);
  const [people, setPeople] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<any[]>('/guide/discover').then(setPeople).catch(() => {});
  }, []);

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      setAvatar(await uploadFile('image', file));
    } catch (e: any) {
      alert(e.message || '上传失败');
    }
    setUploading(false);
  };

  const create = async () => {
    if (!name.trim()) {
      alert('请填写群名');
      return;
    }
    try {
      const g = await api<any>('/im/group', { method: 'POST', body: { name: name.trim(), memberIds: [...selected], avatar } });
      onCreated(g.conversationId, g.name, g.id);
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', marginBottom: 12, fontWeight: 600 }}>创建群聊</div>
        <div className="row" style={{ gap: 12 }}>
          {/* 群头像（可选，不设置默认用群主头像） */}
          <div
            className="avatar"
            onClick={() => fileRef.current?.click()}
            style={{ width: 56, height: 56, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-input)', fontSize: 11, color: 'var(--text-3)' }}
          >
            {avatar ? <img src={avatar} alt="" /> : uploading ? '…' : '头像'}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickAvatar(e.target.files?.[0])} />
          <input className="input grow" style={{ marginBottom: 0 }} placeholder="群名称" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="muted" style={{ margin: '8px 0 10px' }}>群头像可选，不设置默认显示群主头像 · 邀请成员（可选）</div>
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
        <button className="btn mt12" onClick={create}>创建（{selected.size} 人）</button>
      </div>
    </div>
  );
}

/** 加入群聊弹层：群列表可直接加入，也可输邀请码；有密码的群需输密码；initialCode 由「扫一扫」预填并自动查询 */
export function JoinGroupSheet({ onClose, onJoined, initialCode }: { onClose: () => void; onJoined: (convId: string, name: string, groupId: string) => void; initialCode?: string }) {
  const [code, setCode] = useState(initialCode ?? '');
  const [info, setInfo] = useState<any>(null);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<any[]>([]);

  useEffect(() => {
    if (initialCode) check(initialCode);
    api<any[]>('/im/group/list').then(setGroups).catch(() => {});
  }, []);

  /** 按群 id 加入（群列表入口），有密码的群先 prompt */
  const joinById = async (g: any) => {
    if (g.isMember && g.conversationId) {
      onJoined(g.conversationId, g.name, g.id);
      return;
    }
    let password = '';
    if (g.hasPassword) {
      const input = prompt(`「${g.name}」需要密码才能加入`);
      if (input == null) return;
      password = input.trim();
    }
    setBusy(true);
    try {
      const r = await api<any>(`/im/group/${g.id}/join`, { method: 'POST', body: { password } });
      onJoined(r.conversationId, r.name, r.id);
    } catch (e: any) {
      alert(e.message || '加入失败');
    }
    setBusy(false);
  };

  const check = async (raw?: string) => {
    const c = (raw ?? code).trim().toUpperCase();
    if (c.length < 6) { alert('请输入完整邀请码'); return; }
    setBusy(true);
    try {
      const g = await api<any>(`/im/group/code/${c}`);
      setInfo(g);
      setPwd('');
    } catch (e: any) {
      alert(e.message || '邀请码无效');
    }
    setBusy(false);
  };

  const join = async () => {
    if (info.isMember && info.conversationId) {
      onJoined(info.conversationId, info.name, info.groupId);
      return;
    }
    if (info.hasPassword && !pwd.trim()) { alert('请输入入群密码'); return; }
    setBusy(true);
    try {
      const g = await api<any>('/im/group/join-by-code', { method: 'POST', body: { code: code.trim().toUpperCase(), password: pwd.trim() } });
      onJoined(g.conversationId, g.name, g.id);
    } catch (e: any) {
      alert(e.message || '加入失败');
    }
    setBusy(false);
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', marginBottom: 12, fontWeight: 600 }}>加入群聊</div>
        <input
          className="input"
          placeholder="输入群邀请码"
          value={code}
          maxLength={12}
          style={{ textTransform: 'uppercase', letterSpacing: 2 }}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setInfo(null); }}
        />
        {!info ? (
          code.trim() && <button className="btn mt12" disabled={busy} onClick={() => check()}>{busy ? '查询中…' : '查找群聊'}</button>
        ) : (
          <>
            <div className="card" style={{ marginTop: 12, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{info.name}</div>
              <div className="small" style={{ marginTop: 4 }}>共 {info.memberCount} 人{info.hasPassword ? ' · 需要密码' : ''}</div>
              {info.isMember && <div className="small" style={{ color: 'var(--success, #0bd07d)', marginTop: 6 }}>你已在群里</div>}
              {!info.isMember && info.hasPassword && (
                <input className="input" type="password" placeholder="输入入群密码" value={pwd} maxLength={20} style={{ marginTop: 10 }} onChange={(e) => setPwd(e.target.value)} />
              )}
            </div>
            <button className="btn mt12" disabled={busy} onClick={join}>
              {info.isMember ? '进入群聊' : busy ? '加入中…' : '加入群聊'}
            </button>
          </>
        )}

        {/* 群列表：直接浏览加入 */}
        <div className="small" style={{ margin: '14px 0 4px' }}>群列表</div>
        {groups.length === 0 && <div className="empty" style={{ padding: 16 }}>暂无群聊</div>}
        {groups.map((g) => (
          <div key={g.id} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="avatar" style={{ width: 44, height: 44 }}>
              {g.avatar && <img src={g.avatar} alt="" />}
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontSize: 15 }}>{g.name}</div>
              <div className="small" style={{ marginTop: 2 }}>共 {g.memberCount} 人{g.hasPassword ? ' · 需要密码' : ''}</div>
            </div>
            <span
              onClick={() => !busy && joinById(g)}
              style={{
                padding: '6px 16px', borderRadius: 14, fontSize: 12, cursor: 'pointer', flexShrink: 0,
                background: g.isMember ? 'var(--bg-input)' : 'var(--accent-grad)',
                color: g.isMember ? 'var(--text-2)' : '#fff',
              }}
            >{g.isMember ? '进入' : '加入'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 扫一扫（消息页搜索 / 我的页共用）：邀请名片 → 直接打开与对方的私聊；群邀请码 → 加入群聊；收款码 → 提示去转赠页 */
export function ScanFlow({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [scanning, setScanning] = useState(true);
  const [joinCode, setJoinCode] = useState<string | null>(null);

  const handle = async (text: string) => {
    setScanning(false);
    const invite = parseInviteCode(text);
    if (invite) {
      try {
        const r = await api<{ conversationId: string; peer: { id: string; nickname: string } }>(
          '/im/conversations/open-by-code', { method: 'POST', body: { code: invite } },
        );
        onClose();
        if (openNativeChat(r.conversationId, 1, r.peer.id, r.peer.nickname)) return;
        nav(`/chatroom/${r.conversationId}`, { state: { title: r.peer.nickname, convType: 1, targetId: r.peer.id } });
      } catch (e: any) {
        alert(e.message);
        onClose();
      }
      return;
    }
    if (text.includes('pay?sid=')) {
      alert('这是收款码，请到「积分明细 - 转赠」里扫码使用');
      onClose();
      return;
    }
    const g = parseGroupCode(text);
    if (g) setJoinCode(g);
    else { alert('无法识别的二维码'); onClose(); }
  };

  return (
    <>
      {scanning && <QrScanner hint="对准邀请名片或群二维码" onResult={handle} onClose={onClose} />}
      {joinCode && (
        <JoinGroupSheet
          initialCode={joinCode}
          onClose={onClose}
          onJoined={(convId, name, groupId) => {
            onClose();
            if (openNativeChat(convId, 2, groupId, `${name}（群）`)) return;
            nav(`/chatroom/${convId}`, { state: { title: `${name}（群）`, convType: 2, targetId: groupId } });
          }}
        />
      )}
    </>
  );
}

export function ChatListPage() {
  const nav = useNavigate();
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [summary, setSummary] = useState<Record<NoticeKind, NoticeSummary> | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showMusic, setShowMusic] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showScan, setShowScan] = useState(false);

  const loadConvs = () => api<ConversationItem[]>('/im/conversations').then(setConvs).catch(() => {});
  const loadSummary = () => api<Record<NoticeKind, NoticeSummary>>('/notifications/summary').then(setSummary).catch(() => {});

  useEffect(() => {
    loadConvs();
    loadSummary();
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'msg' || frame.op === 'conv_cleared' || frame.op === 'conv_refresh') loadConvs();
      if (frame.op === 'notify') loadSummary();
    });
  }, []);

  const openConv = (c: { id: string; type: number; targetId: string; title: string; focusMsgId?: string }) => {
    const title = c.type === 2 ? `${c.title}（群）` : c.title;
    if (openNativeChat(c.id, c.type, c.targetId, title)) return;
    nav(`/chatroom/${c.id}`, { state: { title, convType: c.type, targetId: c.targetId, focusMsgId: c.focusMsgId } });
  };

  // 会话 + 评论 / 接单两个系统会话混排，最新的在上；AI 助手、音乐固定置顶
  type Entry = { at: string } & ({ kind: 'conv'; conv: ConversationItem } | { kind: 'notice'; key: NoticeKind; s: NoticeSummary });
  const entries: Entry[] = [
    ...convs.map((conv): Entry => ({ kind: 'conv', conv, at: conv.lastMsgAt })),
    ...(['comment', 'task'] as NoticeKind[])
      .filter((k) => summary?.[k]?.last)
      .map((k): Entry => ({ kind: 'notice', key: k, s: summary![k], at: summary![k].last!.createdAt })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const searchExtras: SearchExtra[] = [
    { key: 'ai', title: 'AI 助手', subtitle: '有问必答，随便问', icon: AI_ICON, onOpen: () => nav('/ai-chat') },
    { key: 'music', title: '音乐', subtitle: 'DJ 热曲 · 情感音乐，边聊边听', icon: MUSIC_ICON, onOpen: () => { setShowSearch(false); setShowMusic(true); } },
    ...(['comment', 'task'] as NoticeKind[]).filter((k) => summary?.[k]?.last).map((k) => ({
      key: k,
      title: NOTICE_META[k].title,
      subtitle: summary![k].last!.title,
      unread: summary![k].unread,
      icon: <div className="cl-icon" style={{ width: 44, height: 44, background: NOTICE_META[k].grad }}>{NOTICE_META[k].icon}</div>,
      onOpen: () => nav(`/notices/${k}`),
    })),
  ];

  const pinIcon = (
    <span className="cl-pin">
      <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" /></svg>
    </span>
  );

  const fixedRow = (icon: ReactNode, title: string, sub: string, tag: string, onClick: () => void) => (
    <div className="cl-row" onClick={onClick}>
      {icon}
      <div className="cl-row-main">
        <div className="cl-row-top">
          <span className="cl-row-title ellipsis">{title}</span>
          <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 5px' }}>{tag}</span>
        </div>
        <div className="cl-row-sub">
          <span className="ellipsis">{sub}</span>
          {pinIcon}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* 播放中：顶部固定「正在播放」栏，点中间打开播放弹层 */}
      <NowPlayingBar onOpen={() => setShowMusic(true)} />
      {/* 头部：标题 + 建群按钮 */}
      <div className="cl-head">
        <span className="cl-title">消息</span>
        <span style={{ position: 'relative', flexShrink: 0 }}>
          <span className="cl-plus" onClick={() => setShowPlusMenu((v) => !v)} title="群聊">+</span>
          {showPlusMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setShowPlusMenu(false)} />
              <div style={{
                position: 'absolute', top: 40, right: 0, zIndex: 31,
                background: 'var(--bg-card)', border: '1px solid var(--line)', borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow: 'hidden', width: 120,
              }}>
                <div style={{ padding: '11px 16px', fontSize: 14, cursor: 'pointer' }} onClick={() => { setShowPlusMenu(false); setShowCreate(true); }}>创建群聊</div>
                <div style={{ padding: '11px 16px', fontSize: 14, cursor: 'pointer', borderTop: '1px solid var(--line)' }} onClick={() => { setShowPlusMenu(false); setShowJoin(true); }}>加入群聊</div>
              </div>
            </>
          )}
        </span>
      </div>

      {/* 搜索：点了弹全屏搜索框 */}
      <div className="cl-search" onClick={() => setShowSearch(true)}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        搜索
        <span className="cl-scan" title="扫一扫" onClick={(e) => { e.stopPropagation(); setShowScan(true); }}>
          <ScanIcon size={17} color="currentColor" />
        </span>
      </div>

      {/* AI 助手 / 音乐固定置顶，其余按最新消息时间排 */}
      {fixedRow(AI_ICON, 'AI 助手', '有问必答，随便问', '免费', () => nav('/ai-chat'))}
      {fixedRow(MUSIC_ICON, '音乐', 'DJ 热曲 · 情感音乐，边聊边听', '每日上新', () => setShowMusic(true))}

      {entries.map((e) => {
        if (e.kind === 'notice') {
          const meta = NOTICE_META[e.key];
          return (
            <div key={`n-${e.key}`} className="cl-row" onClick={() => nav(`/notices/${e.key}`)}>
              <div className="cl-icon" style={{ background: meta.grad }}>{meta.icon}</div>
              <div className="cl-row-main">
                <div className="cl-row-top">
                  <span className="cl-row-title ellipsis">{meta.title}</span>
                  <span className="small">{timeText(e.at)}</span>
                </div>
                <div className="cl-row-sub">
                  <span className="ellipsis">{e.s.last?.title}</span>
                  {e.s.unread > 0 && <span className="cs-badge">{e.s.unread > 99 ? '99+' : e.s.unread}</span>}
                </div>
              </div>
            </div>
          );
        }
        const c = e.conv;
        const title = (c.type === 1 ? c.peer?.nickname : c.group?.name) ?? '';
        const avatar = c.type === 1 ? c.peer?.avatar : c.group?.avatar;
        const targetId = (c.type === 1 ? c.peer?.id : c.group?.id) ?? '';
        return (
          <div key={c.id} className="cl-row" onClick={() => openConv({ id: c.id, type: c.type, targetId, title })}>
            <div className="avatar" style={{ width: 54, height: 54 }}>
              {avatar && <img src={avatar} alt="" />}
            </div>
            <div className="cl-row-main">
              <div className="cl-row-top">
                <span className="cl-row-title ellipsis">
                  {title}
                  {c.type === 2 && <span className="cs-tag">群</span>}
                </span>
                <span className="small">{timeText(c.lastMsgAt)}</span>
              </div>
              <div className="cl-row-sub">
                <span className="ellipsis">{previewText(c.lastMsg)}</span>
                {c.unread > 0 && <span className="cs-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
              </div>
            </div>
          </div>
        );
      })}
      {entries.length === 0 && <div className="empty">暂无消息{'\n'}去广场或大厅找人打招呼吧</div>}

      {showSearch && (
        <ChatSearch
          convs={convs}
          extras={searchExtras}
          onClose={() => setShowSearch(false)}
          onOpenConv={(c) => { setShowSearch(false); openConv(c); }}
          onOpenUser={async (id, nickname) => {
            setShowSearch(false);
            try {
              const r = await api<{ conversationId: string }>(`/im/conversations/open/${id}`, { method: 'POST' });
              openConv({ id: r.conversationId, type: 1, targetId: id, title: nickname });
            } catch (e: any) {
              alert(e.message);
            }
          }}
          onScan={() => { setShowSearch(false); setShowScan(true); }}
        />
      )}
      {showScan && <ScanFlow onClose={() => setShowScan(false)} />}

      {showCreate && (
        <CreateGroupSheet
          onClose={() => setShowCreate(false)}
          onCreated={(convId, name, groupId) => {
            setShowCreate(false);
            if (openNativeChat(convId, 2, groupId, `${name}（群）`)) return;
            nav(`/chatroom/${convId}`, { state: { title: `${name}（群）`, convType: 2, targetId: groupId } });
          }}
        />
      )}

      {showMusic && <MusicSheet onClose={() => setShowMusic(false)} />}

      {showJoin && (
        <JoinGroupSheet
          onClose={() => setShowJoin(false)}
          onJoined={(convId, name, groupId) => {
            setShowJoin(false);
            if (openNativeChat(convId, 2, groupId, `${name}（群）`)) return;
            nav(`/chatroom/${convId}`, { state: { title: `${name}（群）`, convType: 2, targetId: groupId } });
          }}
        />
      )}
    </>
  );
}

/** 评论 / 接单通知列表（消息页里的系统会话点进来），拉取即已读 */
export function NoticesPage() {
  const nav = useNavigate();
  const kind: NoticeKind = useParams().kind === 'task' ? 'task' : 'comment';
  const [list, setList] = useState<NotificationItem[] | null>(null);

  useEffect(() => {
    api<NotificationItem[]>(`/notifications?kind=${kind}`).then(setList).catch(() => setList([]));
  }, [kind]);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">{NOTICE_META[kind].title}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar">
        {list === null && <div className="empty">加载中…</div>}
        {list?.length === 0 && <div className="empty">{kind === 'comment' ? '暂无评论消息' : '暂无接单消息'}</div>}
        {(list ?? []).map((n) => (
          <div
            key={n.id}
            style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
            onClick={() => nav(kind === 'comment' ? `/moment/${n.refId}` : `/task/${n.refId}`)}
          >
            <div className="row">
              <span className="grow" style={{ fontSize: 15, fontWeight: n.isRead ? 400 : 600 }}>{n.title}</span>
              <span className="small">{timeText(n.createdAt)}</span>
            </div>
            {n.body && <div className="muted ellipsis" style={{ marginTop: 3 }}>{n.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
