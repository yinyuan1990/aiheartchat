import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * 提供三个连接：普通命令 / 订阅 / 发布。
 * IM 跨节点消息路由走 pub/sub，保证后期水平扩容不改业务代码。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  readonly pub: Redis;
  readonly sub: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL') || 'redis://127.0.0.1:6379';
    this.client = new Redis(url);
    this.pub = new Redis(url);
    this.sub = new Redis(url);
  }

  async onModuleDestroy() {
    await Promise.all([this.client.quit(), this.pub.quit(), this.sub.quit()]);
  }
}
