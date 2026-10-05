import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';
import { t } from '../i18n';

/** 从扫码结果里提取群邀请码（兼容 peiwan://group?code=xxx 和纯码） */
export function parseGroupCode(text: string): string | null {
  const m = text.match(/code=([A-Za-z0-9]{6,12})/);
  if (m) return m[1].toUpperCase();
  const t = text.trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(t) ? t : null;
}

/** 从扫码结果里提取邀请名片码（名片二维码内容 https://域名/t/?u=短号） */
export function parseInviteCode(text: string): string | null {
  if (!text.includes('/t/')) return null;
  const m = text.match(/[?&]u=(\d{1,19})/);
  return m ? m[1] : null;
}

/**
 * 看起来像链上钱包地址或收款链接（0x / EIP-681、Solana、波场 T…、TON、solana: / tron: / ton:// 链接）。
 * 和 App 里的判断一样；网页版没有钱包，只提示去 App 里转账。
 */
export function looksLikeWalletPayment(text: string): boolean {
  const t = text.trim();
  return (
    /^(ethereum|solana|tron|ton|tonkeeper):/i.test(t) ||
    t.startsWith('https://app.tonkeeper.com/transfer/') ||
    /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.test(t) ||
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) ||
    /^[A-Za-z0-9_+/-]{48}$/.test(t) ||
    /^-?[01]:[0-9a-fA-F]{64}$/.test(t)
  );
}

/**
 * 识别一张图片里的二维码（聊天大图「识别二维码」）。图片在 /res/ 下，同一台服务器对哪个域名都转发 /res/，
 * 所以换成本站同源的地址去取，不受跨域限制（canvas 才能读像素）。
 */
export async function decodeQrFromImage(src: string): Promise<string | null> {
  let url = src;
  try {
    const u = new URL(src, location.href);
    if (u.origin !== location.origin && u.pathname.startsWith('/res/')) url = location.origin + u.pathname + u.search;
  } catch {}
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
}

/** 全屏相机取景（getUserMedia + jsQR），识别到二维码即回调并关闭相机 */
export function QrScanner({ hint, onResult, onClose }: { hint: string; onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onResult, onClose });
  cb.current = { onResult, onClose };

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert(t('qr.noCamera'));
      cb.current.onClose();
      return;
    }
    let running = true;
    let stream: MediaStream | null = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const tick = () => {
      const video = videoRef.current;
      if (!running || !video) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code?.data) {
          running = false;
          cb.current.onResult(code.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(async (s) => {
      stream = s;
      if (!running) { s.getTracks().forEach((t) => t.stop()); return; }
      const video = videoRef.current!;
      video.srcObject = s;
      await video.play();
      requestAnimationFrame(tick);
    }).catch(() => {
      alert(t('qr.cameraDenied'));
      cb.current.onClose();
    });

    return () => {
      running = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 290 }}>
      <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div
        style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-60%)',
          width: 230, height: 230, border: '2px solid var(--accent)', borderRadius: 14,
        }}
      />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: '22%', textAlign: 'center', color: '#fff', fontSize: 13 }}>
        {hint}
      </div>
      <div
        style={{
          position: 'absolute', top: 16, right: 16, width: 36, height: 36, borderRadius: 18,
          background: 'rgba(0,0,0,0.4)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
        onClick={onClose}
      >
        ✕
      </div>
    </div>
  );
}

/** 扫一扫图标（四角取景框 + 中线） */
export function ScanIcon({ size = 18, color = 'var(--text)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" />
      <path d="M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8" />
      <path d="M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
      <path d="M5 12h14" />
    </svg>
  );
}
