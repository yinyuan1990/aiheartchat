import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { useApp } from '../store';

/** 实名认证（仅女生）：姓名 + 身份证号，后端本地核验校验位，一证一号 */
export function RealnamePage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [name, setName] = useState('');
  const [idCard, setIdCard] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(''), 2000);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api('/user/realname', { method: 'POST', body: { name: name.trim(), idCard } });
      const u = await api<UserProfile>('/user/me');
      setUser(u);
      showToast('认证成功');
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">实名认证</span>
        <span style={{ width: 40 }} />
      </div>

      <div className="page page-pad">
        {me?.realname ? (
          <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '40px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>已完成实名认证</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>认证姓名：{me.realNameMasked}</div>
          </div>
        ) : (
          <>
            <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: 18 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>真实姓名</div>
              <input
                value={name}
                maxLength={20}
                placeholder="与身份证一致"
                onChange={(e) => setName(e.target.value)}
                style={{
                  width: '100%', background: 'var(--bg-input, rgba(255,255,255,0.06))', border: 'none', outline: 'none',
                  color: 'var(--text)', fontSize: 16, padding: 12, borderRadius: 10, marginBottom: 14,
                }}
              />
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>身份证号</div>
              <input
                value={idCard}
                maxLength={18}
                placeholder="18 位身份证号码"
                onChange={(e) => setIdCard(e.target.value.toUpperCase().replace(/[^0-9X]/g, '').slice(0, 18))}
                style={{
                  width: '100%', background: 'var(--bg-input, rgba(255,255,255,0.06))', border: 'none', outline: 'none',
                  color: 'var(--text)', fontSize: 16, padding: 12, borderRadius: 10,
                }}
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                信息仅用于身份核验，平台不对外展示。每个身份证号仅可认证一个账号。
              </p>
            </div>
            <button
              className="btn"
              style={{ marginTop: 20 }}
              disabled={busy || name.trim().length < 2 || idCard.length !== 18}
              onClick={submit}
            >
              {busy ? '提交中…' : '提交认证'}
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
