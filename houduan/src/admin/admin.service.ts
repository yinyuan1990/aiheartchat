import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly wallets: WalletService,
    private readonly redis: RedisService,
  ) {}

  /** 登录：同一 IP+账号失败 5 次锁 15 分钟；哈希恒时比较防时序探测 */
  async login(username: string, password: string, ip = '') {
    const failKey = `admin:fail:${ip}:${username}`;
    const fails = Number(await this.redis.client.get(failKey)) || 0;
    if (fails >= 5) throw new UnauthorizedException('失败次数过多，请 15 分钟后再试');

    const admin = await this.prisma.adminUser.findUnique({ where: { username } });
    let ok = false;
    if (admin) {
      const [salt, hash] = admin.passwordHash.split(':');
      const check = crypto.scryptSync(password, salt, 32);
      const expect = Buffer.from(hash, 'hex');
      ok = check.length === expect.length && crypto.timingSafeEqual(check, expect);
    }
    if (!admin || !ok) {
      await this.redis.client.multi().incr(failKey).expire(failKey, 900).exec();
      throw new UnauthorizedException('账号或密码错误');
    }
    await this.redis.client.del(failKey);
    return { token: this.jwt.sign({ sub: admin.id.toString(), role: 'admin' }, { expiresIn: '7d' }) };
  }

  // ---------- 用户 ----------

  listUsers(keyword?: string, beforeId?: bigint) {
    return this.prisma.user.findMany({
      where: {
        ...(keyword ? { OR: [{ nickname: { contains: keyword } }, { address: { contains: keyword } }] } : {}),
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 30,
    });
  }

  async setUserStatus(userId: bigint, status: number) {
    await this.prisma.user.update({ where: { id: userId }, data: { status } });
    return { ok: true };
  }

  /** 后台发放/调整积分（唯一积分来源）：正数=发放 admin_grant，负数=扣减 adjust */
  async grantPoints(userId: bigint, amount: bigint, remark: string) {
    if (amount === 0n) throw new BadRequestException('金额不能为 0');
    const isGrant = amount > 0n;
    return this.prisma.$transaction(async (tx) => {
      return this.wallets.applyTx(tx, userId, isGrant ? 'admin_grant' : 'adjust', amount, {
        refKey: `${isGrant ? 'grant' : 'adjust'}_${Date.now()}_${userId}`,
        remark: remark || (isGrant ? '后台发放' : '后台扣减'),
      });
    });
  }

  /** 查看某用户积分明细（游标分页） */
  listUserTransactions(userId: bigint, beforeId?: bigint) {
    return this.wallets.listTransactions(userId, beforeId);
  }

  // ---------- 通话日志（排查视频/语音概率性问题） ----------

  /** 通话记录列表（游标分页），附双方昵称与日志条数 */
  async listCallLogs(beforeId?: bigint) {
    const records = await this.prisma.callRecord.findMany({
      where: beforeId ? { id: { lt: beforeId } } : undefined,
      orderBy: { id: 'desc' },
      take: 30,
    });
    const uids = [...new Set(records.flatMap((r) => [r.callerId, r.calleeId]))];
    const callIds = records.map((r) => r.callId);
    const [users, logCounts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, nickname: true, shortId: true, gender: true } }),
      this.prisma.callClientLog.groupBy({ by: ['callId'], where: { callId: { in: callIds } }, _count: true }),
    ]);
    const umap = new Map(users.map((u) => [u.id, u]));
    const cmap = new Map(logCounts.map((c) => [c.callId, c._count]));
    return records.map((r) => ({
      id: String(r.id),
      callId: r.callId,
      type: r.type,
      status: r.status,
      durationSec: r.durationSec,
      createdAt: r.createdAt,
      caller: umap.get(r.callerId) ?? null,
      callee: umap.get(r.calleeId) ?? null,
      logCount: cmap.get(r.callId) ?? 0,
    }));
  }

  /** 某通通话的全部日志（双端上报按时间排序） */
  async callLogDetail(callId: string) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId } });
    if (!record) throw new BadRequestException('通话不存在');
    const [logs, users] = await Promise.all([
      this.prisma.callClientLog.findMany({ where: { callId }, orderBy: { id: 'asc' } }),
      this.prisma.user.findMany({
        where: { id: { in: [record.callerId, record.calleeId] } },
        select: { id: true, nickname: true, shortId: true, gender: true },
      }),
    ]);
    return {
      record: {
        callId: record.callId,
        type: record.type,
        status: record.status,
        durationSec: record.durationSec,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        callerId: String(record.callerId),
        calleeId: String(record.calleeId),
      },
      users,
      logs: logs.map((l) => ({
        id: String(l.id),
        uid: String(l.uid),
        platform: l.platform,
        content: l.content,
        createdAt: l.createdAt,
      })),
    };
  }

  // ---------- 平台账本（视频通话抽成对账） ----------

  private ledgerRange(from?: string, to?: string) {
    const cond: { gte?: Date; lte?: Date } = {};
    if (from) cond.gte = new Date(`${from}T00:00:00+08:00`);
    if (to) cond.lte = new Date(`${to}T23:59:59.999+08:00`);
    return Object.keys(cond).length ? cond : undefined;
  }

  /** 平台汇总：视频总收费 / 女生分成 / 平台抽成 / 笔数 */
  async ledgerSummary(from?: string, to?: string) {
    const createdAt = this.ledgerRange(from, to);
    const agg = await this.prisma.platformLedger.aggregate({
      where: { type: 'video_cut', ...(createdAt ? { createdAt } : {}) },
      _sum: { grossFen: true, femaleFen: true, platformFen: true, minutes: true },
      _count: true,
    });
    return {
      count: agg._count,
      minutes: agg._sum.minutes ?? 0,
      grossFen: agg._sum.grossFen ?? 0n,
      femaleFen: agg._sum.femaleFen ?? 0n,
      platformFen: agg._sum.platformFen ?? 0n,
    };
  }

  /** 按女生逐人对账：视频笔数/分钟/总收费/分成/抽成 + 消息/礼物收入 */
  async ledgerFemales(from?: string, to?: string) {
    const createdAt = this.ledgerRange(from, to);
    const rows = await this.prisma.platformLedger.groupBy({
      by: ['femaleId'],
      where: { type: 'video_cut', ...(createdAt ? { createdAt } : {}) },
      _sum: { grossFen: true, femaleFen: true, platformFen: true, minutes: true },
      _count: true,
      orderBy: { _sum: { platformFen: 'desc' } },
    });
    const ids = rows.map((r) => r.femaleId);
    const [users, extraIncome] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, shortId: true, nickname: true, avatar: true },
      }),
      // 消息 / 礼物收入（平台不抽成，全额归女方），一并列出便于结算
      this.prisma.walletTransaction.groupBy({
        by: ['userId', 'type'],
        where: { userId: { in: ids }, type: { in: ['msg_income', 'gift_recv'] }, ...(createdAt ? { createdAt } : {}) },
        _sum: { amount: true },
      }),
    ]);
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const extraMap = new Map<string, { msgFen: bigint; giftFen: bigint }>();
    for (const e of extraIncome) {
      const key = e.userId.toString();
      const cur = extraMap.get(key) ?? { msgFen: 0n, giftFen: 0n };
      if (e.type === 'msg_income') cur.msgFen += e._sum.amount ?? 0n;
      if (e.type === 'gift_recv') cur.giftFen += e._sum.amount ?? 0n;
      extraMap.set(key, cur);
    }
    return rows.map((r) => {
      const key = r.femaleId.toString();
      return {
        female: userMap.get(key) ?? { id: r.femaleId, nickname: '已注销', shortId: '', avatar: '' },
        count: r._count,
        minutes: r._sum.minutes ?? 0,
        grossFen: r._sum.grossFen ?? 0n,
        femaleFen: r._sum.femaleFen ?? 0n,
        platformFen: r._sum.platformFen ?? 0n,
        msgIncomeFen: extraMap.get(key)?.msgFen ?? 0n,
        giftIncomeFen: extraMap.get(key)?.giftFen ?? 0n,
      };
    });
  }

  /** 某女生的逐笔视频账单 */
  async ledgerFemaleDetail(femaleId: bigint, from?: string, to?: string) {
    const createdAt = this.ledgerRange(from, to);
    const rows = await this.prisma.platformLedger.findMany({
      where: { type: 'video_cut', femaleId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { id: 'desc' },
      take: 200,
    });
    const maleIds = [...new Set(rows.map((r) => r.maleId))];
    const males = await this.prisma.user.findMany({
      where: { id: { in: maleIds } },
      select: { id: true, shortId: true, nickname: true },
    });
    const maleMap = new Map(males.map((m) => [m.id.toString(), m]));
    return rows.map((r) => ({
      id: r.id,
      male: maleMap.get(r.maleId.toString()) ?? { id: r.maleId, nickname: '已注销', shortId: '' },
      minutes: r.minutes,
      grossFen: r.grossFen,
      femaleFen: r.femaleFen,
      platformFen: r.platformFen,
      createdAt: r.createdAt,
    }));
  }

  // ---------- 地陪审核 ----------

  listGuideApplies(status = 0) {
    return this.prisma.guideApply.findMany({ where: { status }, orderBy: { id: 'asc' }, take: 50 });
  }

  async reviewGuide(applyId: bigint, pass: boolean, reason = '') {
    const apply = await this.prisma.guideApply.findUnique({ where: { id: applyId } });
    if (!apply || apply.status !== 0) throw new NotFoundException('申请不存在或已处理');
    // 搭子认证已合并实名：通过时把实名信息写入用户（身份证被他人占用时只标记 isGuide）
    let userData: any = { isGuide: true };
    if (pass) {
      const used = await this.prisma.user.findFirst({
        where: { idCard: apply.idCardNo, id: { not: apply.userId } },
      });
      if (!used && apply.idCardNo) userData = { isGuide: true, realName: apply.realName, idCard: apply.idCardNo };
    }
    await this.prisma.$transaction([
      this.prisma.guideApply.update({
        where: { id: applyId },
        data: { status: pass ? 1 : 2, rejectReason: reason, reviewedAt: new Date() },
      }),
      ...(pass ? [this.prisma.user.update({ where: { id: apply.userId }, data: userData })] : []),
    ]);
    return { ok: true };
  }

  // ---------- 提现审核 ----------

  listWithdrawals(status = 0) {
    return this.prisma.withdrawApply.findMany({ where: { status }, orderBy: { id: 'asc' }, take: 50 });
  }

  async reviewWithdraw(applyId: bigint, pass: boolean, remark = '') {
    const apply = await this.prisma.withdrawApply.findUnique({ where: { id: applyId } });
    if (!apply || apply.status !== 0) throw new NotFoundException('申请不存在或已处理');
    return this.prisma.$transaction(async (tx) => {
      await tx.withdrawApply.update({
        where: { id: applyId },
        data: { status: pass ? 1 : 2, remark, reviewedAt: new Date() },
      });
      if (pass) {
        // 通过：冻结清零（线下打款）
        await this.wallets.applyTx(tx, apply.userId, 'withdraw', 0n, {
          frozenDelta: -apply.amount,
          refKey: `wd_ok_${applyId}`,
          remark: '提现通过',
        });
      } else {
        // 拒绝：冻结退回可用
        await this.wallets.applyTx(tx, apply.userId, 'withdraw', apply.amount, {
          frozenDelta: -apply.amount,
          refKey: `wd_back_${applyId}`,
          remark: '提现拒绝退回',
        });
      }
      return { ok: true };
    });
  }

  // ---------- 计费配置 ----------

  async getPriceConfig() {
    const price = await this.prisma.priceConfig.findFirst();
    return price ?? { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2 };
  }

  async updatePriceConfig(data: { msgPriceFen?: number; videoBaseFenPerMin?: number; videoPlatformX?: number; momentNeedRealname?: boolean }) {
    const price = await this.prisma.priceConfig.findFirst();
    if (price) {
      return this.prisma.priceConfig.update({ where: { id: price.id }, data });
    }
    return this.prisma.priceConfig.create({ data: { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2, ...data } });
  }

  /** 重置全平台女生视频价格为 成本 x 倍数（默认 x5） */
  async resetFemalePrices(times = 5) {
    const price = await this.prisma.priceConfig.findFirst();
    const target = (price?.videoBaseFenPerMin ?? 2) * times;
    const result = await this.prisma.user.updateMany({
      where: { gender: 2 },
      data: { videoPriceFen: target },
    });
    return { ok: true, priceFen: target, affected: result.count };
  }

  // ---------- 通话参数（后端可调核心） ----------

  async getCallConfig() {
    const cfg = await this.prisma.callConfig.findFirst();
    return cfg ?? { width: 640, height: 480, fps: 25, bitrate: 800, voiceRoomMax: 3 };
  }

  async updateCallConfig(data: { width?: number; height?: number; fps?: number; bitrate?: number; voiceRoomMax?: number }) {
    if (data.voiceRoomMax !== undefined && (data.voiceRoomMax < 1 || data.voiceRoomMax > 50)) {
      throw new BadRequestException('语音房人数上限须在 1-50 之间');
    }
    const cfg = await this.prisma.callConfig.findFirst();
    if (cfg) {
      return this.prisma.callConfig.update({ where: { id: cfg.id }, data });
    }
    return this.prisma.callConfig.create({ data: { width: 640, height: 480, fps: 30, bitrate: 800, ...data } });
  }

  // ---------- 语音房日志：按场次（callId=vr_{groupId}_{rand}）汇总服务端+多端日志 ----------

  async listVroomSessions() {
    const groups = await this.prisma.callClientLog.groupBy({
      by: ['callId'],
      where: { callId: { startsWith: 'vr_' } },
      _count: true,
      _min: { createdAt: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: 50,
    });
    // 场次 ID 形如 vr_{groupId}_{rand}，解析群 id 带出群名
    const groupIds = [...new Set(groups.map((g) => g.callId.split('_')[1]).filter(Boolean))];
    const chatGroups = await this.prisma.chatGroup.findMany({
      where: { id: { in: groupIds.map(BigInt) } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(chatGroups.map((g) => [g.id.toString(), g.name]));
    return groups.map((g) => ({
      roomId: g.callId,
      groupId: g.callId.split('_')[1] ?? '',
      groupName: nameMap.get(g.callId.split('_')[1] ?? '') ?? '(群已删除)',
      logCount: g._count,
      firstAt: g._min.createdAt,
      lastAt: g._max.createdAt,
    }));
  }

  async vroomLogDetail(roomId: string) {
    if (!roomId.startsWith('vr_')) throw new BadRequestException('无效的房间场次 ID');
    const logs = await this.prisma.callClientLog.findMany({ where: { callId: roomId }, orderBy: { id: 'asc' } });
    const uids = [...new Set(logs.map((l) => l.uid).filter((u) => u !== 0n))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: uids } },
      select: { id: true, nickname: true, shortId: true, gender: true },
    });
    const groupId = roomId.split('_')[1] ?? '';
    const group = groupId ? await this.prisma.chatGroup.findUnique({ where: { id: BigInt(groupId) }, select: { name: true } }) : null;
    return { roomId, groupName: group?.name ?? '(群已删除)', logs, users };
  }

  // ---------- 礼物管理 ----------

  listGifts() {
    return this.prisma.gift.findMany({ orderBy: { sort: 'asc' } });
  }

  upsertGift(data: { id?: number; name: string; icon: string; price: string; sort?: number; enabled?: boolean }) {
    const payload = {
      name: data.name,
      icon: data.icon,
      price: BigInt(data.price),
      sort: data.sort ?? 0,
      enabled: data.enabled ?? true,
    };
    if (data.id) {
      return this.prisma.gift.update({ where: { id: data.id }, data: payload });
    }
    return this.prisma.gift.create({ data: payload });
  }

  // ---------- 模块入口管理（横幅项目 + 小游戏） ----------

  listModules() {
    return this.prisma.appModule.findMany({ orderBy: { sort: 'asc' } });
  }

  /**
   * type: native=客户端内置页（entry 为路由标识）；h5=横幅内嵌网页；game=小游戏（大厅宫格，图标+链接+说明）。
   * h5/game 的 entry 必须是 http(s) 完整地址，game 必须有图标；orientation 为游戏屏幕方向（portrait/landscape）。
   */
  upsertModule(data: {
    id?: number; name: string; icon?: string; desc?: string; cover?: string; type: string; entry: string;
    orientation?: string; sort?: number; enabled?: boolean; visibleGender?: number;
  }) {
    if (!['native', 'h5', 'game'].includes(data.type)) throw new BadRequestException('type 非法');
    const entry = (data.entry ?? '').trim();
    if (!entry) throw new BadRequestException('入口不能为空');
    if (data.type !== 'native' && !/^https?:\/\//i.test(entry)) throw new BadRequestException('链接地址需以 http(s):// 开头');
    if (data.type === 'game' && !(data.icon ?? '').trim()) throw new BadRequestException('小游戏需上传图标');
    const orientation = data.orientation ?? 'portrait';
    if (!['portrait', 'landscape'].includes(orientation)) throw new BadRequestException('屏幕方向非法');
    const payload = {
      name: data.name,
      icon: data.icon ?? '',
      desc: data.desc ?? '',
      cover: data.cover ?? '',
      type: data.type,
      entry,
      orientation,
      sort: data.sort ?? 0,
      enabled: data.enabled ?? true,
      visibleGender: data.visibleGender ?? 0,
    };
    if (data.id) {
      return this.prisma.appModule.update({ where: { id: data.id }, data: payload });
    }
    return this.prisma.appModule.create({ data: payload });
  }

  // ---------- 约单仲裁 ----------

  listDisputes() {
    return this.prisma.taskOrder.findMany({ where: { status: { in: [1, 4] } }, orderBy: { id: 'asc' }, take: 50 });
  }

  /** 仲裁：判给接单人(settle)或退回发单人(refund) */
  async arbitrate(orderId: bigint, settleToTaker: boolean) {
    const order = await this.prisma.taskOrder.findUnique({ where: { id: orderId } });
    if (!order || (order.status !== 1 && order.status !== 4)) throw new NotFoundException('约单不可仲裁');

    return this.prisma.$transaction(async (tx) => {
      await tx.taskOrder.update({
        where: { id: orderId },
        data: { status: settleToTaker ? 2 : 3, finishedAt: new Date() },
      });
      if (settleToTaker && order.takerId) {
        await this.wallets.applyTx(tx, order.ownerId, 'task_settle', 0n, {
          frozenDelta: -order.reward,
          refKey: `arb_${orderId}`,
          remark: '仲裁结算支出',
        });
        await this.wallets.applyTx(tx, order.takerId, 'task_settle', order.reward, {
          refKey: `arb_${orderId}`,
          remark: '仲裁判得报酬',
        });
      } else {
        await this.wallets.applyTx(tx, order.ownerId, 'task_refund', order.reward, {
          frozenDelta: -order.reward,
          refKey: `arb_${orderId}`,
          remark: '仲裁退回',
        });
      }
      return { ok: true };
    });
  }

  // ---------- 动态管理 ----------

  async hideMoment(momentId: bigint) {
    await this.prisma.moment.update({ where: { id: momentId }, data: { status: 1 } });
    return { ok: true };
  }
}
