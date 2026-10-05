import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

export type AttachAction = 'gift' | 'location' | 'voice' | 'voiceCall' | 'videoCall';

const MAX_PICK = 9;

interface Picked {
  id: number;
  file: File;
  url: string;
  video: boolean;
}

const Svg = ({ children, size = 22 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const icons = {
  photo: <Svg><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M4.5 17.5l5-5 4 3.5 2.5-2.5 3.5 4" /></Svg>,
  gift: <Svg><rect x="4.5" y="10" width="15" height="10" rx="1.2" /><path d="M3.5 10h17M12 10v10M12 10c-1.5-3.5-5-4-5-1.8S10 10 12 10zm0 0c1.5-3.5 5-4 5-1.8S14 10 12 10z" /></Svg>,
  pin: <Svg><path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0113 0c0 4.9-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Svg>,
  mic: <Svg><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5" /></Svg>,
  phone: <Svg><path d="M6.6 3.8l2.3-.3 1.6 4-1.9 1.4a11 11 0 005.5 5.5l1.4-1.9 4 1.6-.3 2.3a2 2 0 01-2 1.7A15.5 15.5 0 014.9 5.8a2 2 0 011.7-2z" /></Svg>,
  video: <Svg><rect x="3" y="6.5" width="12.5" height="11" rx="2.2" /><path d="M15.5 10.5l5-3v9l-5-3z" /></Svg>,
  camera: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 4.5h6l1.5 2H19a2.5 2.5 0 012.5 2.5v8.5A2.5 2.5 0 0119 20H5a2.5 2.5 0 01-2.5-2.5V9A2.5 2.5 0 015 6.5h2.5z" />
      <circle cx="12" cy="13" r="3.6" fill="rgba(0,0,0,0.35)" />
      <circle cx="12" cy="13" r="2.4" />
    </svg>
  ),
  close: <Svg size={16}><path d="M6 6l12 12M18 6L6 18" strokeWidth="2.2" /></Svg>,
  up: <Svg size={20}><path d="M12 19V5M6 11l6-6 6 6" strokeWidth="2.4" /></Svg>,
};

/**
 * 聊天「+」弹框（Telegram 式）：从底部弹出；第一格相机（手机上直接调起拍照，拍完即发），
 * 第二格从相册选（浏览器拿不到相册列表，选进来的图排在后面，可勾选 / 取消）；
 * 底部悬浮胶囊切 相册 / 礼物 / 位置 / 通话，选了图后换成「添加说明 + 发送」。
 */
export function AttachSheet({
  isSingle,
  canVoice,
  canVideoCall,
  onClose,
  onSend,
  onAction,
}: {
  isSingle: boolean;
  /** 群 / 频道：胶囊里放「语音」（单聊的语音在输入框左边，胶囊放不下） */
  canVoice?: boolean;
  canVideoCall: boolean;
  onClose: () => void;
  onSend: (files: File[], caption: string) => void;
  onAction: (a: AttachAction) => void;
}) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [caption, setCaption] = useState('');
  const [closing, setClosing] = useState(false);
  const [toast, setToast] = useState('');
  const seq = useRef(0);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  useEffect(() => () => pickedRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 收起动画走完再回调 */
  const exit = (after?: () => void) => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      onClose();
      after?.();
    }, 200);
  };

  const addFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const room = MAX_PICK - selected.length;
    if (files.length > room) setToast(t('attach.maxPick', { n: MAX_PICK }));
    const items = files.map((file) => ({
      id: ++seq.current,
      file,
      url: URL.createObjectURL(file),
      video: file.type.startsWith('video'),
    }));
    setPicked((v) => [...items, ...v]);
    setSelected((v) => [...v, ...items.slice(0, Math.max(0, room)).map((p) => p.id)]);
  };

  const toggle = (id: number) => {
    setSelected((v) => {
      if (v.includes(id)) return v.filter((x) => x !== id);
      if (v.length >= MAX_PICK) {
        setToast(t('attach.maxPick', { n: MAX_PICK }));
        return v;
      }
      return [...v, id];
    });
  };

  const send = () => {
    const files = selected.map((id) => picked.find((p) => p.id === id)?.file).filter(Boolean) as File[];
    if (!files.length) return;
    const c = caption;
    exit(() => onSend(files, c));
  };

  const tabs: { key: string; label: string; icon: React.ReactNode; action?: AttachAction }[] = [
    { key: 'album', label: t('attach.album'), icon: icons.photo },
    ...(isSingle ? [{ key: 'gift', label: t('attach.gift'), icon: icons.gift, action: 'gift' as const }] : []),
    { key: 'location', label: t('attach.location'), icon: icons.pin, action: 'location' as const },
    ...(canVoice ? [{ key: 'voiceMsg', label: t('attach.voice'), icon: icons.mic, action: 'voice' as const }] : []),
    ...(isSingle ? [{ key: 'voice', label: t('attach.voiceCall'), icon: icons.phone, action: 'voiceCall' as const }] : []),
    ...(isSingle && canVideoCall ? [{ key: 'video', label: t('attach.videoCall'), icon: icons.video, action: 'videoCall' as const }] : []),
  ];

  return (
    <div className={`att-mask${closing ? ' out' : ''}`} onClick={() => exit()}>
      <div className={`att-sheet${closing ? ' out' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="att-grabber" />
        <div className="att-head">
          <span className="att-close" onClick={() => exit()}>{icons.close}</span>
          <span className="att-title">{t('attach.album')}</span>
        </div>

        <div className="att-grid">
          <label className="att-cell att-camera">
            {icons.camera}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) {
                  const c = caption;
                  exit(() => onSend([f], c));
                }
              }}
            />
          </label>
          <label className="att-cell att-pick">
            {icons.photo}
            <span>{t('attach.pickFromAlbum')}</span>
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          {picked.map((p) => {
            const order = selected.indexOf(p.id);
            return (
              <div key={p.id} className={`att-cell att-photo${order >= 0 ? ' on' : ''}`} onClick={() => toggle(p.id)}>
                {p.video ? <video src={p.url} muted playsInline preload="metadata" /> : <img src={p.url} alt="" />}
                <span className="att-badge">{order >= 0 ? order + 1 : ''}</span>
              </div>
            );
          })}
        </div>

        <div className="att-bottom">
          {selected.length === 0 ? (
            <div className="att-tabs">
              {tabs.map((tab) => (
                <div
                  key={tab.key}
                  className={`att-tab${tab.action ? '' : ' on'}`}
                  onClick={() => tab.action && exit(() => onAction(tab.action!))}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="att-caption">
              <input
                value={caption}
                placeholder={t('attach.captionHint')}
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <span className="att-send" onClick={send}>
                {icons.up}
                <em>{selected.length}</em>
              </span>
            </div>
          )}
        </div>
        {toast && <div className="att-toast">{toast}</div>}
      </div>
    </div>
  );
}
