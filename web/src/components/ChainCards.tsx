import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * 链上钱包的聊天卡片（和 Android ChainCards.kt、iOS ChainCards.swift 同一套字段）。网页版没有钱包：
 * - transfer：服务端核对过链上交易的转账卡片，点开看区块浏览器；
 * - callout：喊单卡片，点开去网页看这个币的行情（App 里会在钱包打开、能直接买）；
 * - payreq：收款消息，显示二维码和地址（App 里能点「转账」）。
 */

const CHAIN_NAMES: Record<string, string> = { arc: 'Arc', eth: 'Ethereum', bsc: 'BNB Chain', base: 'Base', arb: 'Arbitrum', polygon: 'Polygon', sol: 'Solana', trx: 'TRON' };
const EXPLORERS: Record<string, string> = {
  arc: 'https://arc-scan.org/tx/', eth: 'https://etherscan.io/tx/', bsc: 'https://bscscan.com/tx/', base: 'https://basescan.org/tx/',
  arb: 'https://arbiscan.io/tx/', polygon: 'https://polygonscan.com/tx/', sol: 'https://solscan.io/tx/', trx: 'https://tronscan.org/#/transaction/',
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
  if (type === 'transfer') return `[转账] ${tokenAmount(o.amount, Number(o.decimals) || 0)} ${o.symbol ?? ''}`.trim();
  if (type === 'callout') return `[喊单] $${o.symbol ?? ''}`;
  if (type === 'payreq') return o.amount ? `[收款] ${tokenAmount(o.amount, Number(o.decimals) || 0)} ${o.symbol ?? ''}`.trim() : `[收款] ${CHAIN_NAMES[o.chain] ?? o.chain ?? ''}`;
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
      <span style={{ padding: '9px 12px', background: '#f59e0b', color: '#fff', fontSize: 13, fontWeight: 600 }}>⇄ 收款 · {chain}</span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 12, color: '#111' }}>
        <span style={{ fontSize: amount ? 20 : 14, fontWeight: 600 }}>{amount ?? (o.symbol ? `收 ${o.symbol}` : '金额由付款人填写')}</span>
        {o.note && <span style={{ fontSize: 12, color: '#555' }}>{o.note}</span>}
        {qr && <img src={qr} alt="收款二维码" style={{ width: 140, height: 140 }} />}
        <span
          onClick={() => void navigator.clipboard?.writeText(address).then(() => setCopied(true))}
          style={{ fontSize: 11, wordBreak: 'break-all', textAlign: 'center', background: '#f4f4f5', borderRadius: 8, padding: '6px 8px', cursor: 'pointer' }}
        >
          {address}
        </span>
        <span style={{ fontSize: 10, color: '#888' }}>{copied ? '地址已复制' : `点地址复制 · 只收 ${chain} 上的币${mine ? '' : ' · 在 App 里可以直接转账'}`}</span>
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
          <span style={{ fontSize: 12, opacity: 0.85 }}>{mine ? '已转账给对方' : '对方给你转账'}</span>
        </span>
      </span>
      <span style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 14px', background: '#fff4de', fontSize: 11, color: '#9a5b00' }}>
        <span>链上转账 · {CHAIN_NAMES[o.chain] ?? o.chain}</span>
        {o.verified && <span style={{ color: '#16a34a' }}>已到账 ✓</span>}
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
          {usd(o.mcapUsd) && <span style={{ fontSize: 10, opacity: 0.55 }}>市值 {usd(o.mcapUsd)}</span>}
        </span>
      </span>
      {o.note && <span style={{ fontSize: 13, lineHeight: '18px', whiteSpace: 'pre-wrap' }}>{o.note}</span>}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <span style={{ color: '#4ade80' }}>📣</span>
        <span style={{ opacity: 0.55, flex: 1 }}>喊单 · {CHAIN_NAMES[o.chain] ?? o.chain}</span>
        <span style={{ background: '#4ade80', color: '#000', borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>看行情</span>
      </span>
    </span>
  );
}
