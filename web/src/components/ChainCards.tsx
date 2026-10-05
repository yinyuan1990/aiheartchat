import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { wsManager } from '../ws';
import { t } from '../i18n';

/**
 * 链上钱包的聊天卡片（和 Android ChainCards.kt、iOS ChainCards.swift 同一套字段）。网页版没有钱包：
 * - transfer：服务端核对过链上交易的转账卡片，点开看区块浏览器；
 * - callout：喊单卡片，点开去网页看这个币的行情（App 里会在钱包打开、能直接买）；
 * - payreq：收款消息，显示二维码和地址（App 里能点「转账」）。
 */

const CHAIN_NAMES: Record<string, string> = { arc: 'Arc', eth: 'Ethereum', bsc: 'BNB Chain', base: 'Base', arb: 'Arbitrum', polygon: 'Polygon', sol: 'Solana', trx: 'TRON', ton: 'TON' };
const EXPLORERS: Record<string, string> = {
  arc: 'https://arc-scan.org/tx/', eth: 'https://etherscan.io/tx/', bsc: 'https://bscscan.com/tx/', base: 'https://basescan.org/tx/',
  arb: 'https://arbiscan.io/tx/', polygon: 'https://polygonscan.com/tx/', sol: 'https://solscan.io/tx/', trx: 'https://tronscan.org/#/transaction/',
  ton: 'https://tonviewer.com/transaction/',
};

const parse = (s: string): Record<string, any> => {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
};

/** 最小单位 → 人看的数量（最多 6 位小数） */
export function tokenAmount(raw: unknown, decimals: number): string {
  const s = String(raw ?? '');
  if (!/^\d+$/.test(s)) return '?';
  const pad = s.padStart(decimals + 1, '0');
  const int = pad.slice(0, pad.length - decimals) || '0';
  const frac = pad.slice(pad.length - decimals).slice(0, 6).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

const usd = (v: unknown) => {
  if (typeof v !== 'number' || !(v > 0)) return null;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(4))}`;
};

/** 会话列表 / 引用里的一行预览；不是卡片返回 null */
export function chainCardPreview(type: string, content: string): string | null {
  const o = parse(content);
  if (type === 'transfer') return t('card.preview.transfer', { amount: tokenAmount(o.amount, Number(o.decimals) || 0), symbol: o.symbol ?? '' }).trim();
  if (type === 'callout') return t('card.preview.callout', { symbol: o.symbol ?? '' });
  if (type === 'perp') return t('card.preview.perp', { side: o.side === 'short' ? t('card.short') : t('card.long'), coin: o.coin ?? '', lev: o.lev ?? '' });
  if (type === 'payreq') return o.amount ? t('card.preview.payreq', { amount: tokenAmount(o.amount, Number(o.decimals) || 0), symbol: o.symbol ?? '' }).trim() : t('card.preview.payreqChain', { chain: CHAIN_NAMES[o.chain] ?? o.chain ?? '' });
  return null;
}

/** 收款消息：二维码 + 地址（点一下复制）+ 可选的币和金额；网页版没有钱包，「转账」要在 App 里点 */
export function PayreqCard({ content, mine }: { content: string; mine: boolean }) {
  const o = parse(content);
  const address = String(o.address ?? '');
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(address, { margin: 1, width: 280 }).then((u) => alive && setQr(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);
  const chain = CHAIN_NAMES[o.chain] ?? o.chain;
  const amount = o.amount ? `${tokenAmount(o.amount, Number(o.decimals) || 0)} ${o.symbol ?? ''}` : null;
  return (
    <span className="no-menu" style={{ display: 'flex', flexDirection: 'column', width: 230, borderRadius: 14, overflow: 'hidden', background: '#fff', border: '1px solid #f59e0b' }}>
      <span style={{ padding: '9px 12px', background: '#f59e0b', color: '#fff', fontSize: 13, fontWeight: 600 }}>⇄ {t('card.payreq.title', { chain })}</span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 12, color: '#111' }}>
        <span style={{ fontSize: amount ? 20 : 14, fontWeight: 600 }}>{amount ?? (o.symbol ? t('card.payreq.receive', { symbol: o.symbol }) : t('card.payreq.anyAmount'))}</span>
        {o.note && <span style={{ fontSize: 12, color: '#555' }}>{o.note}</span>}
        {qr && <img src={qr} alt={t('card.payreq.qrAlt')} style={{ width: 140, height: 140 }} />}
        <span
          onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true))}
          style={{ fontSize: 11, wordBreak: 'break-all', textAlign: 'center', background: '#f4f4f5', borderRadius: 8, padding: '6px 8px', cursor: 'pointer' }}
        >
          {address}
        </span>
        <span style={{ fontSize: 10, color: '#888' }}>{copied ? t('card.payreq.copied') : `${t('card.payreq.tip', { chain })}${mine ? '' : ` · ${t('card.payreq.appTip')}`}`}</span>
      </span>
    </span>
  );
}

function calloutUrl(o: Record<string, any>) {
  const addr = String(o.address ?? '');
  if (o.chain === 'sol') return `https://pump.fun/coin/${addr}`;
  if (o.chain === 'arc') return `https://arm.yyheart.com/token/${addr}`;
  return `https://dexscreener.com/${({ eth: 'ethereum', arb: 'arbitrum' } as Record<string, string>)[o.chain] ?? o.chain}/${addr}`;
}

