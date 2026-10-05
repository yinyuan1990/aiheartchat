import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Wallet } from 'ethers';
import type { Bot, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { RedisService } from '../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { ConnectionRegistry } from './connection.registry';
import { ChannelService } from './channel.service';
import { BotAvatarService } from './bot-avatar.service';

/**
 * 机器人平台（Telegram Bot API 兼容）：
 * - 机器人本身是一个 user（isBot=true、gender=0、无短号、不能登录），资料在 bot 表；
 * - 用户发给机器人 / 群里 @机器人 / 回调按钮 → 写 bot_update，第三方用 getUpdates 长轮询或 webhook 收；
 * - 第三方用 /api/bot<token>/<method> 调 sendMessage 等，消息走正常会话，按钮存 bot_message_markup。
 */

export class BotApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly parameters?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type BotRow = Bot;
type UserRow = User;
export interface BotCtx {
  bot: BotRow;
  user: UserRow;
}
type Button = { text: string; url?: string; callback_data?: string };
type Markup = { inline_keyboard: Button[][] };
type Chat =
  | { kind: 'private'; conv: any; user: UserRow; chat: Record<string, unknown> }
  | { kind: 'group' | 'channel'; conv: any; group: any; chat: Record<string, unknown> };

const MAX_BOTS_PER_USER = 20;
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,28}bot$/i;
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?/;
const UPDATE_TTL_MS = 24 * 3600_000;
const MAX_PENDING = 1000;
const SENDS_PER_SEC = 30;

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Bot');
  /** getUpdates 长轮询的等待者：有新 update 时唤醒 */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly flushing = new Set<string>();
  private readonly tokenCache = new Map<string, { ctx: BotCtx; at: number }>();
  private timer?: NodeJS.Timeout;
  private ticks = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly redis: RedisService,
    private readonly uploads: UploadService,
    private readonly channels: ChannelService,
    private readonly avatars: BotAvatarService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`tick: ${e}`)), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ==================== 用户管理自己的机器人（App 内） ====================

  async create(ownerId: bigint, dto: { name?: string; username?: string; description?: string; avatar?: string }) {
    const name = (dto.name ?? '').trim();
    const username = (dto.username ?? '').trim().replace(/^@/, '');
    if (!name || name.length > 30) throw new BadRequestException('名称 1~30 个字');
    if (!USERNAME_RE.test(username)) throw new BadRequestException('用户名 4~32 位，字母开头，只能用字母数字下划线，必须以 bot 结尾');
    const description = (dto.description ?? '').trim();
    if (description.length > 500) throw new BadRequestException('简介最长 500 字');
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
    if (!owner || owner.status !== 0 || owner.isBot) throw new ForbiddenException('账号异常');
    if ((await this.prisma.bot.count({ where: { ownerId } })) >= MAX_BOTS_PER_USER) throw new BadRequestException(`每人最多 ${MAX_BOTS_PER_USER} 个机器人`);
    if (await this.prisma.bot.findUnique({ where: { username } })) throw new BadRequestException('这个用户名已被占用');

    const wallet = Wallet.createRandom();
    const user = await this.prisma.user.create({
      data: {
        // 机器人不能登录：deviceId 随机且 enter / register 都拒绝 isBot 账号
        deviceId: `bot_${randomBytes(24).toString('hex')}`,
        address: wallet.address,
        encPrivKey: this.crypto.wrapKey(Buffer.from(wallet.privateKey.slice(2), 'hex')),
        nickname: name,
        avatar: dto.avatar ?? '',
        gender: 0,
        isBot: true,
        wallet: { create: {} },
      },
    });
    const token = this.genToken(user.id);
    try {
      const bot = await this.prisma.bot.create({ data: { id: user.id, ownerId, username, description, tokenHash: this.hash(token) } });
      if (!user.avatar) this.avatars.ensure(user.id);
      return { ...this.view(bot, user), token };
    } catch (e) {
      await this.prisma.user.update({ where: { id: user.id }, data: { status: 1 } });
      throw new BadRequestException('这个用户名已被占用');
    }
  }

  async mine(ownerId: bigint) {
    const bots = await this.prisma.bot.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: bots.map((b) => b.id) } } });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    return bots.filter((b) => userMap.has(b.id.toString())).map((b) => this.view(b, userMap.get(b.id.toString())!));
  }

  async mineOne(ownerId: bigint, id: bigint) {
    const { bot, user } = await this.mustOwn(ownerId, id);
    const pending = await this.prisma.botUpdate.count({ where: { botId: id } });
    return { ...this.view(bot, user), pendingUpdates: pending, lastError: bot.lastError, lastErrorAt: bot.lastErrorAt };
  }

  async update(ownerId: bigint, id: bigint, dto: { name?: string; description?: string; avatar?: string; privacy?: boolean }) {
    const { bot } = await this.mustOwn(ownerId, id);
    const userData: { nickname?: string; avatar?: string } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name || name.length > 30) throw new BadRequestException('名称 1~30 个字');
      userData.nickname = name;
    }
    if (dto.avatar !== undefined) userData.avatar = dto.avatar;
    if (Object.keys(userData).length) await this.prisma.user.update({ where: { id }, data: userData });
    const botData: { description?: string; privacy?: boolean } = {};
    if (dto.description !== undefined) {
      if (dto.description.length > 500) throw new BadRequestException('简介最长 500 字');
      botData.description = dto.description.trim();
    }
    if (dto.privacy !== undefined) botData.privacy = !!dto.privacy;
    if (Object.keys(botData).length) await this.prisma.bot.update({ where: { id: bot.id }, data: botData });
    this.tokenCache.clear();
    return this.mineOne(ownerId, id);
  }

  async resetToken(ownerId: bigint, id: bigint) {
    await this.mustOwn(ownerId, id);
    const token = this.genToken(id);
    await this.prisma.bot.update({ where: { id }, data: { tokenHash: this.hash(token) } });
    this.tokenCache.clear();
    return { token };
  }

  /** 删除机器人：退出所有群 / 频道，账号停用（历史消息保留），用户名释放 */
  async remove(ownerId: bigint, id: bigint) {
    await this.mustOwn(ownerId, id);
    await this.destroy(id);
    return { ok: true };
  }

  async destroy(id: bigint) {
    const memberships = await this.prisma.groupMember.findMany({ where: { userId: id }, select: { groupId: true } });
    await this.prisma.$transaction([
      this.prisma.groupMember.deleteMany({ where: { userId: id } }),
      this.prisma.botUpdate.deleteMany({ where: { botId: id } }),
      this.prisma.bot.delete({ where: { id } }),
      this.prisma.user.update({ where: { id }, data: { status: 1 } }),
    ]);
    this.tokenCache.clear();
    if (memberships.length) {
      const members = await this.prisma.groupMember.findMany({ where: { groupId: { in: memberships.map((m) => m.groupId) } }, select: { userId: true } });
      void this.registry.deliver([...new Set(members.map((m) => m.userId.toString()))], { op: 'conv_refresh' }).catch(() => {});
    }
  }

  // ==================== 后台 ====================

  async adminList(q?: string) {
    const kw = (q ?? '').trim().replace(/^@/, '');
    const bots = await this.prisma.bot.findMany({
      where: kw ? { username: { contains: kw } } : {},
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    if (!bots.length) return [];
    const ids = bots.map((b) => b.id);
    const [users, owners, pending, chats] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } } }),
      this.prisma.user.findMany({ where: { id: { in: bots.map((b) => b.ownerId) } }, select: { id: true, nickname: true, shortId: true } }),
      this.prisma.botUpdate.groupBy({ by: ['botId'], where: { botId: { in: ids } }, _count: { _all: true } }),
      this.prisma.groupMember.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
    ]);
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const ownerMap = new Map(owners.map((o) => [o.id.toString(), o]));
    const pendingMap = new Map(pending.map((p) => [p.botId.toString(), p._count._all]));
    const chatMap = new Map(chats.map((c) => [c.userId.toString(), c._count._all]));
    return bots
      .filter((b) => userMap.has(b.id.toString()))
      .map((b) => ({
        ...this.view(b, userMap.get(b.id.toString())!),
        owner: ownerMap.get(b.ownerId.toString()) ?? null,
        pendingUpdates: pendingMap.get(b.id.toString()) ?? 0,
        chats: chatMap.get(b.id.toString()) ?? 0,
        lastError: b.lastError,
        lastErrorAt: b.lastErrorAt,
      }));
  }

  /** 封禁 = 机器人账号停用（token 失效、发不了消息），解封恢复 */
  async adminSetBanned(id: bigint, banned: boolean) {
    const bot = await this.prisma.bot.findUnique({ where: { id } });
    if (!bot) throw new NotFoundException('机器人不存在');
    await this.prisma.user.update({ where: { id }, data: { status: banned ? 1 : 0 } });
    this.tokenCache.clear();
    return { ok: true };
  }

  async adminDelete(id: bigint) {
    if (!(await this.prisma.bot.findUnique({ where: { id } }))) throw new NotFoundException('机器人不存在');
    await this.destroy(id);
    return { ok: true };
  }

  /** 机器人公开资料：聊天页头部 / 命令菜单 / 开始按钮 */
  async publicInfo(idOrUsername: string) {
    const raw = (idOrUsername ?? '').trim().replace(/^@/, '');
    const bot = /^\d+$/.test(raw)
      ? await this.prisma.bot.findUnique({ where: { id: BigInt(raw) } })
      : await this.prisma.bot.findUnique({ where: { username: raw } });
    const user = bot ? await this.prisma.user.findUnique({ where: { id: bot.id } }) : null;
    if (!bot || !user || user.status !== 0) throw new NotFoundException('机器人不存在');
    return {
      id: bot.id,
      username: bot.username,
      name: user.nickname,
      avatar: user.avatar,
      description: bot.description,
      commands: this.commandsOf(bot),
      ownerId: bot.ownerId,
    };
  }

  /** 群主 / 管理员按用户名把机器人加进群；频道里加进来就是管理员（才能发帖） */
  async addToChat(operatorId: bigint, groupId: bigint, username: string) {
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) throw new NotFoundException('群不存在');
    const op = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: operatorId } } });
    if (op?.role !== 'owner' && op?.role !== 'admin') throw new ForbiddenException(group.kind === 2 ? '只有频道主能添加机器人' : '只有群主 / 管理员能添加机器人');
    const info = await this.publicInfo(username);
    const role = group.kind === 2 ? 'admin' : 'member';
    const existing = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: info.id } } });
    if (existing) {
      if (existing.role === role) return { ok: true, bot: info };
      await this.prisma.groupMember.update({ where: { id: existing.id }, data: { role } });
    } else {
      const count = await this.prisma.groupMember.count({ where: { groupId } });
      if (count >= group.memberLimit) throw new BadRequestException('群成员已达上限');
      await this.prisma.groupMember.create({ data: { groupId, userId: info.id, role } });
    }
    const operator = await this.prisma.user.findUnique({ where: { id: operatorId } });
    const bot = await this.prisma.bot.findUnique({ where: { id: info.id } });
    const botUser = await this.prisma.user.findUnique({ where: { id: info.id } });
    if (bot && botUser && operator) {
      await this.enqueue(bot, {
        my_chat_member: {
          chat: this.groupChat(group),
          from: this.tgUser(operator),
          date: Math.floor(Date.now() / 1000),
          old_chat_member: { user: this.tgUser(botUser, bot), status: existing ? 'member' : 'left' },
          new_chat_member: { user: this.tgUser(botUser, bot), status: role === 'admin' ? 'administrator' : 'member' },
        },
      });
    }
    return { ok: true, bot: info };
  }

  /** 机器人被移出群 / 频道（群主踢出或机器人 leaveChat） */
  async onRemovedFromChat(botId: bigint, groupId: bigint, operatorId: bigint) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) return;
    const [group, botUser, operator] = await Promise.all([
      this.prisma.chatGroup.findUnique({ where: { id: groupId } }),
      this.prisma.user.findUnique({ where: { id: botId } }),
      this.prisma.user.findUnique({ where: { id: operatorId } }),
    ]);
    if (!group || !botUser || !operator) return;
    await this.enqueue(bot, {
      my_chat_member: {
        chat: this.groupChat(group),
        from: this.tgUser(operator, operator.id === botId ? bot : undefined),
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { user: this.tgUser(botUser, bot), status: group.kind === 2 ? 'administrator' : 'member' },
        new_chat_member: { user: this.tgUser(botUser, bot), status: operator.id === botId ? 'left' : 'kicked' },
      },
    });
  }

  // ==================== 用户侧：消息 / 按钮 → update ====================

  /** 用户发给机器人的私聊消息（ImService.sendSingle 调） */
  async onPrivateMessage(botUser: UserRow, sender: UserRow, msg: any, type: string, content: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botUser.id } });
    if (!bot) return;
    await this.enqueue(bot, { message: this.messageObj(msg, type, content, this.tgUser(sender), this.privateChat(sender)) });
  }

  /** 群 / 频道里的新消息（ImService.sendGroup 调）：隐私模式下群里只收 /命令 和 @我；频道里的机器人都是管理员，收全部帖子 */
  async onGroupMessage(group: { id: bigint; kind: number; name: string }, sender: UserRow, msg: any, type: string, content: string) {
    if (sender.isBot) return;
    const rows = await this.prisma.$queryRaw<{ userId: bigint; role: string }[]>`
      SELECT gm.user_id AS userId, gm.role AS role FROM group_member gm JOIN user u ON u.id = gm.user_id
      WHERE gm.group_id = ${group.id} AND u.is_bot = 1 AND u.status = 0`;
    if (!rows.length) return;
    const bots = await this.prisma.bot.findMany({ where: { id: { in: rows.map((r) => BigInt(r.userId)) } } });
    const roleOf = new Map(rows.map((r) => [BigInt(r.userId).toString(), r.role]));
    const chat = this.groupChat(group);
    const text = type === 'text' ? content : '';
    for (const bot of bots) {
      if (group.kind === 2) {
        await this.enqueue(bot, { channel_post: this.messageObj(msg, type, content, null, chat) });
        continue;
      }
      const role = roleOf.get(bot.id.toString());
      const cmd = COMMAND_RE.exec(text);
      const wants =
        !bot.privacy ||
        role === 'admin' ||
        role === 'owner' ||
        (cmd && (!cmd[2] || cmd[2].toLowerCase() === bot.username.toLowerCase())) ||
        text.toLowerCase().includes(`@${bot.username.toLowerCase()}`);
      if (wants) await this.enqueue(bot, { message: this.messageObj(msg, type, content, this.tgUser(sender), chat) });
    }
  }

  /** 用户点了回调按钮：生成 callback_query，机器人用 answerCallbackQuery 回（推 bot_callback_answer 给这个用户） */
  async userCallback(userId: bigint, messageId: bigint, data: string) {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('消息不存在');
    const bot = await this.prisma.bot.findUnique({ where: { id: msg.senderId } });
    if (!bot) throw new BadRequestException('不是机器人消息');
    const conv = await this.prisma.conversation.findUnique({ where: { id: msg.conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    let chat: Record<string, unknown>;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');
    if (conv.type === 1) {
      if (conv.userAId !== userId && conv.userBId !== userId) throw new ForbiddenException('无权操作');
      chat = this.privateChat(user);
    } else {
      const member = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: conv.groupId!, userId } } });
      const group = await this.prisma.chatGroup.findUnique({ where: { id: conv.groupId! } });
      if (!group || group.status !== 0) throw new NotFoundException('群不存在');
      if (!member && group.kind !== 2) throw new ForbiddenException('不在该群中');
      chat = this.groupChat(group);
    }
    const markupRow = await this.prisma.botMessageMarkup.findUnique({ where: { messageId } });
    const markup = markupRow ? (JSON.parse(markupRow.markup) as Markup) : null;
    if (!markup?.inline_keyboard.some((row) => row.some((b) => b.callback_data === data))) throw new BadRequestException('按钮已失效');

    const queryId = `${Date.now()}${randomBytes(4).readUInt32BE(0)}`;
    await this.redis.client.set(`botcb:${queryId}`, JSON.stringify({ u: userId.toString(), b: bot.id.toString() }), 'EX', 600);
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const botUser = await this.prisma.user.findUnique({ where: { id: bot.id } });
    await this.enqueue(bot, {
      callback_query: {
        id: queryId,
        from: this.tgUser(user),
        message: this.messageObj(msg, msg.type, this.safeDecrypt(key, msg.cipherContent), botUser ? this.tgUser(botUser, bot) : null, chat, markup),
        chat_instance: conv.id.toString(),
        data,
      },
    });
    return { queryId };
  }

  // ==================== Bot API（第三方调用） ====================

  async auth(token: string): Promise<BotCtx> {
    const cached = this.tokenCache.get(token);
    if (cached && Date.now() - cached.at < 30_000) return cached.ctx;
    const m = /^(\d+):[A-Za-z0-9_-]{30,64}$/.exec(token ?? '');
    if (!m) throw new BotApiError(401, 'Unauthorized');
    const bot = await this.prisma.bot.findUnique({ where: { tokenHash: this.hash(token) } });
    if (!bot || bot.id.toString() !== m[1]) throw new BotApiError(401, 'Unauthorized');
    const user = await this.prisma.user.findUnique({ where: { id: bot.id } });
    if (!user || user.status !== 0) throw new BotApiError(401, 'Unauthorized');
    const ctx = { bot, user };
    if (this.tokenCache.size > 500) this.tokenCache.clear();
    this.tokenCache.set(token, { ctx, at: Date.now() });
    return ctx;
  }

  async call(ctx: BotCtx, method: string, p: Record<string, any>, file?: { buffer: Buffer; mimetype: string; size: number }) {
    switch (method.toLowerCase()) {
      case 'getme':
        return this.getMe(ctx);
      case 'logout':
      case 'close':
        return true;
      case 'getupdates':
        return this.getUpdates(ctx, p);
      case 'setwebhook':
        return this.setWebhook(ctx, p);
      case 'deletewebhook':
        return this.deleteWebhook(ctx, bool(p.drop_pending_updates));
      case 'getwebhookinfo':
        return this.webhookInfo(ctx);
      case 'sendmessage':
        return this.sendMessage(ctx, p);
      case 'sendphoto':
        return this.sendPhoto(ctx, p, file);
      case 'editmessagetext':
        return this.editMessage(ctx, p, true);
      case 'editmessagereplymarkup':
        return this.editMessage(ctx, p, false);
      case 'deletemessage':
        return this.deleteMessage(ctx, p);
      case 'answercallbackquery':
        return this.answerCallback(ctx, p);
      case 'setmycommands':
        return this.setCommands(ctx, p);
      case 'getmycommands':
        return this.commandsOf(ctx.bot);
      case 'deletemycommands':
        await this.prisma.bot.update({ where: { id: ctx.bot.id }, data: { commands: '[]' } });
        this.tokenCache.clear();
        return true;
      case 'getchat':
        return this.getChat(ctx, p);
      case 'getchatmembercount':
      case 'getchatmemberscount': {
        const t = await this.resolveChat(ctx, p.chat_id);
        return t.kind === 'private' ? 2 : this.prisma.groupMember.count({ where: { groupId: t.group.id } });
      }
      case 'leavechat':
        return this.leaveChat(ctx, p);
      case 'sendchataction':
        await this.resolveChat(ctx, p.chat_id);
        return true;
      case 'getfile':
        return this.getFile(p);
      default:
        throw new BotApiError(404, 'Not Found: method not found');
    }
  }

  private getMe({ bot, user }: BotCtx) {
    return {
      ...this.tgUser(user, bot),
      can_join_groups: true,
      can_read_all_group_messages: !bot.privacy,
      supports_inline_queries: false,
    };
  }

  private async getUpdates({ bot }: BotCtx, p: Record<string, any>) {
    if (bot.webhookUrl) {
      throw new BotApiError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
    }
    const offset = num(p.offset, 0);
    const limit = Math.min(100, Math.max(1, num(p.limit, 100)));
    const timeout = Math.min(50, Math.max(0, num(p.timeout, 0)));
    const allowed = list(p.allowed_updates);
    if (offset > 0) await this.prisma.botUpdate.deleteMany({ where: { botId: bot.id, id: { lt: BigInt(offset) } } });

    const load = async () => {
      if (offset < 0) {
        const rows = await this.prisma.botUpdate.findMany({ where: { botId: bot.id }, orderBy: { id: 'desc' }, take: Math.min(-offset, limit) });
        return rows.reverse();
      }
      return this.prisma.botUpdate.findMany({
        where: { botId: bot.id, ...(offset > 0 ? { id: { gte: BigInt(offset) } } : {}) },
        orderBy: { id: 'asc' },
        take: limit,
      });
    };
    let rows = await load();
    const deadline = Date.now() + timeout * 1000;
    while (!rows.length && Date.now() < deadline) {
      // 本节点有新 update 会立即唤醒；每 3 秒兜底查一次库（多节点部署时 update 可能写在别的节点）
      await this.waitUpdate(bot.id, Math.min(3000, deadline - Date.now()));
      rows = await load();
    }
    return rows
      .map((r) => ({ update_id: Number(r.id), ...JSON.parse(r.payload) }))
      .filter((u) => !allowed.length || Object.keys(u).some((k) => k !== 'update_id' && allowed.includes(k)));
  }

  private async setWebhook({ bot }: BotCtx, p: Record<string, any>) {
    const url = String(p.url ?? '').trim();
    if (!url) return this.deleteWebhook({ bot } as BotCtx, bool(p.drop_pending_updates));
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new BotApiError(400, 'Bad Request: invalid webhook URL specified');
    }
    if (u.protocol !== 'https:') throw new BotApiError(400, 'Bad Request: bad webhook: HTTPS url must be provided for webhook');
    if (u.port && !['443', '80', '88', '8443'].includes(u.port)) throw new BotApiError(400, 'Bad Request: bad webhook: Webhook can be set up only on ports 80, 88, 443 or 8443');
    if (url.length > 500) throw new BotApiError(400, 'Bad Request: bad webhook: URL is too long');
    await this.assertPublicHost(u.hostname);
    const secret = String(p.secret_token ?? '');
    if (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new BotApiError(400, 'Bad Request: secret token contains unallowed characters');
    await this.prisma.bot.update({ where: { id: bot.id }, data: { webhookUrl: url, webhookSecret: secret, lastError: '', lastErrorAt: null } });
    if (bool(p.drop_pending_updates)) await this.prisma.botUpdate.deleteMany({ where: { botId: bot.id } });
    this.tokenCache.clear();
    void this.flush(bot.id);
    return true;
  }

  private async deleteWebhook({ bot }: BotCtx, drop: boolean) {
    await this.prisma.bot.update({ where: { id: bot.id }, data: { webhookUrl: '', webhookSecret: '', lastError: '', lastErrorAt: null } });
    if (drop) await this.prisma.botUpdate.deleteMany({ where: { botId: bot.id } });
    this.tokenCache.clear();
    return true;
  }

  private async webhookInfo({ bot }: BotCtx) {
    const fresh = await this.prisma.bot.findUnique({ where: { id: bot.id } });
    const pending = await this.prisma.botUpdate.count({ where: { botId: bot.id } });
    return {
      url: fresh?.webhookUrl ?? '',
      has_custom_certificate: false,
      pending_update_count: pending,
      max_connections: 1,
      ...(fresh?.lastErrorAt ? { last_error_date: Math.floor(fresh.lastErrorAt.getTime() / 1000), last_error_message: fresh.lastError } : {}),
    };
  }

  private async sendMessage(ctx: BotCtx, p: Record<string, any>) {
    const text = formatText(String(p.text ?? ''), p.parse_mode);
    if (!text.trim()) throw new BotApiError(400, 'Bad Request: message text is empty');
    if (text.length > 4096) throw new BotApiError(400, 'Bad Request: message is too long');
    const target = await this.resolveChat(ctx, p.chat_id);
    return this.post(ctx, target, 'text', text, parseMarkup(p.reply_markup));
  }

  private async sendPhoto(ctx: BotCtx, p: Record<string, any>, file?: { buffer: Buffer; mimetype: string; size: number }) {
    const target = await this.resolveChat(ctx, p.chat_id);
    const caption = formatText(String(p.caption ?? ''), p.parse_mode);
    if (caption.length > 1024) throw new BotApiError(400, 'Bad Request: message caption is too long');
    const markup = parseMarkup(p.reply_markup);
    const url = await this.photoUrl(typeof p.photo === 'string' ? p.photo : '', file);
    const photo = await this.post(ctx, target, 'image', url, caption ? undefined : markup);
    if (!caption) return photo;
    // 我们的消息一条只有一种内容：说明文字单独发一条，按钮挂在文字上
    const textMsg = await this.post(ctx, target, 'text', caption, markup);
    return { ...photo, caption, ...(markup ? { reply_markup: markup } : {}), caption_message_id: textMsg.message_id };
  }

  private async photoUrl(photo: string, file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (file) {
      if (!file.mimetype.startsWith('image/')) throw new BotApiError(400, 'Bad Request: wrong type of the web page content');
      return (await this.uploads.upload('image', file)).url;
    }
    if (/^\/res\/[\w./-]+$/.test(photo)) return photo;
    if (!/^https?:\/\//i.test(photo)) throw new BotApiError(400, 'Bad Request: wrong file identifier/HTTP URL specified');
    const u = new URL(photo);
    await this.assertPublicHost(u.hostname);
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    } catch {
      throw new BotApiError(400, 'Bad Request: failed to get HTTP URL content');
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) throw new BotApiError(400, 'Bad Request: wrong type of the web page content');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw new BotApiError(400, 'Bad Request: file is too big');
    return (await this.uploads.putInternal('image', type.split('/')[1] || 'jpg', buf, type)).url;
  }

  private async editMessage(ctx: BotCtx, p: Record<string, any>, withText: boolean) {
    if (p.inline_message_id) throw new BotApiError(400, 'Bad Request: inline messages are not supported');
    const target = await this.resolveChat(ctx, p.chat_id);
    const msg = await this.ownMessage(ctx, target, p.message_id);
    const key = this.crypto.unwrapKey(target.conv.wrappedKey);
    let content = this.safeDecrypt(key, msg.cipherContent);
    const markup = parseMarkup(p.reply_markup);
    if (withText) {
      if (msg.type !== 'text') throw new BotApiError(400, 'Bad Request: there is no text in the message to edit');
      const text = formatText(String(p.text ?? ''), p.parse_mode);
      if (!text.trim()) throw new BotApiError(400, 'Bad Request: message text is empty');
      if (text.length > 4096) throw new BotApiError(400, 'Bad Request: message is too long');
      content = text;
      await this.prisma.message.update({ where: { id: msg.id }, data: { cipherContent: this.crypto.encrypt(key, text) } });
    }
    // 和 Telegram 一样：编辑时不带 reply_markup = 去掉按钮
    if (markup) await this.prisma.botMessageMarkup.upsert({ where: { messageId: msg.id }, create: { messageId: msg.id, markup: JSON.stringify(markup) }, update: { markup: JSON.stringify(markup) } });
    else await this.prisma.botMessageMarkup.deleteMany({ where: { messageId: msg.id } });
    await this.registry.deliver(await this.audience(target, ctx.bot.id), {
      op: 'msg_edit',
      data: { conversationId: target.conv.id.toString(), msgId: msg.id.toString(), content, markup: markup ?? null },
    });
    return { ...this.messageObj(msg, msg.type, content, this.tgUser(ctx.user, ctx.bot), target.chat, markup), edit_date: Math.floor(Date.now() / 1000) };
  }

  private async deleteMessage(ctx: BotCtx, p: Record<string, any>) {
    const target = await this.resolveChat(ctx, p.chat_id);
    const msg = await this.ownMessage(ctx, target, p.message_id);
    if (target.kind === 'channel') {
      await this.channels.purgePost(target.group.id, msg.id);
    } else {
      await this.prisma.$transaction([
        this.prisma.botMessageMarkup.deleteMany({ where: { messageId: msg.id } }),
        this.prisma.message.delete({ where: { id: msg.id } }),
      ]);
      await this.registry.deliver(await this.audience(target, ctx.bot.id), {
        op: 'msg_delete',
        data: { conversationId: target.conv.id.toString(), msgId: msg.id.toString() },
      });
    }
    return true;
  }

  private async answerCallback({ bot }: BotCtx, p: Record<string, any>) {
    const id = String(p.callback_query_id ?? '');
    const raw = id ? await this.redis.client.get(`botcb:${id}`) : null;
    const q = raw ? (JSON.parse(raw) as { u: string; b: string }) : null;
    if (!q || q.b !== bot.id.toString()) throw new BotApiError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
    await this.redis.client.del(`botcb:${id}`);
    const text = String(p.text ?? '').slice(0, 200);
    const url = String(p.url ?? '');
    await this.registry.deliver([q.u], {
      op: 'bot_callback_answer',
      data: { queryId: id, text, showAlert: bool(p.show_alert), url: /^https?:\/\//i.test(url) ? url : '' },
    });
    return true;
  }

  private async setCommands({ bot }: BotCtx, p: Record<string, any>) {
    let cmds: any = p.commands;
    if (typeof cmds === 'string') {
      try {
        cmds = JSON.parse(cmds);
      } catch {
        throw new BotApiError(400, "Bad Request: can't parse commands JSON object");
      }
    }
    if (!Array.isArray(cmds) || cmds.length > 100) throw new BotApiError(400, 'Bad Request: commands must be an array of at most 100 BotCommand');
    const clean = cmds.map((c: any) => {
      const command = String(c?.command ?? '').replace(/^\//, '').toLowerCase();
      const description = String(c?.description ?? '').trim();
      if (!/^[a-z0-9_]{1,32}$/.test(command)) throw new BotApiError(400, 'Bad Request: BOT_COMMAND_INVALID');
      if (!description || description.length > 256) throw new BotApiError(400, 'Bad Request: BOT_COMMAND_DESCRIPTION_INVALID');
      return { command, description };
    });
    const json = JSON.stringify(clean);
    if (json.length > 4000) throw new BotApiError(400, 'Bad Request: commands are too long');
    await this.prisma.bot.update({ where: { id: bot.id }, data: { commands: json } });
    this.tokenCache.clear();
    return true;
  }

  private async getChat(ctx: BotCtx, p: Record<string, any>) {
    const t = await this.resolveChat(ctx, p.chat_id);
    if (t.kind === 'private') return { ...t.chat, ...(t.user.signature ? { bio: t.user.signature } : {}) };
    return { ...t.chat, ...(t.group.notice ? { description: t.group.notice } : {}) };
  }

  private async leaveChat(ctx: BotCtx, p: Record<string, any>) {
    const t = await this.resolveChat(ctx, p.chat_id);
    if (t.kind === 'private') throw new BotApiError(400, 'Bad Request: chat member status can\'t be changed in private chats');
    await this.prisma.groupMember.delete({ where: { groupId_userId: { groupId: t.group.id, userId: ctx.bot.id } } });
    void this.onRemovedFromChat(ctx.bot.id, t.group.id, ctx.bot.id);
    return true;
  }

  private getFile(p: Record<string, any>) {
    const id = String(p.file_id ?? '');
    if (!/^\/res\/[\w./-]+$/.test(id)) throw new BotApiError(400, 'Bad Request: invalid file_id');
    return { file_id: id, file_unique_id: uniqueId(id), file_path: id.slice(1) };
  }

  // ==================== 内部：会话、发消息、update 队列、webhook ====================

  /** chat_id：正数 = 用户（私聊），负数 = -群 id（群 / 频道） */
  private async resolveChat(ctx: BotCtx, chatIdRaw: unknown): Promise<Chat> {
    const s = String(chatIdRaw ?? '').trim();
    if (!/^-?\d{1,19}$/.test(s)) throw new BotApiError(400, 'Bad Request: chat not found');
    const n = BigInt(s);
    if (n > 0n) {
      const user = await this.prisma.user.findUnique({ where: { id: n } });
      if (!user || user.status !== 0 || user.isBot) throw new BotApiError(400, 'Bad Request: chat not found');
      const [a, b] = n < ctx.bot.id ? [n, ctx.bot.id] : [ctx.bot.id, n];
      const conv = await this.prisma.conversation.findUnique({ where: { pairKey: `${a}_${b}` } });
      // 和 Telegram 一样：用户先给机器人发过消息，机器人才能私聊他
      const started = conv && (await this.prisma.message.findFirst({ where: { conversationId: conv.id, senderId: n }, select: { id: true } }));
      if (!conv || !started) throw new BotApiError(403, "Forbidden: bot can't initiate conversation with a user");
      return { kind: 'private', conv, user, chat: this.privateChat(user) };
    }
    const groupId = -n;
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) throw new BotApiError(400, 'Bad Request: chat not found');
    const member = await this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: ctx.bot.id } } });
    const channel = group.kind === 2;
    if (!member) throw new BotApiError(403, `Forbidden: bot is not a member of the ${channel ? 'channel' : 'group'} chat`);
    if (channel && member.role !== 'admin' && member.role !== 'owner') throw new BotApiError(403, 'Forbidden: need administrator rights in the channel chat');
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) throw new BotApiError(400, 'Bad Request: chat not found');
    return { kind: channel ? 'channel' : 'group', conv, group, chat: this.groupChat(group) };
  }

  private async ownMessage(ctx: BotCtx, target: Chat, messageIdRaw: unknown) {
    const s = String(messageIdRaw ?? '');
    if (!/^\d{1,19}$/.test(s)) throw new BotApiError(400, 'Bad Request: message to edit not found');
    const msg = await this.prisma.message.findUnique({ where: { id: BigInt(s) } });
    if (!msg || msg.conversationId !== target.conv.id) throw new BotApiError(400, 'Bad Request: message to edit not found');
    if (msg.senderId !== ctx.bot.id) throw new BotApiError(400, "Bad Request: message can't be edited");
    return msg;
  }

  private async audience(target: Chat, botId: bigint) {
    if (target.kind === 'private') return [target.user.id];
    const members = await this.prisma.groupMember.findMany({ where: { groupId: target.group.id }, select: { userId: true } });
    return members.map((m) => m.userId).filter((id) => id !== botId);
  }

  /** 机器人发一条消息到会话（走和普通消息一样的存储 / 推送），返回 Telegram Message */
  private async post(ctx: BotCtx, target: Chat, type: string, content: string, markup?: Markup) {
    await this.rateLimit(ctx.bot.id);
    const key = this.crypto.unwrapKey(target.conv.wrappedKey);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: target.conv.id,
        senderId: ctx.bot.id,
        receiverId: target.kind === 'private' ? target.user.id : null,
        type,
        cipherContent: this.crypto.encrypt(key, content),
      },
    });
    await this.prisma.conversation.update({ where: { id: target.conv.id }, data: { lastMsgAt: msg.createdAt } });
    if (target.kind !== 'private') {
      await this.prisma.groupMember.update({ where: { groupId_userId: { groupId: target.group.id, userId: ctx.bot.id } }, data: { lastReadMsgId: msg.id } });
    }
    if (markup) await this.prisma.botMessageMarkup.create({ data: { messageId: msg.id, markup: JSON.stringify(markup) } });
    await this.registry.deliver(await this.audience(target, ctx.bot.id), {
      op: 'msg',
      data: {
        id: msg.id.toString(),
        conversationId: target.conv.id.toString(),
        convType: target.conv.type,
        groupId: target.conv.groupId?.toString() ?? null,
        senderId: ctx.bot.id.toString(),
        senderNickname: ctx.user.nickname,
        senderAvatar: ctx.user.avatar,
        senderIsBot: true,
        receiverId: msg.receiverId?.toString() ?? null,
        type,
        content,
        markup: markup ?? null,
        createdAt: msg.createdAt.toISOString(),
      },
    });
    return this.messageObj(msg, type, content, this.tgUser(ctx.user, ctx.bot), target.chat, markup);
  }

  private async rateLimit(botId: bigint) {
    const sec = Math.floor(Date.now() / 1000);
    const k = `botrl:${botId}:${sec}`;
    const n = await this.redis.client.incr(k);
    if (n === 1) await this.redis.client.expire(k, 2);
    if (n > SENDS_PER_SEC) throw new BotApiError(429, 'Too Many Requests: retry after 1', { retry_after: 1 });
  }

  private async enqueue(bot: BotRow, update: Record<string, unknown>) {
    await this.prisma.botUpdate.create({ data: { botId: bot.id, payload: JSON.stringify(update) } });
    const set = this.waiters.get(bot.id.toString());
    if (set) for (const wake of [...set]) wake();
    if (bot.webhookUrl) void this.flush(bot.id);
  }

  private waitUpdate(botId: bigint, ms: number) {
    const k = botId.toString();
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(k);
      if (!set) this.waiters.set(k, (set = new Set()));
      const done = () => {
        clearTimeout(t);
        set!.delete(done);
        if (!set!.size) this.waiters.delete(k);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      set.add(done);
    });
  }

  /** 按顺序把积压的 update 推给 webhook，失败就停，等定时任务按退避重试 */
  private async flush(botId: bigint) {
    const k = botId.toString();
    if (this.flushing.has(k)) return;
    this.flushing.add(k);
    try {
      for (;;) {
        const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
        if (!bot?.webhookUrl) return;
        const rows = await this.prisma.botUpdate.findMany({ where: { botId }, orderBy: { id: 'asc' }, take: 20 });
        if (!rows.length) return;
        for (const row of rows) {
          const err = await this.deliverWebhook(bot, row);
          if (err) {
            await this.prisma.bot.update({ where: { id: botId }, data: { lastError: err.slice(0, 300), lastErrorAt: new Date() } });
            return;
          }
          await this.prisma.botUpdate.delete({ where: { id: row.id } }).catch(() => {});
        }
      }
    } catch (e) {
      this.log.warn(`flush ${k}: ${e}`);
    } finally {
      this.flushing.delete(k);
    }
  }

  private async deliverWebhook(bot: BotRow, row: { id: bigint; payload: string }): Promise<string | null> {
    try {
      const u = new URL(bot.webhookUrl);
      await this.assertPublicHost(u.hostname);
      const res = await fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bot.webhookSecret ? { 'X-Telegram-Bot-Api-Secret-Token': bot.webhookSecret } : {}) },
        body: JSON.stringify({ update_id: Number(row.id), ...JSON.parse(row.payload) }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      await res.arrayBuffer().catch(() => null);
      return res.ok ? null : `Wrong response from the webhook: ${res.status} ${res.statusText}`;
    } catch (e: any) {
      return e instanceof BotApiError ? e.message : `Connection failed: ${e?.cause?.code ?? e?.name ?? e}`;
    }
  }

  /** 每 15 秒：webhook 失败重试（失败后至少隔 30 秒）；每 10 分钟清理超时 / 超量的 update */
  private async tick() {
    const bots = await this.prisma.bot.findMany({ where: { webhookUrl: { not: '' } }, select: { id: true, lastErrorAt: true } });
    for (const b of bots) {
      if (b.lastErrorAt && Date.now() - b.lastErrorAt.getTime() < 30_000) continue;
      if (await this.prisma.botUpdate.findFirst({ where: { botId: b.id }, select: { id: true } })) void this.flush(b.id);
    }
    if (this.ticks++ % 40 !== 0) return;
    await this.prisma.botUpdate.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - UPDATE_TTL_MS) } } });
    const heavy = await this.prisma.botUpdate.groupBy({ by: ['botId'], _count: { _all: true }, having: { id: { _count: { gt: MAX_PENDING } } } });
    for (const h of heavy) {
      const keep = await this.prisma.botUpdate.findMany({ where: { botId: h.botId }, orderBy: { id: 'desc' }, take: 1, skip: MAX_PENDING - 1, select: { id: true } });
      if (keep[0]) await this.prisma.botUpdate.deleteMany({ where: { botId: h.botId, id: { lt: keep[0].id } } });
    }
  }

  /** webhook / 图片 URL 只能指向公网（防 SSRF 打到内网和本机服务） */
  private async assertPublicHost(host: string) {
    const h = host.replace(/^\[|\]$/g, '');
    let addrs: string[];
    if (isIP(h)) addrs = [h];
    else {
      try {
        addrs = (await lookup(h, { all: true })).map((a) => a.address);
      } catch {
        throw new BotApiError(400, 'Bad Request: bad webhook: Failed to resolve host: Name or service not known');
      }
    }
    if (!addrs.length || addrs.some(isPrivateIp)) throw new BotApiError(400, 'Bad Request: bad webhook: IP address is private or reserved');
  }

  // ==================== Telegram 对象 ====================

  tgUser(u: UserRow, bot?: BotRow | null) {
    return {
      id: Number(u.id),
      is_bot: !!u.isBot,
      first_name: u.nickname || 'user',
      ...(bot ? { username: bot.username } : {}),
      language_code: 'zh-hans',
    };
  }

  private privateChat(u: UserRow) {
    return { id: Number(u.id), type: 'private', first_name: u.nickname || 'user' };
  }

  private groupChat(g: { id: bigint; kind: number; name: string }) {
    return { id: -Number(g.id), type: g.kind === 2 ? 'channel' : 'group', title: g.name };
  }

  private messageObj(msg: { id: bigint; createdAt: Date }, type: string, content: string, from: Record<string, unknown> | null, chat: Record<string, unknown>, markup?: Markup | null) {
    const m: Record<string, unknown> = { message_id: Number(msg.id), date: Math.floor(msg.createdAt.getTime() / 1000), chat };
    if (from) m.from = from;
    if (chat.type === 'channel') m.sender_chat = chat;
    const json = () => {
      try {
        return JSON.parse(content) ?? {};
      } catch {
        return {};
      }
    };
    switch (type) {
      case 'text': {
        m.text = content;
        const cmd = COMMAND_RE.exec(content);
        if (cmd) m.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
        break;
      }
      case 'image': {
        // 多图相册：地址后面带 #g=相册id&w=宽&h=高（客户端写的），对应 Telegram 的 media_group_id
        const [url, frag = ''] = content.split('#');
        const q = new URLSearchParams(frag);
        m.photo = [{ file_id: url, file_unique_id: uniqueId(url), width: Number(q.get('w') ?? 0) || 0, height: Number(q.get('h') ?? 0) || 0 }];
        if (q.get('g')) m.media_group_id = q.get('g');
        break;
      }
      case 'video':
        m.video = { file_id: content, file_unique_id: uniqueId(content), width: 0, height: 0, duration: 0 };
        break;
      case 'audio': {
        const a = json();
        const url = String(a.url ?? content);
        m.voice = { file_id: url, file_unique_id: uniqueId(url), duration: Number(a.duration ?? 0) };
        break;
      }
      case 'location': {
        const l = json();
        m.location = { latitude: Number(l.lat ?? 0), longitude: Number(l.lng ?? 0) };
        break;
      }
      case 'sticker': {
        const s = json();
        const url = String(s.url ?? '');
        m.sticker = { file_id: url, file_unique_id: uniqueId(url), width: Number(s.w ?? 0), height: Number(s.h ?? 0), is_animated: false, is_video: s.format === 'mp4', type: 'regular', emoji: s.emoji ?? undefined };
        break;
      }
      default:
        m.text = `[${type}]`;
    }
    if (markup) m.reply_markup = markup;
    return m;
  }

  private commandsOf(bot: BotRow): { command: string; description: string }[] {
    try {
      return JSON.parse(bot.commands);
    } catch {
      return [];
    }
  }

  private view(bot: BotRow, user: UserRow) {
    return {
      id: bot.id,
      username: bot.username,
      name: user.nickname,
      avatar: user.avatar,
      description: bot.description,
      privacy: bot.privacy,
      commands: this.commandsOf(bot),
      webhookUrl: bot.webhookUrl,
      status: user.status,
      createdAt: bot.createdAt,
    };
  }

  private async mustOwn(ownerId: bigint, id: bigint) {
    const bot = await this.prisma.bot.findUnique({ where: { id } });
    if (!bot || bot.ownerId !== ownerId) throw new NotFoundException('机器人不存在');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('机器人不存在');
    return { bot, user };
  }

  private genToken(id: bigint) {
    return `${id}:${randomBytes(26).toString('base64url')}`;
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private safeDecrypt(key: Buffer, cipher: string) {
    try {
      return this.crypto.decrypt(key, cipher);
    } catch {
      return '';
    }
  }
}

