import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MusicController, MusicPublicController } from './music.controller';
import { MusicService } from './music.service';

@Module({
  imports: [AuthModule, UploadModule, TelegramModule],
  controllers: [MusicController, MusicPublicController],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
