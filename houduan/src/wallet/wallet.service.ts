import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 积分账本（1积分=1元，无充值）：
 * 所有变动走 applyTx，写 wallet_transaction 流水并原子更新余额，
 * (type, refKey, userId) 唯一约束保证幂等。
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * amount: 对可用余额的变动（正入负出）
   * frozenDelta: 对冻结的变动
   */
  async applyTx(
    tx: Prisma.TransactionClient,
    userId: bigint,
    type: string,
    amount: bigint,
    opts: { frozenDelta?: bigint; refKey?: string; remark?: string } = {},
  ) {
    const frozenDelta = opts.frozenDelta ?? 0n;
    const wallet = await tx.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const newBalance = wallet.balance + amount;
    const newFrozen = wallet.frozen + frozenDelta;
    if (newBalance < 0n) throw new BadRequestException('积分不足');
    if (newFrozen < 0n) throw new BadRequestException('冻结额度异常');

    await tx.wallet.update({
      where: { userId },
      data: { balance: newBalance, frozen: newFrozen },
    });
    await tx.walletTransaction.create({
      data: {
        userId,
        type,
        amount,
        frozenDelta,
        balanceAfter: newBalance,
        refKey: opts.refKey ?? '',
        remark: opts.remark ?? '',
      },
    });
    return { balance: newBalance, frozen: newFrozen };
  }

  async getWallet(userId: bigint) {
    const wallet = await this.prisma.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
    return { balance: wallet.balance, frozen: wallet.frozen };
  }

  async listTransactions(userId: bigint, beforeId?: bigint, limit = 30) {
    return this.prisma.walletTransaction.findMany({
      where: { userId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(limit, 50),
    });
  }

  /**
   * 贡献榜：
   * - 女生：哪些男生给我贡献最多（礼物 + 视频通话分成 + 消息收入）
   * - 男生：送花榜，我给哪些女生贡献最多（礼物 + 视频通话实付 + 消息扣费）
   */
  async contribRank(userId: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    if (!me) return { title: '贡献榜', list: [] };
    const isFemale = me.gender === 2;

    const totals = new Map<string, { total: bigint; gift: bigint; call: bigint; msg: bigint }>();
    const add = (peer: bigint | string, kind: 'gift' | 'call' | 'msg', fen: bigint) => {
      const key = peer.toString();
      if (!totals.has(key)) totals.set(key, { total: 0n, gift: 0n, call: 0n, msg: 0n });
      const t = totals.get(key)!;
      t[kind] += fen;
      t.total += fen;
    };

    // 礼物
    const gifts = await this.prisma.giftRecord.groupBy({
      by: [isFemale ? 'senderId' : 'receiverId'],
      where: isFemale ? { receiverId: userId } : { senderId: userId },
      _sum: { price: true },
    });
    for (const g of gifts as any[]) {
      add(isFemale ? g.senderId : g.receiverId, 'gift', g._sum.price ?? 0n);
    }

    // 视频通话：女生按分成算，男生按实付算
    const calls = await this.prisma.platformLedger.groupBy({
      by: [isFemale ? 'maleId' : 'femaleId'],
      where: isFemale ? { femaleId: userId } : { maleId: userId },
      _sum: { femaleFen: true, grossFen: true },
    });
    for (const c of calls as any[]) {
      add(isFemale ? c.maleId : c.femaleId, 'call', (isFemale ? c._sum.femaleFen : c._sum.grossFen) ?? 0n);
    }

    // 消息费：流水关联消息找到对方（ref_key = msg_{id}）
    const msgRows = await this.prisma.$queryRaw<{ peer: bigint; fen: bigint }[]>`
      SELECT ${isFemale ? Prisma.sql`m.sender_id` : Prisma.sql`m.receiver_id`} AS peer,
             CAST(SUM(ABS(w.amount)) AS SIGNED) AS fen
      FROM wallet_transaction w
      JOIN message m ON m.id = CAST(SUBSTRING(w.ref_key, 5) AS UNSIGNED)
      WHERE w.user_id = ${userId} AND w.type = ${isFemale ? 'msg_income' : 'msg_fee'}
      GROUP BY peer
    `;
    for (const r of msgRows) {
      if (r.peer != null) add(BigInt(r.peer), 'msg', BigInt(r.fen ?? 0));
    }

    const top = [...totals.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1)).slice(0, 50);
    const users = await this.prisma.user.findMany({
      where: { id: { in: top.map(([id]) => BigInt(id)) } },
      select: { id: true, nickname: true, avatar: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));

    return {
      title: isFemale ? '贡献榜' : '送花榜',
      list: top.map(([id, t]) => ({
        userId: id,
        nickname: userMap.get(id)?.nickname ?? '用户',
        avatar: userMap.get(id)?.avatar ?? '',
        totalFen: t.total.toString(),
        giftFen: t.gift.toString(),
        callFen: t.call.toString(),
        msgFen: t.msg.toString(),
      })),
    };
  }

  async lookupByShortId(shortId: string) {
    const user = await this.prisma.user.findUnique({
      where: { shortId },
      select: { id: true, shortId: true, nickname: true, avatar: true },
    });
    if (!user) throw new NotFoundException('未找到该 ID 用户');
    return user;
  }

  /** 积分转赠：按短号找收款人，原子扣加，双方各记一条流水 */
  async transfer(fromId: bigint, toShortId: string, amountFen: bigint, remark: string) {
    if (amountFen <= 0n) throw new BadRequestException('金额无效');
    const to = await this.prisma.user.findUnique({ where: { shortId: toShortId } });
    if (!to || to.status !== 0) throw new NotFoundException('未找到该 ID 用户');
    if (to.id === fromId) throw new BadRequestException('不能转给自己');

    const refKey = `xfer_${Date.now()}_${fromId}`;
    await this.prisma.$transaction(async (tx) => {
      await this.applyTx(tx, fromId, 'transfer_out', -amountFen, {
        refKey,
        remark: remark || `转赠给 ${to.nickname}`,
      });
      await this.applyTx(tx, to.id, 'transfer_in', amountFen, {
        refKey,
        remark: remark || '收到转赠',
      });
    });
    return { ok: true, to: { shortId: to.shortId, nickname: to.nickname } };
  }
}
