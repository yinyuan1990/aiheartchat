import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { useApp } from '../store';
import { t } from '../i18n';

/** 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号 */
export function RealnamePage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [name, setName] = useState('');
  const [idCard, setIdCard] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api('/user/realname', { method: 'POST', body: { name: name.trim(), idCard } });
      const u = await api<UserProfile>('/user/me');
      setUser(u);
      showToast(t('realname.success'));
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('realname.title')}</span>
        <span style={{ width: 40 }} />
      </div>

      <div className="page page-pad">
        {me?.realname ? (
          <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '40px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{t('realname.done')}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>{t('realname.verifiedName', { name: me.realNameMasked ?? '' })}</div>
          </div>
        ) : (
          <>
            <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: 18 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{t('realname.name')}</div>
              <input
                value={name}
                maxLength={20}
                placeholder={t('realname.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                style={{
                  width: '100%', background: 'var(--bg-input, rgba(255,255,255,0.06))', border: 'none', outline: 'none',
                  color: 'var(--text)', fontSize: 16, padding: 12, borderRadius: 10, marginBottom: 14,
                }}
              />
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{t('realname.idCardNo')}</div>
              <input
                value={idCard}
                maxLength={18}
                placeholder={t('realname.idCardPlaceholder')}
                onChange={(e) => setIdCard(e.target.value.toUpperCase().replace(/[^0-9X]/g, '').slice(0, 18))}
                style={{
                  width: '100%', background: 'var(--bg-input, rgba(255,255,255,0.06))', border: 'none', outline: 'none',
                  color: 'var(--text)', fontSize: 16, padding: 12, borderRadius: 10,
                }}
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                {t('realname.privacy')}
              </p>
            </div>
            <button
              className="btn"
              style={{ marginTop: 20 }}
              disabled={busy || name.trim().length < 2 || idCard.length !== 18}
              onClick={submit}
            >
              {busy ? t('realname.submitting') : t('realname.submit')}
            </button>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
