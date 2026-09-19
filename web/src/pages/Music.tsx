import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export interface MusicTrack {
  id: string;
  title: string;
  performer: string;
  duration: number;
  size: number;
  url: string;
  cover: string;
  postedAt: string;
  playCount: number;
}

interface MusicList {
  source: { title: string; channel: string } | null;
  list: MusicTrack[];
}

function fmtDur(s: number): string {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function fmtSize(b: number): string {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

function fmtAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d <= 1 ? '昨天' : `${d} 天前`;
}

/** 播放/暂停图标（不用 emoji） */
function PlayIcon({ playing, size = 22 }: { playing: boolean; size?: number }) {
  return playing ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
  );
}

function SkipIcon({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" style={{ transform: dir === 'prev' ? 'scaleX(-1)' : undefined }}>
      <path d="M5 5.5v13a1 1 0 0 0 1.5.86L15 14.2V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v3.8L6.5 4.64A1 1 0 0 0 5 5.5z" />
    </svg>
  );
}

/** 正在播放的动效条 */
function Bars() {
  return (
    <span className="music-bars"><i /><i /><i /></span>
  );
}

/** 封面：有图用图，没有用渐变 + 音符 */
function Cover({ track, size, active }: { track: MusicTrack; size: number; active?: boolean }) {
  return (
    <div className={`music-cover${active ? ' spin' : ''}`} style={{ width: size, height: size }}>
      {track.cover ? (
        <img src={track.cover} alt="" />
      ) : (
        <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="#fff" opacity={0.9}>
          <path d="M9 3v10.55A4 4 0 1 0 11 17V7h5a3 3 0 0 0 3-3V3H9z" />
        </svg>
      )}
    </div>
  );
}

/**
 * 音乐频道（消息页「私聊」tab 置顶入口）：后端从 Telegram 频道同步最近 3 天的音频，
 * 这里列表 + 底部常驻播放器，单曲结束自动播下一首。
 */
export function MusicPage() {
  const nav = useNavigate();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [data, setData] = useState<MusicList | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const countedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    api<MusicList>('/music').then(setData).catch(() => setData({ source: null, list: [] }));
  }, []);

  const list = data?.list ?? [];
  const index = useMemo(() => list.findIndex((t) => t.id === current), [list, current]);
  const track = index >= 0 ? list[index] : null;

  // 切歌：换 src 并播放
  const play = (t: MusicTrack) => {
    const el = audioRef.current;
    if (!el) return;
    if (t.id === current) {
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      return;
    }
    setCurrent(t.id);
    setProgress(0);
    setDuration(t.duration || 0);
    el.src = t.url;
    el.play().catch(() => {});
    if (!countedRef.current.has(t.id)) {
      countedRef.current.add(t.id);
      api(`/music/${t.id}/play`, { method: 'POST' }).catch(() => {});
    }
  };

  const step = (delta: number) => {
    if (!list.length) return;
    const next = index < 0 ? 0 : (index + delta + list.length) % list.length;
    play(list[next]);
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (!track) { if (list.length) play(list[0]); return; }
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
  };

  // 锁屏/通知栏显示曲目信息（支持的浏览器）
  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.performer || data?.source?.title || '',
        artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => audioRef.current?.play());
      navigator.mediaSession.setActionHandler('pause', () => audioRef.current?.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    } catch { /* ignore */ }
  }, [track?.id]);

  const pct = duration ? Math.min(100, (progress / duration) * 100) : 0;

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">
          音乐
          {data?.source && <div className="small" style={{ fontWeight: 400, marginTop: 2 }}>{data.source.title}</div>}
        </span>
        <span style={{ width: 20 }} />
      </div>

      <div className="page" style={{ paddingBottom: track ? 96 : 0 }}>
        {!data && <div className="empty">加载中…</div>}
        {data && list.length === 0 && <div className="empty">最近 3 天还没有新歌<br />稍后再来看看</div>}
        {list.length > 0 && (
          <div className="muted" style={{ padding: '10px 16px 2px', fontSize: 12 }}>只保留最近 3 天 · 共 {list.length} 首</div>
        )}
        {list.map((t) => {
          const active = t.id === current;
          return (
            <div key={t.id} className="row music-row" onClick={() => play(t)}>
              <Cover track={t} size={52} active={active && playing} />
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <span className="grow ellipsis" style={{ fontSize: 15, color: active ? 'var(--accent)' : 'var(--text)', fontWeight: active ? 600 : 400 }}>{t.title}</span>
                  {active && playing && <Bars />}
                </div>
                <div className="small" style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                  {t.performer && <span className="ellipsis" style={{ maxWidth: 120 }}>{t.performer}</span>}
                  <span>{fmtDur(t.duration)}</span>
                  <span>{fmtSize(t.size)}</span>
                  <span>{fmtAgo(t.postedAt)}</span>
                </div>
              </div>
              <span style={{ color: active ? 'var(--accent)' : 'var(--text-3)', display: 'flex' }}>
                <PlayIcon playing={active && playing} size={20} />
              </span>
            </div>
          );
        })}
      </div>

      {/* 底部播放器 */}
      {track && (
        <div className="music-player">
          <div className="music-progress" onClick={seek}>
            <div className="music-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="row" style={{ padding: '10px 14px 12px', gap: 12 }}>
            <Cover track={track} size={44} active={playing} />
            <div className="grow" onClick={() => audioRef.current?.play().catch(() => {})}>
              <div className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{track.title}</div>
              <div className="small" style={{ marginTop: 3 }}>
                {track.performer || data?.source?.title || ''} · {fmtDur(progress)} / {fmtDur(duration)}{loading ? ' · 缓冲中…' : ''}
              </div>
            </div>
            <span className="music-ctl" onClick={() => step(-1)}><SkipIcon dir="prev" /></span>
            <span className="music-ctl main" onClick={toggle}><PlayIcon playing={playing} size={22} /></span>
            <span className="music-ctl" onClick={() => step(1)}><SkipIcon dir="next" /></span>
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onCanPlay={() => setLoading(false)}
        onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime)}
        onDurationChange={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setDuration(d); }}
        onEnded={() => step(1)}
        onError={() => { setLoading(false); setPlaying(false); }}
      />
    </div>
  );
}
