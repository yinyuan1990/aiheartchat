import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { api } from '../api';
import { t } from '../i18n';

interface PersonItem {
  id: string;
  nickname: string;
  avatar: string;
  age: number;
  cityName: string;
  signature: string;
  isGuide: boolean;
  albums?: { id: string; type: number; url: string; coverUrl: string }[];
}

/** 找地陪 / 找人：mode = guide | all */
export function PeoplePage() {
  const nav = useNavigate();
  const { mode } = useParams<{ mode: string }>();
  const [tab, setTab] = useState(mode === 'guide' ? 'guide' : 'all');
  const [items, setItems] = useState<PersonItem[]>([]);
  const [city, setCity] = useState('');

  useEffect(() => {
    const path = tab === 'guide' ? '/guide/list' : '/guide/discover';
    api<PersonItem[]>(path).then(setItems).catch(() => {});
  }, [tab]);

  const greet = async (p: PersonItem) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${p.id}`, { method: 'POST' });
      if (openNativeChat(r.conversationId, 1, p.id, p.nickname)) return;
      nav(`/chatroom/${r.conversationId}`, { state: { title: p.nickname, convType: 1, targetId: p.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{tab === 'guide' ? t('guide.findBuddy') : t('guide.findPeople')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="top-tabs">
        <span className={`top-tab${tab === 'guide' ? ' active' : ''}`} onClick={() => setTab('guide')}>{t('me.verified')}</span>
        <span className={`top-tab${tab === 'all' ? ' active' : ''}`} onClick={() => setTab('all')}>{t('guide.viewAll')}</span>
      </div>
      <div className="page">
        {items.length === 0 && <div className="empty">{tab === 'guide' ? t('guide.noBuddies') : t('people.noUsers')}</div>}
        {items.map((p) => (
          <div key={p.id} className="card" style={{ margin: '0 16px 8px' }}>
            <div className="row">
              <div className="avatar" style={{ width: 56, height: 56 }}>
                {p.avatar && <img src={p.avatar} alt="" />}
              </div>
              <div className="grow">
                <div style={{ fontSize: 15 }}>
                  {p.nickname} <span className="muted">· {p.age}</span>
                  {p.isGuide && <span className="tag tag-accent" style={{ marginLeft: 6 }}>{t('me.verified')}</span>}
                </div>
                <div className="muted ellipsis" style={{ marginTop: 4 }}>{p.signature || t('people.mysterious')}</div>
                {p.cityName && <div className="small" style={{ marginTop: 2 }}>{p.cityName}</div>}
              </div>
              <button className="btn-sm" onClick={() => greet(p)}>{t('people.sayHi')}</button>
            </div>
            {p.albums && p.albums.length > 0 && (
              <div className="grid-photos">
                {p.albums.slice(0, 3).map((a) => (
                  <img key={a.id} src={a.type === 2 ? a.coverUrl : a.url} alt="" />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
