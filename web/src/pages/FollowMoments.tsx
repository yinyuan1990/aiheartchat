import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { MomentCard, MomentItem } from './Plaza';

/** 关注动态（原主页「关注」tab，入口移到「我的」） */
export function FollowMomentsPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<MomentItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<MomentItem[]>('/moments/feed?follow=1')
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const greet = async (m: MomentItem) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${m.user.id}`, { method: 'POST' });
      nav(`/chatroom/${r.conversationId}`, { state: { title: m.user.nickname, convType: 1, targetId: m.user.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">关注动态</span>
      </div>
      <div className="page no-scrollbar">
        {loaded && items.length === 0 && (
          <div className="empty">关注的人还没有动态<br />去遇见里关注一些人吧</div>
        )}
        {items.map((m) => (
          <MomentCard key={m.id} m={m} onOpenDetail={() => nav(`/moment/${m.id}`)} onGreet={() => greet(m)} />
        ))}
      </div>
    </div>
  );
}
