import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotifyService } from '../notify/notify.service';
import { ImService } from '../im/im.service';

export interface PublishTaskInput {
  title: string;
  detail?: string;
  meetAt: string;
  cityCode: string;
  cityName: string;
  address: string;
  reward: string;
}

/** 约单：男发单（报酬托管冻结）→ 女报名 → 男选人 → 完成结算 / 取消退回 */
@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly notify: NotifyService,
    private readonly im: ImService,
  ) {}

  async publish(userId: bigint, input: PublishTaskInput) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');
    if (user.gender !== 1) throw new ForbiddenException('仅男生可发布约单');
    const reward = BigInt(input.reward);
    if (reward <= 0n) throw new BadRequestException('报酬必须大于 0');
    const meetAt = new Date(input.meetAt);
    if (isNaN(meetAt.getTime()) || meetAt.getTime() < Date.now()) {
      throw new BadRequestException('时间无效');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.taskOrder.create({
        data: {
          ownerId: userId,
          title: input.title,
          detail: input.detail ?? '',
          meetAt,
          cityCode: input.cityCode,
          cityName: input.cityName,
          address: input.address,
          reward,
        },
      });
      // 报酬托管：可用转冻结
      await this.wallets.applyTx(tx, userId, 'task_freeze', -reward, {
        frozenDelta: reward,
        refKey: `task_${created.id}`,
        remark: `约单托管:${input.title}`,
      });
      return created;
    });

    // 新单推送给同城异性（接单消息分类）
    const targetGender = user.gender === 1 ? 2 : 1;
    const targets = await this.prisma.user.findMany({
      where: {
        gender: targetGender,
        status: 0,
        OR: [{ cityCode: input.cityCode }, { cityName: input.cityName }],
      },
      select: { id: true },
      take: 500,
    });
    await this.notify.pushMany(
      targets.map((t) => t.id),
      'task',
      `${input.cityName} 有新约单`,
      `「${input.title}」报酬 ${reward} 积分 · ${input.address}`,
      order.id,
    );
    return order;
  }

  /** 接单大厅（仅女生）：待接单列表，按城市过滤 */
  async hall(userId: bigint, cityCode?: string, beforeId?: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.gender !== 2) throw new ForbiddenException('仅女生可查看接单大厅');
    const orders = await this.prisma.taskOrder.findMany({
      where: {
        status: 0,
        meetAt: { gt: new Date() },
        ...(cityCode ? { cityCode } : {}),
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return this.hydrate(orders, userId);
  }

  async mine(userId: bigint) {
    const orders = await this.prisma.taskOrder.findMany({
      where: { ownerId: userId },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return this.hydrate(orders, userId);
  }

  async taken(userId: bigint) {
    const applies = await this.prisma.taskApply.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const orders = await this.prisma.taskOrder.findMany({
      where: { id: { in: applies.map((a) => a.orderId) } },
      orderBy: { id: 'desc' },
    });
    const applyMap = new Map(applies.map((a) => [a.orderId.toString(), a]));
    const hydrated = await this.hydrate(orders, userId);
    return hydrated.map((o: any) => ({ ...o, myApplyStatus: applyMap.get(o.id.toString())?.status }));
  }

  async detail(userId: bigint, orderId: bigint) {
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId }, include: { applies: true } });
    if (!order) throw new NotFoundException('约单不存在');
    const [hydrated] = await this.hydrate([order], userId);

    // 报名者信息仅发单人可见
    let applies: any[] = [];
    if (order.ownerId === userId) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: order.applies.map((a) => a.userId) } },
        select: { id: true, nickname: true, avatar: true, age: true, cityName: true, isGuide: true },
      });
      const userMap = new Map(users.map((u) => [u.id.toString(), u]));
      applies = order.applies.map((a) => ({
        id: a.id,
        user: userMap.get(a.userId.toString()),
        message: a.message,
        status: a.status,
        createdAt: a.createdAt,
      }));
    }
    return { ...hydrated, applies, isOwner: order.ownerId === userId };
  }

  /** 女生报名 */
  async apply(userId: bigint, orderId: bigint, message: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.gender !== 2) throw new ForbiddenException('仅女生可接单');
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId } });
    if (!order || order.status !== 0) throw new BadRequestException('该约单不可报名');

    await this.prisma.taskApply.upsert({
      where: { orderId_userId: { orderId, userId } },
      create: { orderId, userId, message },
      update: { message, status: 0 },
    });
    await this.notify.push(order.ownerId, 'task', '收到新的接单报名', `「${order.title}」有人报名接单`, orderId, userId);
    return { ok: true };
  }

  /** 发单人选定接单人 → 进行中，并自动打开双方会话 */
  async choose(userId: bigint, orderId: bigint, applyId: bigint) {
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('约单不存在');
    if (order.ownerId !== userId) throw new ForbiddenException('无权操作');
    if (order.status !== 0) throw new BadRequestException('状态已变更');
    const apply = await this.prisma.taskApply.findUnique({ where: { id: applyId } });
    if (!apply || apply.orderId !== orderId) throw new NotFoundException('报名不存在');

    await this.prisma.$transaction([
      this.prisma.taskOrder.update({
        where: { id: orderId },
        data: { status: 1, takerId: apply.userId, confirmedAt: new Date() },
      }),
      this.prisma.taskApply.update({ where: { id: applyId }, data: { status: 1 } }),
      this.prisma.taskApply.updateMany({
        where: { orderId, id: { not: applyId }, status: 0 },
        data: { status: 2 },
      }),
    ]);

    const conv = await this.im.getOrCreateSingleConversation(userId, apply.userId);
    await this.notify.push(apply.userId, 'task', '接单成功', `你已被选中接单「${order.title}」`, orderId, userId);
    // 未选中的报名者也实时告知
    const losers = await this.prisma.taskApply.findMany({
      where: { orderId, status: 2 },
      select: { userId: true },
    });
    await this.notify.pushMany(
      losers.map((l) => l.userId),
      'task',
      '约单已被他人接下',
      `「${order.title}」发单人选择了其他报名者`,
      orderId,
    );
    return { ok: true, conversationId: conv.id };
  }

  /** 发单人确认完成 → 托管报酬结算给接单人 */
  async finish(userId: bigint, orderId: bigint) {
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('约单不存在');
    if (order.ownerId !== userId) throw new ForbiddenException('无权操作');
    if (order.status !== 1 || !order.takerId) throw new BadRequestException('状态不允许完成');

    await this.prisma.$transaction(async (tx) => {
      await tx.taskOrder.update({ where: { id: orderId }, data: { status: 2, finishedAt: new Date() } });
      // 发单人解冻并支出
      await this.wallets.applyTx(tx, order.ownerId, 'task_settle', 0n, {
        frozenDelta: -order.reward,
        refKey: `task_${orderId}`,
        remark: `约单结算支出:${order.title}`,
      });
      // 接单人入账
      await this.wallets.applyTx(tx, order.takerId!, 'task_settle', order.reward, {
        refKey: `task_${orderId}`,
        remark: `约单报酬:${order.title}`,
      });
    });
    await this.notify.push(order.takerId!, 'task', '约单已完成', `「${order.title}」报酬 ${order.reward} 积分已到账`, orderId, order.ownerId);
    return { ok: true };
  }

  /** 待接单时发单人取消 → 冻结退回 */
  async cancel(userId: bigint, orderId: bigint) {
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('约单不存在');
    if (order.ownerId !== userId) throw new ForbiddenException('无权操作');
    if (order.status !== 0) throw new BadRequestException('进行中的约单需联系平台仲裁');

    await this.prisma.$transaction(async (tx) => {
      await tx.taskOrder.update({ where: { id: orderId }, data: { status: 3 } });
      await this.wallets.applyTx(tx, userId, 'task_refund', order.reward, {
        frozenDelta: -order.reward,
        refKey: `task_${orderId}`,
        remark: `约单取消退回:${order.title}`,
      });
    });
    // 实时告知所有报名者
    const applicants = await this.prisma.taskApply.findMany({
      where: { orderId, status: { in: [0, 1] } },
      select: { userId: true },
    });
    await this.notify.pushMany(
      applicants.map((a) => a.userId),
      'task',
      '约单已取消',
      `「${order.title}」已被发单人取消`,
      orderId,
    );
    return { ok: true };
  }

  private async hydrate(orders: any[], viewerId: bigint) {
    if (orders.length === 0) return [];
    const ownerIds = [...new Set(orders.map((o) => o.ownerId.toString()))].map(BigInt);
    const owners = await this.prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, nickname: true, avatar: true, age: true },
    });
    const ownerMap = new Map(owners.map((u) => [u.id.toString(), u]));
    const applyCounts = await this.prisma.taskApply.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orders.map((o) => o.id) }, status: { in: [0, 1] } },
      _count: true,
    });
    const countMap = new Map(applyCounts.map((c) => [c.orderId.toString(), c._count]));

    return orders.map((o) => ({
      id: o.id,
      owner: ownerMap.get(o.ownerId.toString()),
      title: o.title,
      detail: o.detail,
      meetAt: o.meetAt,
      cityName: o.cityName,
      address: o.address,
      reward: o.reward,
      status: o.status,
      takerId: o.takerId,
      applyCount: countMap.get(o.id.toString()) ?? 0,
      createdAt: o.createdAt,
    }));
  }
}
