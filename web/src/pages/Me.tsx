import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import { api, fmtPoints, UserProfile } from '../api';
import { useApp } from '../store';
import { JoinGroupSheet } from './ChatList';

/** 从扫码结果里提取群邀请码（兼容 peiwan://group?code=xxx 和纯码） */
function parseGroupCode(text: string): string | null {
  const m = text.match(/code=([A-Za-z0-9]{6,12})/);
  if (m) return m[1].toUpperCase();
  const t = text.trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(t) ? t : null;
}

export function MePage() {
  const nav = useNavigate();
  const { user, setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(user);
  const [scanning, setScanning] = useState(false);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanStopRef = useRef<() => void>(() => {});

  useEffect(() => {
    api<UserProfile>('/user/me').then((u) => {
      setMe(u);
      setUser(u);
    }).catch(() => {});
  }, []);

  useEffect(() => () => scanStopRef.current(), []);

  const stopScan = () => {
    scanStopRef.current();
    setScanning(false);
  };

  /** 扫一扫：群邀请码 → 加入群聊；收款码 → 提示去转赠页 */
  const startScan = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { alert('当前环境不支持相机'); return; }
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      let running = true;
      scanStopRef.current = () => {
        running = false;
        stream.getTracks().forEach((t) => t.stop());
      };

      const tick = () => {
        if (!running) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code?.data) {
            stopScan();
            if (code.data.includes('pay?sid=')) {
              alert('这是收款码，请到「积分明细 - 转赠」里扫码使用');
            } else {
              const c = parseGroupCode(code.data);
              if (c) setJoinCode(c);
              else alert('无法识别的二维码');
            }
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      setScanning(false);
      alert('无法打开相机，请检查权限');
    }
  };

  if (!me) return <div className="empty">加载中…</div>;

  return (
    <div className="no-scrollbar" style={{ overflowY: 'auto', height: '100%' }}>
      {/* 顶部渐变背景 */}
      <div style={{ background: 'linear-gradient(180deg, rgba(254,44,85,0.14), transparent 85%)', padding: '28px 20px 0' }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 76, height: 76, border: '2px solid rgba(255,255,255,0.15)' }}>
            {me.avatar ? <img src={me.avatar} alt="" /> : null}
          </div>
          <div className="grow" style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 21, fontWeight: 700 }}>{me.nickname}</div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <span style={{
                padding: '2px 10px', borderRadius: 10, fontSize: 11,
                background: me.gender === 1 ? 'rgba(64,156,255,0.18)' : 'rgba(254,44,85,0.18)',
                color: me.gender === 1 ? '#6db3ff' : '#ff7a95',
              }}>
                {me.gender === 1 ? '男' : '女'} {me.age}
              </span>
              {me.isGuide && <span className="tag tag-accent">认证</span>}
              {me.cityName && <span className="tag tag-muted">{me.cityName}</span>}
            </div>
            {me.shortId && (
              <div
                className="small"
                style={{ marginTop: 6, cursor: 'pointer' }}
                onClick={() => navigator.clipboard?.writeText(me.shortId!)}
              >
                ID：{me.shortId}（点击复制）
              </div>
            )}
          </div>
          {/* 扫一扫（扫群邀请二维码加群） */}
          <div
            title="扫一扫"
            onClick={startScan}
            style={{
              width: 38, height: 38, borderRadius: 19, flexShrink: 0, marginTop: 4,
              background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text)" strokeWidth="2.2" strokeLinecap="round">
              <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" />
              <path d="M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8" />
              <path d="M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16" />
              <path d="M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
              <path d="M5 12h14" />
            </svg>
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6 }}>
          {me.signature || '还没有签名，写一句介绍自己吧'}
        </div>

        {/* 关注 / 粉丝：点击进列表 */}
        <div className="row" style={{ gap: 26, marginTop: 16 }}>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/following')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.following ?? 0}</b>关注
          </span>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/fans')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.fans ?? 0}</b>粉丝
          </span>
        </div>

        {/* 积分余额：融合进头部（玻璃质感行，点击进钱包） */}
        <div
          onClick={() => nav('/wallet')}
          style={{
            margin: '16px 0 18px', borderRadius: 14, padding: '12px 16px', cursor: 'pointer',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(254,44,85,0.25)',
            display: 'flex', alignItems: 'center',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>积分余额</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--accent)' }}>{fmtPoints(me.balance)}</div>
          </div>
          <div style={{ textAlign: 'right', color: 'var(--text-2)' }}>
            <div style={{ fontSize: 11 }}>冻结 {fmtPoints(me.frozen)}</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>明细 ›</div>
          </div>
        </div>
      </div>

      {/* 菜单分组 */}
      <div className="card" style={{ margin: '14px 16px 0', padding: '4px 0' }}>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/edit-profile')}>编辑资料</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/my-moments')}>我的动态</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/follow-moments')}>关注动态</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/task/mine')}>{me.gender === 2 ? '我的接单' : '我的约单'}</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/gifts-received')}>收到的礼物</div>
      </div>
      {/* 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名） */}
      {!me.isGuide && (
        <div className="card" style={{ margin: '10px 16px 24px', padding: '4px 0' }}>
          <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/guide-apply')}>搭子认证</div>
        </div>
      )}

      {/* 扫一扫全屏取景 */}
      {scanning && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 290 }}>
          <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <div
            style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-60%)',
              width: 230, height: 230, border: '2px solid var(--accent)', borderRadius: 14,
            }}
          />
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: '22%', textAlign: 'center', color: '#fff', fontSize: 13 }}>
            对准群邀请二维码
          </div>
          <div
            style={{
              position: 'absolute', top: 16, right: 16, width: 36, height: 36, borderRadius: 18,
              background: 'rgba(0,0,0,0.4)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
            onClick={stopScan}
          >
            ✕
          </div>
        </div>
      )}

      {/* 扫到群邀请码 → 加入群聊 */}
      {joinCode && (
        <JoinGroupSheet
          initialCode={joinCode}
          onClose={() => setJoinCode(null)}
          onJoined={(convId, name, groupId) => {
            setJoinCode(null);
            nav(`/chatroom/${convId}`, { state: { title: `${name}（群）`, convType: 2, targetId: groupId } });
          }}
        />
      )}
    </div>
  );
}
