import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../store';

interface InviteMine {
  code: string;
  link: string;
  clicks30d: number;
  invited: number;
  recent: { id: string; nickname: string; avatar: string; createdAt: string }[];
}

const full = (p: string) => (!p || p.startsWith('http') ? p : 'https://api.yyheart.com' + p);

/** 我的邀请名片：专属网页链接 + 二维码（女生发给男生 / 男生发给女生，下载后自动归因到我） */
export function InviteCardPage() {
  const nav = useNavigate();
  const { user } = useApp();
  const [info, setInfo] = useState<InviteMine | null>(null);
  const [qr, setQr] = useState('');
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const isFemale = user?.gender === 2;

  useEffect(() => {
    api<InviteMine>('/app/invite/mine').then(async (r) => {
      setInfo(r);
      setQr(await QRCode.toDataURL(r.link, { width: 480, margin: 1 }));
    }).catch((e) => setErr(e.message || '加载失败'));
  }, []);

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(''), 1500); };
  const copy = async () => {
    if (!info) return;
    try { await navigator.clipboard.writeText(info.link); flash('链接已复制'); } catch { flash('复制失败，请长按链接复制'); }
  };
  const share = async () => {
    if (!info) return;
    const text = (isFemale ? '我在心之音等你，来和我聊聊：' : '我在心之音，想请你来聊聊，你的时间在这里每一分钟都算钱：') + info.link;
    if (navigator.share) { try { await navigator.share({ text }); } catch { /* 用户取消 */ } } else copy();
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">我的邀请名片</span>
        <span className="action" />
      </div>
      <div className="page no-scrollbar" style={{ padding: 16 }}>
        {!info ? <div className="empty">{err || '加载中…'}</div> : (
          <>
            <div className="card" style={{ padding: 18, border: '1px solid rgba(254,44,85,0.45)' }}>
              <div className="row">
                <div className="avatar" style={{ width: 52, height: 52 }}>{user?.avatar && <img src={full(user.avatar)} alt="" />}</div>
                <div className="grow">
                  <div style={{ fontSize: 11, color: 'var(--text-2)' }}>心之音 · 专属名片</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{user?.nickname}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>邀请码 {info.code}</div>
                </div>
              </div>
              <p style={{ marginTop: 14, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                {isFemale
                  ? '发给男生：他打开网页能看到你的照片、价格和评分，下载后自动打开你的主页，第一条消息就是你的收入。'
                  : '发给女生：她打开网页能看到你的名片和在这里的收入方式，下载后自动和你成为好友。'}
              </p>
              {qr && <div style={{ textAlign: 'center', marginTop: 16 }}><img src={qr} alt="" style={{ width: 190, height: 190, borderRadius: 12, background: '#fff', padding: 6 }} /></div>}
              <div onClick={copy} style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-input)', fontSize: 13 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.link.replace('https://', '')}</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12 }}>复制</span>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={copy}>复制链接</button>
                <button className="btn" style={{ flex: 1 }} onClick={share}>分享链接</button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              {[[info.clicks30d, '30 天内被打开'], [info.invited, '成功邀请']].map(([n, l]) => (
                <div key={String(l)} className="card" style={{ flex: 1, textAlign: 'center', padding: '14px 0' }}>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{n}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{l}</div>
                </div>
              ))}
            </div>
            {info.recent.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>通过我加入的人</div>
                {info.recent.map((u) => (
                  <div key={u.id} className="row" style={{ padding: '8px 0' }}>
                    <div className="avatar" style={{ width: 38, height: 38 }}>{u.avatar && <img src={full(u.avatar)} alt="" />}</div>
                    <span className="grow" style={{ fontSize: 14 }}>{u.nickname}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{u.createdAt.slice(0, 10)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {toast && (
          <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
