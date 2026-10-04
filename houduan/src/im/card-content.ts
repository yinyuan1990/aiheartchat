import { BadRequestException } from '@nestjs/common';
import { tonRaw } from '../user/chain-address';

/** 链上钱包支持的链（和 Arm 钱包的 WALLET_CHAINS key 一致） */
export const CARD_CHAINS = ['arc', 'eth', 'bsc', 'base', 'arb', 'polygon', 'sol', 'trx', 'ton'] as const;
export const isCardChain = (c: string) => (CARD_CHAINS as readonly string[]).includes(c);

export const cleanText = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

/** 链上地址格式（钱包地址和代币合约同一种格式） */
export function isChainAddress(chain: string, a: string): boolean {
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (chain === 'trx') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  if (chain === 'ton') return !!tonRaw(a);
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/**
 * 收款消息（msgType payreq）：钱包收款页「发到聊天」。收款地址就是发消息的人自己给的（发错了是他自己收不到），
 * 币种和金额可选：token = 合约地址 / "native" / 空（对方自己选），amount 是最小单位整数。
 * 对方点「转账」打开钱包转账页，付完后服务端核对链上交易再回一张转账卡片（chain-card.service.ts，带 req = 这条消息 id）。
 */
export function sanitizePayreq(content: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(content);
  } catch {
    throw new BadRequestException('收款内容不对');
  }
  const chain = String(o.chain ?? '');
  const address = String(o.address ?? '');
  if (!isCardChain(chain)) throw new BadRequestException('不支持的链');
  if (!isChainAddress(chain, address)) throw new BadRequestException('收款地址不对');
  const token = String(o.token ?? '');
  const hasToken = token === 'native' || isChainAddress(chain, token);
  const decimals = Number(o.decimals);
  const amount = String(o.amount ?? '');
  const hasAmount = hasToken && /^\d{1,40}$/.test(amount) && amount !== '0' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
  return JSON.stringify({
    chain,
    address,
    token: hasToken ? token : null,
    symbol: hasToken ? cleanText(o.symbol, 16) || '?' : null,
    decimals: hasToken && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
    amount: hasAmount ? amount : null,
    note: cleanText(o.note, 100),
    at: Date.now(),
  });
}

/** Hyperliquid 合约名（BTC、kPEPE 这种），也是合约群的 coin_group.address */
export const isPerpCoin = (c: string) => /^[A-Za-z0-9]{1,16}$/.test(c);

/**
 * 合约喊单卡片（msgType perp）：只由服务端发（POST /im/perp-call，perp-call.service.ts），address 是服务端从
 * 主钱包签名里恢复出来的，客户端据此去 Hyperliquid 查喊单者现在的仓位和结果。数字是喊单那一刻的。
 */
export function sanitizePerp(b: Record<string, unknown>, coin: string, side: 'long' | 'short', address: string): string {
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const entry = pos(b.entry);
  if (!entry) throw new BadRequestException('开仓价不对');
  const lev = Math.round(Number(b.lev));
  if (!Number.isFinite(lev) || lev < 1 || lev > 100) throw new BadRequestException('杠杆不对');
  let tp = pos(b.tp);
  let sl = pos(b.sl);
  if (tp && (side === 'long' ? tp <= entry : tp >= entry)) tp = null;
  if (sl && (side === 'long' ? sl >= entry : sl <= entry)) sl = null;
  return JSON.stringify({
    coin,
    side,
    lev,
    entry,
    orderType: b.orderType === 'limit' ? 'limit' : 'market',
    tp,
    sl,
    note: cleanText(b.note, 200),
    address,
    at: Date.now(),
  });
}

/**
 * 喊单 / 分享代币卡片（msgType callout）的内容：只留认识的字段，链必须是钱包支持的，图片只收 https。
 * 价格、市值是发的那一刻的快照，客户端打开代币页看实时行情。
 */
export function sanitizeCallout(content: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(content);
  } catch {
    throw new BadRequestException('喊单内容不对');
  }
  const chain = String(o.chain ?? '');
  const address = String(o.address ?? '');
  if (!isCardChain(chain)) throw new BadRequestException('不支持的链');
  if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(address)) throw new BadRequestException('代币地址不对');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const image = typeof o.image === 'string' && /^https:\/\/[^\s"'<>]{1,400}$/.test(o.image) ? o.image : null;
  return JSON.stringify({
    chain,
    address,
    symbol: cleanText(o.symbol, 20) || '?',
    name: cleanText(o.name, 40),
    image,
    priceUsd: num(o.priceUsd),
    mcapUsd: num(o.mcapUsd),
    note: cleanText(o.note, 200),
    at: Date.now(),
  });
}
