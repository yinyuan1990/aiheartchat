/**
 * App 原生桥：大厅 H5 运行在原生 WebView（iOS WKWebView / Android WebView）里时，
 * 聊天等界面唤起原生页面；普通浏览器访问时桥不存在，自动回退网页内跳转。
 */

/** 尝试唤起原生聊天页，成功返回 true（调用方不再走网页路由） */
export function openNativeChat(convId: string, convType: number, targetId: string, title: string): boolean {
  const payload = { type: 'openChat', convId, convType, targetId, title };
  // iOS WKWebView
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    try {
      wk.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }
  // Android WebView（addJavascriptInterface）
  const droid = (window as any).PeiwanNative;
  if (droid?.openChat) {
    try {
      droid.openChat(convId, String(convType), targetId, title);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 是否运行在 App 原生 WebView 里（任一桥存在） */
export function inNativeApp(): boolean {
  const w = window as any;
  return !!(w.webkit?.messageHandlers?.peiwan || w.PeiwanNative);
}

const EMBED_KEY = 'pw_embed';

/** 内嵌模式（App 大厅 WebView，无网页底栏）：hall-embed 入口记录一次，后续页面沿用 */
export function markEmbedded() {
  sessionStorage.setItem(EMBED_KEY, '1');
}

export function isEmbedded(): boolean {
  return sessionStorage.getItem(EMBED_KEY) === '1' || inNativeApp();
}

// ---------- 原生音乐播放器 ----------

/** 交给原生播放的曲目（字段与 /music 接口一致） */
export interface NativeMusicTrack {
  id: string;
  title: string;
  performer?: string;
  duration?: number;
  size?: number;
  url: string;
  cover?: string;
  postedAt?: string;
}

export type NativeMusicAction = 'play' | 'pause' | 'resume' | 'stop' | 'seek' | 'rate';

/**
 * H5 里播音乐时优先交给 App 原生播放器（后台可播、消息页顶部栏 / 锁屏可控，与原生音乐页共用一个播放器）。
 * play 需带 track（可带 queue 作为上一首/下一首列表）；seek 带 ratio(0~1)；rate 带 value(1/1.5/2)。
 * 成功交给原生返回 true，普通浏览器（无桥）返回 false，调用方自己用 <audio> 播。
 */
export function nativeMusic(action: NativeMusicAction, track?: NativeMusicTrack, queue?: NativeMusicTrack[], extra?: { ratio?: number; value?: number }): boolean {
  const payload = { type: 'music', action, track, queue, ...extra };
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    try { wk.postMessage(payload); return true; } catch { return false; }
  }
  const droid = (window as any).PeiwanNative;
  if (droid?.music) {
    try { droid.music(JSON.stringify(payload)); return true; } catch { return false; }
  }
  return false;
}

export interface NativeMusicState {
  id: string | null;
  playing: boolean;
}

/** 原生播放状态回推（原生在切歌/暂停时调 window.PeiwanMusicState({id, playing})），H5 据此同步自己的 UI */
export function onNativeMusicState(cb: (s: NativeMusicState) => void) {
  (window as any).PeiwanMusicState = cb;
}

export type WebOrientation = 'portrait' | 'landscape';

/**
 * 唤起原生全屏网页容器打开 url（小游戏等第三方 H5）：独立于大厅 WebView，
 * 带标题栏/关闭，游戏内导航不影响大厅页；orientation 指定该页屏幕方向（横屏游戏旋转屏幕）。成功返回 true。
 */
export function openNativeWeb(url: string, title: string, orientation: WebOrientation = 'portrait'): boolean {
  const payload = { type: 'openWeb', url, title, orientation };
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    try {
      wk.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }
  const droid = (window as any).PeiwanNative;
  if (droid?.openWeb) {
    try {
      droid.openWeb(url, title, orientation);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
