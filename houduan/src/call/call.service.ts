import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { ImService } from '../im/im.service';
import { IntimacyService } from '../intimacy/intimacy.service';

/** 接通时预冻结的最大分钟数（余额更多也只锁这么多，tick 里按需续冻） */
const MAX_FREEZE_MIN = 30n;
/** 计费心跳间隔（毫秒） */
const BILLING_TICK_MS = 60_000;
/** 双方连续 N 个 tick 离线则强制挂断（防杀进程逃单 / 异常掉线占线） */
const OFFLINE_STRIKE_LIMIT = 2;

/**
 * 一对一音视频通话信令（媒体走 SRS WebRTC）：
 * 流命名 live/{callId}_{userId}，双方各推自己的流、拉对方的流。
 * WHIP 推流: http://SRS:1985/rtc/v1/whip/?app=live&stream={callId}_{userId}
 * WHEP 拉流: http://SRS:1985/rtc/v1/whep/?app=live&stream={callId}_{peerId}
 * 信令帧经 IM WebSocket 下发：{ op: "call", event, data }
 */
@Injectable()
export class CallService implements OnModuleInit, OnModuleDestroy {
  private readonly srsServer: string;
  private readonly srsApi: string;
  private readonly logger = new Logger('CallBilling');
  private billingTimer?: NodeJS.Timeout;
  /** 每通视频的价格缓存（tick 每分钟跑，避免重复查价） */
  private readonly priceCache = new Map<string, { priceFen: bigint; platformCutFen: bigint }>();
  /** 每通视频已冻结总额缓存（重启后 tick 会从流水表懒加载重建） */
  private readonly frozenCache = new Map<string, bigint>();
  /** 双方离线连击计数（连续 OFFLINE_STRIKE_LIMIT 次强制挂断） */
  private readonly offlineStrikes = new Map<string, number>();

  onModuleInit() {
    this.billingTimer = setInterval(() => {
      this.billingTick().catch((e) => this.logger.error(`计费 tick 异常: ${e?.stack ?? e}`));
    }, BILLING_TICK_MS);
    this.logger.log(`计费心跳已启动：间隔 ${BILLING_TICK_MS / 1000}s，预冻结上限 ${MAX_FREEZE_MIN} 分钟，离线判定 ${OFFLINE_STRIKE_LIMIT} 次`);
  }

  onModuleDestroy() {
    if (this.billingTimer) clearInterval(this.billingTimer);
  }

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
      voiceRoomMax: cfg?.voiceRoomMax ?? 3,
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

    // 视频通话发起时校验余额：至少够 1 分钟，不够直接拒绝（真正锁钱在 accept 预冻结）
    if (type === 2) {
      const { priceFen } = await this.videoPricing(calleeId);
      const wallet = await this.wallets.getWallet(callerId);
      if (priceFen > 0n && wallet.balance < priceFen) {
        this.logger.warn(
          `invite 拒绝(积分不足): caller=${callerId} callee=${calleeId} balance=${wallet.balance} price/min=${priceFen}`,
        );
        throw new BadRequestException('积分不足，无法发起视频通话');
      }
    }

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

    // 视频通话接通即预冻结（安全核心：冻结后这笔钱不能同时用于消息/礼物）
    if (record.type === 2) {
      try {
        await this.freezeForCall(callId, record.callerId, record.calleeId, 1);
      } catch (e) {
        // 男方余额在 invite 之后被花掉：不接通，通知双方
        this.logger.warn(`accept 冻结失败，通话取消: callId=${callId} caller=${record.callerId} err=${(e as Error).message}`);
        await this.prisma.callRecord.update({ where: { callId }, data: { status: 4, endedAt: new Date() } });
        await this.registry.deliver([record.callerId], {
          op: 'call', event: 'end', data: { callId, durationSec: 0, reason: '积分不足，无法接通' },
        });
        throw new BadRequestException('对方积分不足，无法接通');
      }
    }

