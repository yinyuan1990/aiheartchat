import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TelegramModule } from '../telegram/telegram.module';
import { StickerController } from './sticker.controller';
import { StickerService } from './sticker.service';

@Module({
  imports: [AuthModule, UploadModule, TelegramModule],
  controllers: [StickerController],
  providers: [StickerService],
  exports: [StickerService],
})
export class StickerModule {}
