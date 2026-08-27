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
