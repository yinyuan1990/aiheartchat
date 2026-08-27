import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../redis/redis.service';

const RATE_LIMIT_KEY = 'rate_limit';

/** 按 IP 限流：windowSec 秒内最多 limit 次（叠加在全局限流之上，用于敏感接口） */
export const Throttle = (limit: number, windowSec: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSec });

/**
 * 全局限流（Nginx 之后的第二道防线，多节点共享 Redis 计数）：
 * - 默认每 IP 每分钟 300 次
 * - 打了 @Throttle 的接口按注解单独计数
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest();
    const ip =
      (req.headers['x-real-ip'] as string) ||
      req.socket?.remoteAddress ||
      'unknown';

    const custom = this.reflector.getAllAndOverride<{ limit: number; windowSec: number } | undefined>(
      RATE_LIMIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    await this.check(`rl:g:${ip}`, 300, 60);
    if (custom) {
      const name = `${ctx.getClass().name}.${ctx.getHandler().name}`;
      await this.check(`rl:${name}:${ip}`, custom.limit, custom.windowSec);
    }
    return true;
  }

  private async check(keyBase: string, limit: number, windowSec: number) {
    const bucket = Math.floor(Date.now() / (windowSec * 1000));
    const key = `${keyBase}:${bucket}`;
    const n = await this.redis.client.incr(key);
    if (n === 1) await this.redis.client.expire(key, windowSec + 1);
    if (n > limit) throw new HttpException('请求过于频繁，请稍后再试', 429);
  }
}
