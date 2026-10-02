import { useState } from 'react';

/** 内部网页全屏预览：传 html（AI 生成的页面，沙箱渲染）或 url（新闻原文、聊天里的链接等外链） */
export function WebPreview({ html, url, title = '网页预览', onClose }: { html?: string; url?: string; title?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ background: 'var(--bg)', padding: '10px 14px', gap: 14 }}>
        <span className="grow ellipsis" style={{ fontSize: 14, color: 'var(--text)' }}>{title}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 14, color: 'var(--text-2)' }}>浏览器打开</a>
        )}
        {url && (
          <span style={{ fontSize: 14, color: 'var(--text-2)', cursor: 'pointer' }} onClick={copy}>{copied ? '已复制' : '复制链接'}</span>
        )}
        <span style={{ fontSize: 14, color: 'var(--accent)', cursor: 'pointer' }} onClick={onClose}>关闭</span>
      </div>
      {html != null ? (
        <iframe title="web-preview" sandbox="allow-scripts" srcDoc={html} style={{ flex: 1, border: 0, width: '100%' }} />
      ) : (
        <iframe title="web-preview" src={url} style={{ flex: 1, border: 0, width: '100%' }} />
      )}
    </div>
  );
}
