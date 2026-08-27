import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtPoints, toFen } from '../api';
import { useApp } from '../store';
import { CityPickerSheet } from '../components/CityPicker';
import { locateCity } from '../cities';
import { wsManager } from '../ws';

/** 收到接单类推送时触发刷新 */
function useTaskRealtime(reload: () => void) {
  useEffect(() => {
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'notify' && frame.event === 'task') reload();
    });
  }, [reload]);
}

interface TaskItem {
  id: string;
  owner?: { id: string; nickname: string; avatar: string; age: number };
  title: string;
  detail: string;
  meetAt: string;
  cityName: string;
  address: string;
  reward: string;
  status: number;
  applyCount: number;
  myApplyStatus?: number;
}

const statusText: Record<number, [string, string]> = {
  0: ['待接单', 'tag-warn'],
  1: ['进行中', 'tag-success'],
  2: ['已完成', 'tag-muted'],
  3: ['已取消', 'tag-muted'],
  4: ['仲裁中', 'tag-accent'],
};

function StatusTag({ status }: { status: number }) {
  const [text, cls] = statusText[status] ?? ['未知', 'tag-muted'];
  return <span className={`tag ${cls}`}>{text}</span>;
}

function TaskCard({ t, onClick }: { t: TaskItem; onClick?: () => void }) {
  return (
    <div className="card" style={{ margin: '0 16px 8px', cursor: 'pointer' }} onClick={onClick}>
      <div className="row">
        <div className="grow">
          <div style={{ fontSize: 16, fontWeight: 600 }}>{t.title} <StatusTag status={t.status} /></div>
          <div className="muted" style={{ marginTop: 6 }}>
            {new Date(t.meetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {t.cityName} · {t.address}
          </div>
          <div className="small" style={{ marginTop: 4 }}>{t.applyCount} 人已报名</div>
        </div>
        <div className="accent" style={{ fontSize: 20, fontWeight: 700 }}>{fmtPoints(t.reward)}<span style={{ fontSize: 11 }}> 积分</span></div>
      </div>
    </div>
  );
}

/** 发布约单（男）：做什么 / 时间 / 位置 / 报酬，简单明了 */
export function TaskPostPage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ title: '', meetAt: '', cityName: '', address: '', reward: '' });
  const [busy, setBusy] = useState(false);
  const [showCity, setShowCity] = useState(false);

  useEffect(() => {
    locateCity().then((city) => {
      if (city) setForm((prev) => (prev.cityName ? prev : { ...prev, cityName: city }));
    });
  }, []);

  const submit = async () => {
    if (!form.title || !form.meetAt || !form.cityName || !form.address || !form.reward) {
      alert('请填写完整信息');
      return;
    }
    setBusy(true);
    try {
      await api('/tasks', {
        method: 'POST',
        body: {
          ...form,
          reward: String(toFen(form.reward)),
          cityCode: form.cityName,
          meetAt: new Date(form.meetAt).toISOString(),
        },
      });
      alert('发布成功，报酬已托管，已推送给同城用户');
      nav('/task/mine', { replace: true });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">发布约单</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar page-pad">
        {/* 做什么 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>做什么</div>
          <input
            value={form.title}
            maxLength={60}
            placeholder="如：周末陪逛展、看电影、吃火锅"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 16, padding: 0 }}
          />
        </div>

        {/* 时间 + 位置 卡片 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, marginBottom: 10 }}>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">时间</span>
            <input
              type="datetime-local"
              value={form.meetAt}
              onChange={(e) => setForm({ ...form, meetAt: e.target.value })}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: form.meetAt ? 'var(--text)' : 'var(--text-3)', fontSize: 15, textAlign: 'right', colorScheme: 'dark' }}
            />
          </div>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => setShowCity(true)}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">城市</span>
            <span className="grow" style={{ textAlign: 'right', fontSize: 15, color: form.cityName ? 'var(--text)' : 'var(--text-3)' }}>{form.cityName || '选择城市'}</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>›</span>
          </div>
          <div className="row" style={{ padding: '14px' }}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">地点</span>
            <input
              value={form.address}
              maxLength={200}
              placeholder="如：市民中心地铁站 A 口"
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 15, textAlign: 'right' }}
            />
          </div>
        </div>

        {/* 报酬 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '14px', marginBottom: 16 }}>
          <div className="row">
            <span style={{ fontSize: 14 }} className="muted grow">报酬（积分）</span>
            <input
              inputMode="numeric"
              value={form.reward}
              placeholder="500"
              onChange={(e) => setForm({ ...form, reward: e.target.value.replace(/\D/g, '') })}
              style={{ width: 120, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accent)', fontSize: 22, fontWeight: 700, textAlign: 'right' }}
            />
          </div>
        </div>

        <button className="btn" disabled={busy} onClick={submit}>{busy ? '提交中…' : '托管发布'}</button>
        <p className="hint">报酬冻结托管，完成后打给对方；发布后自动推送给同城用户</p>
      </div>
      {showCity && (
        <CityPickerSheet
          current={form.cityName}
          onClose={() => setShowCity(false)}
          onSelect={(city) => { setForm({ ...form, cityName: city }); setShowCity(false); }}
        />
      )}
    </div>
  );
}

/** 接单大厅（女） */
export function TaskHallPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<TaskItem[]>([]);
  const [error, setError] = useState('');

  const load = () => api<TaskItem[]>('/tasks/hall').then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useTaskRealtime(load);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">接单大厅</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page" style={{ paddingTop: 8 }}>
        {error && <div className="empty">{error}</div>}
        {!error && items.length === 0 && <div className="empty">暂无可接约单</div>}
        {items.map((t) => <TaskCard key={t.id} t={t} onClick={() => nav(`/task/${t.id}`)} />)}
      </div>
    </div>
  );
}

/** 我的约单（男看发布 / 女看接单） */
export function TaskMinePage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [items, setItems] = useState<TaskItem[]>([]);

  const load = () => {
    const path = me?.gender === 2 ? '/tasks/taken' : '/tasks/mine';
    api<TaskItem[]>(path).then(setItems).catch(() => {});
  };
  useEffect(load, [me?.gender]);
  useTaskRealtime(load);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">{me?.gender === 2 ? '我的接单' : '我的约单'}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page" style={{ paddingTop: 8 }}>
        {items.length === 0 && <div className="empty">暂无记录</div>}
        {items.map((t) => <TaskCard key={t.id} t={t} onClick={() => nav(`/task/${t.id}`)} />)}
      </div>
    </div>
  );
}

