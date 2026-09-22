import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { TgForwardService } from './tg-forward.service';

/** 频道转发（推广）：只有后台接口（挂在 AdminController），没有用户端接口 */
@Module({
  imports: [TelegramModule],
  providers: [TgForwardService],
  exports: [TgForwardService],
})
export class TgForwardModule {}
