import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtPoints, toFen } from '../api';
import { useApp } from '../store';
import { CityPickerSheet } from '../components/CityPicker';
import { locateCity } from '../cities';
import { wsManager } from '../ws';
import { lang, t } from '../i18n';

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
  0: [t('task.status.pending'), 'tag-warn'],
  1: [t('task.status.ongoing'), 'tag-success'],
  2: [t('task.status.completed'), 'tag-muted'],
  3: [t('task.status.cancelled'), 'tag-muted'],
  4: [t('task.status.arbitrating'), 'tag-accent'],
};

function StatusTag({ status }: { status: number }) {
  const [text, cls] = statusText[status] ?? [t('task.status.unknown'), 'tag-muted'];
  return <span className={`tag ${cls}`}>{text}</span>;
}

function TaskCard({ t: task, onClick }: { t: TaskItem; onClick?: () => void }) {
  return (
    <div className="card" style={{ margin: '0 16px 8px', cursor: 'pointer' }} onClick={onClick}>
      <div className="row">
        <div className="grow">
          <div style={{ fontSize: 16, fontWeight: 600 }}>{task.title} <StatusTag status={task.status} /></div>
          <div className="muted" style={{ marginTop: 6 }}>
            {new Date(task.meetAt).toLocaleString(lang() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {task.cityName} · {task.address}
          </div>
          <div className="small" style={{ marginTop: 4 }}>{t('task.card.applyCount', { n: task.applyCount })}</div>
        </div>
        <div className="accent" style={{ fontSize: 20, fontWeight: 700 }}>{fmtPoints(task.reward)}<span style={{ fontSize: 11 }}> {t('task.pointsUnit')}</span></div>
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
      alert(t('task.post.incomplete'));
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
      alert(t('task.post.success'));
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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('task.post.title')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar page-pad">
        {/* 做什么 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{t('task.post.what')}</div>
          <input
            value={form.title}
            maxLength={60}
            placeholder={t('task.post.whatPlaceholder')}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 16, padding: 0 }}
          />
        </div>

        {/* 时间 + 位置 卡片 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, marginBottom: 10 }}>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">{t('task.post.time')}</span>
            <input
              type="datetime-local"
              value={form.meetAt}
              onChange={(e) => setForm({ ...form, meetAt: e.target.value })}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: form.meetAt ? 'var(--text)' : 'var(--text-3)', fontSize: 15, textAlign: 'right', colorScheme: 'dark' }}
            />
          </div>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => setShowCity(true)}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">{t('task.post.city')}</span>
            <span className="grow" style={{ textAlign: 'right', fontSize: 15, color: form.cityName ? 'var(--text)' : 'var(--text-3)' }}>{form.cityName || t('task.post.pickCity')}</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>›</span>
          </div>
          <div className="row" style={{ padding: '14px' }}>
            <span style={{ fontSize: 14, width: 56 }} className="muted">{t('task.post.place')}</span>
            <input
              value={form.address}
              maxLength={200}
              placeholder={t('task.post.placePlaceholder')}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 15, textAlign: 'right' }}
            />
          </div>
        </div>

        {/* 报酬 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: '14px', marginBottom: 16 }}>
          <div className="row">
            <span style={{ fontSize: 14 }} className="muted grow">{t('task.post.reward')}</span>
            <input
              inputMode="numeric"
              value={form.reward}
              placeholder="500"
              onChange={(e) => setForm({ ...form, reward: e.target.value.replace(/\D/g, '') })}
              style={{ width: 120, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accent)', fontSize: 22, fontWeight: 700, textAlign: 'right' }}
            />
          </div>
        </div>

        <button className="btn" disabled={busy} onClick={submit}>{busy ? t('task.post.submitting') : t('task.post.submit')}</button>
        <p className="hint">{t('task.post.hint')}</p>
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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('task.hall.title')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page" style={{ paddingTop: 8 }}>
        {error && <div className="empty">{error}</div>}
        {!error && items.length === 0 && <div className="empty">{t('task.hall.empty')}</div>}
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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{me?.gender === 2 ? t('me.myTasksGuide') : t('me.myTasks')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page" style={{ paddingTop: 8 }}>
        {items.length === 0 && <div className="empty">{t('task.mine.empty')}</div>}
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

  if (!detail) return <div className="app"><div className="empty">{t('common.loading')}</div></div>;

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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('task.detail.title')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page page-pad">
        <div className="card">
          <div style={{ fontSize: 17, fontWeight: 600 }}>{detail.title} <StatusTag status={detail.status} /></div>
          <div className="muted mt12">{t('task.detail.time', { time: new Date(detail.meetAt).toLocaleString('zh-CN') })}</div>
          <div className="muted">{t('task.detail.place', { city: detail.cityName, address: detail.address })}</div>
          <div className="muted">{t('task.detail.rewardLabel')}<span className="accent" style={{ fontWeight: 700 }}>{t('task.pointsN', { n: fmtPoints(detail.reward) })}</span>{t('task.detail.escrowed')}</div>
          {detail.detail && <div className="muted mt12">{detail.detail}</div>}
        </div>

        {/* 女生：报名 */}
        {me?.gender === 2 && detail.status === 0 && (
          <div className="card">
            <label className="label">{t('task.detail.applyMsg')}</label>
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('task.detail.applyPlaceholder')} />
            <button className="btn" onClick={async () => {
              try {
                await api(`/tasks/${id}/apply`, { method: 'POST', body: { message } });
                alert(t('task.detail.applied'));
              } catch (e: any) { alert(e.message); }
            }}>{t('task.detail.apply')}</button>
          </div>
        )}

        {/* 发单人：报名列表 + 操作 */}
        {detail.isOwner && (
          <>
            {detail.status === 0 && (
              <div className="card">
                <div className="muted" style={{ marginBottom: 10 }}>{t('task.detail.applicants', { n: detail.applies?.length ?? 0 })}</div>
                {(detail.applies ?? []).map((a: any) => (
                  <div key={a.id} className="row" style={{ marginBottom: 12 }}>
                    <div className="avatar" style={{ width: 42, height: 42 }}>
                      {a.user?.avatar && <img src={a.user.avatar} alt="" />}
                    </div>
                    <div className="grow">
                      <div>{a.user?.nickname} <span className="muted">· {a.user?.age}</span></div>
                      {a.message && <div className="small">{a.message}</div>}
                    </div>
                    {a.status === 0 && <button className="btn-sm" onClick={() => act(`/tasks/${id}/choose/${a.id}`, t('task.detail.chooseConfirm', { name: a.user?.nickname ?? '' }))}>{t('task.detail.choose')}</button>}
                    {a.status === 1 && <span className="tag tag-success">{t('task.detail.chosen')}</span>}
                  </div>
                ))}
                <button className="btn-ghost btn mt12" onClick={() => act(`/tasks/${id}/cancel`, t('task.detail.cancelConfirm'))}>{t('task.detail.cancel')}</button>
              </div>
            )}
            {detail.status === 1 && (
              <button className="btn mt12" onClick={() => act(`/tasks/${id}/finish`, t('task.detail.finishConfirm'))}>{t('task.detail.finish')}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