    await this.prisma.callRecord.update({
      where: { callId },
      data: { status: 1, startedAt: new Date() },
    });
    const config = await this.getConfig();
    await this.registry.deliver([record.callerId], { op: 'call', event: 'accept', data: { callId } });
    return { callId, config };
  }

  /**
   * 预冻结 / 续冻：按女方每分钟价，冻 min(男方余额可冻分钟数, MAX_FREEZE_MIN) 分钟，
   * 至少 1 分钟，不足抛「积分不足」。seq 用于幂等 refKey（call_{id}_f{seq}）。
   */
  private async freezeForCall(callId: string, maleId: bigint, femaleId: bigint, seq: number): Promise<bigint> {
    let price = this.priceCache.get(callId);
    if (!price) {
      price = await this.videoPricing(femaleId);
      this.priceCache.set(callId, price);
    }
    // 价格配置为 0 = 免费模式，跳过冻结与计费
    if (price.priceFen <= 0n) return 0n;
    const wallet = await this.wallets.getWallet(maleId);
    let minutes = wallet.balance / price.priceFen;
    if (minutes > MAX_FREEZE_MIN) minutes = MAX_FREEZE_MIN;
    if (minutes < 1n) throw new BadRequestException('积分不足');
    const freezeFen = price.priceFen * minutes;

    let result: { balance: bigint; frozen: bigint };
    try {
      result = await this.prisma.$transaction((tx) =>
        this.wallets.applyTx(tx, maleId, 'call_freeze', -freezeFen, {
          frozenDelta: freezeFen,
          refKey: `call_${callId}_f${seq}`,
          remark: `视频通话预冻结 ${minutes} 分钟`,
        }),
      );
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // 同一 seq 已冻结过（accept 重试 / 并发 tick）：幂等成功，缓存失效待重建
        this.logger.warn(`冻结幂等命中(已冻结过): callId=${callId} seq=${seq}`);
        this.frozenCache.delete(callId);
        return 0n;
      }
      throw e;
    }
    const total = (this.frozenCache.get(callId) ?? 0n) + freezeFen;
    this.frozenCache.set(callId, total);
    this.logger.log(
      `冻结: callId=${callId} seq=${seq} male=${maleId} 冻结=${freezeFen}分(${minutes}分钟x${price.priceFen}) ` +
        `累计冻结=${total} 余额=${result.balance} 冻结栏=${result.frozen}`,
    );
    return freezeFen;
  }

  /** 通话已冻结总额：优先内存缓存，重启后从流水表重建（type=call_freeze, refKey 前缀匹配） */
  private async frozenTotal(callId: string, maleId: bigint): Promise<bigint> {
    const cached = this.frozenCache.get(callId);
    if (cached != null) return cached;
    const rows = await this.prisma.walletTransaction.findMany({
      where: { userId: maleId, type: 'call_freeze', refKey: { startsWith: `call_${callId}_f` } },
      select: { frozenDelta: true },
    });
    const total = rows.reduce((s, r) => s + r.frozenDelta, 0n);
    this.frozenCache.set(callId, total);
    if (rows.length) this.logger.log(`冻结额从流水重建: callId=${callId} total=${total}（服务重启后恢复）`);
    return total;
  }

  async reject(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) return { ok: true };
    await this.prisma.callRecord.update({ where: { callId }, data: { status: 4, endedAt: new Date() } });
    await this.refundFrozenIfAny(callId, record.callerId, 'reject');
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
    await this.refundFrozenIfAny(callId, record.callerId, 'cancel');
    await this.registry.deliver([record.calleeId], { op: 'call', event: 'cancel', data: { callId } });
    await this.im.sendCallMessage(record.callerId, record.calleeId, JSON.stringify({ callType: record.type, result: 'cancel' }));
    return { ok: true };
  }

  /** 未接通路径的兜底：把可能残留的冻结全额退回（正常情况下未接通不会有冻结） */
  private async refundFrozenIfAny(callId: string, maleId: bigint, scene: string) {
    try {
      const frozen = await this.frozenTotal(callId, maleId);
      if (frozen > 0n) {
        this.logger.warn(`${scene} 发现残留冻结，全额退回: callId=${callId} frozen=${frozen}`);
        await this.prisma.$transaction((tx) =>
          this.wallets.applyTx(tx, maleId, 'call_unfreeze', frozen, {
            frozenDelta: -frozen,
            refKey: `call_${callId}`,
            remark: '通话未接通，冻结退回',
          }),
        );
      }
    } catch (e: any) {
      if (e?.code === 'P2002') {
        this.logger.warn(`${scene} 冻结退回幂等跳过: callId=${callId}`);
      } else {
        this.logger.error(`${scene} 冻结退回失败: callId=${callId} err=${e?.stack ?? e}`);
      }
    }
    this.priceCache.delete(callId);
    this.frozenCache.delete(callId);
  }

  /**
   * 任一方挂断；视频通话按分钟从预冻结额清算（男付女收）。
   * opts.reason：强制挂断原因（积分不足/连接中断），随 end 信令下发；
   * opts.notifyBoth：true 时双方都收 end 信令（服务端强制挂断场景）。
   */
  async end(userId: bigint, callId: string, opts?: { reason?: string; notifyBoth?: boolean }) {
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

    // 视频计费：不足 1 分钟按 1 分钟；从预冻结额清算，男付全价，平台抽成后剩余归女方
    let billedFen = 0n;
    if (record.type === 2) {
      try {
        billedFen = await this.settleVideo(record, wasActive, durationSec);
      } catch (e: any) {
        // (type, refKey, userId) 唯一约束兜底：双方同时挂断 / tick 与 end 并发，只清算一次
        if (e?.code === 'P2002') {
          this.logger.warn(`清算跳过(已由并发方完成): callId=${callId}`);
        } else {
          this.logger.error(`清算失败: callId=${callId} err=${e?.stack ?? e}`);
          throw e;
        }
      }
    }
    // 清理本通话的内存状态
    this.priceCache.delete(callId);
    this.frozenCache.delete(callId);
    this.offlineStrikes.delete(callId);

    // 亲密度：视频每分钟主叫 +1、被叫 +0.5（不足 1 分钟按 1 分钟）
    if (wasActive && record.type === 2 && durationSec > 0) {
      void this.intimacy.bump(record.callerId, record.calleeId, Math.max(1, Math.ceil(durationSec / 60)));
    }

    const peer = record.callerId === userId ? record.calleeId : record.callerId;
    const targets = opts?.notifyBoth ? [record.callerId, record.calleeId] : [peer];
    await this.registry.deliver(targets, {
      op: 'call',
      event: 'end',
      data: { callId, durationSec, ...(opts?.reason ? { reason: opts.reason } : {}) },
    });
    await this.im.sendCallMessage(
      record.callerId,
      record.calleeId,
      JSON.stringify(wasActive ? { callType: record.type, result: 'end', duration: durationSec } : { callType: record.type, result: 'cancel' }),
    );
    if (opts?.reason) {
      this.logger.log(`强制挂断完成: callId=${callId} reason=${opts.reason} duration=${durationSec}s billed=${billedFen}`);
    }
    return { ok: true, durationSec, billedFen };
  }

  /**
   * 视频清算：实付 = min(价格 x ceil(秒/60), 已冻结总额)，从 frozen 扣，
   * 剩余冻结解回余额；女方分成 = 实付 - 平台抽成。整体在一个事务里，refKey 幂等。
   * 存量兼容：接通于旧版本（无冻结记录）的通话按旧逻辑从余额直扣。
   */
  private async settleVideo(
    record: { callId: string; callerId: bigint; calleeId: bigint },
    wasActive: boolean,
    durationSec: number,
  ): Promise<bigint> {
    const callId = record.callId;
    const frozenTotal = await this.frozenTotal(callId, record.callerId);
    const mins = wasActive && durationSec > 0 ? Math.max(1, Math.ceil(durationSec / 60)) : 0;

    if (frozenTotal <= 0n && mins === 0) return 0n;

    let price = this.priceCache.get(callId);
    if (!price) price = await this.videoPricing(record.calleeId);

    // 存量兼容：无冻结记录的进行中通话（部署前接通），按旧逻辑从余额直扣
    if (frozenTotal <= 0n) {
      const owed = price.priceFen * BigInt(mins);
      const wallet = await this.wallets.getWallet(record.callerId);
      const actual = wallet.balance < owed ? wallet.balance : owed;
      this.logger.warn(`清算(存量无冻结通话，余额直扣): callId=${callId} owed=${owed} actual=${actual}`);
      if (actual <= 0n) return 0n;
      const femaleShare = this.femaleShare(actual, price.platformCutFen, mins);
      await this.settleTx(record, mins, actual, femaleShare, 0n, `视频通话 ${mins} 分钟`, false);
      return actual;
    }

    const owed = price.priceFen * BigInt(mins);
    // 安全边界：只从冻结额扣（tick 续冻失败的场景最多损失一个 tick 周期的分钟差）
    const actual = owed > frozenTotal ? frozenTotal : owed;
    const refund = frozenTotal - actual;
    const femaleShare = this.femaleShare(actual, price.platformCutFen, mins);

    await this.settleTx(record, mins, actual, femaleShare, refund, `视频通话 ${mins} 分钟（冻结清算）`, true);
    this.logger.log(
      `清算: callId=${callId} 时长=${durationSec}s(${mins}分钟) 应收=${owed} 冻结=${frozenTotal} ` +
        `实收=${actual} 女方=${femaleShare} 平台=${actual - femaleShare} 解冻退回=${refund}`,
    );
    return actual;
  }

  private femaleShare(actual: bigint, platformCutFen: bigint, mins: number): bigint {
    const platformTotal = platformCutFen * BigInt(mins);
    return actual > platformTotal ? actual - platformTotal : 0n;
  }

  /** 清算事务：扣冻结/退冻结/女方入账/平台账本，refKey=call_{callId} 全链路幂等 */
  private async settleTx(
    record: { callId: string; callerId: bigint; calleeId: bigint },
    mins: number,
    actual: bigint,
    femaleShare: bigint,
    refundFromFrozen: bigint,
    remark: string,
    fromFrozen: boolean,
  ) {
    const callId = record.callId;
    await this.prisma.$transaction(async (tx) => {
      if (fromFrozen) {
        // 冻结清算：fee 行消耗 frozen，unfreeze 行把剩余退回 balance
        if (actual > 0n) {
          await this.wallets.applyTx(tx, record.callerId, 'call_fee', 0n, {
            frozenDelta: -actual,
            refKey: `call_${callId}`,
            remark,
          });
        }
        if (refundFromFrozen > 0n) {
          await this.wallets.applyTx(tx, record.callerId, 'call_unfreeze', refundFromFrozen, {
            frozenDelta: -refundFromFrozen,
            refKey: `call_${callId}`,
            remark: '视频通话冻结退回',
          });
        }
      } else if (actual > 0n) {
        // 存量直扣（部署前接通、无冻结记录的通话）
        await this.wallets.applyTx(tx, record.callerId, 'call_fee', -actual, {
          refKey: `call_${callId}`,
          remark,
        });
      }
      if (femaleShare > 0n) {
        await this.wallets.applyTx(tx, record.calleeId, 'call_income', femaleShare, {
          refKey: `call_${callId}`,
          remark: `视频通话收入 ${mins} 分钟（已扣平台成本）`,
        });
      }
      if (actual > 0n) {
        // 平台账本落账：总收费 = 女方分成 + 平台抽成，供后台按女生对账
        await tx.platformLedger.create({
          data: {
            type: 'video_cut',
            refKey: `call_${callId}`,
            maleId: record.callerId,
            femaleId: record.calleeId,
            minutes: mins,
            grossFen: actual,
            femaleFen: femaleShare,
            platformFen: actual - femaleShare,
          },
        });
      }
    });
  }

  /**
   * 计费心跳（每分钟）：
   * 1. 余额监控：已通话分钟数 x 价格 超过冻结额 → 尝试续冻，续不上强制挂断；
   * 2. 离线监控：双方任一离线连续 OFFLINE_STRIKE_LIMIT 个 tick → 强制挂断（防杀进程逃单）。
   * 通话中不逐分钟写库，只做读校验，性能开销可忽略。
   */
  private async billingTick() {
    const active = await this.prisma.callRecord.findMany({ where: { status: 1 } });
    if (!active.length) return;

    // 批量在线检查（一次 Redis 查询）
    const ids = active.flatMap((r) => [r.callerId, r.calleeId]);
    const online = await this.registry.onlineSet(ids);
    const now = Date.now();

    for (const r of active) {
      try {
        // ---- 离线监控（语音/视频都适用）----
        const bothSides = [r.callerId.toString(), r.calleeId.toString()];
        const offline = bothSides.filter((id) => !online.has(id));
        if (offline.length > 0) {
          const strikes = (this.offlineStrikes.get(r.callId) ?? 0) + 1;
          this.offlineStrikes.set(r.callId, strikes);
          this.logger.warn(`tick 离线: callId=${r.callId} offline=[${offline.join(',')}] strikes=${strikes}/${OFFLINE_STRIKE_LIMIT}`);
          if (strikes >= OFFLINE_STRIKE_LIMIT) {
            await this.end(r.callerId, r.callId, { reason: '连接中断，通话已结束', notifyBoth: true });
            continue;
          }
        } else if (this.offlineStrikes.has(r.callId)) {
          this.offlineStrikes.delete(r.callId);
          this.logger.log(`tick 恢复在线: callId=${r.callId}`);
        }

        // ---- 余额监控（仅视频计费）----
        if (r.type !== 2 || !r.startedAt) continue;
        const mins = Math.max(1, Math.ceil((now - r.startedAt.getTime()) / 60_000));
        let price = this.priceCache.get(r.callId);
        if (!price) {
          price = await this.videoPricing(r.calleeId);
          this.priceCache.set(r.callId, price);
        }
        if (price.priceFen <= 0n) continue; // 免费模式不计费
        const frozen = await this.frozenTotal(r.callId, r.callerId);
        const owed = price.priceFen * BigInt(mins);
        // 下一分钟就要超出冻结额时提前续冻，避免边界分钟出现资金缺口
        if (owed + price.priceFen > frozen) {
          const freezeSeq = Math.floor(Number(frozen / price.priceFen)) + 1;
          try {
            await this.freezeForCall(r.callId, r.callerId, r.calleeId, 1000 + freezeSeq);
          } catch {
            if (owed >= frozen) {
              this.logger.warn(
                `tick 强制挂断(积分不足): callId=${r.callId} 已通话=${mins}分钟 应收=${owed} 冻结=${frozen} 续冻失败`,
              );
              await this.end(r.callerId, r.callId, { reason: '积分不足，通话已结束', notifyBoth: true });
            } else {
              this.logger.warn(`tick 续冻失败(冻结额还够${frozen - owed}分，暂不挂断): callId=${r.callId}`);
            }
          }
        }
      } catch (e: any) {
        this.logger.error(`tick 处理通话异常: callId=${r.callId} err=${e?.stack ?? e}`);
      }
    }
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
