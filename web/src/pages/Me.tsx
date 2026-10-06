import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints, UserProfile } from '../api';
import { useApp } from '../store';
import { ScanFlow } from './ChatList';
import { ScanIcon } from '../components/QrScanner';
import { SYSTEM, langChoice, languages, setLang, t } from '../i18n';

export function MePage() {
  const nav = useNavigate();
  const { user, setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(user);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    api<UserProfile>('/user/me').then((u) => {
      setMe(u);
      setUser(u);
    }).catch(() => {});
  }, []);

  if (!me) return <div className="empty">{t('common.loading')}</div>;
  const choice = langChoice();
  const langName = choice === SYSTEM ? t('lang.system') : languages.find((l) => l.code === choice)?.name ?? choice;

  return (
    // 头部（头像到积分余额）固定不动，下面的功能分组单独滚动
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部渐变背景 */}
      <div style={{ background: 'linear-gradient(180deg, rgba(254,44,85,0.14), transparent 85%)', padding: '28px 20px 0', flexShrink: 0 }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 76, height: 76, border: '2px solid rgba(0,0,0,0.08)' }}>
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
                {me.gender === 1 ? t('me.male') : t('me.female')} {me.age}
              </span>
              {me.isGuide && <span className="tag tag-accent">{t('me.verified')}</span>}
              {me.cityName && <span className="tag tag-muted">{me.cityName}</span>}
            </div>
            {me.shortId && (
              <div
                className="small"
                style={{ marginTop: 6, cursor: 'pointer' }}
                onClick={() => navigator.clipboard?.writeText(me.shortId!)}
              >
                {t('me.idCopy', { id: me.shortId })}
              </div>
            )}
          </div>
          {/* 扫一扫（邀请名片 / 群二维码） */}
          <div
            title={t('me.scan')}
            onClick={() => setScanning(true)}
            style={{
              width: 38, height: 38, borderRadius: 19, flexShrink: 0, marginTop: 4,
              background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ScanIcon />
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6 }}>
          {me.signature || t('me.noSignatureHint')}
        </div>

        {/* 关注 / 粉丝：点击进列表 */}
        <div className="row" style={{ gap: 26, marginTop: 16 }}>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/following')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.following ?? 0}</b>{t('me.following')}
          </span>
          <span style={{ fontSize: 13, cursor: 'pointer' }} className="muted" onClick={() => nav('/follows/fans')}>
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.fans ?? 0}</b>{t('me.fans')}
          </span>
        </div>

        {/* 积分余额：融合进头部（玻璃质感行，点击进钱包） */}
        <div
          onClick={() => nav('/wallet')}
          style={{
            margin: '16px 0 18px', borderRadius: 14, padding: '12px 16px', cursor: 'pointer',
            background: 'rgba(0,0,0,0.035)',
            border: '1px solid rgba(254,44,85,0.25)',
            display: 'flex', alignItems: 'center',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('me.balance')}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--accent)' }}>{fmtPoints(me.balance)}</div>
          </div>
          <div style={{ textAlign: 'right', color: 'var(--text-2)' }}>
            <div style={{ fontSize: 11 }}>{t('me.frozen', { n: fmtPoints(me.frozen) })}</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>{t('me.details')}</div>
          </div>
        </div>
      </div>

      {/* 功能分组：我的内容 / 同城搭子 / 工具 / 设置 */}
      <div className="me-groups no-scrollbar">
        <div className="me-group-title">{t('me.group.content')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/my-moments')}>{t('me.myMoments')}</div>
          <div className="list-row" onClick={() => nav('/follow-moments')}>{t('me.followMoments')}</div>
          <div className="list-row" onClick={() => nav('/gifts-received')}>{t('me.gifts')}</div>
        </div>
        <div className="me-group-title">{t('me.group.buddy')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/task/mine')}>{me.gender === 2 ? t('me.myTasksGuide') : t('me.myTasks')}</div>
          {/* 搭子认证已合并实名认证（申请时提交姓名+身份证，审核通过即实名） */}
          {!me.isGuide && <div className="list-row" onClick={() => nav('/guide-apply')}>{t('me.guideApply')}</div>}
        </div>
        <div className="me-group-title">{t('me.group.tools')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/bots')}>{t('me.bots')}</div>
          <div className="list-row" onClick={() => nav('/invite-card')}>{t('me.inviteCard')}</div>
        </div>
        <div className="me-group-title">{t('me.group.settings')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/edit-profile')}>{t('me.editProfile')}</div>
          <div className="list-row" onClick={() => setPicking(true)}>
            <span style={{ flex: 1 }}>{t('lang.title')}</span>
            <span className="muted" style={{ fontSize: 14, marginRight: 6 }}>{langName}</span>
          </div>
        </div>
      </div>

      {/* 扫一扫：邀请名片 → 私聊；群邀请码 → 加群；收款码 → 提示 */}
      {scanning && <ScanFlow onClose={() => setScanning(false)} />}

      {/* 语言：跟随系统 + 打包进来的每种语言（名字用各自的语言写） */}
      {picking && (
        <div className="mask" onClick={() => setPicking(false)}>
          <div className="card" style={{ width: 280, padding: '8px 0' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 20px', fontSize: 16, fontWeight: 600 }}>{t('lang.title')}</div>
            {[{ code: SYSTEM, name: t('lang.system') }, ...languages].map((l) => (
              <div key={l.code} style={{ display: 'flex', padding: '14px 20px', fontSize: 15, cursor: 'pointer' }} onClick={() => (l.code === choice ? setPicking(false) : setLang(l.code))}>
                <span style={{ flex: 1 }}>{l.name}</span>
                {l.code === choice && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
