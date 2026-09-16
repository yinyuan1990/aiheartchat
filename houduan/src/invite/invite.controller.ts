import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '../common/rate-limit.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { InviteService } from './invite.service';

export function clientIp(req: any): string {
  return (req.headers?.['x-real-ip'] as string) || req.socket?.remoteAddress || '';
}

/**
 * 专属邀请页接口（yyheart.com/t/?u=短号 调用，无需登录）
 * GET  /app/invite/card/:code  名片数据
 * POST /app/invite/click       { code } 记录访问（安装归因用）
 * GET  /app/invite/mine        （登录）我的邀请链接与统计
 */
@Controller('app/invite')
export class InviteController {
  constructor(private readonly svc: InviteService) {}

  @Get('card/:code')
  @Throttle(60, 60)
  card(@Param('code') code: string) {
    return this.svc.card(code);
  }

  @Post('click')
  @Throttle(30, 60)
  click(@Body() body: { code?: string }, @Req() req: any) {
    return this.svc.click(String(body?.code ?? ''), clientIp(req), String(req.headers?.['user-agent'] ?? ''));
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() userId: bigint) {
    return this.svc.mine(userId);
  }
}
