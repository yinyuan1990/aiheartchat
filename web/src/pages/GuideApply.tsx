import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export function GuideApplyPage() {
  const nav = useNavigate();
  const [existing, setExisting] = useState<any>(null);
  const [form, setForm] = useState({ realName: '', idCardNo: '', intro: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any>('/guide/apply/mine').then(setExisting).catch(() => {});
  }, []);

  const submit = async () => {
    if (!form.realName || !form.idCardNo || !form.intro) {
      alert('请填写完整');
      return;
    }
    setBusy(true);
    try {
      await api('/guide/apply', { method: 'POST', body: form });
      alert('已提交，等待审核');
      nav(-1);
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
        <span className="title">搭子认证</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page page-pad">
        {existing?.status === 0 && <div className="card" style={{ textAlign: 'center' }}>申请审核中，请耐心等待</div>}
        {existing?.status === 2 && <div className="card" style={{ textAlign: 'center', color: 'var(--danger)' }}>上次申请被拒绝：{existing.rejectReason || '未通过'}，可重新提交</div>}
        {existing?.status !== 0 && (
          <>
            <p className="hint" style={{ marginTop: 0 }}>认证需提交真实姓名与身份证号，审核通过即同时完成实名认证</p>
            <label className="label">真实姓名</label>
            <input className="input" value={form.realName} onChange={(e) => setForm({ ...form, realName: e.target.value })} />
            <label className="label">身份证号</label>
            <input className="input" value={form.idCardNo} onChange={(e) => setForm({ ...form, idCardNo: e.target.value })} />
            <label className="label">自我介绍</label>
            <textarea className="input" value={form.intro} maxLength={500} placeholder="介绍自己的城市、兴趣爱好和擅长的活动" onChange={(e) => setForm({ ...form, intro: e.target.value })} />
            <button className="btn mt12" disabled={busy} onClick={submit}>提交认证</button>
          </>
        )}
      </div>
    </div>
  );
}
