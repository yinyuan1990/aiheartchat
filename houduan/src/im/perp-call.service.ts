import { BadRequestException, Injectable } from '@nestjs/common';
import { verifyMessage } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { ImService } from './im.service';
import { CoinGroupService, PERP_CHAIN } from './coin-group.service';
import { isPerpCoin, sanitizePerp } from './card-content';

/**
 * 合约喊单（Arm 钱包「AI 合约」页下单后点「喊单」）：卡片发进这个合约的群（BTC 合约群…，没有就建）。
 * 卡片上的地址不信客户端：钱包用主钱包私钥签 perpCallMessage，这里恢复出地址，别人的群友据此去 Hyperliquid
 * 查喊单者的真实仓位，所以没法拿别人的大户地址冒充战绩。卡片只能经这里发（im.gateway 拦了直接发 perp）。
 */

const SIG_WINDOW_MS = 10 * 60_000;
const PER_DAY = 30;

export const perpCallMessage = (userId: string, coin: string, side: string, ts: number) => `心之音合约喊单\nuser: ${userId}\ncoin: ${coin}\nside: ${side}\nts: ${ts}`;

export type PerpCallBody = { coin?: string; side?: string; lev?: number; entry?: number; orderType?: string; tp?: number | null; sl?: number | null; note?: string; ts?: number; sig?: string };

@Injectable()
export class PerpCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly im: ImService,
    private readonly coinGroups: CoinGroupService,
  ) {}

  async call(userId: bigint, b: PerpCallBody) {
    const coin = String(b.coin ?? '');
    if (!isPerpCoin(coin)) throw new BadRequestException('合约名不对');
    const side = b.side === 'long' || b.side === 'short' ? b.side : null;
    if (!side) throw new BadRequestException('方向不对');
    const ts = Number(b.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_WINDOW_MS) throw new BadRequestException('签名过期了，请重试');
    let address: string;
    try {
      address = verifyMessage(perpCallMessage(String(userId), coin, side, ts), String(b.sig ?? '')).toLowerCase();
    } catch {
      throw new BadRequestException('钱包签名不对');
    }
    const today = await this.prisma.message.count({ where: { senderId: userId, type: 'perp', createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= PER_DAY) throw new BadRequestException(`每天最多喊 ${PER_DAY} 单`);
    const content = sanitizePerp(b as Record<string, unknown>, coin, side, address);
    const g = await this.coinGroups.open(userId, { chain: PERP_CHAIN, address: coin });
    const message = await this.im.sendMessage(userId, { op: 'send', convType: 2, targetId: g.groupId, msgType: 'perp', content });
    return { ...g, message };
  }
}
