import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectionRegistry } from './connection.registry';
import { ImService } from './im.service';
import { CHANNEL_KIND, ChannelService, MEDIA_RE } from './channel.service';
import { UploadService } from '../upload/upload.service';

/** 聊天里长按消息可选的表情；前 7 个是菜单顶上那一排 */
export const MSG_REACTIONS = ['❤️', '👍', '👎', '🔥', '🥰', '👏', '😁', '😂', '😮', '😢', '🎉', '🙏'];
/** 能转发的消息类型（礼物、通话记录、转账卡片不能转发；喊单卡片可以） */
const FORWARDABLE = new Set(['text', 'image', 'video', 'audio', 'location', 'sticker', 'callout', 'card']);
const MAX_BATCH = 100;
const MAX_FORWARD_TARGETS = 10;

/**
 * 消息长按菜单：删除（自己 / 双方）、转发、表情回应、置顶、已读详情、举报。
 * 频道帖子的删除、回应仍走 ChannelService；这里管单聊和群聊（置顶、转发也支持频道）。
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly im: ImService,
    private readonly channels: ChannelService,
    private readonly uploads: UploadService,
  ) {}

  /** 转发的图片 / 视频 / 语音复制一份新文件：频道消息会被物理删除，两边不能共用同一个文件 */
  private async copyMedia(type: string, content: string) {
    if (type !== 'image' && type !== 'video' && type !== 'audio') return content;
    let out = content;
    for (const u of new Set(content.match(MEDIA_RE) ?? [])) out = out.split(u).join(await this.uploads.copy(u));
    return out;
  }

  // ---------- 删除 ----------

  /**
   * forAll=true：为双方删除（物理删除并推送 msg_delete）。自己的消息不限时间；群主 / 管理员可删任何人的。
   * forAll=false：只在自己这边隐藏，对方还能看到。
   */
  async deleteMessages(userId: bigint, conversationId: bigint, ids: bigint[], forAll: boolean) {
    if (!ids.length) throw new BadRequestException('没有选中消息');
    if (ids.length > MAX_BATCH) throw new BadRequestException(`一次最多 ${MAX_BATCH} 条`);
    const { conv, group, role } = await this.ctx(userId, conversationId);
    if (group?.kind === 2) throw new BadRequestException('频道帖子请在频道里删除');

    const msgs = await this.prisma.message.findMany({ where: { id: { in: ids }, conversationId } });
    if (!msgs.length) throw new NotFoundException('消息不存在');

    if (forAll) {
      const isAdmin = role === 'owner' || role === 'admin';
      for (const m of msgs) {
        if (m.type === 'gift') throw new BadRequestException('礼物消息不能为双方删除');
        if (m.senderId !== userId && !(conv.type === 2 && isAdmin)) throw new ForbiddenException('只能为双方删除自己发的消息');
      }
      await this.purge(conv, msgs.map((m) => m.id));
      return { deleted: msgs.length, forAll: true };
    }

    await this.prisma.messageHide.createMany({
      data: msgs.map((m) => ({ userId, messageId: m.id, conversationId })),
      skipDuplicates: true,
    });
    // 只删自己这边的未读消息也算读过，免得红点消不掉
    await this.prisma.message.updateMany({
      where: { id: { in: msgs.map((m) => m.id) }, receiverId: userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    const cid = conversationId.toString();
    for (const m of msgs) await this.registry.deliver([userId], { op: 'msg_delete', data: { conversationId: cid, msgId: m.id.toString() } });
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { deleted: msgs.length, forAll: false };
  }

  // ---------- 转发 ----------

  async forward(userId: bigint, fromConversationId: bigint, ids: bigint[], targets: { convType: 1 | 2; targetId: string }[]) {
    if (!ids.length) throw new BadRequestException('没有选中消息');
    if (ids.length > MAX_BATCH) throw new BadRequestException(`一次最多 ${MAX_BATCH} 条`);
    if (!targets?.length) throw new BadRequestException('请选择转发对象');
    if (targets.length > MAX_FORWARD_TARGETS) throw new BadRequestException(`一次最多转发给 ${MAX_FORWARD_TARGETS} 个会话`);
    const { conv, group } = await this.ctx(userId, fromConversationId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);

    const hidden = await this.prisma.messageHide.findMany({ where: { userId, messageId: { in: ids } }, select: { messageId: true } });
    const hiddenSet = new Set(hidden.map((h) => h.messageId.toString()));
    const msgs = (await this.prisma.message.findMany({ where: { id: { in: ids }, conversationId: fromConversationId }, orderBy: { id: 'asc' } }))
      .filter((m) => !hiddenSet.has(m.id.toString()));
    if (!msgs.length) throw new NotFoundException('消息不存在');
    for (const m of msgs) if (!FORWARDABLE.has(m.type)) throw new BadRequestException('礼物、通话记录不能转发');

    const senders = await this.prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.senderId))] } }, select: { id: true, nickname: true } });
    const names = new Map(senders.map((s) => [s.id.toString(), s.nickname]));
    const items = msgs.map((m) => ({
      type: m.type,
      content: this.crypto.decrypt(key, m.cipherContent),
      // 转发的转发保留最初来源；频道帖子显示频道名
      fwdFrom: (m.fwdFrom || (group?.kind === 2 ? group.name : names.get(m.senderId.toString())) || '').slice(0, 60),
    }));

    const results: { convType: number; targetId: string; ok: boolean; error?: string }[] = [];
    for (const t of targets) {
      const convType = Number(t.convType) === 2 ? 2 : 1;
      const targetId = String(t.targetId ?? '');
      if (!/^\d+$/.test(targetId)) {
        results.push({ convType, targetId, ok: false, error: '目标不正确' });
        continue;
      }
      try {
        for (const it of items) {
          const content = await this.copyMedia(it.type, it.content);
          await this.im.sendMessage(userId, { op: 'send', convType, targetId, msgType: it.type, content, fwdFrom: it.fwdFrom });
        }
        results.push({ convType, targetId, ok: true });
      } catch (e: any) {
        results.push({ convType, targetId, ok: false, error: e?.message ?? '发送失败' });
      }
    }
    // 发送方自己的会话列表也要刷新（sendMessage 只推给对方）
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { results };
  }

  // ---------- 表情回应 ----------

  /** 每人每条消息一个表情：点同一个取消，点别的替换 */
  async react(userId: bigint, messageId: bigint, emoji: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const { conv } = await this.ctx(userId, m.conversationId);
    const e = (emoji ?? '').trim();
    if (e && !MSG_REACTIONS.includes(e)) throw new BadRequestException('不支持的表情');

    const existing = await this.prisma.channelReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
    if (!e || existing?.emoji === e) {
      if (existing) await this.prisma.channelReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await this.prisma.channelReaction.update({ where: { id: existing.id }, data: { emoji: e, createdAt: new Date() } });
    } else {
      await this.prisma.channelReaction.create({ data: { messageId, userId, emoji: e } });
    }
    const reactions = (await this.im.reactionsOf([messageId])).get(messageId.toString()) ?? [];
    const members = (await this.memberIds(conv)).filter((id) => id !== userId);
    await this.registry.deliver(members, {
      op: 'msg_reactions',
      data: { conversationId: m.conversationId.toString(), msgId: messageId.toString(), reactions },
    });
    return { msgId: messageId.toString(), reactions };
  }

  // ---------- 置顶 ----------

  /** 单聊双方都能置顶；群聊、频道只有群主 / 管理员 */
  async pin(userId: bigint, messageId: bigint, pin: boolean) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const { conv, role } = await this.ctx(userId, m.conversationId);
    if (conv.type === 2 && role !== 'owner' && role !== 'admin') throw new ForbiddenException('只有群主或管理员能置顶');

    if (pin) {
      await this.prisma.messagePin.upsert({
        where: { conversationId_messageId: { conversationId: m.conversationId, messageId } },
        create: { conversationId: m.conversationId, messageId, pinnedBy: userId },
        update: {},
      });
    } else {
      await this.prisma.messagePin.deleteMany({ where: { conversationId: m.conversationId, messageId } });
    }
    await this.registry.deliver(await this.memberIds(conv), {
      op: 'msg_pin',
      data: { conversationId: m.conversationId.toString(), msgId: messageId.toString(), pinned: pin },
    });
    return { msgId: messageId.toString(), pinned: pin };
  }

  /** 会话的置顶消息，新置顶的在前 */
  async pins(userId: bigint, conversationId: bigint) {
    const { conv } = await this.ctx(userId, conversationId);
    const rows = await this.prisma.messagePin.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 50 });
    if (!rows.length) return [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const previews = await this.im.replyPreviewsOf(key, rows.map((r) => r.messageId));
    return rows
      .filter((r) => previews.has(r.messageId.toString()))
      .map((r) => ({ ...previews.get(r.messageId.toString())!, pinnedAt: r.createdAt }));
  }

  // ---------- 已读详情 ----------

  /** 只看自己发的消息：单聊 {read, readAt}；群聊 {count, users}（不含自己和机器人） */
  async readers(userId: bigint, messageId: bigint) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const { conv } = await this.ctx(userId, m.conversationId);
    if (m.senderId !== userId) throw new ForbiddenException('只能查看自己消息的已读情况');
    if (conv.type === 1) return { read: m.isRead, readAt: m.readAt };

    const rows = await this.prisma.groupMember.findMany({
      where: { groupId: conv.groupId!, userId: { not: userId }, lastReadMsgId: { gte: messageId } },
      select: { userId: true },
    });
    const users = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.userId) }, isBot: false },
          select: { id: true, nickname: true, avatar: true },
        })
      : [];
    return { count: users.length, users: users.slice(0, 50) };
  }

  // ---------- 举报 ----------

  async report(userId: bigint, messageId: bigint, reason: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    await this.ctx(userId, m.conversationId);
    if (m.senderId === userId) throw new BadRequestException('不能举报自己的消息');
    const r = (reason ?? '').trim().slice(0, 500);
    if (!r) throw new BadRequestException('请选择举报原因');

    const dup = await this.prisma.report.findFirst({
      where: { reporterId: userId, targetType: 'message', targetId: messageId, status: 0 },
    });
    if (dup) return { ok: true, duplicated: true };
    await this.prisma.report.create({
      data: {
        reporterId: userId,
        targetUserId: m.senderId,
        targetType: 'message',
        targetId: messageId,
        reason: r,
        extra: JSON.stringify({ conversationId: m.conversationId.toString(), type: m.type, cipher: m.cipherContent }),
      },
    });
    return { ok: true };
  }

  // ---------- 后台：举报处理 ----------

  async adminReports(status?: number, beforeId?: bigint) {
    const rows = await this.prisma.report.findMany({
      where: { ...(status === 0 || status === 1 ? { status } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 30,
    });
    const userIds = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetUserId]))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, nickname: true, avatar: true, status: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const convIds = new Set<string>();
    const snaps = new Map<string, { conversationId: string; type: string; cipher: string }>();
    for (const r of rows) {
      if (!r.extra) continue;
      try {
        const s = JSON.parse(r.extra);
        snaps.set(r.id.toString(), s);
        if (s.conversationId) convIds.add(String(s.conversationId));
      } catch {
        /* ignore */
      }
    }
    const convs = convIds.size
      ? await this.prisma.conversation.findMany({ where: { id: { in: [...convIds].map(BigInt) } }, select: { id: true, wrappedKey: true, type: true, groupId: true } })
      : [];
    const convMap = new Map(convs.map((c) => [c.id.toString(), c]));
    const alive = new Set(
      (await this.prisma.message.findMany({ where: { id: { in: rows.filter((r) => r.targetType === 'message').map((r) => r.targetId) } }, select: { id: true } })).map((m) =>
        m.id.toString(),
      ),
    );

    return rows.map((r) => {
      const s = snaps.get(r.id.toString());
      const c = s ? convMap.get(String(s.conversationId)) : undefined;
      let content = '';
      if (s && c) {
        try {
          content = this.crypto.decrypt(this.crypto.unwrapKey(c.wrappedKey), s.cipher);
        } catch {
          content = '';
        }
      }
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        status: r.status,
        result: r.result,
        createdAt: r.createdAt,
        reporter: userMap.get(r.reporterId.toString()) ?? null,
        target: userMap.get(r.targetUserId.toString()) ?? null,
        message: s ? { type: s.type, content, convType: c?.type ?? null, groupId: c?.groupId ?? null, deleted: !alive.has(r.targetId.toString()) } : null,
      };
    });
  }

  /** ignore=忽略；delete=删除被举报的消息；ban=删除消息并封禁发送者。同一条消息的其它待处理举报一并结案 */
  async adminHandleReport(id: bigint, action: string) {
    if (!['ignore', 'delete', 'ban'].includes(action)) throw new BadRequestException('未知操作');
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('举报不存在');
    if (action !== 'ignore' && r.targetType === 'message') {
      const m = await this.prisma.message.findUnique({ where: { id: r.targetId } });
      if (m) {
        const conv = await this.prisma.conversation.findUnique({ where: { id: m.conversationId } });
        const group = conv?.groupId ? await this.prisma.chatGroup.findUnique({ where: { id: conv.groupId }, select: { kind: true } }) : null;
        if (group?.kind === CHANNEL_KIND) await this.channels.adminDeletePost(m.id);
        else if (conv) await this.purge(conv, [m.id]);
      }
    }
    if (action === 'ban') await this.prisma.user.update({ where: { id: r.targetUserId }, data: { status: 1 } });
    await this.prisma.report.updateMany({
      where: { OR: [{ id }, { targetType: r.targetType, targetId: r.targetId, status: 0 }] },
      data: { status: 1, result: action },
    });
    return { ok: true };
  }

  // ---------- 工具 ----------

  /** 物理删除消息及其附属数据，并通知会话所有成员 */
  private async purge(conv: { id: bigint; type: number; userAId: bigint | null; userBId: bigint | null; groupId: bigint | null }, mids: bigint[]) {
    await this.prisma.$transaction([
      this.prisma.channelReaction.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.botMessageMarkup.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.messagePin.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.messageHide.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.message.deleteMany({ where: { id: { in: mids } } }),
    ]);
    const members = await this.memberIds(conv);
    const cid = conv.id.toString();
    for (const id of mids) await this.registry.deliver(members, { op: 'msg_delete', data: { conversationId: cid, msgId: id.toString() } });
    await this.registry.deliver(members, { op: 'conv_refresh' });
  }

  private async ctx(userId: bigint, conversationId: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.im.assertMember(userId, conv);
    if (conv.type === 1 || !conv.groupId) return { conv, group: null, role: null as string | null };
    const [group, me] = await Promise.all([
      this.prisma.chatGroup.findUnique({ where: { id: conv.groupId }, select: { id: true, name: true, kind: true } }),
      this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: conv.groupId, userId } }, select: { role: true } }),
    ]);
    return { conv, group, role: me?.role ?? null };
  }

  private async memberIds(conv: { type: number; userAId: bigint | null; userBId: bigint | null; groupId: bigint | null }) {
    if (conv.type === 1) return [conv.userAId, conv.userBId].filter((id): id is bigint => id != null);
    const rows = await this.prisma.groupMember.findMany({ where: { groupId: conv.groupId! }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }
}
