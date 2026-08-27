import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints, UserProfile } from '../api';
import { useApp } from '../store';

export function MePage() {
  const nav = useNavigate();
  const { user, setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(user);

  useEffect(() => {
    api<UserProfile>('/user/me').then((u) => {
      setMe(u);
      setUser(u);
    }).catch(() => {});
  }, []);

  if (!me) return <div className="empty">加载中…</div>;

  return (
    <div className="no-scrollbar" style={{ overflowY: 'auto', height: '100%' }}>
      {/* 顶部渐变背景 */}
      <div style={{ background: 'linear-gradient(180deg, rgba(254,44,85,0.14), transparent 85%)', padding: '28px 20px 0' }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 76, height: 76, border: '2px solid rgba(255,255,255,0.15)' }}>
            {me.avatar ? <img src={me.avatar} alt="" /> : null}
          </div>
          <div className="grow" style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 21, fontWeight: 700 }}>{me.nickname}</div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <span style={{
                padding: '2px 10px', borderRadius: 10, fontSize: 11,
                background: me.gender === 1 ? 'rgba(64,156,255,0.18)' : 'rgba(254,44,85,0.18)',
                color: me.gender === 1 ? '#6db3ff' : '#ff7a95',
              }}>
                {me.gender === 1 ? '男' : '女'} {me.age}
              </span>
              {me.isGuide && <span className="tag tag-accent">认证</span>}
              {me.cityName && <span className="tag tag-muted">{me.cityName}</span>}
            </div>
            {me.shortId && (
              <div
                className="small"
                style={{ marginTop: 6, cursor: 'pointer' }}
                onClick={() => navigator.clipboard?.writeText(me.shortId!)}
              >
                ID：{me.shortId}（点击复制）
              </div>
            )}
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6 }}>
          {me.signature || '还没有签名，写一句介绍自己吧'}
        </div>

        {/* 关注 / 粉丝：点击进列表 */}
        <div className="row" style={{ gap: 26, marginTop: 16 }}>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/following')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.following ?? 0}</b>关注
          </span>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/fans')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.fans ?? 0}</b>粉丝
          </span>
        </div>

        {/* 积分余额：融合进头部（玻璃质感行，点击进钱包） */}
        <div
          onClick={() => nav('/wallet')}
          style={{
            margin: '16px 0 18px', borderRadius: 14, padding: '12px 16px', cursor: 'pointer',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(254,44,85,0.25)',
            display: 'flex', alignItems: 'center',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>积分余额</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--accent)' }}>{fmtPoints(me.balance)}</div>
          </div>
          <div style={{ textAlign: 'right', color: 'var(--text-2)' }}>
            <div style={{ fontSize: 11 }}>冻结 {fmtPoints(me.frozen)}</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>明细 ›</div>
          </div>
        </div>
      </div>

      {/* 菜单分组 */}
      <div className="card" style={{ margin: '14px 16px 0', padding: '4px 0' }}>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/edit-profile')}>编辑资料</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/my-moments')}>我的动态</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/follow-moments')}>关注动态</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/task/mine')}>{me.gender === 2 ? '我的接单' : '我的约单'}</div>
        <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/gifts-received')}>收到的礼物</div>
      </div>
      {/* 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名） */}
      {!me.isGuide && (
        <div className="card" style={{ margin: '10px 16px 24px', padding: '4px 0' }}>
          <div className="list-row" style={{ border: 'none' }} onClick={() => nav('/guide-apply')}>搭子认证</div>
        </div>
      )}
    </div>
  );
}
