import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { NewsModule } from '../news/news.module';
import { TreeholeModule } from '../treehole/treehole.module';
import { ModuleConfigModule } from '../module/module.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MusicModule } from '../music/music.module';
import { GalleryModule } from '../gallery/gallery.module';
import { StickerModule } from '../sticker/sticker.module';
import { GifModule } from '../gif/gif.module';
import { TgForwardModule } from '../tgforward/tg-forward.module';
import { PublishModule } from '../publish/publish.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [AuthModule, WalletModule, NewsModule, TreeholeModule, ModuleConfigModule, TelegramModule, MusicModule, GalleryModule, StickerModule, GifModule, TgForwardModule, PublishModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
