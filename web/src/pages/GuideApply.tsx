import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { t } from '../i18n';

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
      alert(t('guide.fillAll'));
      return;
    }
    setBusy(true);
    try {
      await api('/guide/apply', { method: 'POST', body: form });
      alert(t('guide.submitted'));
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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('me.guideApply')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page page-pad">
        {existing?.status === 0 && <div className="card" style={{ textAlign: 'center' }}>{t('guide.reviewing')}</div>}
        {existing?.status === 2 && <div className="card" style={{ textAlign: 'center', color: 'var(--danger)' }}>{t('guide.rejected', { reason: existing.rejectReason || t('guide.notApproved') })}</div>}
        {existing?.status !== 0 && (
          <>
            <p className="hint" style={{ marginTop: 0 }}>{t('guide.applyHint')}</p>
            <label className="label">{t('realname.name')}</label>
            <input className="input" value={form.realName} onChange={(e) => setForm({ ...form, realName: e.target.value })} />
            <label className="label">{t('realname.idCardNo')}</label>
            <input className="input" value={form.idCardNo} onChange={(e) => setForm({ ...form, idCardNo: e.target.value })} />
            <label className="label">{t('guide.intro')}</label>
            <textarea className="input" value={form.intro} maxLength={500} placeholder={t('guide.introPlaceholder')} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
            <button className="btn mt12" disabled={busy} onClick={submit}>{t('realname.submit')}</button>
          </>
        )}
      </div>
    </div>
  );
}
