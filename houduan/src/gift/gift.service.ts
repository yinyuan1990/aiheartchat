import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ImService } from '../im/im.service';

@Injectable()
export class GiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly im: ImService,
  ) {}

  list() {
    return this.prisma.gift.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
  }

  /** 送礼：扣积分 → 对方入账 → 写送礼记录 → 发一条礼物消息 */
  async send(senderId: bigint, receiverId: bigint, giftId: number) {
    if (senderId === receiverId) throw new BadRequestException('不能送给自己');
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift || !gift.enabled) throw new NotFoundException('礼物不存在');

    const record = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.giftRecord.create({
        data: { giftId, giftName: gift.name, price: gift.price, senderId, receiverId },
      });
      await this.wallets.applyTx(tx, senderId, 'gift_send', -gift.price, {
        refKey: `gift_${rec.id}`,
        remark: `赠送${gift.name}`,
      });
      await this.wallets.applyTx(tx, receiverId, 'gift_recv', gift.price, {
        refKey: `gift_${rec.id}`,
        remark: `收到${gift.name}`,
      });
      return rec;
    });

    // 礼物消息（走 IM，内容为 JSON，双方都推送显示）
    await this.im.sendGiftMessage(
      senderId,
      receiverId,
      JSON.stringify({ giftId, name: gift.name, icon: gift.icon, price: gift.price.toString() }),
    );

    return record;
  }

  /** 礼物墙：返回全部上架礼物及收到数量（0=未收到） */
  async received(userId: bigint) {
    const [gifts, counts] = await Promise.all([
      this.prisma.gift.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } }),
      this.prisma.giftRecord.groupBy({
        by: ['giftId'],
        where: { receiverId: userId },
        _count: true,
      }),
    ]);
    const countMap = new Map(counts.map((c) => [c.giftId, c._count]));
    return gifts.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      price: g.price,
      count: countMap.get(g.id) ?? 0,
    }));
  }
}
