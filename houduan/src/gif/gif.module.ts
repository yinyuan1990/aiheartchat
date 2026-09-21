import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TelegramModule } from '../telegram/telegram.module';
import { GifController } from './gif.controller';
import { GifService } from './gif.service';

@Module({
  imports: [AuthModule, UploadModule, TelegramModule],
  controllers: [GifController],
  providers: [GifService],
  exports: [GifService],
})
export class GifModule {}
