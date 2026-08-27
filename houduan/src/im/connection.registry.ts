import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import { RedisService } from '../redis/redis.service';
import { RouteEnvelope } from './im.types';

/**
 * 连接注册表：本地连接 + Redis 路由表（userId -> nodeId）。
 * 跨节点投递走 Redis Pub/Sub（每个节点订阅自己的频道），
 * 水平扩容时无需改任何业务代码。
 */
@Injectable()
export class ConnectionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ImRegistry');
  readonly nodeId = randomUUID();
  private readonly local = new Map<string, Set<WebSocket>>();

  private static readonly ROUTE_KEY = 'im:route';
  private get channel() {
    return `im:node:${this.nodeId}`;
  }

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    await this.redis.sub.subscribe(this.channel);
    this.redis.sub.on('message', (channel: string, raw: string) => {
      if (channel !== this.channel) return;
      try {
        const env: RouteEnvelope = JSON.parse(raw);
        for (const uid of env.userIds) this.sendLocal(uid, env.frame);
      } catch (e) {
        this.logger.warn(`跨节点消息解析失败: ${e}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.redis.sub.unsubscribe(this.channel);
  }

  async register(userId: bigint, ws: WebSocket) {
    const key = userId.toString();
    if (!this.local.has(key)) this.local.set(key, new Set());
    this.local.get(key)!.add(ws);
    await this.redis.client.hset(ConnectionRegistry.ROUTE_KEY, key, this.nodeId);
  }

  async unregister(userId: bigint, ws: WebSocket) {
    const key = userId.toString();
    const set = this.local.get(key);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.local.delete(key);
        await this.redis.client.hdel(ConnectionRegistry.ROUTE_KEY, key);
      }
    }
  }

  isOnlineLocal(userId: string): boolean {
    return this.local.has(userId);
  }

  /** 本节点上该用户已打开的连接数（用于连接数上限） */
  localCount(userId: bigint | string): number {
    return this.local.get(userId.toString())?.size ?? 0;
  }

  /** 全局在线检查：本地连接或 Redis 路由表中有记录（任一节点在线） */
  async isOnline(userId: bigint | string): Promise<boolean> {
    const key = userId.toString();
    if (this.local.has(key)) return true;
    const node = await this.redis.client.hget(ConnectionRegistry.ROUTE_KEY, key);
    return !!node;
  }

  /** 批量在线检查：返回在线用户 id 集合 */
  async onlineSet(userIds: (bigint | string)[]): Promise<Set<string>> {
    const keys = userIds.map((u) => u.toString());
    const online = new Set<string>();
    if (!keys.length) return online;
    const routes = await this.redis.client.hmget(ConnectionRegistry.ROUTE_KEY, ...keys);
    keys.forEach((key, i) => {
      if (this.local.has(key) || routes[i]) online.add(key);
    });
    return online;
  }

  private sendLocal(userId: string, frame: unknown) {
    const set = this.local.get(userId);
    if (!set) return;
    const raw = JSON.stringify(frame);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  /** 投递给一批用户：本地直接发，异地按节点分组 pub */
  async deliver(userIds: (bigint | string)[], frame: unknown) {
    const remoteByNode = new Map<string, string[]>();
    const keys = userIds.map((u) => u.toString());

    const routes = keys.length ? await this.redis.client.hmget(ConnectionRegistry.ROUTE_KEY, ...keys) : [];
    keys.forEach((key, i) => {
      if (this.local.has(key)) {
        this.sendLocal(key, frame);
      } else if (routes[i] && routes[i] !== this.nodeId) {
        const node = routes[i]!;
        if (!remoteByNode.has(node)) remoteByNode.set(node, []);
        remoteByNode.get(node)!.push(key);
      }
      // 离线用户：不投递，上线后通过历史接口拉取
    });

    for (const [node, ids] of remoteByNode) {
      const env: RouteEnvelope = { userIds: ids, frame };
      await this.redis.pub.publish(`im:node:${node}`, JSON.stringify(env));
    }
  }
}
