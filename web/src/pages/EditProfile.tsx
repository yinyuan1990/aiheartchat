import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints, toFen, uploadFile, UserProfile } from '../api';
import { useApp } from '../store';
import { CityPickerSheet } from '../components/CityPicker';

const AGES = Array.from({ length: 43 }, (_, i) => 18 + i);

export function EditProfilePage() {
  const nav = useNavigate();
  const { setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(null);
  const [nickname, setNickname] = useState('');
  const [age, setAge] = useState(18);
  const [cityName, setCityName] = useState('');
  const [signature, setSignature] = useState('');
  const [avatar, setAvatar] = useState('');
  const [showCity, setShowCity] = useState(false);
  const [showAge, setShowAge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoPrice, setVideoPrice] = useState('');
  // 平台手续费（分/分钟）= 流量成本 x 平台倍率，定价必须高于手续费
  const [feeCut, setFeeCut] = useState(4);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const wallRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<UserProfile>('/user/me').then((u) => {
      setMe(u);
      setNickname(u.nickname);
      setAge(u.age || 18);
      setCityName(u.cityName ?? '');
      setSignature(u.signature ?? '');
      setAvatar(u.avatar ?? '');
      if (u.videoPriceFen && u.videoPriceFen > 0) setVideoPrice(fmtPoints(u.videoPriceFen));
      setPhotos((u.albums ?? []).filter((a) => a.type === 1).map((a) => a.url));
      api<any>('/call/config').then((c) => {
        const base = c.videoBaseFenPerMin ?? 2;
        setFeeCut(base * (c.videoPlatformX ?? 2));
        // 未设置时默认价 = 成本 x5
        if (u.gender === 2 && !(u.videoPriceFen && u.videoPriceFen > 0)) setVideoPrice(fmtPoints(base * 5));
      }).catch(() => {});
    }).catch(() => {});
  }, []);

  const changeAvatar = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      setAvatar(await uploadFile('image', file));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  // 照片墙多选上传：超过剩余可加张数的部分自动截断
  const addWallPhotos = async (files: FileList | null) => {
    const remain = 8 - photos.length;
    if (!files || files.length === 0 || remain <= 0) return;
    const picked = Array.from(files).slice(0, remain);
    if (files.length > remain) alert(`最多 8 张，还可选 ${remain} 张，已自动保留前 ${remain} 张`);
    setUploadingPhoto(true);
    try {
      const urls: string[] = [];
      for (const file of picked) urls.push(await uploadFile('image', file));
      setPhotos((prev) => [...prev, ...urls].slice(0, 8));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploadingPhoto(false);
      if (wallRef.current) wallRef.current.value = '';
    }
  };

  const save = async () => {
    if (!nickname.trim()) return alert('昵称不能为空');
    if (me?.gender === 2 && videoPrice && toFen(videoPrice) <= feeCut) {
      return alert(`视频价格须高于平台手续费 ${fmtPoints(feeCut)} 积分/分钟`);
    }
    setBusy(true);
    try {
      const updated = await api<UserProfile>('/user/me', {
        method: 'PUT',
        body: {
          nickname: nickname.trim(),
          age,
          avatar,
          signature: signature.trim(),
          cityName,
          cityCode: cityName,
          ...(me?.gender === 2 ? { videoPriceFen: videoPrice ? toFen(videoPrice) : 0 } : {}),
        },
      });
      // 照片墙整组保存
      await api('/user/albums', { method: 'PUT', body: { photos } });
      setUser(updated);
      nav(-1);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!me) return <div className="app"><div className="empty">加载中…</div></div>;

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">编辑资料</span>
        <span className="action" onClick={save}>{busy ? '…' : '保存'}</span>
      </div>

      <div className="page no-scrollbar" style={{ padding: '16px' }}>
        {/* 头像 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ position: 'relative', cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>
            <div className="avatar" style={{ width: 92, height: 92 }}>
              {avatar ? <img src={avatar} alt="" /> : null}
            </div>
            <span style={{
              position: 'absolute', bottom: -2, left: '50%', transform: 'translateX(-50%)', fontSize: 10,
              background: 'rgba(0,0,0,0.55)', color: '#fff', padding: '2px 10px', borderRadius: 10, whiteSpace: 'nowrap',
            }}>更换</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>点击更换头像</div>
        </div>

        {/* 表单卡片 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12 }}>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 14, width: 64 }} className="muted">昵称</span>
            <input
              value={nickname}
              maxLength={30}
              onChange={(e) => setNickname(e.target.value)}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 15, textAlign: 'right' }}
            />
          </div>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => setShowAge(true)}>
            <span style={{ fontSize: 14, width: 64 }} className="muted">年纪</span>
            <span className="grow" style={{ textAlign: 'right', fontSize: 15 }}>{age} 岁</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>›</span>
          </div>
          <div className="row" style={{ padding: '14px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => setShowCity(true)}>
            <span style={{ fontSize: 14, width: 64 }} className="muted">城市</span>
            <span className="grow" style={{ textAlign: 'right', fontSize: 15, color: cityName ? 'var(--text)' : 'var(--text-3)' }}>{cityName || '选择'}</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>›</span>
          </div>
          {me.gender === 2 && (
            <div style={{ padding: '14px', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <span style={{ fontSize: 14 }} className="muted">视频价格</span>
                <span className="grow" />
                <input
                  inputMode="decimal"
                  value={videoPrice}
                  placeholder="须高于手续费"
                  onChange={(e) => setVideoPrice(e.target.value.replace(/[^\d.]/g, ''))}
                  style={{ width: 90, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 15, textAlign: 'right' }}
                />
                <span className="small" style={{ marginLeft: 4 }}>积分/分钟</span>
              </div>
              {/* 手续费提示：收入 = 价格 - 手续费 */}
              <div style={{ fontSize: 12, marginTop: 6, color: toFen(videoPrice) > feeCut ? 'var(--text-3)' : '#ff4d4f' }}>
                平台手续费 {fmtPoints(feeCut)} 积分/分钟，你的收入 {fmtPoints(Math.max(0, toFen(videoPrice) - feeCut))} 积分/分钟（价格须高于手续费）
              </div>
            </div>
          )}
          <div style={{ padding: '14px' }}>
            <div className="muted" style={{ fontSize: 14, marginBottom: 8 }}>签名</div>
            <textarea
              value={signature}
              maxLength={80}
              placeholder="介绍一下自己…"
              onChange={(e) => setSignature(e.target.value)}
              style={{ width: '100%', minHeight: 64, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14, lineHeight: 1.6, resize: 'none', padding: 0 }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'right' }}>{signature.length}/80</div>
          </div>
        </div>

        {/* 照片墙：最多 8 张，展示在个人主页 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 12, padding: 14, marginTop: 16 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 14 }}>照片墙</span>
            <span className="grow" />
            <span style={{ fontSize: 12, color: photos.length >= 8 ? 'var(--accent)' : 'var(--text-3)' }}>{photos.length}/8</span>
          </div>
          <div className="small" style={{ color: 'var(--text-3)', marginTop: 2 }}>
            {photos.length >= 8
              ? '已满 8 张，删除后可再添加 · 展示在你的个人主页'
              : `还可选 ${8 - photos.length} 张（支持多选）· 展示在你的个人主页`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 10 }}>
            {photos.map((u, i) => (
              <div key={`${u}_${i}`} style={{ position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-input)' }}>
                <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <span
                  onClick={() => setPhotos(photos.filter((_, idx) => idx !== i))}
                  style={{
                    position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%',
                    background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >✕</span>
              </div>
            ))}
            {photos.length < 8 && (
              <div
                onClick={() => !uploadingPhoto && wallRef.current?.click()}
                style={{
                  aspectRatio: '1', borderRadius: 10, background: 'var(--bg-input)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: 'var(--text-3)',
                }}
              >{uploadingPhoto ? '…' : '＋'}</div>
            )}
          </div>
        </div>

        <p className="hint">性别注册后不可修改</p>
      </div>

      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => changeAvatar(e.target.files)} />
      <input ref={wallRef} type="file" accept="image/*" multiple hidden onChange={(e) => addWallPhotos(e.target.files)} />

      {showCity && (
        <CityPickerSheet
          current={cityName}
          onClose={() => setShowCity(false)}
          onSelect={(city) => { setCityName(city); setShowCity(false); }}
        />
      )}

      {showAge && (
        <div className="mask bottom" onClick={() => setShowAge(false)}>
          <div className="sheet no-scrollbar" style={{ maxHeight: '46vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="muted" style={{ textAlign: 'center', marginBottom: 12 }}>选择年纪</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              {AGES.map((a) => (
                <div
                  key={a}
                  onClick={() => { setAge(a); setShowAge(false); }}
                  style={{
                    padding: '10px 0', textAlign: 'center', borderRadius: 10, fontSize: 14, cursor: 'pointer',
                    background: age === a ? 'var(--accent-grad)' : 'var(--bg-input)',
                    color: age === a ? '#fff' : 'var(--text)',
                  }}
                >
                  {a}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
