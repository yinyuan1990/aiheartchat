import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { UpdateProfileDto } from './user.dto';

/** 18 位身份证号校验（GB 11643-1999 校验位算法），无需第三方接口 */
export function validIdCard(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  const sum = weights.reduce((acc, w, i) => acc + w * Number(id[i]), 0);
  if (codes[sum % 11] !== id[17].toUpperCase()) return false;
  // 出生日期合法性
  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const date = new Date(y, m - 1, d);
  return y >= 1900 && y <= new Date().getFullYear() &&
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly registry: ConnectionRegistry,
  ) {}

  async getMe(userId: bigint) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true, albums: { orderBy: { sort: 'asc' } } },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const [following, fans] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.prisma.follow.count({ where: { targetId: userId } }),
    ]);
    return {
      ...this.auth.toProfile(user),
      balance: user.wallet?.balance ?? 0n,
      frozen: user.wallet?.frozen ?? 0n,
      following,
      fans,
      albums: user.albums,
    };
  }

  /** 关注/取关 toggle */
  async toggleFollow(userId: bigint, targetId: bigint) {
    if (userId === targetId) throw new ForbiddenException('不能关注自己');
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target || target.status !== 0) throw new NotFoundException('用户不存在');

    const existing = await this.prisma.follow.findUnique({
      where: { followerId_targetId: { followerId: userId, targetId } },
    });
    if (existing) {
      await this.prisma.follow.delete({ where: { id: existing.id } });
      return { following: false };
    }
    await this.prisma.follow.create({ data: { followerId: userId, targetId } });
    return { following: true };
  }

  async listFollows(userId: bigint, type: 'following' | 'fans') {
    const rows = await this.prisma.follow.findMany({
      where: type === 'following' ? { followerId: userId } : { targetId: userId },
      orderBy: { id: 'desc' },
      take: 100,
    });
    const ids = rows.map((r) => (type === 'following' ? r.targetId : r.followerId));
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, nickname: true, avatar: true, age: true, gender: true, cityName: true, signature: true, isGuide: true },
    });
    const map = new Map(users.map((u) => [u.id.toString(), u]));
    return ids.map((id) => map.get(id.toString())).filter(Boolean);
  }

  async updateProfile(userId: bigint, dto: UpdateProfileDto) {
    if (dto.videoPriceFen !== undefined) {
      const me = await this.prisma.user.findUnique({ where: { id: userId } });
      if (me?.gender !== 2) throw new ForbiddenException('仅女生可设置视频价格');
      if (dto.videoPriceFen !== 0) {
        const price = await this.prisma.priceConfig.findFirst();
        // 平台每分钟抽成 = 流量成本 x 平台倍率；定价必须高于抽成，否则女方利润为 0
        const cut = (price?.videoBaseFenPerMin ?? 2) * (price?.videoPlatformX ?? 2);
        if (dto.videoPriceFen <= cut) {
          throw new ForbiddenException(
            `视频价格须高于 ${(cut / 100).toFixed(2)} 积分/分钟（平台手续费 ${(cut / 100).toFixed(2)} 积分/分钟，你的收入 = 价格 - 手续费）`,
          );
        }
      }
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data: { ...dto } });
    return this.auth.toProfile(user);
  }

  /**
   * 遇见列表（主页「遇见」tab）：异性用户卡片流。
   * tab=all 综合（评分优先）| new 新人（注册倒序）| city 同城 | intimacy 亲密度倒序。
   */
  async meetList(viewerId: bigint, tab: string, city?: string) {
    const viewer = await this.prisma.user.findUnique({ where: { id: viewerId } });
    if (!viewer) throw new NotFoundException('用户不存在');
    // 全局性别隔离：仅可见异性
    const baseWhere = { gender: viewer.gender === 1 ? 2 : 1, status: 0, id: { not: viewerId } };
    const select = {
      id: true, nickname: true, avatar: true, gender: true, age: true, cityName: true,
      isGuide: true, idCard: true, ratingAvg: true, ratingCount: true, videoPriceFen: true, createdAt: true,
    } as const;

    let users: any[];
    if (tab === 'intimacy') {
      // 只列与我有过互动的人，按我的亲密度倒序
      const rows = await this.prisma.intimacy.findMany({
        where: { userId: viewerId, score: { gt: 0 } },
        orderBy: { score: 'desc' },
        take: 60,
      });
      const found = await this.prisma.user.findMany({
        where: { ...baseWhere, id: { in: rows.map((r) => r.peerId) } },
        select,
      });
      const byId = new Map(found.map((u) => [u.id.toString(), u]));
      users = rows.map((r) => byId.get(r.peerId.toString())).filter(Boolean);
    } else if (tab === 'new') {
      users = await this.prisma.user.findMany({ where: baseWhere, orderBy: { id: 'desc' }, take: 60, select });
    } else if (tab === 'city') {
      const target = (city || viewer.cityName || '').trim();
      users = target
        ? await this.prisma.user.findMany({
            where: { ...baseWhere, cityName: target },
            orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
            take: 60,
            select,
          })
        : [];
    } else {
      users = await this.prisma.user.findMany({
        where: baseWhere,
        orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
        take: 60,
        select,
      });
    }
    if (users.length === 0) return [];

    const ids = users.map((u) => u.id);
    const [priceCfg, onlineSet, busyRows, intimacyRows] = await Promise.all([
      this.prisma.priceConfig.findFirst(),
      this.registry.onlineSet(ids),
      // 占线：进行中或 90 秒内呼叫中的通话
      this.prisma.callRecord.findMany({
        where: {
          AND: [
            { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
            { OR: [{ callerId: { in: ids } }, { calleeId: { in: ids } }] },
          ],
        },
        select: { callerId: true, calleeId: true },
      }),
      this.prisma.intimacy.findMany({ where: { userId: viewerId, peerId: { in: ids } } }),
    ]);
    const busySet = new Set<string>();
    for (const r of busyRows) {
      busySet.add(r.callerId.toString());
      busySet.add(r.calleeId.toString());
    }
    const intimacyMap = new Map(intimacyRows.map((r) => [r.peerId.toString(), r.score]));
    const cut = (priceCfg?.videoBaseFenPerMin ?? 2) * (priceCfg?.videoPlatformX ?? 2);
    const dft = (priceCfg?.videoBaseFenPerMin ?? 2) * 5;
    const newSince = Date.now() - 7 * 86400_000;

    return users.map((u) => ({
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      gender: u.gender,
      age: u.age,
      cityName: u.cityName,
      isGuide: u.isGuide,
      realnameVerified: !!u.idCard,
      // 0-100 缓存分，客户端换算五星显示
      ratingAvg: u.ratingAvg,
      ratingCount: u.ratingCount,
      // 女生返回视频实际价格（分/分钟），男生为 0
      videoPriceFen: u.gender === 2 ? (u.videoPriceFen > cut ? u.videoPriceFen : dft) : 0,
      online: onlineSet.has(u.id.toString()),
      busy: busySet.has(u.id.toString()),
      /** 注册 7 天内 = 新人徽章 */
      isNew: u.createdAt.getTime() > newSince,
      /** 与我的亲密度（分，含 0.5 粒度） */
      intimacy: (intimacyMap.get(u.id.toString()) ?? 0) / 10,
    }));
  }

  /** 照片墙整组保存：删旧建新，按数组顺序排序（最多 8 张，DTO 已限制） */
  async updateAlbums(userId: bigint, photos: string[]) {
    await this.prisma.$transaction([
      this.prisma.userAlbum.deleteMany({ where: { userId, type: 1 } }),
      this.prisma.userAlbum.createMany({
        data: photos.map((url, i) => ({ userId, type: 1, url: String(url).slice(0, 255), sort: i })),
      }),
    ]);
    return { ok: true, count: photos.length };
  }

  /**
   * 实名认证（仅女生）：本地校验身份证格式 + 校验位 + 出生日期，
   * 一证一号（证号全局唯一），通过即认证成功。
   */
  async verifyRealname(userId: bigint, name: string, idCard: string) {
    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!me) throw new NotFoundException('用户不存在');
    if (me.gender !== 2) throw new ForbiddenException('该功能仅对女生开放');
    if (me.idCard) throw new BadRequestException('已完成实名认证，无需重复提交');

    const trimmedName = (name ?? '').trim();
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(trimmedName)) throw new BadRequestException('请输入正确的真实姓名');
    const card = (idCard ?? '').trim().toUpperCase();
    if (!validIdCard(card)) throw new BadRequestException('身份证号不正确');

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { realName: trimmedName, idCard: card },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('该身份证号已被其他账号使用');
      throw e;
    }
    return { ok: true };
  }

  /** GPS 位置上报 */
  async reportLocation(userId: bigint, latitude?: number, longitude?: number) {
    if (latitude == null || longitude == null) return { ok: false };
    await this.prisma.user.update({ where: { id: userId }, data: { latitude, longitude } });
    return { ok: true };
  }

  async getProfile(viewerId: bigint, targetId: bigint) {
    const [viewer, target] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: viewerId } }),
      this.prisma.user.findUnique({ where: { id: targetId }, include: { albums: { orderBy: { sort: 'asc' } } } }),
    ]);
    if (!target || target.status !== 0) throw new NotFoundException('用户不存在');
    // 全局性别隔离：仅异性可见
    if (viewer && viewer.gender === target.gender && viewerId !== targetId) {
      throw new ForbiddenException('无法查看该用户');
    }
    const [following, fans, followRow] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: targetId } }),
      this.prisma.follow.count({ where: { targetId } }),
      this.prisma.follow.findUnique({ where: { followerId_targetId: { followerId: viewerId, targetId } } }),
    ]);

    // 女生附带评分与视频接通率（在线时收到的视频邀请中实际接通的比例）
    let rating: {
      avg: number; count: number;
      photo: number; obedience: number; legs: number; chest: number; skin: number;
    } | null = null;
    let answerRate: number | null = null;
    let videoPriceActualFen = 0;
    if (target.gender === 2) {
      // 五维度均分（0-100），供主页评分面板展示
      const dims = await this.prisma.callRating.aggregate({
        where: { femaleId: targetId },
        _avg: { photo: true, obedience: true, legs: true, chest: true, skin: true },
      });
      rating = {
        avg: target.ratingAvg,
        count: target.ratingCount,
        photo: Math.round(dims._avg.photo ?? 0),
        obedience: Math.round(dims._avg.obedience ?? 0),
        legs: Math.round(dims._avg.legs ?? 0),
        chest: Math.round(dims._avg.chest ?? 0),
        skin: Math.round(dims._avg.skin ?? 0),
      };
      const [total, connected, priceCfg] = await Promise.all([
        this.prisma.callRecord.count({ where: { calleeId: targetId, type: 2, status: { in: [1, 2, 3, 4] } } }),
        this.prisma.callRecord.count({ where: { calleeId: targetId, type: 2, status: { in: [1, 2] } } }),
        this.prisma.priceConfig.findFirst(),
      ]);
      answerRate = total > 0 ? Math.round((connected / total) * 100) : -1; // -1=暂无数据
      const cost = priceCfg?.videoBaseFenPerMin ?? 2;
      const cut = cost * (priceCfg?.videoPlatformX ?? 2);
      videoPriceActualFen = target.videoPriceFen > cut ? target.videoPriceFen : cost * 5;
    }

    // 在线与占线状态（视频通话按钮三态：可打 / 通话中 / 离线）
    const [online, busyRow] = await Promise.all([
      this.registry.isOnline(targetId),
      this.prisma.callRecord.findFirst({
        where: {
          AND: [
            { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
            { OR: [{ callerId: targetId }, { calleeId: targetId }] },
          ],
        },
        select: { id: true },
      }),
    ]);

    return {
      ...this.auth.toProfile(target),
      following,
      fans,
      isFollowing: !!followRow,
      albums: target.albums,
      rating,
      answerRate,
      videoPriceActualFen,
      online,
      busy: !!busyRow,
      realnameVerified: !!target.idCard,
    };
  }
}
