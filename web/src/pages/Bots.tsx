import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { openNativeChat } from '../bridge';
import { wsManager } from '../ws';
import { openLink } from '../components/LinkText';

/** 机器人（Telegram 式）：用户创建，第三方程序用兼容 Telegram 的 Bot API 收发消息 */

export interface InlineButton { text: string; url?: string; callback_data?: string }
export interface InlineMarkup { inline_keyboard: InlineButton[][] }
export interface BotCommand { command: string; description: string }
export interface BotPublic { id: string; username: string; name: string; avatar: string; description: string; commands: BotCommand[]; ownerId: string }

interface MyBot {
  id: string; username: string; name: string; avatar: string; description: string;
  privacy: boolean; commands: BotCommand[]; webhookUrl: string; status: number; createdAt: string;
  pendingUpdates?: number; lastError?: string; lastErrorAt?: string | null;
}

export function flashToast(text: string) {
  const el = document.createElement('div');
  el.className = 'bot-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

/** 机器人公开资料：同一会话里多个组件要用，按 id 缓存 */
const infoCache = new Map<string, Promise<BotPublic | null>>();
export function botInfo(key: string): Promise<BotPublic | null> {
  if (!infoCache.has(key)) infoCache.set(key, api<BotPublic>(`/im/bot/info/${encodeURIComponent(key)}`).catch(() => null));
  return infoCache.get(key)!;
}

/** 打开和机器人的私聊 */
export async function openBotChat(nav: ReturnType<typeof useNavigate>, botId: string, name: string) {
  const r = await api<{ conversationId: string }>(`/im/conversations/open/${botId}`, { method: 'POST' });
  if (openNativeChat(r.conversationId, 1, botId, name)) return;
  nav(`/chatroom/${r.conversationId}`, { state: { title: name, convType: 1, targetId: botId, isBot: true } });
}

interface CallbackAnswer { queryId: string; text: string; showAlert: boolean; url: string }

/** 机器人的回应可能比 /im/bot/callback 的 HTTP 响应先到，先缓存起来再按 queryId 认领 */
const answers = new Map<string, CallbackAnswer>();
const answerWaiters = new Map<string, (a: CallbackAnswer) => void>();
wsManager.on((f) => {
  if (f.op !== 'bot_callback_answer' || !f.data?.queryId) return;
  const a = f.data as CallbackAnswer;
  const w = answerWaiters.get(a.queryId);
  if (w) { answerWaiters.delete(a.queryId); w(a); return; }
  answers.set(a.queryId, a);
  setTimeout(() => answers.delete(a.queryId), 30_000);
});

function showAnswer(a: CallbackAnswer) {
  if (a.url) openLink(a.url);
  if (a.text) a.showAlert ? alert(a.text) : flashToast(a.text);
}

/** 消息下面的内联按钮：url 按钮直接打开；回调按钮发给机器人，机器人 answerCallbackQuery 后弹提示 */
export function InlineKeyboard({ markup, messageId }: { markup?: InlineMarkup | null; messageId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const waitRef = useRef<{ queryId: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => () => {
    if (waitRef.current) { answerWaiters.delete(waitRef.current.queryId); clearTimeout(waitRef.current.timer); }
  }, []);

  const rows = markup?.inline_keyboard?.filter((r) => r?.length) ?? [];
  if (!rows.length || messageId.startsWith('t_')) return null;

  const done = () => {
    if (waitRef.current) { answerWaiters.delete(waitRef.current.queryId); clearTimeout(waitRef.current.timer); waitRef.current = null; }
    setBusy(null);
  };

  const press = async (b: InlineButton, key: string) => {
    if (b.url) {
      openLink(b.url);
      return;
    }
    if (!b.callback_data || busy) return;
    setBusy(key);
    try {
      const { queryId } = await api<{ queryId: string }>('/im/bot/callback', { method: 'POST', body: { messageId, data: b.callback_data } });
      const early = answers.get(queryId);
      if (early) {
        answers.delete(queryId);
        setBusy(null);
        showAnswer(early);
        return;
      }
      answerWaiters.set(queryId, (a) => { done(); showAnswer(a); });
      // 机器人没回应也别一直转圈（Telegram 也是超时后自动停）
      waitRef.current = { queryId, timer: setTimeout(done, 10_000) };
    } catch (e: any) {
      flashToast(e.message || '机器人没有响应');
      setBusy(null);
    }
  };

  return (
    <div className="bot-kb">
      {rows.map((row, i) => (
        <div key={i} className="bot-kb-row">
          {row.map((b, j) => {
            const key = `${i}-${j}`;
            return (
              <span key={key} className={`bot-kb-btn${busy === key ? ' busy' : ''}`} onClick={() => press(b, key)} title={b.url || ''}>
                {busy === key ? '…' : b.text}
                {b.url && <span className="ext">↗</span>}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 群 / 频道里管理机器人：按用户名添加（可从我的机器人里点选），已加入的可移出 */
export function AddBotSheet({ groupId, channel, onClose, onChanged }: { groupId: string; channel?: boolean; onClose: () => void; onChanged?: () => void }) {
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [inChat, setInChat] = useState<{ id: string; nickname: string; avatar: string }[]>([]);
  const [mine, setMine] = useState<MyBot[]>([]);
  const [saving, setSaving] = useState(false);

  const load = () => api<any>(`/im/group/${groupId}`)
    .then((g) => setInChat((g.members ?? []).filter((m: any) => m.isBot)))
    .catch(() => {});
  useEffect(() => {
    load();
    api<MyBot[]>('/im/bots').then((l) => setMine(l.filter((b) => b.status === 0))).catch(() => {});
  }, [groupId]);

  const add = async (name: string) => {
    const u = name.trim().replace(/^@/, '');
    if (!u) return;
    setSaving(true);
    try {
      await api(`/im/group/${groupId}/bot`, { method: 'POST', body: { username: u } });
      setUsername('');
      flashToast('已添加');
      load();
      onChanged?.();
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };
  const remove = async (b: { id: string; nickname: string }) => {
    if (!confirm(`把机器人「${b.nickname}」移出${channel ? '频道' : '群'}？`)) return;
    try {
      await api(`/im/group/${groupId}/kick/${b.id}`, { method: 'POST' });
      load();
      onChanged?.();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const inIds = new Set(inChat.map((b) => b.id));
  return (
    <div className="mask bottom" style={{ zIndex: 150 }} onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="sheet no-scrollbar" style={{ maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 6 }}>{channel ? '频道机器人' : '群机器人'}</div>
        <div className="small" style={{ textAlign: 'center', marginBottom: 14 }}>
          {channel ? '机器人在频道里是管理员，可以发帖，能收到所有帖子' : '机器人默认只收到 /命令 和 @它 的消息（创建者可关闭隐私模式）'}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" style={{ marginBottom: 0 }} placeholder="机器人用户名，如 @weather_bot" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(username)} />
          <button className="btn-sm" disabled={saving} onClick={() => add(username)}>添加</button>
        </div>

        {inChat.length > 0 && <div className="small" style={{ margin: '16px 0 6px' }}>已加入</div>}
        {inChat.map((b) => (
          <div key={b.id} className="row" style={{ padding: '8px 0', gap: 10 }}>
            <div className="avatar" style={{ width: 36, height: 36 }}>{b.avatar && <img src={b.avatar} alt="" />}</div>
            <span className="grow ellipsis">{b.nickname}<span className="bot-tag">机器人</span></span>
            <span className="small" style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => remove(b)}>移出</span>
          </div>
        ))}

        {mine.filter((b) => !inIds.has(b.id)).length > 0 && <div className="small" style={{ margin: '16px 0 6px' }}>我的机器人</div>}
        {mine.filter((b) => !inIds.has(b.id)).map((b) => (
          <div key={b.id} className="row" style={{ padding: '8px 0', gap: 10 }}>
            <div className="avatar" style={{ width: 36, height: 36 }}>{b.avatar && <img src={b.avatar} alt="" />}</div>
            <span className="grow ellipsis">{b.name} <span className="small">@{b.username}</span></span>
            <span className="accent" style={{ cursor: 'pointer', fontSize: 13 }} onClick={() => add(b.username)}>添加</span>
          </div>
        ))}
        <div className="small" style={{ marginTop: 16, textAlign: 'center', cursor: 'pointer' }} onClick={() => nav('/bots')}>创建自己的机器人 ›</div>
      </div>
    </div>
  );
}

/** token 只在创建 / 重置时返回一次 */
function TokenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'left' }}>
        <h3 style={{ textAlign: 'center' }}>机器人 Token</h3>
        <p className="small" style={{ marginBottom: 8 }}>只显示这一次，请马上保存。拿到 token 就能控制这个机器人，不要泄露；泄露了就去重置。</p>
        <div className="bot-code" style={{ userSelect: 'all' }}>{token}</div>
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(token); flashToast('已复制'); }}>复制 Token</button>
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onClose}>我已保存</button>
      </div>
    </div>
  );
}

function CreateBotSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (b: MyBot & { token: string }) => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      onCreated(await api<MyBot & { token: string }>('/im/bots', { method: 'POST', body: { name: name.trim(), username: username.trim(), description: desc.trim() } }));
    } catch (e: any) {
      alert(e.message);
    }
    setSaving(false);
  };
  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 14 }}>创建机器人</div>
        <input className="input" placeholder="名称（聊天里显示的名字）" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="用户名，必须以 bot 结尾，如 weather_bot" maxLength={32} value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
        <textarea className="input" style={{ height: 80, resize: 'none' }} placeholder="简介（用户第一次打开聊天时看到）" maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <button className="btn" disabled={saving || !name.trim() || !username.trim()} onClick={submit}>{saving ? '创建中…' : '创建'}</button>
      </div>
    </div>
  );
}

