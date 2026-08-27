import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** 取 JwtAuthGuard 解析出的当前用户 id (bigint) */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): bigint => {
  return ctx.switchToHttp().getRequest().userId;
});
