import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtPoints } from '../api';
import { useApp } from '../store';
import { t } from '../i18n';

const typeText: Record<string, string> = {
  admin_grant: t('wallet.tx.adminGrant'),
  gift_send: t('wallet.tx.giftSend'),
  gift_recv: t('wallet.tx.giftRecv'),
  task_freeze: t('wallet.tx.taskFreeze'),
  task_settle: t('wallet.tx.taskSettle'),
  task_refund: t('wallet.tx.taskRefund'),
  msg_fee: t('wallet.tx.msgFee'),
  msg_income: t('wallet.tx.msgIncome'),
  call_fee: t('wallet.tx.callFee'),
  call_income: t('wallet.tx.callIncome'),
  transfer_out: t('wallet.tx.transferOut'),
  transfer_in: t('wallet.tx.transferIn'),
  adjust: t('wallet.tx.adjust'),
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
  const rankTitle = user?.gender === 2 ? t('wallet.rankContrib') : t('wallet.rankGifting');

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
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('wallet.title')}</span>
        <span className="action" onClick={() => nav('/transfer')}>{t('wallet.transfer')}</span>
      </div>
      {/* 积分卡固定在顶部，不随流水滚动 */}
      <div style={{ padding: '16px 16px 0' }}>
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <div className="muted">{t('wallet.available')}</div>
          <div style={{ fontSize: 38, fontWeight: 700, margin: '8px 0' }}>{wallet ? fmtPoints(wallet.balance) : '…'}</div>
          <div className="small">{t('wallet.frozenN', { n: fmtPoints(wallet?.frozen) })}</div>
          <button className="btn-sm" style={{ marginTop: 14 }} onClick={() => nav('/transfer')}>{t('wallet.transferPoints')}</button>
        </div>
      </div>

      {/* 明细 / 榜单切换 */}
      <div className="row" style={{ padding: '14px 16px 0', gap: 10 }}>
        {([['txs', t('wallet.tabTxs')], ['rank', rankTitle]] as const).map(([key, label]) => (
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
            {txs.length === 0 && !loading && <div className="empty" style={{ padding: 30 }}>{t('wallet.noTxs')}</div>}
            {txs.map((tx) => (
              <div key={tx.id} className="row" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="grow">
                  <div style={{ fontSize: 14 }}>{typeText[tx.type] ?? tx.type}</div>
                  <div className="small">{tx.remark} · {new Date(tx.createdAt).toLocaleString('zh-CN')}</div>
                </div>
                <div style={{ fontWeight: 600, color: BigInt(tx.amount) >= 0n ? 'var(--success)' : 'var(--text)' }}>
                  {BigInt(tx.amount) >= 0n ? '+' : '-'}{fmtPoints(BigInt(tx.amount) < 0n ? -BigInt(tx.amount) : tx.amount)}
                </div>
              </div>
            ))}
            {hasMore && (
              <div style={{ textAlign: 'center', padding: 14 }}>
                <button className="btn-sm" disabled={loading} onClick={() => loadMore()}>
                  {loading ? t('common.loading') : t('wallet.loadMore')}
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'rank' && (
          <>
            {rank.length === 0 && <div className="empty" style={{ padding: 30 }}>{t('wallet.noData')}</div>}
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
                    {t('wallet.rankBreakdown', { gift: fmtPoints(r.giftFen), call: fmtPoints(r.callFen), msg: fmtPoints(r.msgFen) })}
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
