import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectionRegistry } from './connection.registry';
import { IntimacyService } from '../intimacy/intimacy.service';
import { MessagePayload, ReactionView, ReplyPreview, SendFrame } from './im.types';
import { resolveInviteUser } from '../invite/invite.service';
import { BotService } from './bot.service';
import { sanitizeCallout } from './card-content';
import { COIN_GROUP_COLD_MS } from './coin-group.service';

/** 需要扣费的消息类型（礼物走礼物模块自身计费） */
const CHARGED_TYPES = new Set(['text', 'image', 'video', 'audio', 'location', 'sticker', 'callout']);
/** 频道帖子允许的类型（callout = 喊单卡片） */
const CHANNEL_TYPES = new Set(['text', 'image', 'video', 'audio', 'location', 'sticker', 'callout']);

@Injectable()
export class ImService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly wallets: WalletService,
    private readonly intimacy: IntimacyService,
    private readonly bots: BotService,
  ) {}

  // ---------- 发送 ----------

  async sendMessage(senderId: bigint, frame: SendFrame): Promise<MessagePayload> {
    const sender = await this.prisma.user.findUnique({ where: { id: senderId } });
    if (!sender || sender.status !== 0) throw new ForbiddenException('账号异常');
    if (frame.msgType === 'callout') frame = { ...frame, content: sanitizeCallout(frame.content) };

    if (frame.convType === 1) {
      return this.sendSingle(sender, BigInt(frame.targetId), frame);
    }
    return this.sendGroup(sender, BigInt(frame.targetId), frame);
  }

  private async sendSingle(sender: any, peerId: bigint, frame: SendFrame): Promise<MessagePayload> {
    if (peerId === sender.id) throw new BadRequestException('不能给自己发消息');
    const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
    if (!peer || peer.status !== 0) throw new NotFoundException('对方不存在');
    // 不限性别：同性只能经扫邀请名片进来（遇见 / 搜索 / 主页仍只展示异性）

    const conv = await this.getOrCreateSingleConversation(sender.id, peerId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const reply = await this.resolveReply(conv.id, key, frame.replyToId);

    // 男→女消息按条扣费（后台设价，收入归女方）；同性之间免费
    let msgFee = 0n;
    if (sender.gender === 1 && peer.gender === 2 && CHARGED_TYPES.has(frame.msgType)) {
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
          replyToId: reply ? BigInt(reply.id) : null,
          fwdFrom: frame.fwdFrom || null,
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

    const payload = this.toPayload(msg, conv, sender, frame.content, reply);
    if (peer.isBot) {
      void this.bots.onPrivateMessage(peer, sender, msg, frame.msgType, frame.content).catch(() => {});
      return payload;
    }
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
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId }, select: { id: true, name: true, kind: true, status: true, memberPost: true } });
    if (!group || group.status !== 0) throw new NotFoundException('群不存在');
    if (group.kind === 2) {
      if (member.role !== 'owner' && member.role !== 'admin' && !group.memberPost) throw new ForbiddenException('频道只有频道主能发帖');
      if (!CHANNEL_TYPES.has(frame.msgType)) throw new BadRequestException('频道不支持这种消息');
    }
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) throw new NotFoundException('群会话不存在');

    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const reply = await this.resolveReply(conv.id, key, frame.replyToId);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId: sender.id,
        receiverId: null,
        type: frame.msgType,
        cipherContent: this.crypto.encrypt(key, frame.content),
        replyToId: reply ? BigInt(reply.id) : null,
        fwdFrom: frame.fwdFrom || null,
      },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });
    // 频道阅读数按 lastReadMsgId 统计，发帖人自己算已读
    await this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: sender.id } }, data: { lastReadMsgId: msg.id } });

    const payload = this.toPayload(msg, conv, sender, frame.content, reply);
    if (group.kind === 2 && member.role !== 'owner' && member.role !== 'admin' && !sender.isBot) payload.memberMsg = true;
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    const targets = members.map((m) => m.userId).filter((id) => id !== sender.id);
    await this.registry.deliver(targets, { op: 'msg', data: payload });
    void this.bots.onGroupMessage(group, sender, msg, frame.msgType, frame.content).catch(() => {});
    return payload;
  }

  /** 扫邀请名片（内容 SITE_BASE/t/?u=短号）：直接打开与名片主人的单聊，不需要对方同意 */
  async openByInviteCode(userId: bigint, code: string) {
    const peer = await resolveInviteUser(this.prisma, code);
    if (!peer || peer.status !== 0) throw new NotFoundException('名片已失效');
    if (peer.id === userId) throw new BadRequestException('这是你自己的名片');
    const conv = await this.getOrCreateSingleConversation(userId, peer.id);
    return { conversationId: conv.id, peer: { id: peer.id, nickname: peer.nickname, avatar: peer.avatar } };
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
        data: { isRead: true, readAt: new Date() },
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
    const memberships = await this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true, lastReadMsgId: true, muted: true } });
    const groupIds = memberships.map((m) => m.groupId);
    const lastReadByGroup = new Map(memberships.map((m) => [m.groupId.toString(), m.lastReadMsgId]));
    const mutedGroups = new Set(memberships.filter((m) => m.muted).map((m) => m.groupId.toString()));

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

    // 币的讨论群 7 天没人说话就不显示（从钱包代币页还能进；有人发言就回来）
    const coinGroups = groupIds.length ? new Set((await this.prisma.coinGroup.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true } })).map((g) => g.groupId.toString())) : new Set<string>();
    const coldBefore = Date.now() - COIN_GROUP_COLD_MS;

    // 「只删自己这边」的消息不当会话预览
    const hiddenRows = await this.prisma.messageHide.findMany({ where: { userId }, select: { messageId: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const hidden = new Set(hiddenRows.map((h) => h.messageId.toString()));

    const result = [] as any[];
    for (const conv of convs) {
      if (conv.groupId && coinGroups.has(conv.groupId.toString()) && conv.lastMsgAt.getTime() < coldBefore) continue;
      const key = this.crypto.unwrapKey(conv.wrappedKey);
      const recent = await this.prisma.message.findMany({
        where: { conversationId: conv.id },
        orderBy: { id: 'desc' },
        take: hidden.size ? 10 : 1,
      });
      const lastMsg = recent.find((m) => !hidden.has(m.id.toString())) ?? null;

      if (conv.type === 1) {
        const peerId = conv.userAId === userId ? conv.userBId! : conv.userAId!;
        const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
        // 机器人被删除 / 封禁：会话不再显示
        if (peer?.isBot && peer.status !== 0) continue;
        const unread = await this.prisma.message.count({
          where: { conversationId: conv.id, receiverId: userId, isRead: false },
        });
        result.push({
          id: conv.id,
          type: 1,
          peer: peer && { id: peer.id, nickname: peer.nickname, avatar: peer.avatar, gender: peer.gender, isBot: peer.isBot },
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
        // 没设置群头像时默认显示群主头像
        let groupAvatar = group.avatar;
        if (!groupAvatar) {
          const owner = await this.prisma.user.findUnique({ where: { id: group.ownerId }, select: { avatar: true } });
          groupAvatar = owner?.avatar ?? '';
        }
        result.push({
          id: conv.id,
          type: 2,
          // kind 2 = 频道（老客户端忽略 kind，按群聊显示）
          group: { id: group.id, name: group.name, avatar: groupAvatar, kind: group.kind },
          lastMsg: lastMsg && this.preview(lastMsg, key),
          unread,
          muted: mutedGroups.has(conv.groupId.toString()),
          lastMsgAt: conv.lastMsgAt,
        });
      }
    }
    return result;
  }

  /**
   * 消息页搜索：
   * messages = 我所在会话里文字消息的内容匹配（密文只能逐条解密后比对，只扫最近 SEARCH_SCAN 条）；
   * users = 按 6 位 ID（不限性别）/ 昵称（仅异性）找用户，客户端点了直接开私聊。
   * 会话名匹配由客户端在本地会话列表里做。
   */
  async search(userId: bigint, raw: string) {
    const q = (raw ?? '').trim().slice(0, 50);
    if (!q) return { messages: [], users: [] };
    const needle = q.toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    if (!me) return { messages: [], users: [] };

    const memberships = await this.prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    const groupIds = memberships.map((m) => m.groupId);
    const convs = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { userAId: userId },
          { userBId: userId },
          ...(groupIds.length ? [{ groupId: { in: groupIds } }] : []),
        ],
      },
      select: { id: true, type: true, groupId: true, userAId: true, userBId: true, wrappedKey: true },
    });
    const groups = groupIds.length
      ? await this.prisma.chatGroup.findMany({ where: { id: { in: groupIds }, status: 0 } })
      : [];
    const groupMap = new Map(groups.map((g) => [g.id.toString(), g]));
    const convMap = new Map(
      convs.filter((c) => c.type === 1 || (c.groupId && groupMap.has(c.groupId.toString()))).map((c) => [c.id.toString(), c]),
    );

    const SEARCH_SCAN = 5000;
    const MAX_HITS = 60;
    const rows = convMap.size
      ? await this.prisma.message.findMany({
          where: { conversationId: { in: [...convMap.values()].map((c) => c.id) }, type: 'text' },
          orderBy: { id: 'desc' },
          take: SEARCH_SCAN,
          select: { id: true, conversationId: true, senderId: true, cipherContent: true, createdAt: true },
        })
      : [];
    const keys = new Map<string, Buffer>();
    const hits: { row: (typeof rows)[number]; content: string; idx: number }[] = [];
    for (const row of rows) {
      const cid = row.conversationId.toString();
      let key = keys.get(cid);
      if (!key) {
        key = this.crypto.unwrapKey(convMap.get(cid)!.wrappedKey);
        keys.set(cid, key);
      }
      let content: string;
      try {
        content = this.crypto.decrypt(key, row.cipherContent);
      } catch {
        continue;
      }
      const idx = content.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      hits.push({ row, content, idx });
      if (hits.length >= MAX_HITS) break;
    }

    // 发送者 + 单聊对方 + 群主（群没头像时回退群主头像）一次查完
    const userIds = new Set<string>();
    for (const h of hits) {
      userIds.add(h.row.senderId.toString());
      const c = convMap.get(h.row.conversationId.toString())!;
      if (c.type === 1) userIds.add((c.userAId === userId ? c.userBId! : c.userAId!).toString());
    }
    for (const g of groups) if (!g.avatar) userIds.add(g.ownerId.toString());
    const people = userIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...userIds].map(BigInt) } },
          select: { id: true, nickname: true, avatar: true },
        })
      : [];
    const personMap = new Map(people.map((p) => [p.id.toString(), p]));

    const messages = hits.map(({ row, content, idx }) => {
      const c = convMap.get(row.conversationId.toString())!;
      let title = '';
      let avatar = '';
      let targetId = '';
      if (c.type === 1) {
        const peerId = (c.userAId === userId ? c.userBId! : c.userAId!).toString();
        const peer = personMap.get(peerId);
        title = peer?.nickname ?? '';
        avatar = peer?.avatar ?? '';
        targetId = peerId;
      } else {
        const g = groupMap.get(c.groupId!.toString())!;
        title = g.name;
        avatar = g.avatar || personMap.get(g.ownerId.toString())?.avatar || '';
        targetId = g.id.toString();
      }
      const start = Math.max(0, idx - 16);
      const snippet = (start > 0 ? '…' : '') + content.slice(start, start + 120).replace(/\s+/g, ' ');
      const sender = personMap.get(row.senderId.toString());
      return {
        id: row.id.toString(),
        conversationId: c.id.toString(),
        convType: c.type,
        targetId,
        title,
        avatar,
        senderId: row.senderId.toString(),
        senderNickname: row.senderId === userId ? '我' : sender?.nickname ?? '',
        content: snippet,
        createdAt: row.createdAt,
      };
    });

    // 6 位 ID 精确匹配不限性别（知道 ID 等同拿到名片）；昵称模糊匹配只找异性
    const users = await this.prisma.user.findMany({
      where: {
        status: 0,
        isBot: false,
        id: { not: userId },
        OR: [{ shortId: q }, { nickname: { contains: q }, gender: me.gender === 1 ? 2 : 1 }],
      },
      orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, nickname: true, avatar: true, gender: true, age: true, cityName: true },
    });

    // 机器人按用户名找（@xxx_bot 或 xxx_bot 都行）
    const uname = q.replace(/^@/, '');
    const bots = /^[A-Za-z0-9_]{2,40}$/.test(uname)
      ? await this.prisma.bot.findMany({ where: { username: { contains: uname } }, take: 10 })
      : [];
    const botUsers = bots.length
      ? await this.prisma.user.findMany({ where: { id: { in: bots.map((b) => b.id) }, status: 0 }, select: { id: true, nickname: true, avatar: true } })
      : [];
    const botMap = new Map(bots.map((b) => [b.id.toString(), b]));
    const botHits = botUsers.map((u) => ({ ...u, gender: 0, age: 0, cityName: '', isBot: true, username: botMap.get(u.id.toString())?.username ?? '' }));

    return { messages, users: [...botHits, ...users] };
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
      await this.prisma.messagePin.deleteMany({ where: { conversationId } });
      await this.prisma.messageHide.deleteMany({ where: { conversationId } });
      await this.prisma.message.deleteMany({ where: { conversationId } });
      const peers = [conv.userAId, conv.userBId].filter((id): id is bigint => id != null);
      await this.registry.deliver(peers, { op: 'conv_cleared', data: { conversationId: conversationId.toString() } });
    } else if (conv.groupId) {
      const own = await this.prisma.message.findMany({ where: { conversationId, senderId: userId }, select: { id: true } });
      const ids = own.map((m) => m.id);
      if (ids.length) {
        await this.prisma.messagePin.deleteMany({ where: { messageId: { in: ids } } });
        await this.prisma.messageHide.deleteMany({ where: { messageId: { in: ids } } });
        await this.prisma.channelReaction.deleteMany({ where: { messageId: { in: ids } } });
      }
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

  /**
   * 默认返回最新 limit 条；带 aroundId（搜索结果定位）时返回「目标往前 20 条 → 最新」的连续一段，
   * 客户端仍按「列表末尾即最新」追加实时消息。往后最多 1000 条，超出部分不返回。
   */
  async listMessages(userId: bigint, conversationId: bigint, beforeId?: bigint, limit = 30, aroundId?: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(userId, conv);

    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const hiddenRows = await this.prisma.messageHide.findMany({ where: { userId, conversationId }, select: { messageId: true } });
    const notHidden = hiddenRows.length ? { id: { notIn: hiddenRows.map((h) => h.messageId) } } : {};
    let messages;
    if (aroundId) {
      const [older, newer] = await Promise.all([
        this.prisma.message.findMany({
          where: { conversationId, AND: [{ id: { lt: aroundId } }, notHidden] },
          orderBy: { id: 'desc' },
          take: 20,
        }),
        this.prisma.message.findMany({
          where: { conversationId, AND: [{ id: { gte: aroundId } }, notHidden] },
          orderBy: { id: 'asc' },
          take: 1000,
        }),
      ]);
      messages = [...newer.reverse(), ...older];
    } else {
      messages = await this.prisma.message.findMany({
        where: { conversationId, AND: [beforeId ? { id: { lt: beforeId } } : {}, notHidden] },
        orderBy: { id: 'desc' },
        take: Math.min(limit, 50),
      });
    }

    const senderIds = [...new Set(messages.map((m) => m.senderId.toString()))];
    const senders = await this.prisma.user.findMany({ where: { id: { in: senderIds.map(BigInt) } } });
    const senderMap = new Map(senders.map((s) => [s.id.toString(), s]));
    const ids = messages.map((m) => m.id);
    const [markups, replies, reactions] = await Promise.all([
      this.markupsOf(messages.filter((m) => senderMap.get(m.senderId.toString())?.isBot).map((m) => m.id)),
      this.replyPreviewsOf(key, messages.map((m) => m.replyToId).filter((x): x is bigint => x != null)),
      this.reactionsOf(ids),
    ]);

    return messages.reverse().map((m) => {
      const sender = senderMap.get(m.senderId.toString());
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        senderNickname: sender?.nickname ?? '',
        senderAvatar: sender?.avatar ?? '',
        ...(sender?.isBot ? { senderIsBot: true, markup: markups.get(m.id.toString()) ?? null } : {}),
        receiverId: m.receiverId,
        type: m.type,
        content: this.crypto.decrypt(key, m.cipherContent),
        isRead: m.isRead,
        readAt: m.readAt,
        createdAt: m.createdAt,
        replyTo: m.replyToId ? replies.get(m.replyToId.toString()) ?? { id: m.replyToId.toString(), senderId: '', senderNickname: '', type: '', content: '', deleted: true } : null,
        fwdFrom: m.fwdFrom,
        reactions: reactions.get(m.id.toString()) ?? [],
      };
    });
  }

  /** 发送时校验 replyToId 属于同一会话，返回引用预览；不合法就当没回复 */
  async resolveReply(conversationId: bigint, key: Buffer, replyToId?: string): Promise<ReplyPreview | null> {
    if (!replyToId || !/^\d+$/.test(replyToId)) return null;
    const m = await this.prisma.message.findUnique({ where: { id: BigInt(replyToId) } });
    if (!m || m.conversationId !== conversationId) return null;
    return (await this.replyPreviewsOf(key, [m.id])).get(m.id.toString()) ?? null;
  }

  async replyPreviewsOf(key: Buffer, ids: bigint[]) {
    const map = new Map<string, ReplyPreview>();
    if (!ids.length) return map;
    const rows = await this.prisma.message.findMany({ where: { id: { in: [...new Set(ids)] } } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.senderId))] } },
      select: { id: true, nickname: true },
    });
    const names = new Map(users.map((u) => [u.id.toString(), u.nickname]));
    for (const r of rows) {
      let content = '';
      try {
        const plain = this.crypto.decrypt(key, r.cipherContent);
        if (r.type === 'text') content = plain.slice(0, 100);
        else if (r.type === 'image') content = plain;
      } catch {
        /* ignore */
      }
      map.set(r.id.toString(), {
        id: r.id.toString(),
        senderId: r.senderId.toString(),
        senderNickname: names.get(r.senderId.toString()) ?? '',
        type: r.type,
        content,
      });
    }
    return map;
  }

  /** messageId → [{emoji,count,userIds}]，按数量降序 */
  async reactionsOf(ids: bigint[]) {
    const map = new Map<string, ReactionView[]>();
    if (!ids.length) return map;
    const rows = await this.prisma.channelReaction.findMany({
      where: { messageId: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { messageId: true, userId: true, emoji: true },
    });
    const byMsg = new Map<string, Map<string, string[]>>();
    for (const r of rows) {
      const k = r.messageId.toString();
      if (!byMsg.has(k)) byMsg.set(k, new Map());
      const e = byMsg.get(k)!;
      if (!e.has(r.emoji)) e.set(r.emoji, []);
      e.get(r.emoji)!.push(r.userId.toString());
    }
    for (const [k, e] of byMsg) {
      map.set(
        k,
        [...e.entries()]
          .map(([emoji, users]) => ({ emoji, count: users.length, userIds: users.slice(0, 20) }))
          .sort((a, b) => b.count - a.count),
      );
    }
    return map;
  }

  /** 机器人消息的按钮（inline_keyboard），messageId → markup */
  async markupsOf(ids: bigint[]) {
    const map = new Map<string, unknown>();
    if (!ids.length) return map;
    const rows = await this.prisma.botMessageMarkup.findMany({ where: { messageId: { in: ids } } });
    for (const r of rows) {
      try {
        map.set(r.messageId.toString(), JSON.parse(r.markup));
      } catch {
        /* ignore */
      }
    }
    return map;
  }

  async assertMember(userId: bigint, conv: any) {
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

  private toPayload(msg: any, conv: any, sender: any, plainContent: string, reply?: ReplyPreview | null): MessagePayload {
    return {
      ...(reply ? { replyTo: reply } : {}),
      ...(msg.fwdFrom ? { fwdFrom: msg.fwdFrom } : {}),
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
