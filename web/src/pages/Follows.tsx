import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';

/** 关注/粉丝列表条目（GET /user/follows/list） */
interface FollowUser {
  id: string;
  nickname: string;
  avatar: string;
  age: number;
  gender: number;
  cityName: string;
  signature: string;
  isGuide: boolean;
}

/** 关注/粉丝列表（我的页面点击数字进入），type = following | fans */
export function FollowsPage() {
  const nav = useNavigate();
  const { type } = useParams();
  const isFans = type === 'fans';
  const [list, setList] = useState<FollowUser[] | null>(null);

  useEffect(() => {
    api<FollowUser[]>(`/user/follows/list?type=${isFans ? 'fans' : 'following'}`)
      .then(setList)
      .catch(() => setList([]));
  }, [isFans]);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">{isFans ? '粉丝' : '关注'}</span>
      </div>
      <div className="page no-scrollbar">
        {list === null && <div className="empty">加载中…</div>}
        {list !== null && list.length === 0 && (
          <div className="empty">{isFans ? '还没有粉丝' : '还没有关注的人'}</div>
        )}
        {(list ?? []).map((u) => (
          <div
            key={u.id}
            onClick={() => nav(`/u/${u.id}`)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}
          >
            <div className="avatar" style={{ width: 46, height: 46, flexShrink: 0 }}>
              {u.avatar && <img src={u.avatar} alt="" />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{u.nickname}</span>
                {u.isGuide && (
                  <span style={{ fontSize: 10, color: 'var(--accent)', background: 'rgba(254,44,85,0.12)', borderRadius: 3, padding: '1px 5px' }}>认证</span>
                )}
              </div>
              {(u.signature || u.cityName) && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.signature || u.cityName}
                </div>
              )}
            </div>
            <span style={{ color: 'var(--text-3)', fontSize: 18 }}>›</span>
          </div>
        ))}
      </div>
    </div>
  );
}
