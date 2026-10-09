import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImService } from './im.service';
import { CoinGroupService } from './coin-group.service';
import { cleanText, sanitizeCard } from './card-content';

/**
 * 通用卡片喊单（msgType card）。钱包只说「喊哪个东西」（kind + id + 一句话），卡片内容和要发进的群都由我们自己的
 * 服务生成（SOURCES），客户端伪造不了数字。以后加类型：在 SOURCES 里加一项（再在网页里加对应页面），App 不用发版。
 *
 * 入口复用合约喊单的原生桥：钱包调 ArmWalletNative.perpCall({kind, ...})，两端外壳都原样转给 POST /im/perp-call，
 * 控制器看到 kind 就转到这里（im.controller.ts），成功后外壳照常打开返回的群。
 */

const ARM_API = (process.env.ARM_API_BASE ?? 'https://arm.yyheart.com/api').replace(/\/$/, '');
const PER_DAY = 50;

type Source = (body: Record<string, unknown>) => Promise<{ card: Record<string, unknown>; group: { ns: string; key: string; name: string; notice: string; symbol?: string } }>;

async function armJson(path: string) {
  const r = await fetch(`${ARM_API}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) throw new BadRequestException('商品不存在或已下架');
  if (!r.ok) throw new BadRequestException('暂时取不到商品信息，稍后再试');
  return r.json() as Promise<any>;
}

const SOURCES: Record<string, Source> = {
  /** Arm 创作者商城的商品：发进卖家地址的店铺群 */
  shop: async (b) => {
    const id = Number(b.productId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('商品不对');
    const j = await armJson(`/shop/card/${id}`);
    if (!j?.card || j.group?.ns !== 'shop') throw new BadRequestException('商品信息不对');
    return j;
  },
};

export type CardCallBody = { kind?: string; note?: string } & Record<string, unknown>;

@Injectable()
export class CardCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly im: ImService,
    private readonly coinGroups: CoinGroupService,
  ) {}

  async call(userId: bigint, b: CardCallBody) {
    const source = SOURCES[String(b.kind ?? '')];
    if (!source) throw new BadRequestException('不支持的喊单类型，请升级 App');
    const today = await this.prisma.message.count({ where: { senderId: userId, type: 'card', createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= PER_DAY) throw new BadRequestException(`每天最多喊 ${PER_DAY} 次`);
    const { card, group } = await source(b);
    const content = sanitizeCard(card, cleanText(b.note, 200));
    const g = group.ns === 'shop' ? await this.coinGroups.openShop(userId, { key: group.key, name: group.name, notice: group.notice, symbol: group.symbol ?? '' }) : null;
    if (!g) throw new BadRequestException('不支持的群');
    const message = await this.im.sendMessage(userId, { op: 'send', convType: 2, targetId: g.groupId, msgType: 'card', content });
    return { ...g, message };
  }
}
