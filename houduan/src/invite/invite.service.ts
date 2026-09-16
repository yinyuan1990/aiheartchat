import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistry } from '../im/connection.registry';

/** 专属邀请页域名（页面地址 = SITE_BASE/t/?u=短号） */
export const SITE_BASE = process.env.SITE_BASE || 'https://yyheart.com';

/** 邀请码 → 用户：6 位数字按短号，其余按用户 id */
export async function resolveInviteUser(prisma: PrismaService, code: string) {
  const c = (code ?? '').trim();
  if (!c) return null;
  if (/^\d{6}$/.test(c)) return prisma.user.findUnique({ where: { shortId: c } });
  if (/^\d{1,19}$/.test(c)) return prisma.user.findUnique({ where: { id: BigInt(c) } });
  return null;
}

/** 从 UA 判断平台（页面访问 / 归因匹配用） */
export function platformOfUa(ua: string): 'ios' | 'android' | 'other' {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

/**
 * 专属邀请页（/t/?u=短号）：
 * - card：公开的名片数据，女生版给男生看（价目/评分/照片/近况），男生版给女生看（累计送出/加入天数）
 * - click：页面访问记录，供安装后首启归因
 * - mine：App 内「我的邀请名片」页数据（链接、点击数、成功邀请数）
 */
@Injectable()
export class InviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
  ) {}

  async card(code: string) {
    const u = await resolveInviteUser(this.prisma, code);
    if (!u || u.status !== 0) throw new NotFoundException('用户不存在');
    const id = u.id;

    const [priceCfg, albums, moments, online, fans, invited] = await Promise.all([
      this.prisma.priceConfig.findFirst(),
      this.prisma.userAlbum.findMany({ where: { userId: id }, orderBy: { sort: 'asc' }, take: 9 }),
      this.prisma.moment.findMany({
        where: { userId: id, status: 0 },
        orderBy: { id: 'desc' },
        take: 3,
        select: { id: true, content: true, type: true, images: true, coverUrl: true, createdAt: true, likeCount: true },
      }),
      this.registry.isOnline(id),
      this.prisma.follow.count({ where: { targetId: id } }),
      this.prisma.user.count({ where: { inviterId: id } }),
    ]);

    const base = {
      id: u.id,
      shortId: u.shortId,
      nickname: u.nickname,
      avatar: u.avatar,
      gender: u.gender,
      age: u.age,
      cityName: u.cityName,
      signature: u.signature,
      isGuide: u.isGuide,
      realnameVerified: !!u.idCard,
      online,
      fans,
      invited,
      joinedDays: Math.max(1, Math.floor((Date.now() - u.createdAt.getTime()) / 86400_000)),
      albums: albums.map((a) => ({ type: a.type, url: a.url, coverUrl: a.coverUrl })),
      moments: moments.map((m) => {
        let images: string[] = [];
        try { images = JSON.parse(m.images || '[]'); } catch { /* ignore */ }
        return { id: m.id, content: m.content, type: m.type, cover: m.type === 2 ? m.coverUrl : images[0] ?? '', likeCount: m.likeCount, createdAt: m.createdAt };
      }),
      msgPriceFen: priceCfg?.msgPriceFen ?? 10,
      link: `${SITE_BASE}/t/?u=${u.shortId ?? u.id.toString()}`,
    };

    if (u.gender === 2) {
      const cost = priceCfg?.videoBaseFenPerMin ?? 2;
      const cut = cost * (priceCfg?.videoPlatformX ?? 2);
      const [chatPeers, callAgg, dims] = await Promise.all([
        // 和她聊过的人数：单聊会话数
        this.prisma.conversation.count({ where: { type: 1, OR: [{ userAId: id }, { userBId: id }] } }),
        this.prisma.callRecord.aggregate({
          where: { calleeId: id, type: 2, status: 2, durationSec: { gt: 0 } },
          _avg: { durationSec: true },
          _count: { _all: true },
        }),
        this.prisma.callRating.aggregate({
          where: { femaleId: id },
          _avg: { photo: true, obedience: true, legs: true, chest: true, skin: true },
        }),
      ]);
      return {
        ...base,
        videoPriceFen: u.videoPriceFen > cut ? u.videoPriceFen : cost * 5,
        ratingAvg: u.ratingAvg,
        ratingCount: u.ratingCount,
        ratingDims: {
          photo: Math.round(dims._avg.photo ?? 0),
          obedience: Math.round(dims._avg.obedience ?? 0),
          legs: Math.round(dims._avg.legs ?? 0),
          chest: Math.round(dims._avg.chest ?? 0),
          skin: Math.round(dims._avg.skin ?? 0),
        },
        chatPeers,
        callCount: callAgg._count._all,
        avgCallMin: Math.round((callAgg._avg.durationSec ?? 0) / 60),
      };
    }

    // 男生：累计送出（消息 / 视频 / 礼物 / 约单结算）与投诉数
    const [spendRows, reports] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        // call_fee 是 amount=0 / frozenDelta<0 的冻结清算行，用 amount+frozenDelta 统一算净支出
        where: { userId: id, type: { in: ['msg_fee', 'call_fee', 'gift_send', 'task_settle'] } },
        select: { amount: true, frozenDelta: true },
      }),
      this.prisma.report.count({ where: { targetUserId: id } }),
    ]);
    let spentFen = 0n;
    for (const r of spendRows) {
      const net = r.amount + r.frozenDelta;
      if (net < 0n) spentFen -= net;
    }
    return { ...base, spentFen, reports };
  }

  async click(code: string, ip: string, ua: string) {
    const u = await resolveInviteUser(this.prisma, code);
    if (!u || u.status !== 0) return { ok: false };
    await this.prisma.inviteClick.create({
      data: { inviterId: u.id, ip: (ip || '').slice(0, 64), platform: platformOfUa(ua), ua: (ua || '').slice(0, 300) },
    });
    return { ok: true };
  }

  async mine(userId: bigint) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('用户不存在');
    const since = new Date(Date.now() - 30 * 86400_000);
    const [clicks, invited, recent] = await Promise.all([
      this.prisma.inviteClick.count({ where: { inviterId: userId, createdAt: { gt: since } } }),
      this.prisma.user.count({ where: { inviterId: userId } }),
      this.prisma.user.findMany({
        where: { inviterId: userId },
        orderBy: { id: 'desc' },
        take: 20,
        select: { id: true, nickname: true, avatar: true, gender: true, createdAt: true },
      }),
    ]);
    const code = u.shortId ?? u.id.toString();
    return { code, link: `${SITE_BASE}/t/?u=${code}`, clicks30d: clicks, invited, recent };
  }
}
