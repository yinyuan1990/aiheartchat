import { Fragment, useEffect, useState } from 'react';
import { WebPreview } from './WebPreview';

/** http(s):// 或 www. 开头，遇到空白 / 中文标点 / 引号结束 */
const URL_RE = /(https?:\/\/|www\.)[^\s<>"'“”‘’，。！？；：、（）【】《》]+/gi;
const TRAILING = /[.,;:!?)\]}>]+$/;

export function splitLinks(text: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let raw = m[0];
    const tail = raw.match(TRAILING)?.[0] ?? '';
    if (tail) raw = raw.slice(0, -tail.length);
    if (!raw || raw.toLowerCase() === 'www.') continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: raw, url: /^www\./i.test(raw) ? `https://${raw}` : raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

type Listener = (url: string) => void;
const listeners = new Set<Listener>();

/** 应用内打开网页（顶部可「浏览器打开 / 复制链接」）；没挂 LinkHost 时退回新标签页 */
export function openLink(url: string) {
  if (!listeners.size) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  listeners.forEach((l) => l(url));
}

/** 挂在应用根部，负责弹出应用内网页 */
export function LinkHost() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const l: Listener = (u) => setUrl(u);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* ignore */
  }
  return <WebPreview url={url} title={host} onClose={() => setUrl(null)} />;
}

/** 文本里的链接可点，点开走应用内网页 */
export function LinkText({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const parts = splitLinks(text);
  return (
    <span className={className} style={style}>
      {parts.map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            className="msg-link"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openLink(p.url!);
            }}
          >
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}
