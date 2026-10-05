import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { api } from '../api';
import { useApp } from '../store';
import { t } from '../i18n';

/** 地陪项目主页：项目内自己的规则与功能入口（独立页面，带返回栏） */
export function GuideProjectPage() {
  const nav = useNavigate();
  return (
    <div className="app">
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('guide.localBuddy')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page no-scrollbar" style={{ padding: '4px 16px' }}>
        <GuideProjectBody />
      </div>
    </div>
  );
}

/** 同城搭子内容区：功能入口 2x2 + 推荐搭子；大厅「同城搭子」tab 直接内联此组件 */
export function GuideProjectBody() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const isFemale = me?.gender === 2;
  const [guides, setGuides] = useState<any[]>([]);

  useEffect(() => {
    api<any[]>('/guide/list').then((list) => setGuides(list.slice(0, 6))).catch(() => {});
  }, []);

  const entries = [
    { title: t('guide.findBuddy'), desc: t('guide.findBuddyDesc'), to: '/people/guide' },
    { title: t('guide.findPeople'), desc: t('guide.findPeopleDesc'), to: '/people/all' },
    isFemale
      ? { title: t('guide.taskHall'), desc: t('guide.taskHallDesc'), to: '/task/hall' }
      : { title: t('guide.postTask'), desc: t('guide.postTaskDesc'), to: '/task/post' },
    { title: isFemale ? t('me.myTasksGuide') : t('me.myTasks'), desc: t('guide.myTasksDesc'), to: '/task/mine' },
  ];

  const greet = async (p: any) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${p.id}`, { method: 'POST' });
      if (openNativeChat(r.conversationId, 1, p.id, p.nickname)) return;
      nav(`/chatroom/${r.conversationId}`, { state: { title: p.nickname, convType: 1, targetId: p.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <>
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
            <span style={{ fontSize: 15, fontWeight: 600 }} className="grow">{t('guide.recommended')}</span>
            <span className="small" style={{ cursor: 'pointer' }} onClick={() => nav('/people/guide')}>{t('guide.viewAll')} ›</span>
          </div>
          {guides.map((p) => (
            <div key={p.id} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="avatar" style={{ width: 48, height: 48 }}>
                {p.avatar && <img src={p.avatar} alt="" />}
              </div>
              <div className="grow">
                <div style={{ fontSize: 15 }}>
                  {p.nickname} <span className="muted">· {p.age}</span>
                  <span className="tag tag-accent" style={{ marginLeft: 6 }}>{t('me.verified')}</span>
                </div>
                <div className="small ellipsis" style={{ marginTop: 3 }}>{p.cityName ? `${p.cityName} · ` : ''}{p.signature || t('people.mysterious')}</div>
              </div>
              <button className="btn-sm" onClick={() => greet(p)}>{t('people.sayHi')}</button>
            </div>
          ))}
        </>
      )}
      {guides.length === 0 && (
        <div className="empty" style={{ padding: 40 }}>{t('guide.noBuddies')}<br />{t('guide.noBuddiesHint')}</div>
      )}
    </>
  );
}
