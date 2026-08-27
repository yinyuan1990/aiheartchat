import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';

/** 地陪项目主页：项目内自己的规则与功能入口 */
export function GuideProjectPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const isFemale = me?.gender === 2;
  const [guides, setGuides] = useState<any[]>([]);

  useEffect(() => {
    api<any[]>('/guide/list').then((list) => setGuides(list.slice(0, 6))).catch(() => {});
  }, []);

  const entries = [
    { title: '找搭子', desc: '按城市寻找认证搭子', to: '/people/guide' },
    { title: '找人', desc: '发现新朋友打招呼', to: '/people/all' },
    isFemale
      ? { title: '接单大厅', desc: '报名接单赚积分', to: '/task/hall' }
      : { title: '发布约单', desc: '时间地点报酬托管', to: '/task/post' },
    { title: isFemale ? '我的接单' : '我的约单', desc: '查看进行中的约单', to: '/task/mine' },
  ];

  const greet = async (p: any) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${p.id}`, { method: 'POST' });
      nav(`/chatroom/${r.conversationId}`, { state: { title: p.nickname, convType: 1, targetId: p.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">同城搭子</span>
        <span style={{ width: 40 }} />
      </div>

      <div className="page no-scrollbar" style={{ padding: '4px 16px' }}>
        {/* 功能入口 2x2 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {entries.map((e) => (
            <div
              key={e.title}
              onClick={() => nav(e.to)}
              style={{ padding: '18px 16px', borderRadius: 14, background: 'var(--bg-card)', cursor: 'pointer' }}
            >
              <div style={{ fontSize: 16, fontWeight: 600 }}>{e.title}</div>
              <div className="small" style={{ marginTop: 5 }}>{e.desc}</div>
            </div>
          ))}
        </div>

        {/* 推荐地陪 */}
        {guides.length > 0 && (
          <>
            <div className="row" style={{ margin: '20px 0 10px' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }} className="grow">推荐搭子</span>
              <span className="small" style={{ cursor: 'pointer' }} onClick={() => nav('/people/guide')}>全部 ›</span>
            </div>
            {guides.map((p) => (
              <div key={p.id} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="avatar" style={{ width: 48, height: 48 }}>
                  {p.avatar && <img src={p.avatar} alt="" />}
                </div>
                <div className="grow">
                  <div style={{ fontSize: 15 }}>
                    {p.nickname} <span className="muted">· {p.age}</span>
                    <span className="tag tag-accent" style={{ marginLeft: 6 }}>认证</span>
                  </div>
                  <div className="small ellipsis" style={{ marginTop: 3 }}>{p.cityName ? `${p.cityName} · ` : ''}{p.signature || '这个人很神秘'}</div>
                </div>
                <button className="btn-sm" onClick={() => greet(p)}>打招呼</button>
              </div>
            ))}
          </>
        )}
        {guides.length === 0 && (
          <div className="empty" style={{ padding: 40 }}>暂无认证搭子<br />可以先去「找人」打招呼</div>
        )}
      </div>
    </div>
  );
}