export function TransferCard({ content, mine }: { content: string; mine: boolean }) {
  const o = parse(content);
  const url = o.hash && EXPLORERS[o.chain] ? EXPLORERS[o.chain] + o.hash : null;
  return (
    <span
      className="no-menu"
      onClick={() => url && window.open(url, '_blank', 'noopener')}
      style={{ display: 'flex', flexDirection: 'column', width: 220, borderRadius: 14, overflow: 'hidden', background: '#f59e0b', border: '1px solid #f59e0b', cursor: url ? 'pointer' : 'default' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', color: '#fff' }}>
        <span style={{ width: 38, height: 38, borderRadius: 19, background: 'rgba(255,255,255,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>⇄</span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 17, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {tokenAmount(o.amount, Number(o.decimals) || 0)} {o.symbol}
          </span>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{mine ? t('card.transfer.sent') : t('card.transfer.received')}</span>
        </span>
      </span>
      <span style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 14px', background: '#fff4de', fontSize: 11, color: '#9a5b00' }}>
        <span>{t('card.transfer.onchain', { chain: CHAIN_NAMES[o.chain] ?? o.chain })}</span>
        {o.verified && <span style={{ color: '#16a34a' }}>{t('card.transfer.verified')}</span>}
      </span>
    </span>
  );
}

/**
 * 合约喊单（msgType perp）：喊单者真实仓位的实时状态。聊天页 wsManager.perpWatch 告诉服务端在看哪些卡片，服务端每 3 秒
 * 推 perpTick（行情价 + 变了的状态）；持仓中的收益率用最新价现算。网页版没有钱包，跟单要在 App 里点。
 */
const perpStatuses = new Map<string, Record<string, any>>();
const perpMarks = new Map<string, number>();
wsManager.on((f) => {
  if (f?.op !== 'perpTick') return;
  for (const [k, v] of Object.entries((f.marks ?? {}) as Record<string, number>)) perpMarks.set(k, v);
  for (const [k, v] of Object.entries((f.statuses ?? {}) as Record<string, Record<string, any>>)) perpStatuses.set(k, v);
});

const perpPx = (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v >= 1 ? String(Number(v.toFixed(4))) : String(Number(v.toPrecision(4))));
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const roe = (entry: number, price: number, lev: number, long: boolean) => (price / entry - 1) * lev * (long ? 100 : -100);

export function PerpCard({ id, content }: { id: string; content: string }) {
  const o = parse(content);
  const [, redraw] = useState(0);
  useEffect(() => wsManager.on((f) => f?.op === 'perpTick' && (f.statuses?.[id] || f.marks?.[o.coin]) && redraw((n) => n + 1)), [id, o.coin]);
  const long = o.side !== 'short';
  const lev = Number(o.lev) || 1;
  const entry = Number(o.entry) || 0;
  const st = perpStatuses.get(id) ?? {};
  const mark = perpMarks.get(o.coin);
  const up = '#22c55e', down = '#ef4444';
  let label = t('card.perp.loading'), value = '', color = 'rgba(255,255,255,.5)';
  if (st.state === 'open') {
    const e = Number(st.entry) || entry;
    const r = mark && e ? roe(e, mark, Number(st.lev) || lev, long) : Number(st.roe) || 0;
    [label, value, color] = [t('card.perp.open'), pct(r), r >= 0 ? up : down];
  } else if (st.state === 'closed') {
    const r = entry && st.exit ? roe(entry, Number(st.exit), lev, long) : 0;
    const why = ({ tp: t('card.perp.tpHit'), sl: t('card.perp.slHit'), liq: t('card.perp.liq') } as Record<string, string>)[st.reason] ?? t('card.perp.closed');
    [label, value, color] = st.reason === 'liq' ? [why, '-100%', down] : [why, pct(r), r >= 0 ? up : down];
  } else if (st.state === 'pending') [label, value, color] = [t('card.perp.pending'), st.px ? `@ ${perpPx(Number(st.px))}` : '', 'rgba(255,255,255,.7)'];
  else if (st.state === 'none') label = t('card.perp.none');
  const cell = (k: string, v: unknown) => (
    <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 10, opacity: 0.5 }}>{k}</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>{typeof v === 'number' && v > 0 ? perpPx(v) : '—'}</span>
    </span>
  );
  return (
    <span className="no-menu" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 240, padding: 12, borderRadius: 14, background: '#0f1115', color: '#fff' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{o.coin}-USD</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: long ? up : down, background: long ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.18)', borderRadius: 6, padding: '2px 6px' }}>
          {long ? t('card.long') : t('card.short')} {lev}x
        </span>
        <span style={{ flex: 1 }} />
        {mark && <span style={{ fontSize: 12, opacity: 0.7 }}>{perpPx(mark)}</span>}
      </span>
      <span style={{ display: 'flex', gap: 4 }}>
        {cell(o.orderType === 'limit' ? t('card.perp.limit') : t('card.perp.entry'), o.entry)}
        {cell(t('card.perp.tp'), o.tp)}
        {cell(t('card.perp.sl'), o.sl)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', background: '#1b1f27', borderRadius: 10, padding: '8px 10px' }}>
        <span style={{ fontSize: 12, opacity: 0.75, flex: 1 }}>{label}</span>
        <span style={{ fontSize: 18, fontWeight: 700, color }}>{value}</span>
      </span>
      {o.note && <span style={{ fontSize: 13, lineHeight: '18px', whiteSpace: 'pre-wrap' }}>{o.note}</span>}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <span style={{ color: '#4ade80' }}>📣</span>
        <span style={{ opacity: 0.55, flex: 1 }}>{t('card.perp.footer')}</span>
        {st.state !== 'closed' && <span style={{ opacity: 0.55 }}>{t('card.perp.copyInApp')}</span>}
      </span>
    </span>
  );
}

export function CalloutCard({ content }: { content: string }) {
  const o = parse(content);
  const symbol = String(o.symbol ?? '');
  return (
    <span
      className="no-menu"
      onClick={() => window.open(calloutUrl(o), '_blank', 'noopener')}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 230, padding: 12, borderRadius: 14, background: '#0f1115', color: '#fff', cursor: 'pointer' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ position: 'relative', width: 42, height: 42, borderRadius: 10, background: '#2a2e37', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0, overflow: 'hidden' }}>
          {symbol.slice(0, 2).toUpperCase()}
          {o.image && <img src={o.image} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${symbol}</span>
          <span style={{ fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          {usd(o.priceUsd) && <span style={{ fontSize: 12 }}>{usd(o.priceUsd)}</span>}
          {usd(o.mcapUsd) && <span style={{ fontSize: 10, opacity: 0.55 }}>{t('card.callout.mcap', { v: usd(o.mcapUsd) ?? '' })}</span>}
        </span>
      </span>
      {o.note && <span style={{ fontSize: 13, lineHeight: '18px', whiteSpace: 'pre-wrap' }}>{o.note}</span>}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <span style={{ color: '#4ade80' }}>📣</span>
        <span style={{ opacity: 0.55, flex: 1 }}>{t('card.callout.footer', { chain: CHAIN_NAMES[o.chain] ?? o.chain })}</span>
        <span style={{ background: '#4ade80', color: '#000', borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{t('card.callout.view')}</span>
      </span>
    </span>
  );
}
