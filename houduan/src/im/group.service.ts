import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';

@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async createGroup(ownerId: bigint, name: string, memberIds: bigint[] = []) {
    const group = await this.prisma.chatGroup.create({ data: { name, ownerId } });
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
      avatar: group.avatar,
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

  async join(userId: bigint, groupId: bigint) {
    const group = await this.mustGroup(groupId);
    const count = await this.prisma.groupMember.count({ where: { groupId } });
    if (count >= group.memberLimit) throw new BadRequestException('群成员已达上限');
    await this.prisma.groupMember.createMany({ data: [{ groupId, userId }], skipDuplicates: true });
    return this.getGroup(userId, groupId);
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
