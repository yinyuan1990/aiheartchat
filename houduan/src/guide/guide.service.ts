import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { validIdCard } from '../user/user.service';

@Injectable()
export class GuideService {
  constructor(private readonly prisma: PrismaService) {}

  /** 搭子认证申请（后台审核）：已合并实名认证，通过后同时写入实名信息 */
  async apply(userId: bigint, input: { realName: string; idCardNo: string; intro: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');
    if (user.isGuide) throw new BadRequestException('已是地陪');
    const pending = await this.prisma.guideApply.findFirst({ where: { userId, status: 0 } });
    if (pending) throw new BadRequestException('申请审核中');
    // 实名信息本地核验（与原实名认证同一套校验）
    const trimmedName = (input.realName ?? '').trim();
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(trimmedName)) throw new BadRequestException('请输入正确的真实姓名');
    const card = (input.idCardNo ?? '').trim().toUpperCase();
    if (!validIdCard(card)) throw new BadRequestException('身份证号不正确');
    const used = await this.prisma.user.findFirst({ where: { idCard: card, id: { not: userId } } });
    if (used) throw new BadRequestException('该身份证号已被其他账号使用');
    return this.prisma.guideApply.create({ data: { userId, realName: trimmedName, idCardNo: card, intro: input.intro } });
  }

  async myApply(userId: bigint) {
    return this.prisma.guideApply.findFirst({ where: { userId }, orderBy: { id: 'desc' } });
  }

  /** 找地陪列表：仅异性 + 已认证，按城市过滤 */
  async list(userId: bigint, cityCode?: string, beforeId?: bigint) {
    const viewer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!viewer) throw new ForbiddenException('账号异常');
    const targetGender = viewer.gender === 1 ? 2 : 1;
    return this.prisma.user.findMany({
      where: {
        gender: targetGender,
        isGuide: true,
        status: 0,
        ...(cityCode ? { cityCode } : {}),
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      select: {
        id: true, nickname: true, avatar: true, age: true,
        cityName: true, signature: true, isGuide: true,
        albums: { orderBy: { sort: 'asc' }, take: 3 },
      },
      orderBy: { id: 'desc' },
      take: 20,
    });
  }

  /** 找人（发现页）：所有异性用户 */
  async discover(userId: bigint, cityCode?: string, beforeId?: bigint) {
    const viewer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!viewer) throw new ForbiddenException('账号异常');
    const targetGender = viewer.gender === 1 ? 2 : 1;
    return this.prisma.user.findMany({
      where: {
        gender: targetGender,
        status: 0,
        ...(cityCode ? { cityCode } : {}),
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      select: {
        id: true, nickname: true, avatar: true, age: true,
        cityName: true, signature: true, isGuide: true,
      },
      orderBy: { id: 'desc' },
      take: 20,
    });
  }
}
