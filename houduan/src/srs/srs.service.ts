import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** 下发给客户端的媒体入口（所有节点安装路径/端口一致，只有 IP 不同） */
export interface SrsEndpoint {
  /** 节点 IP；空 = 未配置任何节点且无环境变量 */
  srsServer: string;
  whipUrl: string;
  whepUrl: string;
}

/** 语音房 → 节点 映射（hash: field=groupId value=ip），用于统计各节点上的语音房人数 */
const VROOM_NODE_KEY = 'srs:vroom_nodes';
/** 呼叫中记录的有效期（与 CallService.busySet 一致）：超过视为异常残留，不计负载 */
const RINGING_VALID_MS = 90_000;

/**
 * SRS 节点调度：
 * - 节点由后台维护（增删、优先级、最大连接数、启用、默认）
 * - 选节点：启用节点按 priority,id 排序，取第一个 当前连接数 < maxConnections 的；全满则取负载率最低者
 * - 连接数 = 该节点上进行中/呼叫中通话的人数（每路 2 人）+ 语音房在房人数
 * - 表为空时退回环境变量 SRS_SERVER / SRS_API（兼容旧部署）
 */
@Injectable()
export class SrsService {
  private readonly logger = new Logger('Srs');
  private readonly envServer: string;
  private readonly envApi: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.envServer = (config.get<string>('SRS_SERVER') ?? '').trim();
    this.envApi = (config.get<string>('SRS_API') ?? '').trim().replace(/\/+$/, '');
  }

  // ---------- 入口构造 ----------

  private endpoint(ip: string, apiPort: number): SrsEndpoint {
    const base = `http://${ip}:${apiPort}`;
    return { srsServer: ip, whipUrl: `${base}/rtc/v1/whip/`, whepUrl: `${base}/rtc/v1/whep/` };
  }

  private envEndpoint(): SrsEndpoint {
    return {
      srsServer: this.envServer,
      whipUrl: this.envApi ? `${this.envApi}/rtc/v1/whip/` : '',
      whepUrl: this.envApi ? `${this.envApi}/rtc/v1/whep/` : '',
    };
  }

  /** 已分配过节点的场景（接听/重连）：按记录里的 IP 还原入口；IP 为空或节点已删则退环境变量 */
  async endpointFor(ip: string | null | undefined): Promise<SrsEndpoint> {
    if (!ip) return this.envEndpoint();
    const node = await this.prisma.srsNode.findUnique({ where: { ip } });
    if (!node) return this.envEndpoint();
    return this.endpoint(node.ip, node.apiPort);
  }

  // ---------- 负载 ----------

  /** 各节点当前连接数（ip → 人数） */
  async loadMap(): Promise<Map<string, number>> {
    const load = new Map<string, number>();
    const since = new Date(Date.now() - RINGING_VALID_MS);
    const calls = await this.prisma.callRecord.groupBy({
      by: ['srsNode'],
      where: { OR: [{ status: 1 }, { status: 0, createdAt: { gt: since } }] },
      _count: { _all: true },
    });
    for (const c of calls) {
      if (!c.srsNode) continue;
      load.set(c.srsNode, (load.get(c.srsNode) ?? 0) + c._count._all * 2);
    }
    // 语音房：hash 里每个群的节点 + 房内人数
    const rooms = await this.redis.client.hgetall(VROOM_NODE_KEY);
    const stale: string[] = [];
    for (const [groupId, ip] of Object.entries(rooms)) {
      const n = await this.redis.client.hlen(`vroom:${groupId}`);
      if (n <= 0) {
        stale.push(groupId);
        continue;
      }
      load.set(ip, (load.get(ip) ?? 0) + n);
    }
    if (stale.length) await this.redis.client.hdel(VROOM_NODE_KEY, ...stale);
    return load;
  }

  // ---------- 选节点 ----------

  /** 为一次新通话/新语音房场次分配节点 */
  async pick(scene: string): Promise<SrsEndpoint> {
    const nodes = await this.prisma.srsNode.findMany({
      where: { enabled: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    if (nodes.length === 0) {
      if (!this.envServer) this.logger.warn(`${scene}: 未配置任何 SRS 节点，且环境变量 SRS_SERVER 为空`);
      return this.envEndpoint();
    }
    const load = await this.loadMap();
    // 第一个未满的节点
    for (const n of nodes) {
      const cur = load.get(n.ip) ?? 0;
      if (cur < n.maxConnections) {
        if (n !== nodes[0]) this.logger.log(`${scene}: 前置节点已满，落到 ${n.ip}（${cur}/${n.maxConnections}）`);
        return this.endpoint(n.ip, n.apiPort);
      }
    }
    // 全满：取负载率最低的（仍要保证能打通话）
    const least = nodes
      .map((n) => ({ n, ratio: (load.get(n.ip) ?? 0) / Math.max(1, n.maxConnections) }))
      .sort((a, b) => a.ratio - b.ratio)[0].n;
    this.logger.warn(`${scene}: 所有 SRS 节点已满，选负载率最低的 ${least.ip}（${load.get(least.ip) ?? 0}/${least.maxConnections}）`);
    return this.endpoint(least.ip, least.apiPort);
  }

  /** 语音房：新场次开始时分配并记录；已有场次直接复用 */
  async pickForVoiceRoom(groupId: bigint, newSession: boolean): Promise<SrsEndpoint> {
    const key = groupId.toString();
    if (!newSession) {
      const ip = await this.redis.client.hget(VROOM_NODE_KEY, key);
      if (ip) return this.endpointFor(ip);
    }
    const ep = await this.pick(`vroom group=${groupId}`);
    if (ep.srsServer) await this.redis.client.hset(VROOM_NODE_KEY, key, ep.srsServer);
    return ep;
  }

  async releaseVoiceRoom(groupId: bigint) {
    await this.redis.client.hdel(VROOM_NODE_KEY, groupId.toString());
  }

  // ---------- 后台管理 ----------

  async adminList() {
    const [nodes, load] = await Promise.all([
      this.prisma.srsNode.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] }),
      this.loadMap(),
    ]);
    return {
      envFallback: { srsServer: this.envServer, srsApi: this.envApi },
      nodes: nodes.map((n) => ({ ...n, current: load.get(n.ip) ?? 0 })),
    };
  }

  /** 部署工具用：默认节点（复制源）。没有显式默认则取优先级最高的启用节点 */
  async defaultNode() {
    return (
      (await this.prisma.srsNode.findFirst({ where: { isDefault: true } })) ??
      (await this.prisma.srsNode.findFirst({ where: { enabled: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] }))
    );
  }

  private normalize(body: any) {
    const ip = String(body?.ip ?? '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[a-zA-Z0-9.-]+$/.test(ip)) throw new BadRequestException('IP 格式不正确');
    const apiPort = Number(body?.apiPort ?? 1985);
    if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new BadRequestException('端口不正确');
    const priority = Number(body?.priority ?? 100);
    if (!Number.isInteger(priority)) throw new BadRequestException('优先级必须是整数');
    const maxConnections = Number(body?.maxConnections ?? 40);
    if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new BadRequestException('最大连接数必须 ≥ 1');
    return {
      ip,
      apiPort,
      priority,
      maxConnections,
      name: String(body?.name ?? '').trim().slice(0, 40),
      remark: String(body?.remark ?? '').trim().slice(0, 200),
      enabled: body?.enabled == null ? true : !!body.enabled,
    };
  }

  /** 新增；首个节点自动设为默认 */
  async adminCreate(body: any) {
    const data = this.normalize(body);
    if (await this.prisma.srsNode.findUnique({ where: { ip: data.ip } })) throw new BadRequestException('该 IP 已存在');
    const isDefault = (await this.prisma.srsNode.count()) === 0;
    return this.prisma.srsNode.create({ data: { ...data, isDefault } });
  }

  async adminUpdate(id: number, body: any) {
    const node = await this.prisma.srsNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('节点不存在');
    const data = this.normalize({ ...node, ...body });
    if (data.ip !== node.ip && (await this.prisma.srsNode.findUnique({ where: { ip: data.ip } }))) {
      throw new BadRequestException('该 IP 已存在');
    }
    return this.prisma.srsNode.update({ where: { id }, data });
  }

  /** 设为默认（复制源）；同时只能有一个 */
  async adminSetDefault(id: number) {
    const node = await this.prisma.srsNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('节点不存在');
    await this.prisma.$transaction([
      this.prisma.srsNode.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
      this.prisma.srsNode.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { ok: true };
  }

  /** 删除；默认节点被删则把默认转给优先级最高的剩余节点。进行中的通话不受影响（客户端已拿到 IP） */
  async adminDelete(id: number) {
    const node = await this.prisma.srsNode.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('节点不存在');
    await this.prisma.srsNode.delete({ where: { id } });
    if (node.isDefault) {
      const next = await this.prisma.srsNode.findFirst({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
      if (next) await this.prisma.srsNode.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { ok: true };
  }
}
