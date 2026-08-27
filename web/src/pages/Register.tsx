import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getDeviceId, setToken, UserProfile } from '../api';
import { useApp } from '../store';

const AGES = Array.from({ length: 43 }, (_, i) => 18 + i); // 18 - 60
const ITEM_H = 44;

/** iOS 风格单列滚轮选择器 */
function AgeWheel({ value, onConfirm, onClose }: { value: number | null; onConfirm: (age: number) => void; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(value ?? 22);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const idx = AGES.indexOf(value ?? 22);
    scrollRef.current?.scrollTo({ top: Math.max(idx, 0) * ITEM_H });
  }, []);

  const onScroll = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      const idx = Math.min(AGES.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM_H)));
      setCurrent(AGES[idx]);
      el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
    }, 80);
  };

  return (
    <div className="mask bottom" onClick={onClose}>
      <div className="sheet" style={{ padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ padding: '14px 16px' }}>
          <span className="muted" style={{ cursor: 'pointer', fontSize: 15 }} onClick={onClose}>取消</span>
          <span className="grow" style={{ textAlign: 'center', fontWeight: 600 }}>年纪</span>
          <span className="accent" style={{ cursor: 'pointer', fontSize: 15 }} onClick={() => onConfirm(current)}>确定</span>
        </div>
        <div style={{ position: 'relative', height: ITEM_H * 5 }}>
          {/* 中间选中带 */}
          <div style={{
            position: 'absolute', top: ITEM_H * 2, left: 16, right: 16, height: ITEM_H,
            borderRadius: 10, background: 'var(--bg-input)', pointerEvents: 'none',
          }} />
          {/* 上下渐隐 */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2, background: 'linear-gradient(to bottom, var(--bg-card) 0%, transparent 35%, transparent 65%, var(--bg-card) 100%)' }} />
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="no-scrollbar"
            style={{ height: '100%', overflowY: 'auto', scrollSnapType: 'y mandatory', position: 'relative', zIndex: 1 }}
          >
            <div style={{ height: ITEM_H * 2 }} />
            {AGES.map((a) => (
              <div
                key={a}
                style={{
                  height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  scrollSnapAlign: 'center',
                  fontSize: a === current ? 20 : 16,
                  fontWeight: a === current ? 600 : 400,
                  color: a === current ? 'var(--text)' : 'var(--text-3)',
                  transition: 'font-size 0.12s, color 0.12s',
                }}
              >
                {a}
              </div>
            ))}
            <div style={{ height: ITEM_H * 2 }} />
          </div>
        </div>
        <div style={{ height: 'env(safe-area-inset-bottom)' }} />
      </div>
    </div>
  );
}

/** 一机一号注册：头像+昵称+年纪+性别，无密码 */
export function RegisterPage() {
  const nav = useNavigate();
  const setUser = useApp((s) => s.setUser);
  const [nickname, setNickname] = useState('');
  const [age, setAge] = useState<number | null>(null);
  const [gender, setGender] = useState<1 | 2 | 0>(0);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const [showAge, setShowAge] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!avatarFile) return setError('请选择头像');
    if (!nickname.trim()) return setError('请填写昵称');
    if (!age) return setError('请选择年纪');
    if (!gender) return setError('请选择性别');
    setLoading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', avatarFile);
      const uploadRes = await fetch('/api/upload/avatar', { method: 'POST', body: form });
      const uploadJson = await uploadRes.json();
      if (uploadJson.code !== 0) throw new Error(uploadJson.msg || '头像上传失败');

      const r = await api<{ token: string; user: UserProfile }>('/auth/register', {
        method: 'POST',
        body: { deviceId: getDeviceId(), nickname: nickname.trim(), age, gender, avatar: uploadJson.data.url },
      });
      setToken(r.token);
      setUser(r.user);
      nav('/plaza', { replace: true });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <div className="page page-pad" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', fontSize: 28, fontWeight: 700, letterSpacing: 6, marginBottom: 30 }}>心之音</div>

        {/* 头像 */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
          <div className="avatar" style={{ width: 88, height: 88, cursor: 'pointer', border: '1px solid var(--line)' }} onClick={() => fileRef.current?.click()}>
            {avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="small">点击选择头像</span>}
          </div>
          <input
            ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setAvatarFile(f);
              setAvatarPreview(f ? URL.createObjectURL(f) : '');
            }}
          />
        </div>

        {/* 昵称 */}
        <input className="input" value={nickname} maxLength={30} placeholder="昵称" onChange={(e) => setNickname(e.target.value)} />

        {/* 年纪：选择器 */}
        <div className="input row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => setShowAge(true)}>
          <span style={{ color: age ? 'var(--text)' : 'var(--text-3)' }}>{age ? `${age} 岁` : '年纪'}</span>
          <span className="muted">›</span>
        </div>

        {/* 性别：小巧胶囊 */}
        <div className="row" style={{ justifyContent: 'center', gap: 14, margin: '6px 0 4px' }}>
          {([[1, '男'], [2, '女']] as const).map(([v, label]) => (
            <span
              key={v}
              onClick={() => setGender(v)}
              style={{
                padding: '8px 30px', borderRadius: 18, fontSize: 14, cursor: 'pointer',
                background: gender === v ? 'var(--accent-grad)' : 'var(--bg-input)',
                color: gender === v ? '#fff' : 'var(--text-2)',
                fontWeight: gender === v ? 600 : 400,
              }}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="small" style={{ textAlign: 'center', marginBottom: 8 }}>性别注册后不可修改</div>

        {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}

        <button className="btn mt12" disabled={loading} onClick={submit}>{loading ? '创建中…' : '进入'}</button>
        <p className="hint">无需密码，账号与本机自动绑定，卸载重装自动恢复</p>
        <p className="hint" style={{ marginTop: 6 }}>
          本平台仅限年满 18 周岁用户使用，注册即代表您已满 18 周岁并同意
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/user')}>《用户协议》</span>
          与
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => nav('/agreement/privacy')}>《隐私政策》</span>
        </p>
      </div>

      {/* 年纪：iOS 滚轮 */}
      {showAge && (
        <AgeWheel
          value={age}
          onConfirm={(a) => { setAge(a); setShowAge(false); }}
          onClose={() => setShowAge(false)}
        />
      )}
    </div>
  );
}
