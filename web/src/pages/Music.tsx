import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { music, useMusic, type MusicTrack } from '../music';

function fmtDur(s: number): string {
  if (!s || !isFinite(s)) return '0:00';
  const v = Math.floor(s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
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

// ---------- 图标（矢量，不用 emoji） ----------

function PlayIcon({ playing, size = 22 }: { playing: boolean; size?: number }) {
  return playing ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
  );
}

function SkipIcon({ dir, size = 26 }: { dir: 'prev' | 'next'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ transform: dir === 'prev' ? 'scaleX(-1)' : undefined }}>
      <path d="M4 5.5v13a1 1 0 0 0 1.5.86L12 15.2v3.3a1 1 0 0 0 1.5.86l8-5.5a1 1 0 0 0 0-1.72l-8-5.5A1 1 0 0 0 12 8.5v3.3L5.5 4.64A1 1 0 0 0 4 5.5z" />
    </svg>
  );
}

function ShuffleIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="m4 4 5 5" />
    </svg>
  );
}

function RepeatIcon({ one, size = 20 }: { one: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
      {one && <text x="12" y="15" fontSize="8" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">1</text>}
    </svg>
  );
}

function CloseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
  );
}

function Bars() {
  return <span className="music-bars"><i /><i /><i /></span>;
}

/** 封面：有图用图，没有用渐变 + 音符 */
function Cover({ track, size, round = true, active }: { track: MusicTrack; size: number; round?: boolean; active?: boolean }) {
  return (
    <div className={`music-cover${active ? ' spin' : ''}${round ? '' : ' square'}`} style={{ width: size, height: size }}>
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

// ---------- 消息页顶部「正在播放」栏 ----------

/** 播放中固定在消息页顶部：暂停 / 标题·艺术家 / 倍速 / 关闭；点中间打开播放弹层 */
export function NowPlayingBar({ onOpen }: { onOpen: () => void }) {
  const s = useMusic();
  const t = s.current;
  if (!t) return null;
  return (
    <div className="now-playing">
      <span className="np-btn" onClick={() => music.toggle()}><PlayIcon playing={s.playing} size={20} /></span>
      <div className="np-text" onClick={onOpen}>
        <div className="np-title ellipsis">{t.title}</div>
        <div className="np-sub ellipsis">{t.performer || s.data?.source?.title || '未知艺术家'}{s.buffering ? ' · 缓冲中…' : ''}</div>
      </div>
      <span className="np-rate" onClick={() => music.cycleRate()}>{s.rate === 1 ? '1X' : `${s.rate}X`}</span>
      <span className="np-btn" onClick={() => music.stop()}><CloseIcon /></span>
    </div>
  );
}

// ---------- 播放弹层（列表 + 大播放器） ----------

/**
 * 独立弹层：上半部曲目列表，下半部播放器（封面、标题、进度/时间、倍速、随机/上一首/播放/下一首/循环）。
 * 数据来自后端从 Telegram 频道同步的最近 3 天曲目。
 */
export function MusicSheet({ onClose }: { onClose: () => void }) {
  const s = useMusic();
  const [loaded, setLoaded] = useState(!!s.data);

  useEffect(() => {
    music.load().finally(() => setLoaded(true));
  }, []);

  const list = s.data?.list ?? [];
  const track = s.current;
  const pct = s.duration ? Math.min(100, (s.progress / s.duration) * 100) : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    music.seek((e.clientX - rect.left) / rect.width);
  };

  return (
    <div className="mask bottom music-mask" onClick={onClose}>
      <div className="music-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="music-sheet-head">
          <div className="music-handle" />
          <div className="row" style={{ padding: '4px 16px 10px' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }} className="ellipsis">{s.data?.source?.title || '音乐'}</div>
              <div className="small" style={{ marginTop: 2 }}>只保留最近 3 天{list.length ? ` · 共 ${list.length} 首` : ''}</div>
            </div>
            <span className="np-btn" onClick={onClose}><CloseIcon /></span>
          </div>
        </div>

        <div className="music-list no-scrollbar">
          {!loaded && <div className="empty">加载中…</div>}
          {loaded && list.length === 0 && <div className="empty">最近 3 天还没有新歌<br />稍后再来看看</div>}
          {list.map((t) => {
            const active = t.id === track?.id;
            return (
              <div key={t.id} className="row music-row" onClick={() => music.play(t)}>
                <Cover track={t} size={48} active={active && s.playing} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="grow ellipsis" style={{ fontSize: 15, color: active ? 'var(--accent)' : 'var(--text)', fontWeight: active ? 600 : 400 }}>{t.title}</span>
                    {active && s.playing && <Bars />}
                  </div>
                  <div className="small" style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                    <span>{fmtDur(t.duration)}</span>
                    {t.performer && <span className="ellipsis" style={{ maxWidth: 120 }}>· {t.performer}</span>}
                    <span>· {fmtSize(t.size)}</span>
                    <span>· {fmtAgo(t.postedAt)}</span>
                  </div>
                </div>
                <span style={{ color: active ? 'var(--accent)' : 'var(--text-3)', display: 'flex' }}>
                  <PlayIcon playing={active && s.playing} size={20} />
                </span>
              </div>
            );
          })}
        </div>

        {/* 大播放器 */}
        <div className="music-big">
          {track ? (
            <>
              <div className="row" style={{ gap: 12 }}>
                <Cover track={track} size={52} round={false} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontSize: 16, fontWeight: 600 }}>{track.title}</div>
                  <div className="muted ellipsis" style={{ marginTop: 3 }}>{track.performer || '未知艺术家'}</div>
                </div>
              </div>
              <div className="music-progress big" onClick={seek}>
                <div className="music-progress-fill" style={{ width: `${pct}%` }} />
                <div className="music-knob" style={{ left: `${pct}%` }} />
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <span className="small" style={{ width: 56 }}>{fmtDur(s.progress)}</span>
                <span className="grow" style={{ textAlign: 'center' }}>
                  <span className="np-rate" onClick={() => music.cycleRate()}>{s.rate === 1 ? '1X' : `${s.rate}X`}</span>
                </span>
                <span className="small" style={{ width: 56, textAlign: 'right' }}>{fmtDur(s.duration)}</span>
              </div>
            </>
          ) : (
            <div className="muted" style={{ textAlign: 'center', padding: '6px 0 2px' }}>点上面的歌开始播放</div>
          )}
          <div className="music-controls">
            <span className={`music-ctl${s.shuffle ? ' on' : ''}`} onClick={() => music.toggleShuffle()}><ShuffleIcon /></span>
            <span className="music-ctl" onClick={() => music.step(-1)}><SkipIcon dir="prev" /></span>
            <span className="music-ctl main" onClick={() => music.toggle()}><PlayIcon playing={s.playing} size={30} /></span>
            <span className="music-ctl" onClick={() => music.step(1)}><SkipIcon dir="next" /></span>
            <span className={`music-ctl${s.repeat === 'one' ? ' on' : ''}`} onClick={() => music.toggleRepeat()}><RepeatIcon one={s.repeat === 'one'} /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 路由页形式（直接访问 /music 时用），关闭即返回 */
export function MusicPage() {
  const nav = useNavigate();
  return (
    <div className="app">
      <MusicSheet onClose={() => nav(-1)} />
    </div>
  );
}
