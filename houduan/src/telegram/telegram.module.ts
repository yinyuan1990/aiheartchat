import { Module } from '@nestjs/common';
import { TelegramClientService } from './telegram.service';

@Module({
  providers: [TelegramClientService],
  exports: [TelegramClientService],
})
export class TelegramModule {}
