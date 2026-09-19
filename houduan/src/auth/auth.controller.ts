import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '../common/rate-limit.guard';
import { AuthService } from './auth.service';
import { ReviewService } from './review.service';
import { EnterDto, RegisterDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly review: ReviewService,
  ) {}

  /** 审核演示账号登录（账号 11111111111，密码任意）：iOS 审核模式下启动页显示的登录框调用 */
  @Post('demo-login')
  @Throttle(20, 600)
  async demoLogin(@Body() body: { username?: string; password?: string }) {
    const user = await this.review.demoLogin(body?.username ?? '', body?.password ?? '');
    return { registered: true, token: this.auth.signFor(user.id), user: this.auth.toProfile(user), inviter: null };
  }

  /** 启动进入：设备已注册则直接恢复登录，未注册返回 registered=false */
  @Post('enter')
  @Throttle(30, 60)
  enter(@Body() dto: EnterDto) {
    return this.auth.enter(dto.deviceId);
  }

  /** 一机一号注册：昵称+年纪+性别+头像，账号(BNB地址)自动生成，无密码；附带邀请归因（返回 inviter） */
  @Post('register')
  @Throttle(10, 3600)
  register(@Body() dto: RegisterDto, @Req() req: any) {
    const ip = (req.headers?.['x-real-ip'] as string) || req.socket?.remoteAddress || '';
    return this.auth.register(dto, ip);
  }
}
