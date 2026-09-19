import { useEffect, useState } from 'react';
import { api } from './api';
import { inNativeApp, nativeMusic, onNativeMusicState } from './bridge';

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

export interface MusicList {
  source: { title: string; channel: string } | null;
  list: MusicTrack[];
}

export type RepeatMode = 'list' | 'one';

interface MusicState {
  data: MusicList | null;
  current: MusicTrack | null;
  playing: boolean;
  buffering: boolean;
  progress: number;
  duration: number;
  rate: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

const RATES = [1, 1.5, 2];

/**
 * 全局音乐播放器（单个 <audio>，不随页面卸载）：消息页顶部「正在播放」栏、音乐弹层共用。
 * 通过 subscribe/useMusic 把状态同步给 React。
 *
 * 运行在 App 原生 WebView（大厅内嵌）里时不用 <audio>，全部交给原生播放器（bridge.nativeMusic）：
 * 能后台播、消息页顶部栏 / 锁屏可控；原生通过 window.PeiwanMusicState 回推状态。
 */
class MusicStore {
  state: MusicState = { data: null, current: null, playing: false, buffering: false, progress: 0, duration: 0, rate: 1, shuffle: false, repeat: 'list' };
  private audio: HTMLAudioElement | null = null;
  private listeners = new Set<() => void>();
  private counted = new Set<string>();
  private loading: Promise<MusicList> | null = null;
  /**
   * 是否交给原生播放（App 内嵌 WebView）。老版本 App 没有 music 桥：Android 能直接探测方法，
   * iOS 探测不到（postMessage 总是成功），所以第一次 play 后 1.5 秒内没收到原生回推就判定不可用，退回 <audio>。
   */
  private native = inNativeApp() && (!(window as any).PeiwanNative || typeof (window as any).PeiwanNative.music === 'function');
  private nativeConfirmed = false;
  private nativeProbe: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (this.native) {
      onNativeMusicState((s) => {
        this.nativeConfirmed = true;
        if (this.nativeProbe) { clearTimeout(this.nativeProbe); this.nativeProbe = null; }
        const cur = s.id ? this.list.find((t) => t.id === s.id) ?? this.state.current : null;
        this.set({ current: cur, playing: s.playing, buffering: false });
      });
    }
  }

  /** 第一次交给原生播时启动探测：没回推就退回网页 <audio> 重播这首 */
  private probeNative(t: MusicTrack) {
    if (this.nativeConfirmed || this.nativeProbe) return;
    this.nativeProbe = setTimeout(() => {
      this.nativeProbe = null;
      if (this.nativeConfirmed) return;
      this.native = false;
      this.set({ current: null, playing: false });
      this.play(t);
    }, 1500);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private set(patch: Partial<MusicState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private el(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio();
    a.preload = 'metadata';
    a.addEventListener('play', () => this.set({ playing: true }));
    a.addEventListener('pause', () => this.set({ playing: false }));
    a.addEventListener('waiting', () => this.set({ buffering: true }));
    a.addEventListener('playing', () => this.set({ buffering: false }));
    a.addEventListener('canplay', () => this.set({ buffering: false }));
    a.addEventListener('timeupdate', () => this.set({ progress: a.currentTime }));
    a.addEventListener('durationchange', () => { if (isFinite(a.duration) && a.duration > 0) this.set({ duration: a.duration }); });
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => this.set({ buffering: false, playing: false }));
    this.audio = a;
    return a;
  }

  /** 拉列表（带缓存，force 重新拉） */
  async load(force = false): Promise<MusicList> {
    if (this.state.data && !force) return this.state.data;
    if (this.loading) return this.loading;
    this.loading = api<MusicList>('/music')
      .catch(() => ({ source: null, list: [] } as MusicList))
      .then((d) => { this.set({ data: d }); this.loading = null; return d; });
    return this.loading;
  }

  get list(): MusicTrack[] { return this.state.data?.list ?? []; }

  /** 点列表项：同一首切换播放/暂停，不同首切歌 */
  play(t: MusicTrack) {
    if (this.native) {
      if (this.state.current?.id === t.id) {
        nativeMusic(this.state.playing ? 'pause' : 'resume');
        this.set({ playing: !this.state.playing });
      } else {
        nativeMusic('play', t, this.list);
        this.set({ current: t, playing: true, progress: 0, duration: t.duration || 0 });
        this.probeNative(t);
      }
      return;
    }
    const a = this.el();
    if (this.state.current?.id === t.id) {
      if (a.paused) a.play().catch(() => {}); else a.pause();
      return;
    }
    this.set({ current: t, progress: 0, duration: t.duration || 0, buffering: true });
    a.src = t.url;
    a.playbackRate = this.state.rate;
    a.play().catch(() => {});
    this.updateSession(t);
    if (!this.counted.has(t.id)) {
      this.counted.add(t.id);
      api(`/music/${t.id}/play`, { method: 'POST' }).catch(() => {});
    }
  }

  toggle() {
    if (!this.state.current) { if (this.list.length) this.play(this.list[0]); return; }
    if (this.native) { this.play(this.state.current); return; }
    const a = this.el();
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }

  pause() {
    if (this.native) { nativeMusic('pause'); this.set({ playing: false }); return; }
    this.audio?.pause();
  }

  /** 关闭：停止并收起顶部栏 */
  stop() {
    if (this.native) nativeMusic('stop');
    const a = this.audio;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
    this.set({ current: null, playing: false, buffering: false, progress: 0, duration: 0 });
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  step(delta: number) {
    const list = this.list;
    if (!list.length) return;
    const idx = list.findIndex((t) => t.id === this.state.current?.id);
    let next: number;
    if (this.state.shuffle && list.length > 1) {
      do { next = Math.floor(Math.random() * list.length); } while (next === idx);
    } else {
      next = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
    }
    this.play(list[next]);
  }

  private onEnded() {
    if (this.state.repeat === 'one' && this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    this.step(1);
  }

  seek(ratio: number) {
    if (this.native) { nativeMusic('seek', undefined, undefined, { ratio }); return; }
    const a = this.audio;
    if (!a || !this.state.duration) return;
    a.currentTime = Math.min(1, Math.max(0, ratio)) * this.state.duration;
  }

  /** 倍速循环 1x → 1.5x → 2x */
  cycleRate() {
    const i = RATES.indexOf(this.state.rate);
    const rate = RATES[(i + 1) % RATES.length];
    if (this.native) nativeMusic('rate', undefined, undefined, { value: rate });
    else if (this.audio) this.audio.playbackRate = rate;
    this.set({ rate });
  }

  toggleShuffle() { this.set({ shuffle: !this.state.shuffle }); }
  toggleRepeat() { this.set({ repeat: this.state.repeat === 'list' ? 'one' : 'list' }); }

  /** 锁屏/通知栏显示曲目信息 */
  private updateSession(t: MusicTrack) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.performer || this.state.data?.source?.title || '',
        artwork: t.cover ? [{ src: t.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => this.audio?.play());
      navigator.mediaSession.setActionHandler('pause', () => this.audio?.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => this.step(1));
    } catch { /* ignore */ }
  }
}

export const music = new MusicStore();

/** React 订阅：任何字段变化都触发重渲染 */
export function useMusic(): MusicState {
  const [, tick] = useState(0);
  useEffect(() => music.subscribe(() => tick((n) => n + 1)), []);
  return music.state;
}