function bool(v: unknown) {
  return v === true || v === 'true' || v === '1' || v === 1;
}

function num(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function uniqueId(s: string) {
  return createHash('sha1').update(s).digest('base64url').slice(0, 16);
}

/** parse_mode：我们的气泡只显示纯文本，HTML 去标签、MarkdownV2 去转义 */
function formatText(text: string, mode: unknown) {
  const m = String(mode ?? '').toLowerCase();
  if (m === 'html') {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  if (m === 'markdownv2') return text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
  return text;
}

/** 只支持 inline_keyboard（url / callback_data 按钮）；其它键盘类型忽略不报错，免得现成的 TG 机器人直接挂掉 */
function parseMarkup(raw: unknown): Markup | undefined {
  let v: any = raw;
  if (typeof v === 'string') {
    if (!v.trim()) return undefined;
    try {
      v = JSON.parse(v);
    } catch {
      throw new BotApiError(400, "Bad Request: can't parse reply keyboard markup JSON object");
    }
  }
  if (!v || !Array.isArray(v.inline_keyboard)) return undefined;
  const rows: Button[][] = [];
  for (const row of v.inline_keyboard.slice(0, 20)) {
    if (!Array.isArray(row)) throw new BotApiError(400, 'Bad Request: field "inline_keyboard" of the InlineKeyboardMarkup must be an Array of Arrays');
    const btns: Button[] = [];
    for (const b of row.slice(0, 8)) {
      const text = String(b?.text ?? '').slice(0, 64);
      if (!text) throw new BotApiError(400, 'Bad Request: text buttons are unallowed in the inline keyboard');
      if (b.url) {
        const url = String(b.url);
        if (!/^https?:\/\/\S+$/i.test(url) || url.length > 1000) throw new BotApiError(400, 'Bad Request: BUTTON_URL_INVALID');
        btns.push({ text, url });
      } else if (b.callback_data !== undefined) {
        const data = String(b.callback_data);
        if (!data || Buffer.byteLength(data) > 64) throw new BotApiError(400, 'Bad Request: BUTTON_DATA_INVALID');
        btns.push({ text, callback_data: data });
      } else {
        throw new BotApiError(400, 'Bad Request: text buttons are unallowed in the inline keyboard');
      }
    }
    if (btns.length) rows.push(btns);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function isPrivateIp(ip: string) {
  const v = ip.toLowerCase();
  if (v.includes(':')) {
    if (v === '::1' || v === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const [a, b] = v.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}
