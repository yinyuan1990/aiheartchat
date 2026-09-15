import { useEffect, useState } from 'react';
import { api, getToken, UserProfile } from '../api';
import { inNativeApp, openNativeWeb, WebOrientation } from '../bridge';
import { useApp } from '../store';
import { GuideProjectBody } from './GuideProject';
import { TreeholeFeed } from './Treehole';

interface ProjectItem {
  id: number;
  name: string;
  icon: string;
  desc: string;
  cover: string;
  /** native=客户端内置页 h5=横幅内嵌网页 game=小游戏（九宫格） */
  type: string;
  entry: string;
  /** 小游戏屏幕方向：portrait / landscape（App 游戏页按此旋转） */
  orientation?: string;
}

/** 大厅页版本标记，日志里用来确认 App 加载到的是不是新部署的 H5 */
const HALL_VERSION = '2026-09-15-hall-tabs-v3';

type HallTab = 'guide' | 'games' | 'treehole';
const TABS: { key: HallTab; label: string }[] = [
  { key: 'guide', label: '同城搭子' },
  { key: 'games', label: '休闲游戏' },
  { key: 'treehole', label: '私密树洞' },
];
const TAB_KEY = 'hall_tab';

const COVERS = [
  'linear-gradient(120deg, #3d0f1f 0%, #7a1f3d 55%, #b32b53 100%)',
  'linear-gradient(120deg, #101a2e 0%, #1c3a6e 60%, #2b5cb0 100%)',
  'linear-gradient(120deg, #241436 0%, #4a2580 60%, #7a3fd1 100%)',
];

/** 游戏链接占位符：{token} 登录态、{uid} 用户 ID（后台配置时选填，仅自有游戏用） */
function fillEntry(entry: string, uid: string): string {
  return entry
    .replace(/\{token\}/g, encodeURIComponent(getToken() ?? ''))
    .replace(/\{uid\}/g, encodeURIComponent(uid));
}

/**
 * 打开小游戏：App 内走原生全屏 WebView（独立于大厅页，带标题栏/关闭）；
 * 浏览器新标签打开；被拦截则当前页跳转。
 */
function openGameUrl(url: string, title: string, orientation: WebOrientation) {
  const w = window as any;
  console.log(
    `[Game] open url=${url} title=${title} orientation=${orientation} ` +
      `bridge: wk=${!!w.webkit?.messageHandlers?.peiwan} droid=${!!w.PeiwanNative} droid.openWeb=${typeof w.PeiwanNative?.openWeb}`,
  );
  if (openNativeWeb(url, title, orientation)) {
    console.log('[Game] native bridge accepted');
    return;
  }
  if (inNativeApp()) {
    console.log('[Game] in app but no openWeb bridge (old app), fallback location.href');
    location.href = url;
    return;
  }
  console.log('[Game] browser fallback window.open');
  const win = window.open(url, '_blank', 'noopener');
  if (!win) location.href = url;
}

/** 大厅：三个 tab —— 同城搭子（项目内容内联）/ 休闲游戏（九宫格）/ 私密树洞（匿名信息流） */
export function HallPage() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [tab, setTab] = useState<HallTab>(() => (sessionStorage.getItem(TAB_KEY) as HallTab) || 'guide');
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const switchTab = (t: HallTab) => {
    setTab(t);
    sessionStorage.setItem(TAB_KEY, t);
  };

  useEffect(() => {
    console.log(`[Game] hall mounted, version=${HALL_VERSION} path=${location.pathname}${location.hash}`);
    api<ProjectItem[]>('/modules')
      .then((list) => {
        console.log(
          `[Game] /modules ok: ${list.length} items, games=${list.filter((p) => p.type === 'game').length} ` +
            list.map((p) => `${p.type}:${p.name}${p.type === 'game' ? `(${p.orientation ?? 'portrait'})` : ''}`).join(', '),
        );
        setProjects(list);
      })
      .catch((e) => console.error('[Game] /modules failed', e?.message ?? e))
      .finally(() => setLoaded(true));
  }, []);

  // 内嵌模式只带 token 未拉用户资料；同城搭子入口按性别不同、游戏链接可能要 {uid}，补一次
  useEffect(() => {
    if (user) return;
    api<UserProfile>('/user/me').then(setUser).catch(() => {});
  }, [user]);

  // 除地陪（已内联）之外后台配置的其它横幅项目
  const extraBanners = projects.filter((p) => p.type !== 'game' && p.entry !== 'guide');
  const games = projects.filter((p) => p.type === 'game');

  const openBanner = (p: ProjectItem) => {
    if (p.type === 'h5') location.href = p.entry;
  };

  const openGame = (g: ProjectItem) => {
    console.log(`[Game] click game id=${g.id} name=${g.name}`);
    openGameUrl(fillEntry(g.entry, user?.id ?? ''), g.name, g.orientation === 'landscape' ? 'landscape' : 'portrait');
  };

  return (
    <>
      <div className="top-tabs">
        {TABS.map((t) => (
          <span key={t.key} className={`top-tab${tab === t.key ? ' active' : ''}`} onClick={() => switchTab(t.key)}>
            {t.label}
          </span>
        ))}
      </div>

      <div style={{ padding: '4px 16px' }}>
        {tab === 'guide' && (
          <>
            <GuideProjectBody />
            {extraBanners.map((p, i) => (
              <div
                key={p.id}
                onClick={() => openBanner(p)}
                style={{
                  position: 'relative', borderRadius: 16, overflow: 'hidden', cursor: 'pointer',
                  marginTop: 14, height: 120,
                  background: p.cover ? `url(${p.cover}) center/cover` : COVERS[i % COVERS.length],
                }}
              >
                <div style={{ position: 'absolute', left: 18, bottom: 16, right: 100 }}>
                  <div style={{ fontSize: 19, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 5 }}>{p.desc}</div>
                </div>
                <span style={{
                  position: 'absolute', right: 16, bottom: 16,
                  padding: '7px 20px', borderRadius: 16, fontSize: 13, fontWeight: 600,
                  background: 'rgba(255,255,255,0.92)', color: '#111',
                }}>
                  进入
                </span>
              </div>
            ))}
          </>
        )}

        {tab === 'games' && (
          <>
            {games.length > 0 && (
              <div className="game-grid">
                {games.map((g) => (
                  <div key={g.id} className="game-cell" onClick={() => openGame(g)}>
                    <img src={g.icon} alt={g.name} />
                    <div className="name ellipsis">{g.name}</div>
                    {g.desc && <div className="desc">{g.desc}</div>}
                  </div>
                ))}
              </div>
            )}
            {loaded && games.length === 0 && <div className="empty">游戏正在筹备中<br />敬请期待</div>}
          </>
        )}

        {tab === 'treehole' && <TreeholeFeed />}
      </div>
    </>
  );
}
