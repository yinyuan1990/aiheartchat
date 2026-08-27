import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async createGroup(ownerId: bigint, name: string, memberIds: bigint[] = [], avatar = '') {
    const group = await this.prisma.chatGroup.create({ data: { name, ownerId, avatar } });
    await this.prisma.conversation.create({
      data: {
        type: 2,
        pairKey: `g_${group.id}`,
        groupId: group.id,
        wrappedKey: this.crypto.wrapKey(this.crypto.generateConversationKey()),
      },
    });

    const uniqueMembers = [...new Set([ownerId, ...memberIds].map((id) => id.toString()))].map(BigInt);
    await this.prisma.groupMember.createMany({
      data: uniqueMembers.map((userId) => ({
        groupId: group.id,
        userId,
        role: userId === ownerId ? 'owner' : 'member',
      })),
    });
    return this.getGroup(ownerId, group.id);
  }

  async getGroup(userId: bigint, groupId: bigint) {
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) throw new NotFoundException('群不存在');
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, orderBy: { joinedAt: 'asc' } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, nickname: true, avatar: true, gender: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    return {
      id: group.id,
      name: group.name,
      // 没设置群头像时默认显示群主头像
      avatar: group.avatar || (userMap.get(group.ownerId.toString())?.avatar ?? ''),
      notice: group.notice,
      ownerId: group.ownerId,
      memberLimit: group.memberLimit,
      conversationId: conv?.id,
      isMember: members.some((m) => m.userId === userId),
      members: members.map((m) => ({
        ...userMap.get(m.userId.toString()),
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    };
  }

  async invite(operatorId: bigint, groupId: bigint, userIds: bigint[]) {
    const group = await this.mustGroup(groupId);
    await this.mustMember(groupId, operatorId);
    const count = await this.prisma.groupMember.count({ where: { groupId } });
    if (count + userIds.length > group.memberLimit) throw new BadRequestException('群成员已达上限');

    const valid = await this.prisma.user.findMany({ where: { id: { in: userIds }, status: 0 }, select: { id: true } });
    await this.prisma.groupMember.createMany({
      data: valid.map((u) => ({ groupId, userId: u.id })),
      skipDuplicates: true,
    });
    return this.getGroup(operatorId, groupId);
  }

  async join(userId: bigint, groupId: bigint, password?: string) {
    const group = await this.mustGroup(groupId);
    const already = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!already) {
      if (group.joinPassword !== '' && (password ?? '').trim() !== group.joinPassword) {
        throw new BadRequestException('入群密码错误');
      }
      const count = await this.prisma.groupMember.count({ where: { groupId } });
      if (count >= group.memberLimit) throw new BadRequestException('群成员已达上限');
      await this.prisma.groupMember.createMany({ data: [{ groupId, userId }], skipDuplicates: true });
    }
    return this.getGroup(userId, groupId);
  }

  /** 群广场：可加入的群列表（含是否需要密码、是否已加入） */
  async listGroups(userId: bigint) {
    const groups = await this.prisma.chatGroup.findMany({
      where: { status: 0 },
      orderBy: { id: 'desc' },
      take: 100,
    });
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const counts = await this.prisma.groupMember.groupBy({
      by: ['groupId'],
      where: { groupId: { in: ids } },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.groupId.toString(), c._count._all]));
    const mine = await this.prisma.groupMember.findMany({
      where: { userId, groupId: { in: ids } },
      select: { groupId: true },
    });
    const mineSet = new Set(mine.map((m) => m.groupId.toString()));
    const owners = await this.prisma.user.findMany({
      where: { id: { in: groups.map((g) => g.ownerId) } },
      select: { id: true, avatar: true },
    });
    const ownerAvatar = new Map(owners.map((o) => [o.id.toString(), o.avatar]));
    const convs = await this.prisma.conversation.findMany({
      where: { groupId: { in: ids } },
      select: { id: true, groupId: true },
    });
    const convMap = new Map(convs.map((c) => [c.groupId!.toString(), c.id]));
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      avatar: g.avatar || (ownerAvatar.get(g.ownerId.toString()) ?? ''),
      memberCount: countMap.get(g.id.toString()) ?? 0,
      hasPassword: g.joinPassword !== '',
      isMember: mineSet.has(g.id.toString()),
      conversationId: mineSet.has(g.id.toString()) ? convMap.get(g.id.toString()) : undefined,
    }));
  }

  // ---------- 群分享：邀请码 + 可选入群密码 ----------

  /** 分享信息（成员可看）：邀请码首次分享时生成 */
  async shareInfo(userId: bigint, groupId: bigint) {
    const group = await this.mustGroup(groupId);
    const me = await this.mustMember(groupId, userId);
    let code = group.inviteCode;
    if (!code) {
      code = await this.genInviteCode();
      await this.prisma.chatGroup.update({ where: { id: groupId }, data: { inviteCode: code } });
    }
    return {
      code,
      hasPassword: group.joinPassword !== '',
      // 明文密码只回给群主/管理员（分享面板展示用）
      password: me.role === 'owner' || me.role === 'admin' ? group.joinPassword : undefined,
      canEdit: me.role === 'owner' || me.role === 'admin',
      name: group.name,
    };
  }

  /** 设置入群密码（群主/管理员）：空串 = 无密码 */
  async setSharePassword(userId: bigint, groupId: bigint, password: string) {
    await this.mustGroup(groupId);
    const me = await this.mustMember(groupId, userId);
    if (me.role !== 'owner' && me.role !== 'admin') throw new ForbiddenException('仅群主/管理员可设置');
    const pwd = (password ?? '').trim();
    if (pwd.length > 20) throw new BadRequestException('密码最长 20 位');
    await this.prisma.chatGroup.update({ where: { id: groupId }, data: { joinPassword: pwd } });
    return this.shareInfo(userId, groupId);
  }

  /** 邀请码预检：给入群页展示群名/是否需要密码 */
  async codeInfo(userId: bigint, code: string) {
    const group = await this.groupByCode(code);
    const memberCount = await this.prisma.groupMember.count({ where: { groupId: group.id } });
    const me = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    const conv = me ? await this.prisma.conversation.findUnique({ where: { groupId: group.id } }) : null;
    const owner = await this.prisma.user.findUnique({ where: { id: group.ownerId }, select: { avatar: true } });
    return {
      groupId: group.id,
      name: group.name,
      avatar: group.avatar || (owner?.avatar ?? ''),
      memberCount,
      hasPassword: group.joinPassword !== '',
      isMember: !!me,
      // 已是成员直接给会话 id，客户端可直接进群聊
      conversationId: conv?.id,
    };
  }

  /** 扫码/输码入群：有密码必须输对 */
  async joinByCode(userId: bigint, code: string, password?: string) {
    const group = await this.groupByCode(code);
    if (group.joinPassword !== '') {
      if ((password ?? '').trim() !== group.joinPassword) throw new BadRequestException('入群密码错误');
    }
    const count = await this.prisma.groupMember.count({ where: { groupId: group.id } });
    const already = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (!already && count >= group.memberLimit) throw new BadRequestException('群成员已达上限');
    await this.prisma.groupMember.createMany({ data: [{ groupId: group.id, userId }], skipDuplicates: true });
    return this.getGroup(userId, group.id);
  }

  private async groupByCode(code: string) {
    const c = (code ?? '').trim().toUpperCase();
    if (!c) throw new BadRequestException('请输入邀请码');
    const group = await this.prisma.chatGroup.findUnique({ where: { inviteCode: c } });
    if (!group || group.status !== 0) throw new NotFoundException('邀请码无效或群已解散');
    return group;
  }

  /** 8 位邀请码：去掉易混淆字符（0O1IL），碰撞重试 */
  private async genInviteCode(): Promise<string> {
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    for (let i = 0; i < 5; i++) {
      let code = '';
      for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
      const exists = await this.prisma.chatGroup.findUnique({ where: { inviteCode: code } });
      if (!exists) return code;
    }
    throw new BadRequestException('生成邀请码失败，请重试');
  }

  async leave(userId: bigint, groupId: bigint) {
    const member = await this.mustMember(groupId, userId);
    if (member.role === 'owner') throw new BadRequestException('群主请先转让或解散群');
    await this.prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId } } });
    return { ok: true };
  }

  async kick(operatorId: bigint, groupId: bigint, targetId: bigint) {
    const operator = await this.mustMember(groupId, operatorId);
    if (operator.role !== 'owner' && operator.role !== 'admin') throw new ForbiddenException('无权操作');
    const target = await this.mustMember(groupId, targetId);
    if (target.role === 'owner') throw new ForbiddenException('无法移出群主');
    await this.prisma.groupMember.delete({ where: { groupId_userId: { groupId, userId: targetId } } });
    return { ok: true };
  }

  async transfer(ownerId: bigint, groupId: bigint, targetId: bigint) {
    const owner = await this.mustMember(groupId, ownerId);
    if (owner.role !== 'owner') throw new ForbiddenException('仅群主可转让');
    await this.mustMember(groupId, targetId);
    await this.prisma.$transaction([
      this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: ownerId } }, data: { role: 'member' } }),
      this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: targetId } }, data: { role: 'owner' } }),
      this.prisma.chatGroup.update({ where: { id: groupId }, data: { ownerId: targetId } }),
    ]);
    return { ok: true };
  }

  async dissolve(ownerId: bigint, groupId: bigint) {
    const owner = await this.mustMember(groupId, ownerId);
    if (owner.role !== 'owner') throw new ForbiddenException('仅群主可解散');
    await this.prisma.chatGroup.update({ where: { id: groupId }, data: { status: 1 } });
    return { ok: true };
  }

  async updateInfo(operatorId: bigint, groupId: bigint, data: { name?: string; avatar?: string; notice?: string }) {
    const operator = await this.mustMember(groupId, operatorId);
    if (operator.role !== 'owner' && operator.role !== 'admin') throw new ForbiddenException('无权操作');
    await this.prisma.chatGroup.update({ where: { id: groupId }, data });
    return this.getGroup(operatorId, groupId);
  }

  private async mustGroup(groupId: bigint) {
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) throw new NotFoundException('群不存在');
    return group;
  }

  private async mustMember(groupId: bigint, userId: bigint) {
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member) throw new ForbiddenException('不在该群中');
    return member;
  }
}
