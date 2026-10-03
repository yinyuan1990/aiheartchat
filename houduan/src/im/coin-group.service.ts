import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Wallet } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { GroupService } from './group.service';
import { cleanText, isCardChain } from './card-content';

/**
 * 每个币一个讨论群（钱包代币页「讨论群」），按「点了才建」做：第一个人点的时候才建群，之后的人直接加入。
 * 群主是系统账号「币群助手」（不能登录），这样不会有哪个普通用户能解散 / 改名社区群。
 * 哪些币显示入口由钱包页决定（有喊单或者有一定市值才显示）；这里限每人每天新建 10 个，防止刷群。
 * 冷群：7 天没人说话的币群不出现在会话列表里（im.service listConversations），有人再发言就回来。
 */

const SYSTEM_DEVICE = 'sys_coin_groups';
const NEW_PER_DAY = 10;
const MEMBER_LIMIT = 2000;
export const COIN_GROUP_COLD_MS = 7 * 86_400_000;

export type CoinGroupBody = { chain?: string; address?: string; symbol?: string; name?: string; image?: string };

@Injectable()
export class CoinGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly groups: GroupService,
  ) {}

  private ownerId: bigint | null = null;

  private async systemOwner(): Promise<bigint> {
    if (this.ownerId) return this.ownerId;
    const found = await this.prisma.user.findUnique({ where: { deviceId: SYSTEM_DEVICE }, select: { id: true } });
    if (found) return (this.ownerId = found.id);
    const wallet = Wallet.createRandom();
    try {
      const u = await this.prisma.user.create({
        data: {
          // 和机器人一样不能登录：enter / register 都拒绝 isBot 账号
          deviceId: SYSTEM_DEVICE,
          address: wallet.address,
          encPrivKey: this.crypto.wrapKey(Buffer.from(wallet.privateKey.slice(2), 'hex')),
          nickname: '币群助手',
          gender: 0,
          isBot: true,
          wallet: { create: {} },
        },
        select: { id: true },
      });
      return (this.ownerId = u.id);
    } catch {
      // 并发时另一个请求已经建好了
      const again = await this.prisma.user.findUnique({ where: { deviceId: SYSTEM_DEVICE }, select: { id: true } });
      if (!again) throw new BadRequestException('建群失败，请重试');
      return (this.ownerId = again.id);
    }
  }

  async open(userId: bigint, b: CoinGroupBody) {
    const chain = String(b.chain ?? '');
    const raw = String(b.address ?? '').trim();
    if (!isCardChain(chain)) throw new BadRequestException('不支持的链');
    if (!(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(raw)) throw new BadRequestException('代币地址不对');
    const address = chain === 'sol' ? raw : raw.toLowerCase();

    let row = await this.prisma.coinGroup.findUnique({ where: { chain_address: { chain, address } } });
    if (row) {
      const g = await this.prisma.chatGroup.findUnique({ where: { id: row.groupId }, select: { status: true } });
      // 后台封了这个群：不能再进，也不重建
      if (!g || g.status !== 0) throw new BadRequestException('这个币的讨论群已关闭');
    } else {
      const recent = await this.prisma.coinGroup.count({ where: { creatorId: userId, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
      if (recent >= NEW_PER_DAY) throw new BadRequestException('今天新建的币群太多了，明天再来');
      const symbol = cleanText(b.symbol, 20) || '?';
      const name = cleanText(b.name, 40);
      const image = typeof b.image === 'string' && /^https:\/\/[^\s"'<>]{1,240}$/.test(b.image) ? b.image : '';
      const owner = await this.systemOwner();
      const created = await this.groups.createGroup(owner, `$${symbol} 讨论群`.slice(0, 50), [userId], image);
      const groupId = BigInt(created.id);
      await this.prisma.chatGroup.update({
        where: { id: groupId },
        data: { memberLimit: MEMBER_LIMIT, notice: `${name || symbol} 的讨论群（${chain}）。喊单不构成投资建议；陌生链接、私聊「客服」、让你签名授权的，基本都是骗局。`.slice(0, 500) },
      });
      try {
        row = await this.prisma.coinGroup.create({ data: { chain, address, groupId, creatorId: userId } });
      } catch {
        // 两个人同时点：留先建好的那个，刚建的群作废
        await this.prisma.chatGroup.update({ where: { id: groupId }, data: { status: 1 } }).catch(() => {});
        row = await this.prisma.coinGroup.findUnique({ where: { chain_address: { chain, address } } });
        if (!row) throw new BadRequestException('建群失败，请重试');
      }
    }
    const g = await this.groups.join(userId, row.groupId);
    return { groupId: String(g.id), conversationId: g.conversationId != null ? String(g.conversationId) : null, name: g.name, avatar: g.avatar };
  }
}
