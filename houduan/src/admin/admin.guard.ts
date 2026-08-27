import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/** 管理员鉴权：JWT payload 需带 role=admin */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('未登录');
    try {
      const payload = this.jwt.verify(token);
      if (payload.role !== 'admin') throw new Error();
      req.adminId = Number(payload.sub);
      return true;
    } catch {
      throw new UnauthorizedException('管理员登录已过期');
    }
  }
}
