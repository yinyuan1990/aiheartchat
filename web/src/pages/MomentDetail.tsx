import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { MomentItem } from './Plaza';
import { useApp } from '../store';

const EMOJIS = ['😀', '😂', '🥰', '😍', '😘', '😊', '🤔', '😎', '🥺', '😭', '😅', '🙃', '❤️', '💕', '👍', '👏', '🌹', '🎉', '🔥', '✨', '🙌', '🤝', '💪', '🍻'];

/** 动态详情页：正文 + 全部评论 + 底部固定输入栏 */
export function MomentDetailPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const { id } = useParams<{ id: string }>();
  const [moment, setMoment] = useState<MomentItem | null>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; nickname: string } | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);

  const loadComments = () => api<any[]>(`/moments/${id}/comments`).then(setComments).catch(() => {});

  useEffect(() => {
    api<MomentItem>(`/moments/${id}`).then((m) => {
      setMoment(m);
      setLiked(m.liked);
      setLikeCount(m.likeCount);
    }).catch((e) => {
      alert(e.message);
      nav(-1);
    });
    loadComments();
  }, [id]);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(''), 1600);
  };

  const toggleLike = async () => {
    try {
      const r = await api<{ liked: boolean }>(`/moments/${id}/like`, { method: 'POST' });
      setLiked(r.liked);
      setLikeCount((c) => c + (r.liked ? 1 : -1));
    } catch {}
  };

  const greet = async () => {
    if (!moment) return;
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${moment.user.id}`, { method: 'POST' });
      nav(`/chatroom/${r.conversationId}`, { state: { title: moment.user.nickname, convType: 1, targetId: moment.user.id } });
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const send = async (imageUrl?: string) => {
    const content = input.trim();
    if (!content && !imageUrl) return;
    setBusy(true);
    try {
      await api(`/moments/${id}/comments`, { method: 'POST', body: { content, imageUrl, replyToId: replyTo?.id } });
      setInput('');
      setReplyTo(null);
      setShowEmoji(false);
      showToast('评论成功');
      loadComments();
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadFile('image', file);
      await send(url);
    } catch (e: any) {
      showToast(e.message);
      setBusy(false);
    }
  };

  if (!moment) return <div className="app"><div className="empty">加载中…</div></div>;

  return (
    <div className="app">
      {/* 顶栏：返回 + 作者 */}
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <div className="avatar" style={{ width: 34, height: 34 }}>
          {moment.user?.avatar && <img src={moment.user.avatar} alt="" />}
        </div>
        <span className="grow" style={{ fontSize: 15 }}>{moment.user?.nickname}</span>
        {/* 自己的动态不显示私聊按钮 */}
        {me?.id !== moment.user?.id && (
          <button className="btn-sm ghost" onClick={greet}>私聊</button>
        )}
      </div>

      <div className="page no-scrollbar" style={{ padding: '0 16px' }}>
        {/* 正文 */}
        {moment.content && <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{moment.content}</div>}
        {moment.type === 1 && moment.images.length > 0 && (
          <div className="grid-photos">{moment.images.map((url, i) => <img key={i} src={url} alt="" />)}</div>
        )}
        {moment.type === 2 && moment.videoUrl && (
          <video
            src={moment.videoUrl}
            poster={moment.coverUrl || undefined}
            controls
            playsInline
            onPlay={(e) => {
              document.querySelectorAll('video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
            }}
            style={{ width: '100%', borderRadius: 8, marginTop: 10, maxHeight: 420, background: '#000' }}
          />
        )}
        {moment.cityName && (
          <div style={{ marginTop: 10 }}>
            <span className="tag tag-muted">{moment.cityName}</span>
          </div>
        )}
        <div className="small" style={{ marginTop: 8 }}>{new Date(moment.createdAt).toLocaleString('zh-CN')}</div>

        {/* 全部评论 */}
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>全部评论（{comments.length}）</div>
          {comments.length === 0 && <div className="empty" style={{ padding: 24 }}>暂无评论，抢首评</div>}
          {comments.map((c) => (
            <div key={c.id} className="row" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
              <div className="avatar" style={{ width: 34, height: 34 }}>
                {c.user?.avatar && <img src={c.user.avatar} alt="" />}
              </div>
              <div className="grow">
                <div className="small">
                  {c.user?.nickname}
                  {c.replyToNickname && <span> 回复 <span className="accent">@{c.replyToNickname}</span></span>}
                </div>
                {c.content && <div style={{ fontSize: 14, marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.content}</div>}
                {c.imageUrl && <img src={c.imageUrl} style={{ maxWidth: 140, borderRadius: 8, marginTop: 4, display: 'block' }} alt="" />}
                <div className="small" style={{ marginTop: 4 }}>
                  {new Date(c.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  <span className="accent" style={{ marginLeft: 12, cursor: 'pointer' }} onClick={() => setReplyTo({ id: c.id, nickname: c.user?.nickname ?? '' })}>回复</span>
                </div>
              </div>
            </div>
          ))}
          <div style={{ height: 16 }} />
        </div>
      </div>

      {/* 表情面板 */}
      {showEmoji && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4, padding: '8px 16px', borderTop: '1px solid var(--line)' }}>
          {EMOJIS.map((e) => (
            <span key={e} style={{ textAlign: 'center', fontSize: 22, cursor: 'pointer', padding: 4 }} onClick={() => setInput((v) => v + e)}>{e}</span>
          ))}
        </div>
      )}

      {/* 回复提示条 */}
      {replyTo && (
        <div className="row" style={{ padding: '6px 16px' }}>
          <span className="small grow">回复 <span className="accent">@{replyTo.nickname}</span></span>
          <span className="small" style={{ cursor: 'pointer' }} onClick={() => setReplyTo(null)}>取消</span>
        </div>
      )}

      {/* 底部固定输入栏 */}
      <div className="row" style={{ padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--line)', gap: 8 }}>
        <span style={{ fontSize: 20, cursor: 'pointer' }} onClick={() => setShowEmoji((v) => !v)}>☺</span>
        <span
          style={{ width: 30, height: 30, borderRadius: 15, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)', flexShrink: 0 }}
          onClick={() => imgRef.current?.click()}
        >+</span>
        <input
          className="input grow"
          style={{ marginBottom: 0, padding: '10px 14px' }}
          value={input}
          placeholder={replyTo ? `回复 @${replyTo.nickname}` : '说点什么…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <span className={liked ? 'accent' : 'muted'} style={{ cursor: 'pointer', fontSize: 13, flexShrink: 0 }} onClick={toggleLike}>
          点赞 {likeCount > 0 ? likeCount : ''}
        </span>
        <button className="btn-sm" disabled={busy} onClick={() => send()}>发送</button>
      </div>

      <input ref={imgRef} type="file" accept="image/*" hidden onChange={(e) => sendImage(e.target.files)} />
      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
