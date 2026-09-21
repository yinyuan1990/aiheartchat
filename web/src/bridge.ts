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

// ---------- 分享 ----------

/** 分享短链域名：/s/music/:id、/s/gallery/:id 由后端出带 og 标签的页面（链接卡片才有图），再跳 H5 */
export function shareBase(): string {
  return /yyheart\.com$/.test(location.hostname) ? location.origin : 'https://app.yyheart.com';
}

/**
 * 分享一段文字 + 链接：App 内优先原生分享面板（Android `PeiwanNative.shareText`；iOS WKWebView 支持 navigator.share），
 * 浏览器走系统分享，不支持时复制到剪贴板。返回 'native' | 'copied' | 'cancel' | 'fail'。
 */
export async function shareText(text: string, url: string, title = text): Promise<'native' | 'copied' | 'cancel' | 'fail'> {
  // url 传空 = 链接已经拼在 text 里，只分享文字（系统面板不去抓链接预览图）
  const full = url ? `${text}\n${url}` : text;
  const droid = (window as any).PeiwanNative;
  if (droid?.shareText) {
    try { droid.shareText(full, title); return 'native'; } catch { /* 走下面 */ }
  }
  if (navigator.share) {
    try { await navigator.share(url ? { title, text, url } : { title, text }); return 'native'; } catch { return 'cancel'; }
  }
  try {
    await navigator.clipboard.writeText(url ? `${text} ${url}` : text);
    return 'copied';
  } catch {
    prompt('复制下面的链接分享给好友', url || text);
    return 'fail';
  }
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

// ---------- 原生媒体查看器（看大图 / 播视频） ----------

export interface NativeMediaItem {
  type: 'image' | 'video';
  url: string;
  cover?: string;
}

/**
 * 点图放大 / 点视频播放时优先交给原生全屏查看器：
 * groups = 信息流里所有帖子的媒体（按显示顺序），上下滑切帖子，左右滑切同一帖里的多张图，双指缩放，视频原生播放器。
 * group/index = 点开的是第几条帖子的第几个。
 * 普通浏览器（无桥）返回 false，调用方用网页灯箱。老版本 App 没这个桥：Android 能探测方法；
 * iOS 靠原生注入的 window.__peiwanBridgeV2 标记，没有就走网页灯箱。
 */
export function viewNativeMedia(groups: NativeMediaItem[][], group: number, index: number): boolean {
  const payload = { type: 'viewMedia', groups, group, index, items: groups[group] ?? [] };
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    if (!(window as any).__peiwanBridgeV2) return false;
    try { wk.postMessage(payload); return true; } catch { return false; }
  }
  const droid = (window as any).PeiwanNative;
  if (droid?.viewMediaGroups) {
    try { droid.viewMediaGroups(JSON.stringify(groups), String(group), String(index)); return true; } catch { return false; }
  }
  return false;
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
