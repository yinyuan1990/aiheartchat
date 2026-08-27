import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ConnectionRegistry } from './connection.registry';

/** 心跳超时（毫秒）：超过视为已退出（杀进程/断网兜底） */
const MEMBER_TTL_MS = 90_000;

/**
 * 群聊语音房：房间状态存 Redis（hash: vroom:{groupId}，field=userId value=心跳时间戳），
 * 音频媒体走 SRS（每人推一路音频 WHIP，拉其他成员 WHEP），流名 vr_{groupId}_{userId}。
 * 人数上限从 call_config.voiceRoomMax 读取（管理端可调，默认 3）。
 * 成员变化经 IM WS 广播全群：{ op: "vroom", data: { groupId, members, max } }。
 *
 * 日志按「房间场次」归类（排查核心）：
 * 空房间首个成员加入时生成场次 ID（vr_{groupId}_{8位随机}），
 * 服务端事件与各端客户端上报都写入 call_client_log 的同一场次 ID 下，
 * 管理端「通话日志 - 语音房」按场次查看全部端的日志。
 */
@Injectable()
export class VoiceRoomService {
  private readonly logger = new Logger('VoiceRoom');
  private readonly srsApi: string;
  /** 上限配置内存缓存（30 秒），避免每次心跳查库 */
  private maxCache?: { value: number; at: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly registry: ConnectionRegistry,
    config: ConfigService,
  ) {
    this.srsApi = config.get<string>('SRS_API') ?? '';
  }

  private key(groupId: bigint) {
    return `vroom:${groupId}`;
  }

  private sidKey(groupId: bigint) {
    return `vroom:${groupId}:sid`;
  }

  private qrKey(groupId: bigint) {
    return `vroom:${groupId}:qr`;
  }

  /** 当前场次 ID（无则返回空串） */
  private async currentSid(groupId: bigint): Promise<string> {
    return (await this.redis.client.get(this.sidKey(groupId))) ?? '';
  }

  private async maxMembers(): Promise<number> {
    if (this.maxCache && Date.now() - this.maxCache.at < 30_000) return this.maxCache.value;
    const cfg = await this.prisma.callConfig.findFirst();
    const value = cfg?.voiceRoomMax ?? 3;
    this.maxCache = { value, at: Date.now() };
    return value;
  }

