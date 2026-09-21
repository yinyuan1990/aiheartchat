import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TelegramModule } from '../telegram/telegram.module';
import { GalleryController, GalleryPublicController } from './gallery.controller';
import { GalleryService } from './gallery.service';

@Module({
  imports: [AuthModule, UploadModule, TelegramModule],
  controllers: [GalleryController, GalleryPublicController],
  providers: [GalleryService],
  exports: [GalleryService],
})
export class GalleryModule {}
