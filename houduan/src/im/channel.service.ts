import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { StickerService, parseStickerJson } from '../sticker/sticker.service';
import { ConnectionRegistry } from './connection.registry';

/** 频道 = chat_group.kind=2：群主 / 管理员发帖，订阅者（group_member.role=member）只看、表情回应、评论 */
export const CHANNEL_KIND = 2;
/** 订阅人数上限（复用 memberLimit） */
const CHANNEL_LIMIT = 1_000_000;
/** 可用的表情回应 */
export const REACTIONS = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🎉', '👎'];

type Reactions = { emoji: string; count: number }[];

@Injectable()
export class ChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly stickers: StickerService,
  ) {}

  // ---------- 频道本身 ----------

  async create(ownerId: bigint, dto: { name?: string; avatar?: string; description?: string }) {
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException('请填写频道名称');
    if (name.length > 50) throw new BadRequestException('频道名称最长 50 字');
    const description = (dto.description ?? '').trim();
    if (description.length > 500) throw new BadRequestException('简介最长 500 字');
    const owned = await this.prisma.chatGroup.count({ where: { ownerId, kind: CHANNEL_KIND, status: 0 } });
    if (owned >= 10) throw new BadRequestException('每人最多创建 10 个频道');

    const group = await this.prisma.chatGroup.create({
      data: { name, avatar: dto.avatar ?? '', notice: description, ownerId, kind: CHANNEL_KIND, memberLimit: CHANNEL_LIMIT },
    });
    await this.prisma.conversation.create({
      data: {
        type: 2,
        pairKey: `g_${group.id}`,
        groupId: group.id,
        wrappedKey: this.crypto.wrapKey(this.crypto.generateConversationKey()),
      },
    });
    await this.prisma.groupMember.create({ data: { groupId: group.id, userId: ownerId, role: 'owner' } });
    void this.registry.deliver([ownerId], { op: 'conv_refresh' }).catch(() => {});
    return this.info(ownerId, group.id);
  }

  /** 频道资料：任何人可看（订阅前预览）；成员列表不对外 */
  async info(userId: bigint, groupId: bigint) {
    const g = await this.mustChannel(groupId);
    const [subscribers, me, conv, owner] = await Promise.all([
      this.prisma.groupMember.count({ where: { groupId } }),
      this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } }),
      this.prisma.conversation.findUnique({ where: { groupId }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { id: g.ownerId }, select: { id: true, nickname: true, avatar: true } }),
    ]);
    return {
      id: g.id,
      name: g.name,
      avatar: g.avatar || owner?.avatar || '',
      description: g.notice,
      ownerId: g.ownerId,
      owner,
      subscribers,
      conversationId: conv?.id,
      isMember: !!me,
      role: me?.role ?? null,
      canPost: me?.role === 'owner' || me?.role === 'admin',
      muted: me?.muted ?? false,
      createdAt: g.createdAt,
    };
  }

  /** 发现频道：按订阅数倒序，可按名称 / 简介搜索 */
  async list(userId: bigint, q?: string) {
    const kw = (q ?? '').trim().slice(0, 30);
    const groups = await this.prisma.chatGroup.findMany({
      where: {
        kind: CHANNEL_KIND,
        status: 0,
        ...(kw ? { OR: [{ name: { contains: kw } }, { notice: { contains: kw } }] } : {}),
      },
      orderBy: { id: 'desc' },
      take: 300,
    });
    if (!groups.length) return [];
    const ids = groups.map((g) => g.id);
    const [counts, mine, owners, convs] = await Promise.all([
      this.prisma.groupMember.groupBy({ by: ['groupId'], where: { groupId: { in: ids } }, _count: { _all: true } }),
      this.prisma.groupMember.findMany({ where: { userId, groupId: { in: ids } }, select: { groupId: true } }),
      this.prisma.user.findMany({ where: { id: { in: groups.map((g) => g.ownerId) } }, select: { id: true, nickname: true, avatar: true } }),
      this.prisma.conversation.findMany({ where: { groupId: { in: ids } }, select: { id: true, groupId: true } }),
    ]);
    const countMap = new Map(counts.map((c) => [c.groupId.toString(), c._count._all]));
    const mineSet = new Set(mine.map((m) => m.groupId.toString()));
    const ownerMap = new Map(owners.map((o) => [o.id.toString(), o]));
    const convMap = new Map(convs.map((c) => [c.groupId!.toString(), c.id]));
    return groups
      .map((g) => {
        const owner = ownerMap.get(g.ownerId.toString());
        return {
          id: g.id,
          name: g.name,
          avatar: g.avatar || owner?.avatar || '',
          description: g.notice,
          ownerNickname: owner?.nickname ?? '',
          subscribers: countMap.get(g.id.toString()) ?? 0,
          isMember: mineSet.has(g.id.toString()),
          conversationId: convMap.get(g.id.toString()),
        };
      })
      .sort((a, b) => b.subscribers - a.subscribers)
      .slice(0, 100);
  }

  async subscribe(userId: bigint, groupId: bigint) {
    await this.mustChannel(groupId);
    const r = await this.prisma.groupMember.createMany({ data: [{ groupId, userId }], skipDuplicates: true });
    if (r.count) void this.registry.deliver([userId], { op: 'conv_refresh' }).catch(() => {});
    return this.info(userId, groupId);
  }

  async unsubscribe(userId: bigint, groupId: bigint) {
    const me = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
    if (!me) return this.info(userId, groupId);
    if (me.role === 'owner') throw new BadRequestException('频道主不能退订，可以删除频道');
    await this.prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId } } });
    void this.registry.deliver([userId], { op: 'conv_refresh' }).catch(() => {});
    return this.info(userId, groupId);
  }

  async setMuted(userId: bigint, groupId: bigint, muted: boolean) {
    const r = await this.prisma.groupMember.updateMany({ where: { groupId, userId }, data: { muted } });
    if (!r.count) throw new ForbiddenException('还没有订阅该频道');
    return { muted };
  }

  async update(userId: bigint, groupId: bigint, dto: { name?: string; avatar?: string; description?: string }) {
    await this.mustChannel(groupId);
    await this.mustAdmin(groupId, userId);
    const data: { name?: string; avatar?: string; notice?: string } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name || name.length > 50) throw new BadRequestException('频道名称 1~50 字');
      data.name = name;
    }
    if (dto.avatar !== undefined) data.avatar = dto.avatar;
    if (dto.description !== undefined) {
      if (dto.description.length > 500) throw new BadRequestException('简介最长 500 字');
      data.notice = dto.description.trim();
    }
    await this.prisma.chatGroup.update({ where: { id: groupId }, data });
    return this.info(userId, groupId);
  }

  async remove(userId: bigint, groupId: bigint) {
    const g = await this.mustChannel(groupId);
    if (g.ownerId !== userId) throw new ForbiddenException('只有频道主能删除频道');
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    await this.prisma.chatGroup.update({ where: { id: groupId }, data: { status: 1 } });
    void this.registry.deliver(members.map((m) => m.userId), { op: 'conv_refresh' }).catch(() => {});
    return { ok: true };
  }

  // ---------- 帖子 ----------

  /**
   * 帖子列表（订阅前也能看）：消息 + 浏览数 + 表情回应 + 评论数。
   * 浏览数 = 已读位置不早于这条的订阅者人数（group_member.last_read_msg_id，不另建表）。
   */
  async posts(userId: bigint, groupId: bigint, beforeId?: bigint) {
    await this.mustChannel(groupId);
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) throw new NotFoundException('频道不存在');
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const rows = await this.prisma.message.findMany({
      where: { conversationId: conv.id, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 30,
    });
    rows.reverse();
    const ids = rows.map((m) => m.id);
    const reads = (await this.prisma.groupMember.findMany({ where: { groupId }, select: { lastReadMsgId: true } }))
      .map((m) => m.lastReadMsgId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const views = (id: bigint) => {
      let lo = 0;
      let hi = reads.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (reads[mid] < id) lo = mid + 1;
        else hi = mid;
      }
      return reads.length - lo;
    };
    const [reactions, comments] = await this.stats(ids, userId);
    const senders = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((m) => m.senderId.toString()))].map(BigInt) } },
      select: { id: true, nickname: true, avatar: true },
    });
    const senderMap = new Map(senders.map((s) => [s.id.toString(), s]));
    return rows.map((m) => {
      let content = '';
      try {
        content = this.crypto.decrypt(key, m.cipherContent);
      } catch {
        content = '';
      }
      const r = reactions.get(m.id.toString());
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        senderNickname: senderMap.get(m.senderId.toString())?.nickname ?? '',
        senderAvatar: senderMap.get(m.senderId.toString())?.avatar ?? '',
        type: m.type,
        content,
        createdAt: m.createdAt,
        views: Math.max(1, views(m.id)),
        reactions: r?.list ?? [],
        myReaction: r?.mine ?? null,
        commentCount: comments.get(m.id.toString()) ?? 0,
      };
    });
  }

  /** 表情回应：同一个再点 = 取消，点别的 = 换 */
  async react(userId: bigint, messageId: bigint, emoji: string) {
    const { groupId } = await this.postOf(messageId);
    const e = (emoji ?? '').trim();
    if (e && !REACTIONS.includes(e)) throw new BadRequestException('不支持的表情');
    const existing = await this.prisma.channelReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
    if (!e || existing?.emoji === e) {
      if (existing) await this.prisma.channelReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await this.prisma.channelReaction.update({ where: { id: existing.id }, data: { emoji: e } });
    } else {
      await this.prisma.channelReaction.create({ data: { messageId, userId, emoji: e } });
    }
    const [reactions] = await this.stats([messageId], userId);
    const r = reactions.get(messageId.toString());
    // 操作人以接口返回为准：推送和接口返回可能乱序，连点时旧推送会盖掉新结果
    void this.broadcastStats(groupId, messageId, userId);
    return { reactions: r?.list ?? [], myReaction: r?.mine ?? null };
  }

  async comments(messageId: bigint, beforeId?: bigint) {
    await this.postOf(messageId);
    const list = await this.prisma.channelComment.findMany({
      where: { messageId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const replyIds = list.map((c) => c.replyToId).filter((id): id is bigint => id != null);
    const replies = replyIds.length ? await this.prisma.channelComment.findMany({ where: { id: { in: replyIds } } }) : [];
    const userIds = new Set([...list, ...replies].map((c) => c.userId.toString()));
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds].map(BigInt) } },
      select: { id: true, nickname: true, avatar: true, gender: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const replyMap = new Map(replies.map((c) => [c.id.toString(), c]));
    return list.reverse().map((c) => {
      const replyTo = c.replyToId ? replyMap.get(c.replyToId.toString()) : null;
      return {
        id: c.id,
        user: userMap.get(c.userId.toString()),
        content: c.content,
        sticker: parseStickerJson(c.sticker),
        replyToId: c.replyToId,
        replyToNickname: replyTo ? userMap.get(replyTo.userId.toString())?.nickname ?? '' : '',
        createdAt: c.createdAt,
      };
    });
  }

  /** 评论：任何登录用户都能评（不要求订阅，和 Telegram 讨论区一样），免费 */
  async addComment(userId: bigint, messageId: bigint, dto: { content?: string; stickerId?: string; replyToId?: string }) {
    const { groupId } = await this.postOf(messageId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');
    const content = (dto.content ?? '').trim();
    if (content.length > 500) throw new BadRequestException('评论最长 500 字');
    const sticker = await this.stickers.payloadOf(dto.stickerId);
    if (!content && !sticker) throw new BadRequestException('评论不能为空');
    let replyToId: bigint | null = null;
    if (dto.replyToId) {
      const r = await this.prisma.channelComment.findUnique({ where: { id: BigInt(dto.replyToId) } });
      if (!r || r.messageId !== messageId) throw new BadRequestException('回复的评论不存在');
      replyToId = r.id;
    }
    const c = await this.prisma.channelComment.create({
      data: { messageId, groupId, userId, content, sticker: sticker ? JSON.stringify(sticker) : '', replyToId },
    });
    void this.broadcastStats(groupId, messageId);
    return { id: c.id };
  }

  /** 删评论：评论作者 / 频道主 / 管理员 */
  async deleteComment(userId: bigint, commentId: bigint) {
    const c = await this.prisma.channelComment.findUnique({ where: { id: commentId } });
    if (!c || c.status !== 0) return { ok: true };
    if (c.userId !== userId) await this.mustAdmin(c.groupId, userId);
    await this.prisma.channelComment.update({ where: { id: commentId }, data: { status: 1 } });
    void this.broadcastStats(c.groupId, c.messageId);
    return { ok: true };
  }

  /** 删帖：频道主 / 管理员 */
  async deletePost(userId: bigint, messageId: bigint) {
    const { groupId } = await this.postOf(messageId);
    await this.mustAdmin(groupId, userId);
    return this.purgePost(groupId, messageId);
  }

  /** 物理删除帖子 + 回应 + 评论，通知订阅者刷新（后台也用） */
  async purgePost(groupId: bigint, messageId: bigint) {
    await this.prisma.$transaction([
      this.prisma.message.delete({ where: { id: messageId } }),
      this.prisma.channelReaction.deleteMany({ where: { messageId } }),
      this.prisma.channelComment.deleteMany({ where: { messageId } }),
    ]);
    const conv = await this.prisma.conversation.findUnique({ where: { groupId }, select: { id: true } });
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    void this.registry
      .deliver(members.map((m) => m.userId), { op: 'channel_post_deleted', data: { conversationId: conv?.id.toString(), msgId: messageId.toString() } })
      .catch(() => {});
    return { ok: true };
  }

  // ---------- 后台 ----------

  /** 后台频道列表：含已封禁 / 已删除 */
  async adminList(q?: string) {
    const kw = (q ?? '').trim();
    const groups = await this.prisma.chatGroup.findMany({
      where: { kind: CHANNEL_KIND, ...(kw ? { OR: [{ name: { contains: kw } }, { notice: { contains: kw } }] } : {}) },
      orderBy: { id: 'desc' },
      take: 200,
    });
    if (!groups.length) return [];
    const ids = groups.map((g) => g.id);
    const [counts, owners, convs] = await Promise.all([
      this.prisma.groupMember.groupBy({ by: ['groupId'], where: { groupId: { in: ids } }, _count: { _all: true } }),
      this.prisma.user.findMany({ where: { id: { in: groups.map((g) => g.ownerId) } }, select: { id: true, nickname: true, shortId: true, avatar: true } }),
      this.prisma.conversation.findMany({ where: { groupId: { in: ids } }, select: { id: true, groupId: true, lastMsgAt: true } }),
    ]);
    const postCounts = convs.length
      ? await this.prisma.message.groupBy({ by: ['conversationId'], where: { conversationId: { in: convs.map((c) => c.id) } }, _count: { _all: true } })
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId.toString(), c._count._all]));
    const ownerMap = new Map(owners.map((o) => [o.id.toString(), o]));
    const convMap = new Map(convs.map((c) => [c.groupId!.toString(), c]));
    const postMap = new Map(postCounts.map((p) => [p.conversationId.toString(), p._count._all]));
    return groups.map((g) => {
      const conv = convMap.get(g.id.toString());
      return {
        id: g.id,
        name: g.name,
        avatar: g.avatar || ownerMap.get(g.ownerId.toString())?.avatar || '',
        description: g.notice,
        owner: ownerMap.get(g.ownerId.toString()) ?? null,
        status: g.status,
        subscribers: countMap.get(g.id.toString()) ?? 0,
        posts: conv ? postMap.get(conv.id.toString()) ?? 0 : 0,
        lastPostAt: conv?.lastMsgAt ?? null,
        createdAt: g.createdAt,
      };
    });
  }

  /** 后台封禁（status=2）/ 解封（status=0）；已被频道主删除的（status=1）也能恢复 */
  async adminSetStatus(groupId: bigint, status: 0 | 2) {
    const g = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!g || g.kind !== CHANNEL_KIND) throw new NotFoundException('频道不存在');
    await this.prisma.chatGroup.update({ where: { id: groupId }, data: { status } });
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    void this.registry.deliver(members.map((m) => m.userId), { op: 'conv_refresh' }).catch(() => {});
    return { ok: true };
  }

  async adminPosts(groupId: bigint, beforeId?: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) return [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const rows = await this.prisma.message.findMany({
      where: { conversationId: conv.id, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const [reactions, comments] = await this.stats(rows.map((m) => m.id));
    return rows.map((m) => {
      let content = '';
      try {
        content = this.crypto.decrypt(key, m.cipherContent);
      } catch {
        content = '';
      }
      return {
        id: m.id,
        type: m.type,
        content,
        createdAt: m.createdAt,
        reactions: reactions.get(m.id.toString())?.list ?? [],
        commentCount: comments.get(m.id.toString()) ?? 0,
      };
    });
  }

  async adminDeletePost(messageId: bigint) {
    const { groupId } = await this.postOfAny(messageId);
    return this.purgePost(groupId, messageId);
  }

  async adminDeleteComment(commentId: bigint) {
    const c = await this.prisma.channelComment.findUnique({ where: { id: commentId } });
    if (!c) return { ok: true };
    await this.prisma.channelComment.update({ where: { id: commentId }, data: { status: 1 } });
    void this.broadcastStats(c.groupId, c.messageId);
    return { ok: true };
  }

  /** 同 postOf，但不要求频道正常（封禁的频道后台也能删帖） */
  private async postOfAny(messageId: bigint) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    const conv = m && (await this.prisma.conversation.findUnique({ where: { id: m.conversationId }, select: { groupId: true } }));
    if (!conv?.groupId) throw new NotFoundException('帖子不存在');
    return { groupId: conv.groupId };
  }

  // ---------- 内部 ----------

  /** 一批帖子的表情回应（含我的）和评论数 */
  private async stats(ids: bigint[], userId?: bigint): Promise<[Map<string, { list: Reactions; mine: string | null }>, Map<string, number>]> {
    const reactions = new Map<string, { list: Reactions; mine: string | null }>();
    const comments = new Map<string, number>();
    if (!ids.length) return [reactions, comments];
    const [rx, mine, cc] = await Promise.all([
      this.prisma.channelReaction.groupBy({ by: ['messageId', 'emoji'], where: { messageId: { in: ids } }, _count: { _all: true } }),
      userId
        ? this.prisma.channelReaction.findMany({ where: { messageId: { in: ids }, userId }, select: { messageId: true, emoji: true } })
        : Promise.resolve([] as { messageId: bigint; emoji: string }[]),
      this.prisma.channelComment.groupBy({ by: ['messageId'], where: { messageId: { in: ids }, status: 0 }, _count: { _all: true } }),
    ]);
    for (const r of rx) {
      const k = r.messageId.toString();
      const e = reactions.get(k) ?? { list: [], mine: null };
      e.list.push({ emoji: r.emoji, count: r._count._all });
      reactions.set(k, e);
    }
    for (const e of reactions.values()) e.list.sort((a, b) => b.count - a.count || REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji));
    for (const m of mine) {
      const k = m.messageId.toString();
      const e = reactions.get(k) ?? { list: [], mine: null };
      e.mine = m.emoji;
      reactions.set(k, e);
    }
    for (const c of cc) comments.set(c.messageId.toString(), c._count._all);
    return [reactions, comments];
  }

  /** 回应 / 评论数变了：推给在线订阅者（不含「我的回应」，客户端保留自己的） */
  private async broadcastStats(groupId: bigint, messageId: bigint, exceptUserId?: bigint) {
    try {
      const [reactions, comments] = await this.stats([messageId]);
      const conv = await this.prisma.conversation.findUnique({ where: { groupId }, select: { id: true } });
      const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
      await this.registry.deliver(
        members.map((m) => m.userId).filter((id) => id !== exceptUserId),
        {
          op: 'channel_stats',
          data: {
            conversationId: conv?.id.toString(),
            msgId: messageId.toString(),
            reactions: reactions.get(messageId.toString())?.list ?? [],
            commentCount: comments.get(messageId.toString()) ?? 0,
          },
        },
      );
    } catch {
      /* 推送失败不影响主流程 */
    }
  }

  private async postOf(messageId: bigint) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    if (!m) throw new NotFoundException('帖子不存在');
    const conv = await this.prisma.conversation.findUnique({ where: { id: m.conversationId }, select: { groupId: true } });
    if (!conv?.groupId) throw new NotFoundException('帖子不存在');
    await this.mustChannel(conv.groupId);
    return { groupId: conv.groupId };
  }

  private async mustChannel(groupId: bigint) {
    const g = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!g || g.kind !== CHANNEL_KIND || g.status !== 0) throw new NotFoundException('频道不存在或已关闭');
    return g;
  }

  private async mustAdmin(groupId: bigint, userId: bigint) {
    const m = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
    if (m?.role !== 'owner' && m?.role !== 'admin') throw new ForbiddenException('只有频道主能操作');
    return m;
  }
}
