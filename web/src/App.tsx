import { useEffect, useState } from 'react';
import { HashRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getDeviceId, setToken, UserProfile } from './api';
import { useApp } from './store';
import { wsManager } from './ws';
import { EnterPage } from './pages/Enter';
import { RegisterPage } from './pages/Register';
import { PlazaPage } from './pages/Plaza';
import { HallPage } from './pages/Hall';
import { ChatListPage } from './pages/ChatList';
import { ChatRoomPage } from './pages/ChatRoom';
import { AiChatPage } from './pages/AiChat';
import { NewsDetailPage, NewsListPage } from './pages/NewsDetail';
import { MusicPage, MusicSharePage } from './pages/Music';
import { GallerySharePage } from './pages/Gallery';
import { MePage } from './pages/Me';
import { PublishPage } from './pages/Publish';
import { PeoplePage } from './pages/People';
import { TaskPostPage, TaskHallPage, TaskMinePage, TaskDetailPage } from './pages/Task';
import { WalletPage } from './pages/Wallet';
import { GuideApplyPage } from './pages/GuideApply';
import { RealnamePage } from './pages/Realname';
import { MyMomentsPage } from './pages/MyMoments';
import { FollowMomentsPage } from './pages/FollowMoments';
import { FollowsPage } from './pages/Follows';
import { MomentDetailPage } from './pages/MomentDetail';
import { GuideProjectPage } from './pages/GuideProject';
import { EditProfilePage } from './pages/EditProfile';
import { InviteCardPage } from './pages/InviteCard';
import { TransferPage } from './pages/Transfer';
import { GiftsReceivedPage } from './pages/GiftsReceived';
import { AgreementPage } from './pages/Agreement';
import { UserHomePage } from './pages/UserHome';
import { TreeholeDetailPage, TreeholePublishPage, TreeholeSharePage } from './pages/Treehole';
import { markEmbedded } from './bridge';

function Shell() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState('');

  useEffect(() => {
    wsManager.connect();
    const load = () =>
      api<any[]>('/im/conversations')
        .then((list) => setUnread(list.reduce((s, c) => s + (c.unread ?? 0), 0)))
        .catch(() => {});
    load();
    return wsManager.on((frame) => {
      if (frame.op === 'msg') load();
      if (frame.op === 'notify') {
        const d = frame.data ?? {};
        const text = frame.event === 'comment_reply'
          ? `${d.from} 回复了你的评论：${d.preview}`
          : `${d.from} 评论了你的动态：${d.preview}`;
        setToast(text);
        setTimeout(() => setToast(''), 3000);
      }
    });
  }, []);

  return (
    <div className="app">
      {toast && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 200,
          background: 'rgba(20,20,24,0.95)', border: '1px solid var(--line)', padding: '10px 18px',
          borderRadius: 12, fontSize: 13, maxWidth: '86%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{toast}</div>
      )}
      <div className="page">
        <Outlet />
      </div>
      <nav className="tabbar">
        <NavLink to="/plaza" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>广场</NavLink>
        <NavLink to="/hall" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>大厅</NavLink>
        <div className="tab-plus" onClick={() => nav('/publish')}>
          <div className="plus-box">+</div>
        </div>
        <NavLink to="/chat" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          消息
          {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to="/me" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>我的</NavLink>
      </nav>
    </div>
  );
}

/**
 * App 内嵌大厅（原生大厅 tab 的 WebView 入口）：
 * URL 带 ?token= 免登录（用 App 的身份），无底部导航（App 已有原生 tab 栏）。
 * 以后大厅新增业务模块只改网页，无需客户端发版。
 */
function EmbedHallPage() {
  const [params] = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = params.get('token');
    if (t) setToken(t);
    // 记录内嵌模式：树洞详情/发布等子页面据此调整布局（无网页底栏）
    markEmbedded();
    // App 内嵌 WebView：#root 直接钉成窗口像素高度，不依赖 html→body→#root 的 height:100% 链。
    // 华为/荣耀内核里这条链解析成了十几像素（.page 只剩 padding 高度、内容全被裁掉 → 大厅黑屏），innerHeight 却是对的。
    // #root 有了确定高度，之后在同一 WebView 里打开的子页面（.app{height:100%}）也一并正常
    const pin = () => {
      const root = document.getElementById('root');
      if (root && window.innerHeight > 0) root.style.height = `${window.innerHeight}px`;
    };
    pin();
    window.addEventListener('resize', pin);
    setReady(true);
    return () => window.removeEventListener('resize', pin);
  }, []);

  if (!ready) return null;
  return (
    <div className="app">
      <div className="page" style={{ paddingBottom: 12 }}>
        <HallPage />
      </div>
    </div>
  );
}

function Boot() {
  const nav = useNavigate();
  const setUser = useApp((s) => s.setUser);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ registered: boolean; token: string | null; user: UserProfile | null }>(
          '/auth/enter',
          { method: 'POST', body: { deviceId: getDeviceId() } },
        );
        if (r.registered && r.token) {
          setToken(r.token);
          setUser(r.user);
          nav('/plaza', { replace: true });
        } else {
          nav('/register', { replace: true });
        }
      } catch {
        nav('/register', { replace: true });
      }
    })();
  }, []);

  return (
    <div className="app">
      <div className="empty">进入中…</div>
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Boot />} />
        <Route path="/enter" element={<EnterPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/agreement/:type" element={<AgreementPage />} />
        <Route path="/hall-embed" element={<EmbedHallPage />} />
        <Route path="/music/share/:id" element={<MusicSharePage />} />
        <Route path="/gallery/share/:id" element={<GallerySharePage />} />
        <Route path="/treehole/share/:id" element={<TreeholeSharePage />} />
        <Route element={<Shell />}>
          <Route path="/plaza" element={<PlazaPage />} />
          <Route path="/hall" element={<HallPage />} />
          <Route path="/chat" element={<ChatListPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        <Route path="/publish" element={<PublishPage />} />
        <Route path="/chatroom/:id" element={<ChatRoomPage />} />
        <Route path="/ai-chat" element={<AiChatPage />} />
        <Route path="/treehole/publish" element={<TreeholePublishPage />} />
        <Route path="/treehole/:id" element={<TreeholeDetailPage />} />
        <Route path="/news" element={<NewsListPage />} />
        <Route path="/news/:id" element={<NewsDetailPage />} />
        <Route path="/music" element={<MusicPage />} />
        <Route path="/people/:mode" element={<PeoplePage />} />
        <Route path="/task/post" element={<TaskPostPage />} />
        <Route path="/task/hall" element={<TaskHallPage />} />
        <Route path="/task/mine" element={<TaskMinePage />} />
        <Route path="/task/:id" element={<TaskDetailPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/guide-apply" element={<GuideApplyPage />} />
        <Route path="/realname" element={<RealnamePage />} />
        <Route path="/my-moments" element={<MyMomentsPage />} />
        <Route path="/follow-moments" element={<FollowMomentsPage />} />
        <Route path="/follows/:type" element={<FollowsPage />} />
        <Route path="/moment/:id" element={<MomentDetailPage />} />
        <Route path="/project/guide" element={<GuideProjectPage />} />
        <Route path="/edit-profile" element={<EditProfilePage />} />
        <Route path="/invite-card" element={<InviteCardPage />} />
        <Route path="/transfer" element={<TransferPage />} />
        <Route path="/gifts-received" element={<GiftsReceivedPage />} />
        <Route path="/u/:id" element={<UserHomePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
