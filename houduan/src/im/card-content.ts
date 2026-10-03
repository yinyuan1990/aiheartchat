import { BadRequestException } from '@nestjs/common';

/** 链上钱包支持的链（和 Arm 钱包的 WALLET_CHAINS key 一致） */
export const CARD_CHAINS = ['arc', 'eth', 'bsc', 'base', 'arb', 'polygon', 'sol'] as const;
export const isCardChain = (c: string) => (CARD_CHAINS as readonly string[]).includes(c);

export const cleanText = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

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
