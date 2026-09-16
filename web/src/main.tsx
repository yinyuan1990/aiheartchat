import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './theme.css';

// 全局：点空白处收起键盘（WebView 内偶尔点非交互区域不 blur）。点到输入框/按钮/链接等交互元素不处理。
document.addEventListener('click', (e) => {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) return;
  const t = e.target as Element | null;
  if (t && t.closest('input,textarea,select,[contenteditable],button,a,label,[role="button"]')) return;
  active.blur();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
