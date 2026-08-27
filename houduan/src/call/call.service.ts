import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { ImService } from '../im/im.service';
import { IntimacyService } from '../intimacy/intimacy.service';

/**
 * 一对一音视频通话信令（媒体走 SRS WebRTC）：
 * 流命名 live/{callId}_{userId}，双方各推自己的流、拉对方的流。
 * WHIP 推流: http://SRS:1985/rtc/v1/whip/?app=live&stream={callId}_{userId}
 * WHEP 拉流: http://SRS:1985/rtc/v1/whep/?app=live&stream={callId}_{peerId}
 * 信令帧经 IM WebSocket 下发：{ op: "call", event, data }
 */
@Injectable()
export class CallService {
  private readonly srsServer: string;
  private readonly srsApi: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly wallets: WalletService,
    private readonly im: ImService,
    private readonly intimacy: IntimacyService,
    config: ConfigService,
  ) {
    this.srsServer = config.get<string>('SRS_SERVER') ?? '';
    this.srsApi = config.get<string>('SRS_API') ?? '';
  }

  /** 通话参数（后台可调：分辨率/帧率/码率）+ 计费信息 */
  async getConfig() {
    const [cfg, price] = await Promise.all([
      this.prisma.callConfig.findFirst(),
      this.prisma.priceConfig.findFirst(),
    ]);
    return {
      width: cfg?.width ?? 640,
      height: cfg?.height ?? 480,
      fps: cfg?.fps ?? 25,
      bitrate: cfg?.bitrate ?? 800,
      srsServer: this.srsServer,
      whipUrl: `${this.srsApi}/rtc/v1/whip/`,
      whepUrl: `${this.srsApi}/rtc/v1/whep/`,
      msgPriceFen: price?.msgPriceFen ?? 10,
      videoBaseFenPerMin: price?.videoBaseFenPerMin ?? 2,
      videoPlatformX: price?.videoPlatformX ?? 2,
    };
  }

  /**
   * 视频计费（分/分钟）：videoBaseFenPerMin 为流量成本价，videoPlatformX 为平台倍率。
   * 平台每分钟抽成 = 成本 x X（覆盖成本并赚 X-1 倍）；女方所得 = 价格 - 成本 x X。
   * 女生未自定价（=0）时使用默认价 = 成本 x 5。
   */
  private async videoPricing(femaleId: bigint): Promise<{ priceFen: bigint; platformCutFen: bigint }> {
    const [female, price] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: femaleId }, select: { videoPriceFen: true } }),
      this.prisma.priceConfig.findFirst(),
    ]);
    const cost = price?.videoBaseFenPerMin ?? 2;
    const cut = cost * (price?.videoPlatformX ?? 2);
    const custom = female?.videoPriceFen ?? 0;
    const priceFen = custom > cut ? custom : cost * 5;
    return { priceFen: BigInt(priceFen), platformCutFen: BigInt(cut) };
  }

  async invite(callerId: bigint, calleeId: bigint, type: 1 | 2) {
    if (callerId === calleeId) throw new BadRequestException('无法呼叫自己');
    const [caller, callee] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: callerId } }),
      this.prisma.user.findUnique({ where: { id: calleeId } }),
    ]);
    if (!callee || callee.status !== 0) throw new NotFoundException('对方不存在');
    if (!caller || caller.gender === callee.gender) throw new ForbiddenException('无法呼叫该用户');
    // 视频通话仅男方可发起（女方只能接听）
    if (type === 2 && caller.gender !== 1) throw new ForbiddenException('视频通话仅支持男士发起');

    // 对方不在线直接提示，不进入等待接听
    if (!(await this.registry.isOnline(calleeId))) {
      throw new BadRequestException('对方不在线，无法接通');
    }

    // 占线检查：任一方有进行中的通话则拒绝（呼叫中记录 90 秒内有效，防止异常退出永久占线）
    const busySet = await this.busySet([callerId, calleeId]);
    if (busySet.has(calleeId.toString())) throw new BadRequestException('对方正在通话中');
    if (busySet.has(callerId.toString())) throw new BadRequestException('您正在通话中');

    const callId = randomUUID().replace(/-/g, '');
    const record = await this.prisma.callRecord.create({
      data: { callId, callerId, calleeId, type, status: 0 },
    });

    const config = await this.getConfig();
    await this.registry.deliver([calleeId], {
      op: 'call',
      event: 'invite',
      data: {
        callId,
        type,
        caller: { id: caller.id.toString(), nickname: caller.nickname, avatar: caller.avatar },
        config,
      },
    });
    return { callId, config, record: { id: record.id } };
  }

  async accept(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) throw new BadRequestException('通话状态已变更');
    await this.prisma.callRecord.update({
      where: { callId },
      data: { status: 1, startedAt: new Date() },
    });
    const config = await this.getConfig();
    await this.registry.deliver([record.callerId], { op: 'call', event: 'accept', data: { callId } });
    return { callId, config };
  }

  async reject(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) return { ok: true };
    await this.prisma.callRecord.update({ where: { callId }, data: { status: 4, endedAt: new Date() } });
    await this.registry.deliver([record.callerId], { op: 'call', event: 'reject', data: { callId } });
    await this.im.sendCallMessage(record.callerId, record.calleeId, JSON.stringify({ callType: record.type, result: 'reject' }));
    return { ok: true };
  }

  /** 主叫在对方未接听时取消 */
  async cancel(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) return { ok: true };
    await this.prisma.callRecord.update({ where: { callId }, data: { status: 5, endedAt: new Date() } });
    await this.registry.deliver([record.calleeId], { op: 'call', event: 'cancel', data: { callId } });
    await this.im.sendCallMessage(record.callerId, record.calleeId, JSON.stringify({ callType: record.type, result: 'cancel' }));
    return { ok: true };
  }

  /** 任一方挂断；视频通话按分钟结算（男付女收） */
  async end(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 1 && record.status !== 0) return { ok: true };
    const wasActive = record.status === 1;
    const endedAt = new Date();
    const durationSec = record.startedAt ? Math.floor((endedAt.getTime() - record.startedAt.getTime()) / 1000) : 0;
    await this.prisma.callRecord.update({
      where: { callId },
      data: { status: wasActive ? 2 : 3, endedAt, durationSec },
    });

    // 视频计费：不足 1 分钟按 1 分钟；男付全价，平台抽 4 倍成本/分钟，剩余归女方
    let billedFen = 0n;
    if (wasActive && record.type === 2 && durationSec > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: [record.callerId, record.calleeId] } },
        select: { id: true, gender: true },
      });
      const male = users.find((u) => u.gender === 1);
      const female = users.find((u) => u.gender === 2);
      if (male && female) {
        const { priceFen, platformCutFen } = await this.videoPricing(female.id);
        const minutes = BigInt(Math.max(1, Math.ceil(durationSec / 60)));
        const total = priceFen * minutes;
        const wallet = await this.prisma.wallet.findUnique({ where: { userId: male.id } });
        const actual = wallet && wallet.balance < total ? wallet.balance : total;
        if (actual > 0n) {
          // 平台成本优先扣除，剩余给女方（余额不足时按比例缩减女方所得）
          const platformTotal = platformCutFen * minutes;
          const femaleShare = actual > platformTotal ? actual - platformTotal : 0n;
          const mins = Math.ceil(durationSec / 60);
          await this.prisma.$transaction(async (tx) => {
            await this.wallets.applyTx(tx, male.id, 'call_fee', -actual, {
              refKey: `call_${callId}`,
              remark: `视频通话 ${mins} 分钟`,
            });
            if (femaleShare > 0n) {
              await this.wallets.applyTx(tx, female.id, 'call_income', femaleShare, {
                refKey: `call_${callId}`,
                remark: `视频通话收入 ${mins} 分钟（已扣平台成本）`,
              });
            }
            // 平台账本落账：总收费 = 女方分成 + 平台抽成，供后台按女生对账
            await tx.platformLedger.create({
              data: {
                type: 'video_cut',
                refKey: `call_${callId}`,
                maleId: male.id,
                femaleId: female.id,
                minutes: mins,
                grossFen: actual,
                femaleFen: femaleShare,
                platformFen: actual - femaleShare,
              },
            });
          });
          billedFen = actual;
        }
      }
    }

    // 亲密度：视频每分钟主叫 +1、被叫 +0.5（不足 1 分钟按 1 分钟）
    if (wasActive && record.type === 2 && durationSec > 0) {
      void this.intimacy.bump(record.callerId, record.calleeId, Math.max(1, Math.ceil(durationSec / 60)));
    }

    const peer = record.callerId === userId ? record.calleeId : record.callerId;
    await this.registry.deliver([peer], { op: 'call', event: 'end', data: { callId, durationSec } });
    await this.im.sendCallMessage(
      record.callerId,
      record.calleeId,
      JSON.stringify(wasActive ? { callType: record.type, result: 'end', duration: durationSec } : { callType: record.type, result: 'cancel' }),
    );
    return { ok: true, durationSec, billedFen };
  }

  /**
   * 一方推流完成的通知：转发给对方，对方收到后才开始 WHEP 订阅。
   * SRS 会接受"发布者尚未推流"的订阅（ICE 也通）但之后永远不转发 RTP，
   * 必须保证订阅晚于发布。
   */
  async published(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('无权操作');
    const peer = record.callerId === userId ? record.calleeId : record.callerId;
    await this.registry.deliver([peer], { op: 'call', event: 'published', data: { callId } });
    return { ok: true };
  }

  private async mustCall(callId: string) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId } });
    if (!record) throw new NotFoundException('通话不存在');
    return record;
  }

  /**
   * 客户端通话日志上报：双端各自分批上报，后台按 callId 汇总排查媒体问题。
   * 仅通话参与方可上报；单批最多 500 行，超长行截断。
   */
  async appendLog(userId: bigint, dto: { callId: string; platform: string; lines: string[] }) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId: dto.callId } });
    if (!record) throw new NotFoundException('通话不存在');
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('非通话参与方');
    const content = dto.lines.slice(0, 500).map((l) => String(l).slice(0, 500)).join('\n');
    if (!content) return { ok: true };
    await this.prisma.callClientLog.create({
      data: { callId: dto.callId, uid: userId, platform: dto.platform.slice(0, 10), content },
    });
    return { ok: true };
  }

  /**
   * 视频通话结束后男方对女方评分：5 维度各 0-100，平均分为最终得分。
   * 一次通话只能评一次；评完刷新女方评分缓存（影响广场推荐排序）。
   */
  async rate(userId: bigint, dto: { callId: string; photo: number; obedience: number; legs: number; chest: number; skin: number }) {
    const record = await this.mustCall(dto.callId);
    if (record.callerId !== userId) throw new ForbiddenException('仅发起方可评分');
    if (record.type !== 2) throw new BadRequestException('仅视频通话可评分');
    if (record.status !== 2 || record.durationSec <= 0) throw new BadRequestException('通话未接通，无法评分');

    const avg = Math.round((dto.photo + dto.obedience + dto.legs + dto.chest + dto.skin) / 5);
    try {
      await this.prisma.callRating.create({
        data: {
          callId: dto.callId,
          maleId: record.callerId,
          femaleId: record.calleeId,
          photo: dto.photo,
          obedience: dto.obedience,
          legs: dto.legs,
          chest: dto.chest,
          skin: dto.skin,
          avg,
        },
      });
    } catch {
      throw new BadRequestException('该通话已评过分');
    }

    // 刷新女方评分缓存
    const agg = await this.prisma.callRating.aggregate({
      where: { femaleId: record.calleeId },
      _avg: { avg: true },
      _count: true,
    });
    await this.prisma.user.update({
      where: { id: record.calleeId },
      data: { ratingAvg: Math.round(agg._avg.avg ?? 0), ratingCount: agg._count },
    });
    return { ok: true, avg };
  }

  /**
   * 批量查询用户占线状态：进行中（status=1）或 90 秒内的呼叫中（status=0）算占线。
   * 返回占线用户 id 字符串集合。
   */
  async busySet(userIds: bigint[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.callRecord.findMany({
      where: {
        AND: [
          { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
          { OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }] },
        ],
      },
      select: { callerId: true, calleeId: true },
    });
    const set = new Set<string>();
    const idSet = new Set(userIds.map((i) => i.toString()));
    for (const r of rows) {
      if (idSet.has(r.callerId.toString())) set.add(r.callerId.toString());
      if (idSet.has(r.calleeId.toString())) set.add(r.calleeId.toString());
    }
    return set;
  }

  /** 女生视频接通率：在线时收到的视频邀请中实际接通的比例 */
  async answerRate(femaleId: bigint) {
    const [total, connected] = await Promise.all([
      this.prisma.callRecord.count({ where: { calleeId: femaleId, type: 2, status: { in: [1, 2, 3, 4] } } }),
      this.prisma.callRecord.count({ where: { calleeId: femaleId, type: 2, status: { in: [1, 2] } } }),
    ]);
    return { total, connected, rate: total > 0 ? Math.round((connected / total) * 100) : 0 };
  }
}
