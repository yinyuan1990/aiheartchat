import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { NewsModule } from '../news/news.module';
import { TreeholeModule } from '../treehole/treehole.module';
import { ModuleConfigModule } from '../module/module.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MusicModule } from '../music/music.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [AuthModule, WalletModule, NewsModule, TreeholeModule, ModuleConfigModule, TelegramModule, MusicModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
