import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../notify/notify.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { IntimacyService } from '../intimacy/intimacy.service';
import { CommentDto, PublishMomentDto } from './moment.dto';

@Injectable()
export class MomentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly registry: ConnectionRegistry,
    private readonly intimacy: IntimacyService,
  ) {}

  async publish(userId: bigint, dto: PublishMomentDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');
    // 后台开关：女生须实名认证才能发布动态（男生无实名功能，不受约束）
    if (user.gender === 2 && !user.idCard) {
      const cfg = await this.prisma.priceConfig.findFirst();
      if (cfg?.momentNeedRealname) throw new ForbiddenException('请先完成搭子认证后再发布动态');
    }
    if (dto.type === 1 && !(dto.images?.length || dto.content?.trim())) {
      throw new BadRequestException('请填写内容或选择图片');
    }
    if (dto.type === 2 && !dto.videoUrl) throw new BadRequestException('请上传视频');
    if ((dto.images?.length ?? 0) > 9) throw new BadRequestException('最多 9 张图片');

    return this.prisma.moment.create({
      data: {
        userId,
        gender: user.gender,
        content: dto.content?.trim() ?? '',
        type: dto.type,
        images: JSON.stringify(dto.images ?? []),
        videoUrl: dto.videoUrl ?? '',
        coverUrl: dto.coverUrl ?? '',
        cityCode: dto.cityCode ?? user.cityCode,
        cityName: dto.cityName ?? user.cityName,
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });
  }

  /** 删除自己的动态（软删除，status=1） */
  async remove(userId: bigint, momentId: bigint) {
    const moment = await this.prisma.moment.findUnique({ where: { id: momentId } });
    if (!moment || moment.status !== 0) throw new NotFoundException('动态不存在');
    if (moment.userId !== userId) throw new ForbiddenException('只能删除自己的动态');
    await this.prisma.moment.update({ where: { id: momentId }, data: { status: 1 } });
    return { ok: true };
  }

  /** 广场流：服务端强制性别隔离（只看异性），可按城市/关注/在线过滤 */
  async feed(userId: bigint, opts: { cityCode?: string; beforeId?: bigint; limit?: number; onlyVideo?: boolean; onlyFollowed?: boolean; onlyOnline?: boolean }) {
    const viewer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!viewer) throw new ForbiddenException('账号异常');
    const targetGender = viewer.gender === 1 ? 2 : 1;

    let followedIds: bigint[] | undefined;
    if (opts.onlyFollowed) {
      const follows = await this.prisma.follow.findMany({ where: { followerId: userId }, select: { targetId: true } });
      followedIds = follows.map((f) => f.targetId);
      if (followedIds.length === 0) return [];
    }

    const moments = await this.prisma.moment.findMany({
      where: {
        gender: targetGender,
        status: 0,
        ...(followedIds ? { userId: { in: followedIds } } : {}),
        ...(opts.cityCode ? { cityCode: opts.cityCode } : {}),
        ...(opts.beforeId ? { id: { lt: opts.beforeId } } : {}),
        ...(opts.onlyVideo ? { type: 2 } : {}),
      },
      orderBy: { id: 'desc' },
      take: Math.min(opts.limit ?? 20, 50),
    });
    const list = await this.hydrate(userId, moments);
    const filtered = opts.onlyOnline ? list.filter((m) => (m.user as any)?.online) : list;
    // 在线作者优先；同组内评分高的作者靠前（评分越高推荐越靠前）；再按时间倒序
    return [...filtered].sort((a, b) => {
      const ao = (a.user as any)?.online ? 1 : 0;
      const bo = (b.user as any)?.online ? 1 : 0;
      if (bo !== ao) return bo - ao;
      const ar = (a.user as any)?.ratingAvg ?? 0;
      const br = (b.user as any)?.ratingAvg ?? 0;
      if (br !== ar) return br - ar;
      return Number(BigInt(b.id) - BigInt(a.id));
    });
  }

  /** 他人主页动态列表（性别隔离与详情一致：仅本人或异性可见） */
  async byUser(viewerId: bigint, targetId: bigint, beforeId?: bigint) {
    if (viewerId !== targetId) {
      const [viewer, target] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: viewerId } }),
        this.prisma.user.findUnique({ where: { id: targetId } }),
      ]);
      if (!viewer || !target) throw new NotFoundException('用户不存在');
      if (viewer.gender === target.gender) throw new ForbiddenException('无法查看该用户');
    }
    const moments = await this.prisma.moment.findMany({
      where: { userId: targetId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return this.hydrate(viewerId, moments);
  }

  /** 动态详情（作者本人或异性可见） */
  async detail(viewerId: bigint, momentId: bigint) {
    const moment = await this.prisma.moment.findUnique({ where: { id: momentId } });
    if (!moment || moment.status !== 0) throw new NotFoundException('动态不存在');
    const viewer = await this.prisma.user.findUnique({ where: { id: viewerId } });
    if (!viewer) throw new ForbiddenException('账号异常');
    if (moment.userId !== viewerId && moment.gender === viewer.gender) {
      throw new ForbiddenException('无法查看该动态');
    }
    const [hydrated] = await this.hydrate(viewerId, [moment]);
    return hydrated;
  }

  async mine(userId: bigint, beforeId?: bigint) {
    const moments = await this.prisma.moment.findMany({
      where: { userId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return this.hydrate(userId, moments);
  }

  private async hydrate(viewerId: bigint, moments: any[]) {
    if (moments.length === 0) return [];
    const userIds = [...new Set(moments.map((m) => m.userId.toString()))].map(BigInt);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, nickname: true, avatar: true, gender: true, age: true, isGuide: true, latitude: true, longitude: true, videoPriceFen: true, ratingAvg: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    // 视频每分钟实际价格：自定价高于平台抽成则用自定价，否则用默认价（成本 x5），供视频通话按钮展示
    const priceCfg = await this.prisma.priceConfig.findFirst();
    const videoCutFen = (priceCfg?.videoBaseFenPerMin ?? 2) * (priceCfg?.videoPlatformX ?? 2);
    const videoDefaultFen = (priceCfg?.videoBaseFenPerMin ?? 2) * 5;
    const [liked, follows, onlineSet, busyRows] = await Promise.all([
      this.prisma.momentLike.findMany({
        where: { userId: viewerId, momentId: { in: moments.map((m) => m.id) } },
        select: { momentId: true },
      }),
      this.prisma.follow.findMany({
        where: { followerId: viewerId, targetId: { in: userIds } },
        select: { targetId: true },
      }),
      this.registry.onlineSet(userIds),
      // 占线状态：进行中或 90 秒内呼叫中的通话
      this.prisma.callRecord.findMany({
        where: {
          AND: [
            { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
            { OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }] },
          ],
        },
        select: { callerId: true, calleeId: true },
      }),
    ]);
    const busySet = new Set<string>();
    for (const r of busyRows) {
      busySet.add(r.callerId.toString());
      busySet.add(r.calleeId.toString());
    }
    const likedSet = new Set(liked.map((l) => l.momentId.toString()));
    const followedSet = new Set(follows.map((f) => f.targetId.toString()));

    return moments.map((m) => {
      const author = userMap.get(m.userId.toString());
      return {
        id: m.id,
        user: author
          ? {
              ...author,
              online: onlineSet.has(m.userId.toString()),
              // 正在通话中（占线）
              busy: busySet.has(m.userId.toString()),
              // Decimal 显式转数字，避免客户端按字符串解析失败
              latitude: author.latitude != null ? Number(author.latitude) : null,
              longitude: author.longitude != null ? Number(author.longitude) : null,
              // 女生返回视频通话实际价格（分/分钟），男生为 0
              videoPriceFen: author.gender === 2 ? (author.videoPriceFen > videoCutFen ? author.videoPriceFen : videoDefaultFen) : 0,
            }
          : author,
        content: m.content,
        type: m.type,
        images: JSON.parse(m.images || '[]'),
        videoUrl: m.videoUrl,
        coverUrl: m.coverUrl,
        cityName: m.cityName,
        latitude: m.latitude != null ? Number(m.latitude) : null,
        longitude: m.longitude != null ? Number(m.longitude) : null,
        likeCount: m.likeCount,
        commentCount: m.commentCount,
        liked: likedSet.has(m.id.toString()),
        isFollowing: followedSet.has(m.userId.toString()),
        createdAt: m.createdAt,
      };
    });
  }

  /** 点赞/取消点赞（toggle） */
  async toggleLike(userId: bigint, momentId: bigint) {
    const moment = await this.prisma.moment.findUnique({ where: { id: momentId } });
    if (!moment || moment.status !== 0) throw new NotFoundException('动态不存在');

    const existing = await this.prisma.momentLike.findUnique({
      where: { momentId_userId: { momentId, userId } },
    });
    if (existing) {
      await this.prisma.$transaction([
        this.prisma.momentLike.delete({ where: { id: existing.id } }),
        this.prisma.moment.update({ where: { id: momentId }, data: { likeCount: { decrement: 1 } } }),
      ]);
      return { liked: false };
    }
    await this.prisma.$transaction([
      this.prisma.momentLike.create({ data: { momentId, userId } }),
      this.prisma.moment.update({ where: { id: momentId }, data: { likeCount: { increment: 1 } } }),
    ]);
    // 亲密度：点赞方 +1，被赞方 +0.5（取消点赞不扣分）
    if (moment.userId !== userId) void this.intimacy.bump(userId, moment.userId);
    return { liked: true };
  }

  async comments(momentId: bigint, beforeId?: bigint) {
    const list = await this.prisma.momentComment.findMany({
      where: { momentId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const userIds = new Set(list.map((c) => c.userId.toString()));
    // 被回复评论的作者昵称
    const replyIds = list.map((c) => c.replyToId).filter((id): id is bigint => id != null);
    const replyComments = replyIds.length
      ? await this.prisma.momentComment.findMany({ where: { id: { in: replyIds } } })
      : [];
    replyComments.forEach((c) => userIds.add(c.userId.toString()));
    const replyMap = new Map(replyComments.map((c) => [c.id.toString(), c]));

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds].map(BigInt) } },
      select: { id: true, nickname: true, avatar: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));

    return list.reverse().map((c) => {
      const replyTo = c.replyToId ? replyMap.get(c.replyToId.toString()) : null;
      return {
        id: c.id,
        user: userMap.get(c.userId.toString()),
        content: c.content,
        imageUrl: c.imageUrl,
        replyToId: c.replyToId,
        replyToNickname: replyTo ? userMap.get(replyTo.userId.toString())?.nickname ?? '' : '',
        createdAt: c.createdAt,
      };
    });
  }

  async addComment(userId: bigint, momentId: bigint, dto: CommentDto) {
    const moment = await this.prisma.moment.findUnique({ where: { id: momentId } });
    if (!moment || moment.status !== 0) throw new NotFoundException('动态不存在');
    const content = dto.content?.trim() ?? '';
    if (!content && !dto.imageUrl) throw new BadRequestException('评论不能为空');

    let replyToUserId: bigint | null = null;
    if (dto.replyToId) {
      const replyTo = await this.prisma.momentComment.findUnique({ where: { id: BigInt(dto.replyToId) } });
      if (!replyTo || replyTo.momentId !== momentId) throw new BadRequestException('回复的评论不存在');
      replyToUserId = replyTo.userId;
    }

    const [comment] = await this.prisma.$transaction([
      this.prisma.momentComment.create({
        data: {
          momentId,
          userId,
          content,
          imageUrl: dto.imageUrl ?? '',
          replyToId: dto.replyToId ? BigInt(dto.replyToId) : null,
        },
      }),
      this.prisma.moment.update({ where: { id: momentId }, data: { commentCount: { increment: 1 } } }),
    ]);

    // 分类通知：动态作者与被回复人（不通知自己），落库 + 在线推送
    const commenter = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } });
    const preview = (content || '[图片]').slice(0, 60);
    const from = commenter?.nickname ?? '';
    if (moment.userId !== userId) {
      await this.notify.push(moment.userId, 'comment', `${from} 评论了你的动态`, preview, momentId, userId);
    }
    if (replyToUserId && replyToUserId !== userId && replyToUserId !== moment.userId) {
      await this.notify.push(replyToUserId, 'comment', `${from} 回复了你的评论`, preview, momentId, userId);
    }
    // 亲密度：评论方 +1，动态作者 +0.5
    if (moment.userId !== userId) void this.intimacy.bump(userId, moment.userId);
    return comment;
  }
}
