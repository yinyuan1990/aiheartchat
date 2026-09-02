import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, UserProfile } from '../api';
import { inNativeApp, openNativeWeb, WebOrientation } from '../bridge';
import { useApp } from '../store';

interface ProjectItem {
  id: number;
  name: string;
  icon: string;
  desc: string;
  cover: string;
  /** native=客户端内置页 h5=横幅内嵌网页 game=小游戏（宫格） */
  type: string;
  entry: string;
  /** 小游戏屏幕方向：portrait / landscape（App 游戏页按此旋转） */
  orientation?: string;
}

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
  if (openNativeWeb(url, title, orientation)) return;
  if (inNativeApp()) {
    location.href = url;
    return;
  }
  const w = window.open(url, '_blank', 'noopener');
  if (!w) location.href = url;
}

/** 项目大厅：横幅项目卡 + 小游戏宫格，均由后台配置 */
export function HallPage() {
  const nav = useNavigate();
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<ProjectItem[]>('/modules')
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // 内嵌模式只带 token 未拉用户资料；有游戏链接需要 {uid} 时补一次
  useEffect(() => {
    if (user || !projects.some((p) => p.type === 'game' && p.entry.includes('{uid}'))) return;
    api<UserProfile>('/user/me').then(setUser).catch(() => {});
  }, [projects, user]);

  const banners = projects.filter((p) => p.type !== 'game');
  const games = projects.filter((p) => p.type === 'game');

  const open = (p: ProjectItem) => {
    if (p.type === 'h5') {
      location.href = p.entry;
    } else if (p.entry === 'guide') {
      nav('/project/guide');
    }
  };

  const openGame = (g: ProjectItem) => {
    openGameUrl(fillEntry(g.entry, user?.id ?? ''), g.name, g.orientation === 'landscape' ? 'landscape' : 'portrait');
  };

  return (
    <>
      <div className="page-title">大厅</div>
      <div style={{ padding: '4px 16px' }}>
        {banners.map((p, i) => (
          <div
            key={p.id}
            onClick={() => open(p)}
            style={{
              position: 'relative', borderRadius: 16, overflow: 'hidden', cursor: 'pointer',
              marginBottom: 14, height: 132,
              background: p.cover ? `url(${p.cover}) center/cover` : COVERS[i % COVERS.length],
            }}
          >
            {/* 左下信息 */}
            <div style={{ position: 'absolute', left: 18, bottom: 16, right: 100 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 5 }}>{p.desc}</div>
            </div>
            {/* 右下进入按钮 */}
            <span style={{
              position: 'absolute', right: 16, bottom: 16,
              padding: '7px 20px', borderRadius: 16, fontSize: 13, fontWeight: 600,
              background: 'rgba(255,255,255,0.92)', color: '#111',
            }}>
              进入
            </span>
            {/* 顶部微光 */}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(255,255,255,0.08), transparent 40%)' }} />
          </div>
        ))}

        {games.length > 0 && (
          <div className="card" style={{ padding: '14px 8px 6px', marginTop: banners.length ? 4 : 0 }}>
            <div className="row" style={{ padding: '0 8px 12px', alignItems: 'baseline' }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>小游戏</span>
              <span style={{ fontSize: 12, color: 'var(--text-2)', marginLeft: 8 }}>随时开一局</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', rowGap: 14 }}>
              {games.map((g) => (
                <div
                  key={g.id}
                  onClick={() => openGame(g)}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', padding: '0 4px' }}
                >
                  <img
                    src={g.icon}
                    alt={g.name}
                    style={{ width: 56, height: 56, borderRadius: 16, objectFit: 'cover', background: 'var(--bg-input)' }}
                  />
                  <div style={{ fontSize: 13, marginTop: 8, maxWidth: '100%' }} className="ellipsis">{g.name}</div>
                  {g.desc && (
                    <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 3, maxWidth: '100%', textAlign: 'center' }} className="ellipsis">
                      {g.desc}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {loaded && projects.length === 0 && <div className="empty">暂无项目</div>}
        <div className="hint" style={{ marginTop: 4 }}>更多项目筹备中</div>
      </div>
    </>
  );
}
