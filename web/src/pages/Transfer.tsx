import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { api, fmtPoints, toFen } from '../api';
import { useApp } from '../store';

/** 收款码内容格式：peiwan://pay?sid=6位ID */
const payQrContent = (sid: string) => `peiwan://pay?sid=${sid}`;

/** 从扫码结果里提取 6 位 ID（兼容 peiwan://pay?sid=xxx 和纯数字） */
function parsePaySid(text: string): string | null {
  const m = text.match(/sid=(\d{6})/);
  if (m) return m[1];
  const digits = text.replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

/** 积分转赠：输入 6 位 ID → 确认对方 → 输入积分 → 转赠 */
export function TransferPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [balance, setBalance] = useState('0');
  const [shortId, setShortId] = useState('');
  const [target, setTarget] = useState<{ shortId: string; nickname: string; avatar: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [myQr, setMyQr] = useState('');
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanStopRef = useRef<() => void>(() => {});

  useEffect(() => {
    api<any>('/wallet').then((w) => setBalance(w.balance)).catch(() => {});
  }, []);

  useEffect(() => () => scanStopRef.current(), []);

  const showMyQr = async () => {
    if (!me?.shortId) return;
    setMyQr(await QRCode.toDataURL(payQrContent(me.shortId), { width: 460, margin: 1 }));
  };

  const stopScan = () => {
    scanStopRef.current();
    setScanning(false);
  };

  const startScan = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return showToast('当前环境不支持相机');
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
            const sid = parsePaySid(code.data);
            stopScan();
            if (sid) {
              setShortId(sid);
              lookup(sid);
            } else {
              showToast('无法识别的二维码');
            }
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      setScanning(false);
      showToast('无法打开相机，请检查权限');
    }
  };

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(''), 2000);
  };

  const lookup = async (id: string) => {
    setTarget(null);
    if (!/^\d{6}$/.test(id)) return;
    try {
      setTarget(await api(`/wallet/lookup/${id}`));
    } catch {
      showToast('未找到该 ID');
    }
  };

  const submit = async () => {
    if (!target) return showToast('请先输入正确的对方 ID');
    const fen = toFen(amount);
    if (fen <= 0) return showToast('请输入转赠积分');
    if (fen > Number(balance)) return showToast('余额不足');
    setBusy(true);
    try {
      await api('/wallet/transfer', {
        method: 'POST',
        body: { toShortId: target.shortId, amountFen: String(fen), remark: remark.trim() },
      });
      showToast('转赠成功');
      setTimeout(() => nav(-1), 800);
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
        <span className="title">积分转赠</span>
        <span style={{ width: 40 }} />
      </div>

      <div className="page no-scrollbar page-pad">
        {/* 收款人卡：大号居中输入 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '18px', marginBottom: 14, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>对方 ID</div>
          <input
            value={shortId}
            inputMode="numeric"
            maxLength={6}
            placeholder="6 位数字"
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setShortId(v);
              lookup(v);
            }}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text)', fontSize: 30, fontWeight: 600, letterSpacing: 8, textAlign: 'center', padding: '6px 0',
            }}
          />
          <div style={{ height: 1, background: 'var(--line)', margin: '0 40px 12px' }} />
          {target ? (
            <div className="row" style={{ gap: 10, justifyContent: 'flex-start' }}>
              <div className="avatar" style={{ width: 40, height: 40 }}>
                {target.avatar && <img src={target.avatar} alt="" />}
              </div>
              <span style={{ fontSize: 15, fontWeight: 500 }}>{target.nickname}</span>
              <span className="grow" />
              <span style={{ fontSize: 12, color: '#0bd07d' }}>● 已确认</span>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              {shortId.length === 6 ? '正在查找…' : '输入对方的 6 位 ID 自动确认收款人'}
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <span style={{ flex: 1, color: 'var(--accent)', fontSize: 13, cursor: 'pointer' }} onClick={startScan}>扫一扫</span>
            <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
            <span style={{ flex: 1, color: 'var(--accent)', fontSize: 13, cursor: 'pointer' }} onClick={showMyQr}>我的收款码</span>
          </div>
        </div>

        {/* 金额卡：大号居中金额 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '18px', marginBottom: 14, textAlign: 'center' }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>转赠积分</div>
          <input
            value={amount}
            inputMode="decimal"
            placeholder="0"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--accent)', fontSize: 40, fontWeight: 700, textAlign: 'center', padding: '4px 0',
            }}
          />
          <div style={{ height: 1, background: 'var(--line)', margin: '0 40px 10px' }} />
          <div className="muted" style={{ fontSize: 12 }}>
            可用余额 {fmtPoints(balance)}
            <span style={{ color: 'var(--accent)', marginLeft: 8, cursor: 'pointer' }} onClick={() => setAmount(fmtPoints(balance))}>全部</span>
          </div>
        </div>

        {/* 备注 */}
        <div style={{ background: 'var(--bg-card)', borderRadius: 14, padding: '14px 18px', marginBottom: 20 }}>
          <input
            value={remark}
            maxLength={50}
            placeholder="留言（可选）"
            onChange={(e) => setRemark(e.target.value)}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14, padding: 0 }}
          />
        </div>

        <button className="btn" disabled={busy || !target || toFen(amount) <= 0} onClick={submit}>{busy ? '转赠中…' : '确认转赠'}</button>
        {me?.shortId && (
          <p className="hint" style={{ textAlign: 'center' }}>我的 ID：{me.shortId}（告诉对方即可互转）</p>
        )}
      </div>

      {/* 我的收款码 */}
      {myQr && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setMyQr('')}
        >
          <div
            style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, textAlign: 'center', width: 300 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>我的收款码</div>
            <div className="muted" style={{ fontSize: 13, margin: '4px 0 14px' }}>ID：{me?.shortId}</div>
            <img src={myQr} alt="收款二维码" style={{ width: 230, height: 230, borderRadius: 10, background: '#fff', padding: 8 }} />
            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>使用「积分转赠 - 扫一扫」扫码给我转积分</div>
            <div className="row" style={{ gap: 12, marginTop: 14, justifyContent: 'center' }}>
              <span
                style={{ width: 100, padding: '9px 0', borderRadius: 20, background: 'rgba(255,255,255,0.08)', fontSize: 14, cursor: 'pointer' }}
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = myQr;
                  a.download = `收款码_${me?.shortId ?? ''}.png`;
                  a.click();
                }}
              >
                保存
              </span>
              <span
                style={{ width: 100, padding: '9px 0', borderRadius: 20, background: 'var(--accent)', color: '#fff', fontSize: 14, cursor: 'pointer' }}
                onClick={async () => {
                  try {
                    const blob = await (await fetch(myQr)).blob();
                    const file = new File([blob], 'qr.png', { type: 'image/png' });
                    if (navigator.canShare?.({ files: [file] })) {
                      await navigator.share({ files: [file], title: '我的收款码' });
                    } else {
                      showToast('当前环境不支持分享，请使用保存');
                    }
                  } catch {}
                }}
              >
                分享
              </span>
            </div>
            <div className="muted" style={{ fontSize: 14, marginTop: 12, cursor: 'pointer' }} onClick={() => setMyQr('')}>关闭</div>
          </div>
        </div>
      )}

      {/* 扫一扫 */}
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
            对准对方的收款二维码
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

      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
