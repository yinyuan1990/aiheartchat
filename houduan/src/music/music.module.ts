import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MusicController } from './music.controller';
import { MusicService } from './music.service';

@Module({
  imports: [AuthModule, UploadModule, TelegramModule],
  controllers: [MusicController],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
