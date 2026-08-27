import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectionRegistry } from './connection.registry';
import { IntimacyService } from '../intimacy/intimacy.service';
import { MessagePayload, SendFrame } from './im.types';

/** 需要扣费的消息类型（礼物走礼物模块自身计费） */
const CHARGED_TYPES = new Set(['text', 'image', 'video', 'audio', 'location']);

@Injectable()
export class ImService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly wallets: WalletService,
    private readonly intimacy: IntimacyService,
  ) {}

  // ---------- 发送 ----------

  async sendMessage(senderId: bigint, frame: SendFrame): Promise<MessagePayload> {
    const sender = await this.prisma.user.findUnique({ where: { id: senderId } });
    if (!sender || sender.status !== 0) throw new ForbiddenException('账号异常');

    if (frame.convType === 1) {
      return this.sendSingle(sender, BigInt(frame.targetId), frame);
    }
    return this.sendGroup(sender, BigInt(frame.targetId), frame);
  }

  private async sendSingle(sender: any, peerId: bigint, frame: SendFrame): Promise<MessagePayload> {
    if (peerId === sender.id) throw new BadRequestException('不能给自己发消息');
    const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
    if (!peer || peer.status !== 0) throw new NotFoundException('对方不存在');
    // 全局性别隔离：单聊仅限异性
    if (peer.gender === sender.gender) throw new ForbiddenException('无法与该用户聊天');

    const conv = await this.getOrCreateSingleConversation(sender.id, peerId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);

    // 男→女消息按条扣费（后台设价，收入归女方）
    let msgFee = 0n;
    if (sender.gender === 1 && CHARGED_TYPES.has(frame.msgType)) {
      const price = await this.prisma.priceConfig.findFirst();
      msgFee = BigInt(price?.msgPriceFen ?? 0);
    }

    const msg = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conv.id,
          senderId: sender.id,
          receiverId: peerId,
          type: frame.msgType,
          cipherContent: this.crypto.encrypt(key, frame.content),
        },
      });
      if (msgFee > 0n) {
        await this.wallets.applyTx(tx, sender.id, 'msg_fee', -msgFee, {
          refKey: `msg_${created.id}`,
          remark: '发送消息',
        });
        await this.wallets.applyTx(tx, peerId, 'msg_income', msgFee, {
          refKey: `msg_${created.id}`,
          remark: '收到消息',
        });
      }
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: created.createdAt } });
      return created;
    });

    const payload = this.toPayload(msg, conv, sender, frame.content);
    await this.registry.deliver([peerId], { op: 'msg', data: payload });
    // 亲密度：发送方 +1，接收方 +0.5（异步不阻塞发送）
    void this.intimacy.bump(sender.id, peerId);
    return payload;
  }

  /** 礼物消息：写入单聊会话并推送双方（计费已在礼物模块完成），双方聊天框都能看到 */
  async sendGiftMessage(senderId: bigint, receiverId: bigint, content: string) {
    const sender = await this.prisma.user.findUnique({ where: { id: senderId } });
    if (!sender) return;
    const conv = await this.getOrCreateSingleConversation(senderId, receiverId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId,
        receiverId,
        type: 'gift',
        cipherContent: this.crypto.encrypt(key, content),
      },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });
    const payload = this.toPayload(msg, conv, sender, content);
    await this.registry.deliver([senderId, receiverId], { op: 'msg', data: payload });
  }

  /** 通话记录消息（微信式）：写入单聊会话并推送双方，免费不计扣费 */
  async sendCallMessage(callerId: bigint, calleeId: bigint, content: string) {
    const sender = await this.prisma.user.findUnique({ where: { id: callerId } });
    if (!sender) return;
    const conv = await this.getOrCreateSingleConversation(callerId, calleeId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId: callerId,
        receiverId: calleeId,
        type: 'call',
        cipherContent: this.crypto.encrypt(key, content),
      },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });
    const payload = this.toPayload(msg, conv, sender, content);
    await this.registry.deliver([callerId, calleeId], { op: 'msg', data: payload });
  }

  private async sendGroup(sender: any, groupId: bigint, frame: SendFrame): Promise<MessagePayload> {
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: sender.id } },
    });
    if (!member) throw new ForbiddenException('不在该群中');
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) throw new NotFoundException('群会话不存在');

    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId: sender.id,
        receiverId: null,
        type: frame.msgType,
        cipherContent: this.crypto.encrypt(key, frame.content),
      },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });

    const payload = this.toPayload(msg, conv, sender, frame.content);
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    const targets = members.map((m) => m.userId).filter((id) => id !== sender.id);
    await this.registry.deliver(targets, { op: 'msg', data: payload });
    return payload;
  }

  async getOrCreateSingleConversation(a: bigint, b: bigint) {
    const [min, max] = a < b ? [a, b] : [b, a];
    const pairKey = `${min}_${max}`;
    const existing = await this.prisma.conversation.findUnique({ where: { pairKey } });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: {
        type: 1,
        pairKey,
        userAId: min,
        userBId: max,
        wrappedKey: this.crypto.wrapKey(this.crypto.generateConversationKey()),
      },
    });
  }

  // ---------- 已读 ----------

  async markRead(userId: bigint, conversationId: bigint, msgId: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return;
    if (conv.type === 1) {
      if (conv.userAId !== userId && conv.userBId !== userId) return;
      await this.prisma.message.updateMany({
        where: { conversationId, receiverId: userId, isRead: false, id: { lte: msgId } },
        data: { isRead: true },
      });
      const peer = conv.userAId === userId ? conv.userBId : conv.userAId;
      await this.registry.deliver([peer!], {
        op: 'read',
        conversationId: conversationId.toString(),
        msgId: msgId.toString(),
        userId: userId.toString(),
      });
    } else if (conv.groupId) {
      await this.prisma.groupMember.updateMany({
        where: { groupId: conv.groupId, userId },
        data: { lastReadMsgId: msgId },
      });
    }
  }

  // ---------- 查询（REST） ----------

  async listConversations(userId: bigint) {
    const memberships = await this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true, lastReadMsgId: true } });
    const groupIds = memberships.map((m) => m.groupId);
    const lastReadByGroup = new Map(memberships.map((m) => [m.groupId.toString(), m.lastReadMsgId]));

    const convs = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { userAId: userId },
          { userBId: userId },
          ...(groupIds.length ? [{ groupId: { in: groupIds } }] : []),
        ],
      },
      orderBy: { lastMsgAt: 'desc' },
      take: 100,
    });

    const result = [] as any[];
    for (const conv of convs) {
      const key = this.crypto.unwrapKey(conv.wrappedKey);
      const lastMsg = await this.prisma.message.findFirst({
        where: { conversationId: conv.id },
        orderBy: { id: 'desc' },
      });

      if (conv.type === 1) {
        const peerId = conv.userAId === userId ? conv.userBId! : conv.userAId!;
        const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
        const unread = await this.prisma.message.count({
          where: { conversationId: conv.id, receiverId: userId, isRead: false },
        });
        result.push({
          id: conv.id,
          type: 1,
          peer: peer && { id: peer.id, nickname: peer.nickname, avatar: peer.avatar, gender: peer.gender },
          lastMsg: lastMsg && this.preview(lastMsg, key),
          unread,
          lastMsgAt: conv.lastMsgAt,
        });
      } else if (conv.groupId) {
        const group = await this.prisma.chatGroup.findUnique({ where: { id: conv.groupId } });
        if (!group || group.status !== 0) continue;
        const lastRead = lastReadByGroup.get(conv.groupId.toString()) ?? 0n;
        const unread = await this.prisma.message.count({
          where: { conversationId: conv.id, id: { gt: lastRead }, senderId: { not: userId } },
        });
        result.push({
          id: conv.id,
          type: 2,
          group: { id: group.id, name: group.name, avatar: group.avatar },
          lastMsg: lastMsg && this.preview(lastMsg, key),
          unread,
          lastMsgAt: conv.lastMsgAt,
        });
      }
    }
    return result;
  }

  /**
   * 清空聊天记录：
   * 单聊 = 双向物理删除全部消息，并实时推送双方在线端同步清空；
   * 群聊 = 物理删除本人发送的全部消息，并实时推送所有群成员刷新消息列表。
   */
  async clearMessages(userId: bigint, conversationId: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(userId, conv);

    if (conv.type === 1) {
      await this.prisma.message.deleteMany({ where: { conversationId } });
      const peers = [conv.userAId, conv.userBId].filter((id): id is bigint => id != null);
      await this.registry.deliver(peers, { op: 'conv_cleared', data: { conversationId: conversationId.toString() } });
    } else if (conv.groupId) {
      await this.prisma.message.deleteMany({ where: { conversationId, senderId: userId } });
      const members = await this.prisma.groupMember.findMany({
        where: { groupId: conv.groupId },
        select: { userId: true },
      });
      await this.registry.deliver(
        members.map((m) => m.userId),
        { op: 'conv_cleared', data: { conversationId: conversationId.toString() } },
      );
    }
    return { ok: true };
  }

  async listMessages(userId: bigint, conversationId: bigint, beforeId?: bigint, limit = 30) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(userId, conv);

    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const messages = await this.prisma.message.findMany({
      where: { conversationId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: Math.min(limit, 50),
    });

    const senderIds = [...new Set(messages.map((m) => m.senderId.toString()))];
    const senders = await this.prisma.user.findMany({ where: { id: { in: senderIds.map(BigInt) } } });
    const senderMap = new Map(senders.map((s) => [s.id.toString(), s]));

    return messages.reverse().map((m) => {
      const sender = senderMap.get(m.senderId.toString());
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        senderNickname: sender?.nickname ?? '',
        senderAvatar: sender?.avatar ?? '',
        receiverId: m.receiverId,
        type: m.type,
        content: this.crypto.decrypt(key, m.cipherContent),
        isRead: m.isRead,
        createdAt: m.createdAt,
      };
    });
  }

  private async assertMember(userId: bigint, conv: any) {
    if (conv.type === 1) {
      if (conv.userAId !== userId && conv.userBId !== userId) throw new ForbiddenException('无权访问该会话');
    } else if (conv.groupId) {
      const member = await this.prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: conv.groupId, userId } },
      });
      if (!member) throw new ForbiddenException('不在该群中');
    }
  }

  private preview(msg: any, key: Buffer) {
    let content: string;
    try {
      content = this.crypto.decrypt(key, msg.cipherContent);
    } catch {
      content = '';
    }
    return { id: msg.id, senderId: msg.senderId, type: msg.type, content, createdAt: msg.createdAt };
  }

  private toPayload(msg: any, conv: any, sender: any, plainContent: string): MessagePayload {
    return {
      id: msg.id.toString(),
      conversationId: conv.id.toString(),
      convType: conv.type,
      groupId: conv.groupId?.toString() ?? null,
      senderId: sender.id.toString(),
      senderNickname: sender.nickname,
      senderAvatar: sender.avatar,
      receiverId: msg.receiverId?.toString() ?? null,
      type: msg.type,
      content: plainContent,
      createdAt: msg.createdAt.toISOString(),
    };
  }
}
