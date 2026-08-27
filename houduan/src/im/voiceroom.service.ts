import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
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

  /** 读取当前成员并惰性剔除心跳超时者，返回是否有剔除 */
  private async liveMembers(groupId: bigint): Promise<{ ids: string[]; pruned: boolean }> {
    const key = this.key(groupId);
    const all = await this.redis.client.hgetall(key);
    const now = Date.now();
    const ids: string[] = [];
    const stale: string[] = [];
    for (const [uid, ts] of Object.entries(all)) {
      if (now - Number(ts) > MEMBER_TTL_MS) stale.push(uid);
      else ids.push(uid);
    }
    if (stale.length) {
      await this.redis.client.hdel(key, ...stale);
      this.serverLog(await this.currentSid(groupId), `心跳超时剔除: group=${groupId} stale=[${stale.join(',')}] 剩余=${ids.length}`, 'warn');
    }
    return { ids, pruned: stale.length > 0 };
  }

  private async memberDetails(ids: string[]) {
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
      .map((u) => ({ id: u!.id.toString(), nickname: u!.nickname, avatar: u!.avatar }));
  }

  /** 成员变化广播全群（在线成员实时刷新语音房状态） */
  private async broadcast(groupId: bigint) {
    const { ids } = await this.liveMembers(groupId);
    const [members, max, groupMembers] = await Promise.all([
      this.memberDetails(ids),
      this.maxMembers(),
      this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } }),
    ]);
    await this.registry.deliver(
      groupMembers.map((m) => m.userId),
      { op: 'vroom', data: { groupId: groupId.toString(), members, max } },
    );
  }

  /** 房间状态（群聊页入口展示 N/max） */
  async info(userId: bigint, groupId: bigint) {
    await this.assertGroupMember(userId, groupId);
    const { ids, pruned } = await this.liveMembers(groupId);
    if (pruned) void this.broadcast(groupId).catch(() => {});
    return { members: await this.memberDetails(ids), max: await this.maxMembers(), roomId: await this.currentSid(groupId) };
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

    // 空房间首个成员进入 = 新场次，生成场次 ID（后续所有端的日志都归到这一场）
    let sid = await this.currentSid(groupId);
    if (ids.length === 0 || !sid) {
      sid = `vr_${groupId}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await this.redis.client.set(this.sidKey(groupId), sid, 'EX', 86_400);
      this.serverLog(sid, `新场次开始: group=${groupId} 发起人=${uid} 上限=${max}`);
    }

    await this.redis.client.hset(key, uid, Date.now().toString());
    await this.redis.client.expire(key, 86_400);
    this.serverLog(sid, `join: user=${uid} 房内=${ids.includes(uid) ? ids.length : ids.length + 1}/${max}`);
    await this.broadcast(groupId);
    const { ids: after } = await this.liveMembers(groupId);
    return {
      members: await this.memberDetails(after),
      max,
      roomId: sid,
      whipUrl: `${this.srsApi}/rtc/v1/whip/`,
      whepUrl: `${this.srsApi}/rtc/v1/whep/`,
      stream: `vr_${groupId}_${uid}`,
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

  /** 客户端 30 秒一次心跳：刷新时间戳；已被剔除则返回 inRoom=false 由客户端退出 */
  async heartbeat(userId: bigint, groupId: bigint) {
    const key = this.key(groupId);
    const uid = userId.toString();
    const exists = await this.redis.client.hexists(key, uid);
    if (exists) {
      await this.redis.client.hset(key, uid, Date.now().toString());
    }
    const { ids, pruned } = await this.liveMembers(groupId);
    if (pruned) void this.broadcast(groupId).catch(() => {});
    return { inRoom: ids.includes(uid), members: await this.memberDetails(ids) };
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