  private async assertGroupMember(userId: bigint, groupId: bigint) {
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member) throw new ForbiddenException('不在该群中');
  }

  /**
   * 服务端事件双写：进程日志（带场次前缀，grep VoiceRoom 看全局）
   * + call_client_log（uid=0 platform=server，与客户端日志同场次汇总）
   */
  private serverLog(sid: string, line: string, level: 'log' | 'warn' = 'log') {
    this.logger[level](`room=${sid || '-'} ${line}`);
    if (!sid) return;
    const ts = new Date().toISOString().slice(11, 23);
    void this.prisma.callClientLog
      .create({ data: { callId: sid, uid: 0n, platform: 'server', content: `${ts} ${line}` } })
      .catch(() => {});
  }

  /** 成员哈希值编码：{心跳时间戳}:{是否静音 0/1} */
  private encodeVal(ts: number, muted: boolean) {
    return `${ts}:${muted ? 1 : 0}`;
  }

  private decodeVal(raw: string): { ts: number; muted: boolean } {
    const [ts, muted] = String(raw).split(':');
    return { ts: Number(ts) || 0, muted: muted === '1' };
  }

  /** 读取当前成员并惰性剔除心跳超时者，返回静音集合与是否有剔除 */
  private async liveMembers(groupId: bigint): Promise<{ ids: string[]; mutedIds: Set<string>; pruned: boolean }> {
    const key = this.key(groupId);
    const all = await this.redis.client.hgetall(key);
    const now = Date.now();
    const ids: string[] = [];
    const mutedIds = new Set<string>();
    const stale: string[] = [];
    for (const [uid, raw] of Object.entries(all)) {
      const { ts, muted } = this.decodeVal(raw);
      if (now - ts > MEMBER_TTL_MS) {
        stale.push(uid);
      } else {
        ids.push(uid);
        if (muted) mutedIds.add(uid);
      }
    }
    if (stale.length) {
      await this.redis.client.hdel(key, ...stale);
      this.serverLog(await this.currentSid(groupId), `心跳超时剔除: group=${groupId} stale=[${stale.join(',')}] 剩余=${ids.length}`, 'warn');
    }
    return { ids, mutedIds, pruned: stale.length > 0 };
  }

  private async memberDetails(ids: string[], mutedIds: Set<string> = new Set()) {
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids.map(BigInt) } },
      select: { id: true, nickname: true, avatar: true },
    });
    // 保持加入顺序
    const map = new Map(users.map((u) => [u.id.toString(), u]));
    return ids
      .map((id) => map.get(id))
      .filter(Boolean)
      .map((u) => ({
        id: u!.id.toString(),
        nickname: u!.nickname,
        avatar: u!.avatar,
        muted: mutedIds.has(u!.id.toString()),
      }));
  }

  /** 成员变化广播全群（在线成员实时刷新语音房状态） */
  private async broadcast(groupId: bigint) {
    const { ids, mutedIds } = await this.liveMembers(groupId);
    const [members, max, groupMembers] = await Promise.all([
      this.memberDetails(ids, mutedIds),
      this.maxMembers(),
      this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } }),
    ]);
    await this.registry.deliver(
      groupMembers.map((m) => m.userId),
      { op: 'vroom', data: { groupId: groupId.toString(), members, max } },
    );
  }

  /** 房间状态（群聊页入口展示 N/max）；qrToken 供房内成员生成分享二维码 */
  async info(userId: bigint, groupId: bigint) {
    await this.assertGroupMember(userId, groupId);
    const { ids, mutedIds, pruned } = await this.liveMembers(groupId);
    if (pruned) void this.broadcast(groupId).catch(() => {});
    return {
      members: await this.memberDetails(ids, mutedIds),
      max: await this.maxMembers(),
      roomId: await this.currentSid(groupId),
      qrToken: ids.length > 0 ? (await this.redis.client.get(this.qrKey(groupId))) ?? '' : '',
    };
  }

  async join(userId: bigint, groupId: bigint) {
    await this.assertGroupMember(userId, groupId);
    const key = this.key(groupId);
    const { ids } = await this.liveMembers(groupId);
    const uid = userId.toString();
    const max = await this.maxMembers();
    if (!ids.includes(uid) && ids.length >= max) {
      this.serverLog(await this.currentSid(groupId), `join 拒绝(已满): group=${groupId} user=${uid} current=${ids.length}/${max}`, 'warn');
      throw new BadRequestException(`语音房已满（上限 ${max} 人）`);
    }

    // 只有群主能开房（空房间首个进入者必须是群主），其他人只能加入已开的房
    if (ids.length === 0) {
      const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
      if (!group || group.status !== 0) throw new NotFoundException('群不存在');
      if (group.ownerId !== userId) {
        this.serverLog(await this.currentSid(groupId), `join 拒绝(非群主开房): group=${groupId} user=${uid}`, 'warn');
        throw new ForbiddenException('仅群主可开启语音房');
      }
    }

    // 空房间首个成员进入 = 新场次：生成场次 ID（日志归类）+ 二维码 token（扫码免密进房凭证）
    let sid = await this.currentSid(groupId);
    if (ids.length === 0 || !sid) {
      sid = `vr_${groupId}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await this.redis.client.set(this.sidKey(groupId), sid, 'EX', 86_400);
      await this.redis.client.set(this.qrKey(groupId), randomUUID().replace(/-/g, '').slice(0, 12), 'EX', 86_400);
      this.serverLog(sid, `新场次开始: group=${groupId} 群主=${uid} 上限=${max}`);
    }

    await this.redis.client.hset(key, uid, this.encodeVal(Date.now(), false));
    await this.redis.client.expire(key, 86_400);
    this.serverLog(sid, `join: user=${uid} 房内=${ids.includes(uid) ? ids.length : ids.length + 1}/${max}`);
    await this.broadcast(groupId);
    const { ids: after, mutedIds: afterMuted } = await this.liveMembers(groupId);
    return {
      members: await this.memberDetails(after, afterMuted),
      max,
      roomId: sid,
      qrToken: (await this.redis.client.get(this.qrKey(groupId))) ?? '',
      whipUrl: `${this.srsApi}/rtc/v1/whip/`,
      whepUrl: `${this.srsApi}/rtc/v1/whep/`,
      stream: `vr_${groupId}_${uid}`,
    };
  }

  /**
   * 语音房二维码扫码：token 校验通过即免密入群（尊重群人数上限），
   * 返回群会话信息与房间状态，客户端随后走正常 join 建立媒体。
   */
  async scanJoin(userId: bigint, groupId: bigint, token: string) {
    const saved = await this.redis.client.get(this.qrKey(groupId));
    if (!saved || !token || saved !== token) throw new BadRequestException('二维码已失效');
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) throw new NotFoundException('群已解散');

    const already = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!already) {
      const count = await this.prisma.groupMember.count({ where: { groupId } });
      if (count >= group.memberLimit) throw new BadRequestException('群成员已达上限');
      await this.prisma.groupMember.createMany({ data: [{ groupId, userId }], skipDuplicates: true });
      this.serverLog(await this.currentSid(groupId), `扫码免密入群: group=${groupId} user=${userId}`);
      // 通知新成员刷新会话列表（否则新群要等有人发消息才显示）
      void this.registry.deliver([userId], { op: 'conv_refresh' }).catch(() => {});
    }

    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    const { ids } = await this.liveMembers(groupId);
    return {
      groupId: groupId.toString(),
      conversationId: conv?.id?.toString() ?? '',
      groupName: group.name,
      roomActive: ids.length > 0,
    };
  }

  async leave(userId: bigint, groupId: bigint) {
    const removed = await this.redis.client.hdel(this.key(groupId), userId.toString());
    if (removed > 0) {
      const { ids } = await this.liveMembers(groupId);
      this.serverLog(await this.currentSid(groupId), `leave: user=${userId} 剩余=${ids.length}`);
      if (ids.length === 0) {
        this.serverLog(await this.currentSid(groupId), `场次结束: group=${groupId} 房间已清空`);
      }
      await this.broadcast(groupId);
    }
    return { ok: true };
  }

  /** 客户端 30 秒一次心跳：刷新时间戳（保留静音标记）；已被剔除则返回 inRoom=false 由客户端退出 */
  async heartbeat(userId: bigint, groupId: bigint) {
    const key = this.key(groupId);
    const uid = userId.toString();
    const raw = await this.redis.client.hget(key, uid);
    if (raw != null) {
      await this.redis.client.hset(key, uid, this.encodeVal(Date.now(), this.decodeVal(raw).muted));
    }
    const { ids, mutedIds, pruned } = await this.liveMembers(groupId);
    if (pruned) void this.broadcast(groupId).catch(() => {});
    return { inRoom: ids.includes(uid), members: await this.memberDetails(ids, mutedIds) };
  }

  /** 静音状态同步：本人开/关麦克风时上报，广播全群刷新静音图标 */
  async setMuted(userId: bigint, groupId: bigint, muted: boolean) {
    const key = this.key(groupId);
    const uid = userId.toString();
    const raw = await this.redis.client.hget(key, uid);
    if (raw == null) return { ok: true };
    await this.redis.client.hset(key, uid, this.encodeVal(Date.now(), muted));
    this.serverLog(await this.currentSid(groupId), `mute: user=${uid} muted=${muted}`);
    await this.broadcast(groupId);
    return { ok: true };
  }

  /** 客户端日志上报：归入当前场次（房间已无场次 ID 时丢弃） */
  async appendLog(userId: bigint, groupId: bigint, platform: string, lines: string[]) {
    await this.assertGroupMember(userId, groupId);
    const sid = await this.currentSid(groupId);
    if (!sid) return { ok: true };
    const content = lines.slice(0, 500).map((l) => String(l).slice(0, 500)).join('\n');
    if (!content) return { ok: true };
    await this.prisma.callClientLog.create({
      data: { callId: sid, uid: userId, platform: platform.slice(0, 10), content },
    });
    return { ok: true };
  }
}
