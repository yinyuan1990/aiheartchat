import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { UploadModule } from '../upload/upload.module';
import { PublishAgentController, PublishAgentGuard } from './publish-agent.controller';
import { PublishMediaService } from './publish-media.service';
import { PublishService } from './publish.service';
import { XPicsService } from './x-pics.service';

/** 内容分发（推广）：树洞新帖 → AI 改写 → 各平台；X 美女图（TG 频道 → X 纯图）；后台接口挂在 AdminController，发布机接口在 PublishAgentController */
@Module({
  imports: [UploadModule, TelegramModule],
  controllers: [PublishAgentController],
  providers: [PublishService, PublishMediaService, XPicsService, PublishAgentGuard],
  exports: [PublishService, XPicsService],
})
export class PublishModule {}