/** 我的机器人 /bots */
export function BotsPage() {
  const nav = useNavigate();
  const [list, setList] = useState<MyBot[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(MyBot & { token: string }) | null>(null);

  const load = () => api<MyBot[]>('/im/bots').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">我的机器人</span>
        <span className="action" onClick={() => setCreating(true)}>创建</span>
      </div>
      <div className="page no-scrollbar">
        <div className="small" style={{ padding: '12px 16px', lineHeight: 1.6 }}>
          机器人可以接入你自己的程序：用 Telegram 兼容的 Bot API 收发消息、发图片、带按钮，能私聊、进群、在频道发帖。
          现有的 Telegram 机器人代码改一下接口地址就能直接用。
        </div>
        {list === null && <div className="empty">加载中…</div>}
        {list?.length === 0 && (
          <div className="empty" style={{ paddingTop: 40 }}>
            还没有机器人
            <div><button className="btn-sm" style={{ marginTop: 16 }} onClick={() => setCreating(true)}>创建第一个机器人</button></div>
          </div>
        )}
        {(list ?? []).map((b) => (
          <div key={b.id} className="cl-row" onClick={() => nav(`/bots/${b.id}`)}>
            <div className="avatar" style={{ width: 48, height: 48 }}>{b.avatar && <img src={b.avatar} alt="" />}</div>
            <div className="cl-row-main">
              <div className="cl-row-top">
                <span className="cl-row-title ellipsis">{b.name}<span className="bot-tag">机器人</span></span>
                {b.status !== 0 && <span className="tag tag-warn">已封禁</span>}
              </div>
              <div className="cl-row-sub"><span className="ellipsis">@{b.username} · {b.webhookUrl ? 'Webhook' : 'getUpdates'}</span></div>
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateBotSheet onClose={() => setCreating(false)} onCreated={(b) => { setCreating(false); setCreated(b); load(); }} />}
      {created && <TokenDialog token={created.token} onClose={() => { const id = created.id; setCreated(null); nav(`/bots/${id}`); }} />}
    </div>
  );
}

/** 机器人详情 /bots/:id：资料、隐私模式、接收状态、token、接入说明 */
export function BotDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [bot, setBot] = useState<MyBot | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [token, setToken] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api<MyBot>(`/im/bots/${id}`).then((b) => { setBot(b); setName(b.name); setDesc(b.description); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  const save = async (body: Record<string, unknown>) => {
    try {
      await api(`/im/bots/${id}`, { method: 'PUT', body });
      infoCache.delete(id);
      setEditing(false);
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };
  const changeAvatar = async (file?: File) => {
    if (!file) return;
    try {
      await save({ avatar: await uploadFile('image', file) });
    } catch (e: any) {
      alert(e.message || '上传失败');
    }
  };
  const reset = async () => {
    if (!confirm('重置后旧 token 立即失效，正在运行的程序要换成新 token。确定重置？')) return;
    try {
      setToken((await api<{ token: string }>(`/im/bots/${id}/token`, { method: 'POST' })).token);
    } catch (e: any) {
      alert(e.message);
    }
  };
  const remove = async () => {
    if (!confirm(`删除机器人 @${bot?.username}？会退出所有群和频道，不能恢复`)) return;
    try {
      await api(`/im/bots/${id}/delete`, { method: 'POST' });
      nav('/bots', { replace: true });
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (error) return <div className="app"><div className="navbar"><span className="back" onClick={() => nav(-1)}>‹</span><span className="title">机器人</span></div><div className="empty">{error}</div></div>;
  if (!bot) return <div className="empty">加载中…</div>;

  const apiBase = `${location.origin}/api`;
  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">{bot.name}</span>
        <span className="action" onClick={() => openBotChat(nav, bot.id, bot.name).catch((e) => alert(e.message))}>聊天</span>
      </div>
      <div className="page no-scrollbar" style={{ padding: '16px 16px 40px' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="avatar" style={{ width: 76, height: 76, margin: '0 auto', cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>
            {bot.avatar && <img src={bot.avatar} alt="" />}
          </div>
          <div className="small" style={{ marginTop: 4, fontSize: 11 }}>点头像可修改</div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => changeAvatar(e.target.files?.[0])} />
          {editing ? (
            <div style={{ marginTop: 12 }}>
              <input className="input" value={name} maxLength={30} placeholder="名称" onChange={(e) => setName(e.target.value)} />
              <textarea className="input" style={{ height: 90, resize: 'none' }} value={desc} maxLength={500} placeholder="简介" onChange={(e) => setDesc(e.target.value)} />
              <div className="row">
                <button className="btn-sm ghost" onClick={() => setEditing(false)}>取消</button>
                <span className="grow" />
                <button className="btn-sm" onClick={() => save({ name: name.trim(), description: desc.trim() })}>保存</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 19, fontWeight: 700, marginTop: 8 }}>{bot.name}<span className="bot-tag">机器人</span></div>
              <div className="small" style={{ marginTop: 4 }}>@{bot.username}{bot.status !== 0 && <span className="tag tag-warn" style={{ marginLeft: 6 }}>已被平台封禁</span>}</div>
              <div style={{ fontSize: 14, marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{bot.description || <span className="small">（无简介）</span>}</div>
              <span className="accent" style={{ fontSize: 13, cursor: 'pointer', display: 'inline-block', marginTop: 8 }} onClick={() => setEditing(true)}>编辑资料</span>
            </>
          )}
        </div>

        <div className="card" style={{ marginTop: 16, padding: '4px 14px' }}>
          <div className="row" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="grow">
              <div style={{ fontSize: 15 }}>群隐私模式</div>
              <div className="small" style={{ marginTop: 2 }}>开启：群里只收到 /命令 和 @它 的消息；关闭：收到全部群消息</div>
            </div>
            <span className={`ch-sub-btn${bot.privacy ? '' : ' on'}`} style={{ cursor: 'pointer' }} onClick={() => save({ privacy: !bot.privacy })}>{bot.privacy ? '已开启' : '已关闭'}</span>
          </div>
          <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: 15 }}>接收方式</div>
            <div className="small" style={{ marginTop: 2, wordBreak: 'break-all' }}>
              {bot.webhookUrl ? `Webhook：${bot.webhookUrl}` : 'getUpdates 轮询（没有设置 Webhook）'} · 待取消息 {bot.pendingUpdates ?? 0} 条
            </div>
            {bot.lastError && <div className="small" style={{ marginTop: 4, color: 'var(--danger)' }}>最近一次推送失败：{bot.lastError}</div>}
          </div>
          <div style={{ padding: '12px 0' }}>
            <div style={{ fontSize: 15 }}>命令菜单</div>
            <div className="small" style={{ marginTop: 2 }}>
              {bot.commands.length ? bot.commands.map((c) => `/${c.command} ${c.description}`).join('\n') : '还没设置，程序里调用 setMyCommands 设置'}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12, padding: '4px 14px' }}>
          <div className="ch-menu" onClick={reset}>重置 Token</div>
          <div className="ch-menu" style={{ color: 'var(--danger)', borderBottom: 'none' }} onClick={remove}>删除机器人</div>
        </div>

        <div style={{ marginTop: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>接入说明</div>
          <div className="small" style={{ lineHeight: 1.7 }}>
            接口和 Telegram Bot API 一样，只是地址换成我们的：<br />
            <b>{apiBase}/bot&lt;token&gt;/方法名</b><br />
            支持 getMe、getUpdates、setWebhook、deleteWebhook、getWebhookInfo、sendMessage、sendPhoto、editMessageText、
            editMessageReplyMarkup、deleteMessage、answerCallbackQuery、setMyCommands、getChat、getFile 等。
            按钮只支持 inline_keyboard（url / callback_data）。chat_id：私聊是用户 id，群和频道是负数。
            用户要先给机器人发过消息，机器人才能私聊他。
          </div>
          <div className="small" style={{ marginTop: 10 }}>命令行试一下：</div>
          <div className="bot-code">{`curl ${apiBase}/bot<token>/getUpdates

curl -X POST ${apiBase}/bot<token>/sendMessage \\
  -H 'Content-Type: application/json' \\
  -d '{"chat_id": 用户id, "text": "你好", "reply_markup": {"inline_keyboard": [[{"text": "点我", "callback_data": "hi"}]]}}'`}</div>
          <div className="small">Python（python-telegram-bot）：</div>
          <div className="bot-code">{`app = (Application.builder().token(TOKEN)
       .base_url("${apiBase}/bot")
       .base_file_url("${apiBase}/file/bot")
       .build())`}</div>
          <div className="small">Node.js（Telegraf）：</div>
          <div className="bot-code">{`const bot = new Telegraf(TOKEN, { telegram: { apiRoot: '${location.origin}/api' } })`}</div>
          <div className="small">Webhook 需要 https 公网地址；设置 secret_token 后每次推送都会带 X-Telegram-Bot-Api-Secret-Token 头。</div>
        </div>
      </div>
      {token && <TokenDialog token={token} onClose={() => setToken('')} />}
    </div>
  );
}
