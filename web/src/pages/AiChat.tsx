import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { WebPreview } from '../components/WebPreview';

interface AiMsg {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

/** 把回复拆成 文字说明 + HTML 文档（AI 写攻略/页面时输出 ```html 代码块） */
function extractHtml(content: string): { text: string; html: string | null } {
  const fence = content.match(/```html\s*([\s\S]*?)```/i);
  if (fence) return { text: content.replace(fence[0], '').trim(), html: fence[1].trim() };
  const bare = content.match(/<!DOCTYPE html[\s\S]*<\/html\s*>|<html[\s\S]*<\/html\s*>/i);
  if (bare) return { text: content.replace(bare[0], '').trim(), html: bare[0] };
  return { text: content, html: null };
}

const AI_AVATAR = (
  <div style={{
    width: 36, height: 36, borderRadius: 18, flexShrink: 0,
    background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontSize: 12, fontWeight: 800, letterSpacing: 1,
  }}>AI</div>
);

/** AI 助手（免费问答，历史存服务端） */
export function AiChatPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [messages, setMessages] = useState<AiMsg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [toast, setToast] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2000);
  };

  useEffect(() => {
    api<AiMsg[]>('/ai/messages').then(setMessages).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, thinking]);

  const send = async () => {
    const content = input.trim();
    if (!content || thinking) return;
    setInput('');
    setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'user', content }]);
    setThinking(true);
    try {
      const reply = await api<AiMsg>('/ai/chat', { method: 'POST', body: { content } });
      setMessages((prev) => [...prev, reply]);
    } catch (e: any) {
      showToast(e.message ?? 'AI 暂时不可用');
    } finally {
      setThinking(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('清空与 AI 的全部对话记录？')) return;
    try {
      await api('/ai/clear', { method: 'POST' });
      setMessages([]);
    } catch (e: any) {
      showToast(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title">AI 助手</span>
        <span className="action" style={{ color: 'var(--text-2)' }} onClick={clear}>清空</span>
      </div>

      <div className="page page-pad">
        {messages.length === 0 && !thinking && (
          <div className="empty">我是 AI 助手，完全免费{'\n'}有什么想问的尽管说</div>
        )}
        {messages.map((m) => {
          const mine = m.role === 'user';
          const { text, html } = mine ? { text: m.content, html: null } : extractHtml(m.content);
          return (
            <div key={m.id} className={`bubble-row${mine ? ' mine' : ''}`} style={{ gap: 8, alignItems: 'flex-start' }}>
              {!mine && AI_AVATAR}
              <div className="bubble-wrap">
                {text && <div className={`bubble ${mine ? 'mine' : 'theirs'}`} style={{ whiteSpace: 'pre-wrap' }}>{text}</div>}
                {html && (
                  <div
                    className="bubble theirs"
                    style={{ marginTop: text ? 6 : 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                    onClick={() => setPreview(html)}
                  >
                    <span style={{ fontSize: 22 }}>🌐</span>
                    <span>
                      <span style={{ display: 'block', fontSize: 14 }}>网页内容</span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>点击打开预览 ›</span>
                    </span>
                  </div>
                )}
              </div>
              {mine && (
                <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0 }}>
                  {me?.avatar && <img src={me.avatar} alt="" />}
                </div>
              )}
            </div>
          );
        })}
        {thinking && (
          <div className="bubble-row" style={{ gap: 8, alignItems: 'flex-start' }}>
            {AI_AVATAR}
            <div className="bubble-wrap">
              <div className="bubble theirs" style={{ color: 'var(--text-2)' }}>正在思考…</div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="row" style={{ padding: 8, gap: 8, background: 'var(--bg-card)' }}>
        <input
          className="input grow"
          style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
          value={input}
          placeholder="随便问点什么…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        {input.trim() && !thinking && (
          <button className="btn-sm" style={{ height: 40, borderRadius: 20, flexShrink: 0 }} onClick={send}>发送</button>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 200, background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 14, padding: '10px 18px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {toast}
        </div>
      )}

      {/* AI 生成的网页全屏预览（共用组件） */}
      {preview !== null && <WebPreview html={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
