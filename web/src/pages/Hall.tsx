import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';

interface ProjectItem {
  id: number;
  name: string;
  desc: string;
  cover: string;
  type: string;
  entry: string;
}

const COVERS = [
  'linear-gradient(120deg, #3d0f1f 0%, #7a1f3d 55%, #b32b53 100%)',
  'linear-gradient(120deg, #101a2e 0%, #1c3a6e 60%, #2b5cb0 100%)',
  'linear-gradient(120deg, #241436 0%, #4a2580 60%, #7a3fd1 100%)',
];

/** 项目大厅：每个项目一张横幅卡；地陪是项目一，游戏等后台加卡即上线 */
export function HallPage() {
  const nav = useNavigate();
  const [projects, setProjects] = useState<ProjectItem[]>([]);

  useEffect(() => {
    api<ProjectItem[]>('/modules').then(setProjects).catch(() => {});
  }, []);

  const open = (p: ProjectItem) => {
    if (p.type === 'h5') {
      location.href = p.entry;
    } else if (p.entry === 'guide') {
      nav('/project/guide');
    }
  };

  return (
    <>
      <div className="page-title">大厅</div>
      <div style={{ padding: '4px 16px' }}>
        {projects.map((p, i) => (
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
        {projects.length === 0 && <div className="empty">暂无项目</div>}
        <div className="hint" style={{ marginTop: 4 }}>更多项目筹备中</div>
      </div>
    </>
  );
}
