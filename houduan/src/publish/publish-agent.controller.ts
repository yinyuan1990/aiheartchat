import { Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PublishService } from './publish.service';

/** 发布机鉴权：请求头 X-Publish-Token = 后台「内容分发」页里的 token */
@Injectable()
export class PublishAgentGuard implements CanActivate {
  constructor(private readonly publish: PublishService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = String(req.headers['x-publish-token'] ?? '');
    if (!(await this.publish.checkToken(token))) throw new UnauthorizedException('发布机 token 不对');
    return true;
  }
}

/** 给操作者本机发布机（publisher/）用的接口 */
@Controller('publish/agent')
@UseGuards(PublishAgentGuard)
export class PublishAgentController {
  constructor(private readonly publish: PublishService) {}

  /** 心跳 + 各平台登录状态；回启用的平台列表 */
  @Post('heartbeat')
  heartbeat(@Body() body: { host?: string; accounts?: Record<string, { ok: boolean; msg?: string; checkedAt?: string }> }) {
    return this.publish.heartbeat(body ?? {});
  }

  /** 领一条到点的任务；platforms = 本机已登录的平台，formats = 本机支持的形式（note,video；不传只给图文），都逗号分隔。没有则回 null */
  @Get('next')
  next(@Query('platforms') platforms?: string, @Query('formats') formats?: string, @Query('host') host?: string) {
    const split = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return this.publish.claim(split(platforms), formats ? split(formats) : ['note'], String(host ?? '').slice(0, 60));
  }

  @Post('result')
  result(@Body() body: { id: string; ok: boolean; url?: string; error?: string }) {
    return this.publish.result(body);
  }
}
