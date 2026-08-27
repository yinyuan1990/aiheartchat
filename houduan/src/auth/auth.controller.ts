import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '../common/rate-limit.guard';
import { AuthService } from './auth.service';
import { EnterDto, RegisterDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 启动进入：设备已注册则直接恢复登录，未注册返回 registered=false */
  @Post('enter')
  @Throttle(30, 60)
  enter(@Body() dto: EnterDto) {
    return this.auth.enter(dto.deviceId);
  }

  /** 一机一号注册：昵称+年纪+性别+头像，账号(BNB地址)自动生成，无密码 */
  @Post('register')
  @Throttle(10, 3600)
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }
}
