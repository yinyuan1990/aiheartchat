import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { wsManager } from '../ws';

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

type Tab = 'single' | 'group' | 'comment' | 'task';

function previewText(msg?: ConversationItem['lastMsg']): string {
  if (!msg) return '';
  switch (msg.type) {
    case 'text': return msg.content.slice(0, 30);
    case 'image': return '[图片]';
    case 'video': return '[视频]';
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
  const [people, setPeople] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<any[]>('/guide/discover').then(setPeople).catch(() => {});
  }, []);

  const create = async () => {
    if (!name.trim()) {
      alert('请填写群名');
      return;
    }
    try {
      const g = await api<any>('/im/group', { method: 'POST', body: { name: name.trim(), memberIds: [...selected] } });
      onCreated(g.conversationId, g.name, g.id);
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet no-scrollbar" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', marginBottom: 12, fontWeight: 600 }}>创建群聊</div>
        <input className="input" placeholder="群名称" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        <div className="muted" style={{ margin: '4px 0 10px' }}>邀请成员（可选）</div>
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

export function ChatListPage() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('single');
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [notices, setNotices] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [showCreate, setShowCreate] = useState(false);

  const loadConvs = () => api<ConversationItem[]>('/im/conversations').then(setConvs).catch(() => {});
  const loadUnread = () => api<Record<string, number>>('/notifications/unread').then(setUnread).catch(() => {});
  const loadNotices = (kind: string) => api<NotificationItem[]>(`/notifications?kind=${kind}`).then((list) => {
    setNotices(list);
    loadUnread();
  }).catch(() => {});

  useEffect(() => {
    loadConvs();
    loadUnread();
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'msg') loadConvs();
      if (frame.op === 'notify') loadUnread();
    });
  }, []);

  useEffect(() => {
    if (tab === 'comment' || tab === 'task') loadNotices(tab);
  }, [tab]);

  const singleUnread = convs.filter((c) => c.type === 1).reduce((s, c) => s + c.unread, 0);
  const groupUnread = convs.filter((c) => c.type === 2).reduce((s, c) => s + c.unread, 0);

  const tabs: { key: Tab; label: string; badge: number }[] = [
    { key: 'single', label: '私聊', badge: singleUnread },
    { key: 'group', label: '群聊', badge: groupUnread },
    { key: 'comment', label: '评论', badge: unread.comment ?? 0 },
    { key: 'task', label: '接单', badge: unread.task ?? 0 },
  ];

  const shownConvs = convs.filter((c) => (tab === 'single' ? c.type === 1 : c.type === 2));

  return (
    <>
      {/* 头部：胶囊分类 + 建群按钮 */}
      <div className="row" style={{ padding: '14px 16px 12px', gap: 8 }}>
        {tabs.map((t) => (
          <span
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              position: 'relative',
              padding: '7px 16px',
              borderRadius: 17,
              fontSize: 14,
              cursor: 'pointer',
              background: tab === t.key ? 'var(--accent-grad)' : 'var(--bg-input)',
              color: tab === t.key ? '#fff' : 'var(--text-2)',
              fontWeight: tab === t.key ? 600 : 400,
              transition: 'background 0.15s',
            }}
          >
            {t.label}
            {t.badge > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                background: 'var(--accent)', color: '#fff', fontSize: 9,
                borderRadius: 8, padding: '1px 5px', fontWeight: 600,
                border: '2px solid var(--bg)',
              }}>
                {t.badge > 99 ? '99+' : t.badge}
              </span>
            )}
          </span>
        ))}
        <span className="grow" />
        <span
          onClick={() => setShowCreate(true)}
          title="发起群聊"
          style={{
            width: 34, height: 34, borderRadius: 17, flexShrink: 0,
            background: 'var(--bg-input)', color: 'var(--text)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, cursor: 'pointer',
          }}
        >+</span>
      </div>

      {/* 会话列表（私聊/群聊） */}
      {(tab === 'single' || tab === 'group') && (
        <>
          {/* AI 助手置顶入口（免费问答） */}
          {tab === 'single' && (
            <div className="row" style={{ padding: '10px 16px', cursor: 'pointer' }} onClick={() => nav('/ai-chat')}>
              <div style={{
                width: 48, height: 48, borderRadius: 24, flexShrink: 0,
                background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 15, fontWeight: 800, letterSpacing: 1,
              }}>AI</div>
              <div className="grow" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                <div className="row">
                  <span className="grow" style={{ fontSize: 15 }}>AI 助手</span>
                  <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 5px' }}>免费</span>
                </div>
                <div className="muted ellipsis" style={{ marginTop: 3 }}>有问必答，随便问</div>
              </div>
            </div>
          )}
          {/* 花边新闻置顶入口（每小时更新） */}
          {tab === 'single' && (
            <div className="row" style={{ padding: '10px 16px', cursor: 'pointer' }} onClick={() => nav('/news')}>
              <div style={{
                width: 48, height: 48, borderRadius: 24, flexShrink: 0,
                background: 'linear-gradient(135deg, #ff9500, #ff2c55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22,
              }}>📰</div>
              <div className="grow" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                <div className="row">
                  <span className="grow" style={{ fontSize: 15 }}>花边新闻</span>
                  <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 5px' }}>每小时更新</span>
                </div>
                <div className="muted ellipsis" style={{ marginTop: 3 }}>逆袭·励志·情感，看看别人的故事</div>
              </div>
            </div>
          )}
          {shownConvs.length === 0 && (
            <div className="empty">{tab === 'single' ? '暂无私聊\n去广场或大厅找人打招呼吧' : '暂无群聊\n点右上角发起群聊'}</div>
          )}
          {shownConvs.map((c) => {
            const title = c.type === 1 ? c.peer?.nickname : c.group?.name;
            const avatar = c.type === 1 ? c.peer?.avatar : c.group?.avatar;
            const targetId = c.type === 1 ? c.peer?.id : c.group?.id;
            return (
              <div
                key={c.id}
                className="row"
                style={{ padding: '10px 16px', cursor: 'pointer' }}
                onClick={() => nav(`/chatroom/${c.id}`, { state: { title, convType: c.type, targetId } })}
              >
                <div className="avatar" style={{ width: 48, height: 48 }}>
                  {avatar && <img src={avatar} alt="" />}
                </div>
                <div className="grow" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                  <div className="row">
                    <span className="grow ellipsis" style={{ fontSize: 15 }}>{title}</span>
                    <span className="small">{timeText(c.lastMsgAt)}</span>
                  </div>
                  <div className="row" style={{ marginTop: 3 }}>
                    <span className="muted grow ellipsis">{previewText(c.lastMsg)}</span>
                    {c.unread > 0 && (
                      <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: 9, fontSize: 10, padding: '1px 6px', fontWeight: 600 }}>{c.unread}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* 通知列表（评论/接单） */}
      {(tab === 'comment' || tab === 'task') && (
        <>
          {notices.length === 0 && (
            <div className="empty">{tab === 'comment' ? '暂无评论消息' : '暂无接单消息'}</div>
          )}
          {notices.map((n) => (
            <div
              key={n.id}
              style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
              onClick={() => nav(tab === 'comment' ? `/moment/${n.refId}` : `/task/${n.refId}`)}
            >
              <div className="row">
                <span className="grow" style={{ fontSize: 15, fontWeight: n.isRead ? 400 : 600 }}>{n.title}</span>
                <span className="small">{timeText(n.createdAt)}</span>
              </div>
              {n.body && <div className="muted ellipsis" style={{ marginTop: 3 }}>{n.body}</div>}
            </div>
          ))}
        </>
      )}

      {showCreate && (
        <CreateGroupSheet
          onClose={() => setShowCreate(false)}
          onCreated={(convId, name, groupId) => {
            setShowCreate(false);
            nav(`/chatroom/${convId}`, { state: { title: `${name}（群）`, convType: 2, targetId: groupId } });
          }}
        />
      )}
    </>
  );
}
