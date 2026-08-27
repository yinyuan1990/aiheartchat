import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints } from '../api';
import { useApp } from '../store';

const typeText: Record<string, string> = {
  admin_grant: '平台发放',
  gift_send: '送出礼物',
  gift_recv: '收到礼物',
  task_freeze: '约单托管',
  task_settle: '约单结算',
  task_refund: '约单退回',
  msg_fee: '发送消息',
  msg_income: '消息收入',
  call_fee: '视频通话',
  call_income: '通话收入',
  transfer_out: '转赠支出',
  transfer_in: '收到转赠',
  adjust: '调整',
};

const PAGE_SIZE = 30;

export function WalletPage() {
  const nav = useNavigate();
  const user = useApp((s) => s.user);
  const [wallet, setWallet] = useState<{ balance: string; frozen: string } | null>(null);
  const [txs, setTxs] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'txs' | 'rank'>('txs');
  const [rank, setRank] = useState<any[]>([]);
  const rankTitle = user?.gender === 2 ? '贡献榜' : '送花榜';

  useEffect(() => {
    if (tab === 'rank' && rank.length === 0) {
      api<any>('/wallet/contrib-rank').then((r) => setRank(r.list ?? [])).catch(() => {});
    }
  }, [tab]);

  const loadMore = async (reset = false) => {
    if (loading) return;
    setLoading(true);
    try {
      const cur = reset ? [] : txs;
      const last = cur[cur.length - 1];
      const list = await api<any[]>(`/wallet/transactions${last ? `?beforeId=${last.id}` : ''}`);
      setTxs([...cur, ...list]);
      setHasMore(list.length >= PAGE_SIZE);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api<any>('/wallet').then(setWallet).catch(() => {});
    loadMore(true).catch(() => {});
  }, []);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ 返回</span>
        <span className="title">积分明细</span>
        <span className="action" onClick={() => nav('/transfer')}>转赠</span>
      </div>
      {/* 积分卡固定在顶部，不随流水滚动 */}
      <div style={{ padding: '16px 16px 0' }}>
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <div className="muted">可用积分</div>
          <div style={{ fontSize: 38, fontWeight: 700, margin: '8px 0' }}>{wallet ? fmtPoints(wallet.balance) : '…'}</div>
          <div className="small">冻结中 {fmtPoints(wallet?.frozen)}</div>
          <button className="btn-sm" style={{ marginTop: 14 }} onClick={() => nav('/transfer')}>转赠积分</button>
        </div>
      </div>

      {/* 明细 / 榜单切换 */}
      <div className="row" style={{ padding: '14px 16px 0', gap: 10 }}>
        {([['txs', '明细'], ['rank', rankTitle]] as const).map(([key, label]) => (
          <span
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '6px 18px', borderRadius: 16, fontSize: 13, cursor: 'pointer',
              background: tab === key ? 'var(--accent-grad)' : 'var(--bg-input)',
              color: tab === key ? '#fff' : 'var(--text-2)',
              fontWeight: tab === key ? 600 : 400,
            }}
          >
            {label}
          </span>
        ))}
      </div>

      <div className="page" style={{ padding: '0 16px 16px' }}>
        {tab === 'txs' && (
          <>
            {txs.length === 0 && !loading && <div className="empty" style={{ padding: 30 }}>暂无流水</div>}
            {txs.map((t) => (
              <div key={t.id} className="row" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="grow">
                  <div style={{ fontSize: 14 }}>{typeText[t.type] ?? t.type}</div>
                  <div className="small">{t.remark} · {new Date(t.createdAt).toLocaleString('zh-CN')}</div>
                </div>
                <div style={{ fontWeight: 600, color: BigInt(t.amount) >= 0n ? 'var(--success)' : 'var(--text)' }}>
                  {BigInt(t.amount) >= 0n ? '+' : '-'}{fmtPoints(BigInt(t.amount) < 0n ? -BigInt(t.amount) : t.amount)}
                </div>
              </div>
            ))}
            {hasMore && (
              <div style={{ textAlign: 'center', padding: 14 }}>
                <button className="btn-sm" disabled={loading} onClick={() => loadMore()}>
                  {loading ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'rank' && (
          <>
            {rank.length === 0 && <div className="empty" style={{ padding: 30 }}>暂无数据</div>}
            {rank.map((r, i) => (
              <div key={r.userId} className="row" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)', gap: 12 }}>
                <span style={{
                  width: 24, textAlign: 'center', fontWeight: 700, fontStyle: 'italic',
                  color: i < 3 ? 'var(--accent)' : 'var(--text-3)', fontSize: i < 3 ? 17 : 14,
                }}>
                  {i + 1}
                </span>
                <div className="avatar" style={{ width: 40, height: 40 }}>
                  {r.avatar && <img src={r.avatar} alt="" />}
                </div>
                <div className="grow">
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{r.nickname}</div>
                  <div className="small">
                    礼物 {fmtPoints(r.giftFen)} · 通话 {fmtPoints(r.callFen)} · 消息 {fmtPoints(r.msgFen)}
                  </div>
                </div>
                <div style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmtPoints(r.totalFen)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