/** 约单详情：女可报名；男（发单人）可选人/完成/取消 */
export function TaskDetailPage() {
  const nav = useNavigate();
  const { id } = useParams<{ id: string }>();
  const me = useApp((s) => s.user);
  const [detail, setDetail] = useState<any>(null);
  const [message, setMessage] = useState('');

  const load = () => api<any>(`/tasks/${id}`).then(setDetail).catch(() => {});
  useEffect(() => { load(); }, [id]);
  useTaskRealtime(load);

  if (!detail) return <div className="app"><div className="empty">加载中…</div></div>;

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api(path, { method: 'POST' });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">约单详情</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page page-pad">
        <div className="card">
          <div style={{ fontSize: 17, fontWeight: 600 }}>{detail.title} <StatusTag status={detail.status} /></div>
          <div className="muted mt12">时间：{new Date(detail.meetAt).toLocaleString('zh-CN')}</div>
          <div className="muted">地点：{detail.cityName} · {detail.address}</div>
          <div className="muted">报酬：<span className="accent" style={{ fontWeight: 700 }}>{fmtPoints(detail.reward)} 积分</span>（已托管）</div>
          {detail.detail && <div className="muted mt12">{detail.detail}</div>}
        </div>

        {/* 女生：报名 */}
        {me?.gender === 2 && detail.status === 0 && (
          <div className="card">
            <label className="label">报名留言（可选）</label>
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="介绍一下自己" />
            <button className="btn" onClick={async () => {
              try {
                await api(`/tasks/${id}/apply`, { method: 'POST', body: { message } });
                alert('报名成功，等待对方选择');
              } catch (e: any) { alert(e.message); }
            }}>报名接单</button>
          </div>
        )}

        {/* 发单人：报名列表 + 操作 */}
        {detail.isOwner && (
          <>
            {detail.status === 0 && (
              <div className="card">
                <div className="muted" style={{ marginBottom: 10 }}>报名列表（{detail.applies?.length ?? 0}）</div>
                {(detail.applies ?? []).map((a: any) => (
                  <div key={a.id} className="row" style={{ marginBottom: 12 }}>
                    <div className="avatar" style={{ width: 42, height: 42 }}>
                      {a.user?.avatar && <img src={a.user.avatar} alt="" />}
                    </div>
                    <div className="grow">
                      <div>{a.user?.nickname} <span className="muted">· {a.user?.age}</span></div>
                      {a.message && <div className="small">{a.message}</div>}
                    </div>
                    {a.status === 0 && <button className="btn-sm" onClick={() => act(`/tasks/${id}/choose/${a.id}`, `确定选择 ${a.user?.nickname} 接单？`)}>选TA</button>}
                    {a.status === 1 && <span className="tag tag-success">已选中</span>}
                  </div>
                ))}
                <button className="btn-ghost btn mt12" onClick={() => act(`/tasks/${id}/cancel`, '确定取消？托管报酬将退回')}>取消约单</button>
              </div>
            )}
            {detail.status === 1 && (
              <button className="btn mt12" onClick={() => act(`/tasks/${id}/finish`, '确认完成？托管报酬将打给对方')}>确认完成并结算</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
