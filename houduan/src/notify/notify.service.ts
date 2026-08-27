import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistry } from '../im/connection.registry';

/** 分类通知：落库 + 在线实时推送（WS 帧 op=notify） */
@Injectable()
export class NotifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
  ) {}

  async push(
    userId: bigint,
    kind: 'comment' | 'task',
    title: string,
    body: string,
    refId: bigint,
    fromUserId?: bigint,
  ) {
    await this.prisma.notification.create({
      data: { userId, kind, title, body, refId, fromUserId },
    });
    await this.registry.deliver([userId], {
      op: 'notify',
      event: kind,
      data: { title, body, refId: refId.toString() },
    });
  }

  /** 批量推送（如：新约单推给同城异性） */
  async pushMany(userIds: bigint[], kind: 'comment' | 'task', title: string, body: string, refId: bigint) {
    if (userIds.length === 0) return;
    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, kind, title, body, refId })),
    });
    await this.registry.deliver(userIds, {
      op: 'notify',
      event: kind,
      data: { title, body, refId: refId.toString() },
    });
  }

  async list(userId: bigint, kind: string, beforeId?: bigint) {
    const list = await this.prisma.notification.findMany({
      where: { userId, kind, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 30,
    });
    // 拉取即已读
    await this.prisma.notification.updateMany({
      where: { userId, kind, isRead: false },
      data: { isRead: true },
    });
    return list;
  }

  async unreadCounts(userId: bigint) {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: { userId, isRead: false },
      _count: true,
    });
    const result: Record<string, number> = { comment: 0, task: 0 };
    rows.forEach((r) => (result[r.kind] = r._count));
    return result;
  }
}
