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
