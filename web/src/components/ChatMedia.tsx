import { useEffect, useRef, useState } from 'react';
import { albumLayout } from '../album';
import { t } from '../i18n';

/** 正在上传 / 发送的本地图片的状态 */
export interface UploadState {
  /** 上传进度 0～1；传完等服务端确认时为 undefined */
  progress?: number;
  failed?: boolean;
}

/** 图片上盖的一层：上传中是进度圈，传完等确认时转圈，失败显示重试 */
export function UploadMask({ state, sending, onRetry }: { state?: UploadState; sending?: boolean; onRetry?: () => void }) {
  if (state?.failed) {
    return (
      <div className="up-mask no-menu" onClick={(e) => { e.stopPropagation(); onRetry?.(); }}>
        <span className="up-fail">!</span>
        <span className="up-tip">{t('chat.upload.retry')}</span>
      </div>
    );
  }
  const p = state?.progress;
  if (p === undefined && !sending) return null;
  const R = 17;
  const C = 2 * Math.PI * R;
  return (
    <div className="up-mask no-menu" onClick={(e) => e.stopPropagation()}>
      <svg width="44" height="44" viewBox="0 0 44 44" className={p === undefined ? 'up-spin' : undefined}>
        <circle cx="22" cy="22" r="20" fill="rgba(0,0,0,0.45)" />
        <circle
          cx="22" cy="22" r={R} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"
          strokeDasharray={`${p === undefined ? C * 0.28 : Math.max(0.04, p) * C} ${C}`}
          transform="rotate(-90 22 22)"
        />
      </svg>
    </div>
  );
}

export interface AlbumCell {
  key: string;
  src: string;
  w?: number;
  h?: number;
  state?: UploadState;
  sending?: boolean;
  /** 这一格的 DOM id（引用跳转 / 删除动画按消息 id 找元素） */
  domId?: string;
}

const GAP = 2;

/** Telegram 式多图拼版：圆角整块裁切，格子之间留 2px 缝 */
export function AlbumGrid({ cells, width, onTap, onRetry }: {
  cells: AlbumCell[];
  width: number;
  onTap: (i: number) => void;
  onRetry: (i: number) => void;
}) {
  const { rects, height } = albumLayout(cells.map((c) => (c.w && c.h ? c.w / c.h : 1)));
  const H = Math.round(height * width);
  return (
    <div className="album" style={{ width, height: H }}>
      {cells.map((c, i) => {
        const r = rects[i];
        const left = r.x * width + (r.x > 0.001 ? GAP / 2 : 0);
        const right = (r.x + r.w) * width - (r.x + r.w < 0.999 ? GAP / 2 : 0);
        const top = r.y * width + (r.y > 0.001 ? GAP / 2 : 0);
        const bottom = (r.y + r.h) * width - (r.y + r.h < height - 0.001 ? GAP / 2 : 0);
        return (
          <div
            key={c.key}
            id={c.domId}
            data-album-i={i}
            className="album-cell"
            style={{ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }}
          >
            <img src={c.src} alt="" onClick={() => onTap(i)} />
            <UploadMask state={c.state} sending={c.sending} onRetry={() => onRetry(i)} />
          </div>
        );
      })}
    </div>
  );
}

export const KeyboardGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.3 10h.01M12.6 10h.01M15.9 10h.01M6 13.5h.01M18 10h.01M18 13.5h.01M8.5 14h7" strokeWidth="2" />
  </svg>
);

/** 按住说话（网页版）：MediaRecorder 录 webm / mp4，服务端统一转成 m4a */
export function VoiceHoldButton({ onSend, onError }: { onSend: (blob: Blob, duration: number) => void; onError: (msg: string) => void }) {
  const [rec, setRec] = useState(false);
  const [cancel, setCancel] = useState(false);
  const mr = useRef<MediaRecorder | null>(null);
  const started = useRef(0);
  const chunks = useRef<Blob[]>([]);
  const want = useRef(false);
  const cancelRef = useRef(false);
  const startY = useRef(0);

  useEffect(() => () => {
    want.current = false;
    mr.current?.stream.getTracks().forEach((tr) => tr.stop());
  }, []);

  const start = async (y: number) => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return onError(t('chat.voice.unsupported'));
    want.current = true;
    cancelRef.current = false;
    setCancel(false);
    startY.current = y;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      want.current = false;
      return onError(t('chat.voice.denied'));
    }
    // 申请权限的弹框期间已经松手了
    if (!want.current) return stream.getTracks().forEach((tr) => tr.stop());
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((x) => MediaRecorder.isTypeSupported?.(x));
    const r = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const dur = Math.round((Date.now() - started.current) / 1000);
      if (cancelRef.current) return;
      if (dur < 1) return onError(t('chat.voice.tooShort'));
      const mime = (r.mimeType || type || 'audio/webm').split(';')[0];
      onSend(new Blob(chunks.current, { type: mime }), Math.min(dur, 60));
    };
    mr.current = r;
    started.current = Date.now();
    r.start();
    setRec(true);
  };
  const stop = () => {
    want.current = false;
    setRec(false);
    const r = mr.current;
    mr.current = null;
    if (r && r.state !== 'inactive') r.stop();
  };
  const move = (y: number) => {
    if (!rec) return;
    const c = startY.current - y > 60;
    cancelRef.current = c;
    setCancel(c);
  };

  // 录满 60 秒自动发
  useEffect(() => {
    if (!rec) return;
    const timer = setTimeout(stop, 60_000);
    return () => clearTimeout(timer);
  }, [rec]);

  return (
    <>
      <div
        className={`voice-hold${rec ? ' on' : ''}`}
        onMouseDown={(e) => start(e.clientY)}
        onMouseUp={stop}
        onMouseLeave={() => rec && stop()}
        onMouseMove={(e) => move(e.clientY)}
        onTouchStart={(e) => { e.preventDefault(); start(e.touches[0].clientY); }}
        onTouchMove={(e) => move(e.touches[0].clientY)}
        onTouchEnd={(e) => { e.preventDefault(); stop(); }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {rec ? (cancel ? t('chat.voice.releaseCancel') : t('chat.releaseToSend')) : t('chat.holdToTalk')}
      </div>
      {rec && (
        <div className={`voice-overlay${cancel ? ' cancel' : ''}`}>
          <span className="voice-bars playing"><span /><span /><span /></span>
          <span>{cancel ? t('chat.voice.releaseCancel') : t('chat.voice.slideCancel')}</span>
        </div>
      )}
    </>
  );
}
