import { Module } from '@nestjs/common';
import { ModuleController } from './module.controller';
import { AuthModule } from '../auth/auth.module';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { HallTabsService } from './hall-tabs.service';

@Module({
  imports: [AuthModule],
  controllers: [ModuleController, AppVersionController],
  providers: [AppVersionService, HallTabsService],
  exports: [AppVersionService, HallTabsService],
})
export class ModuleConfigModule {}
