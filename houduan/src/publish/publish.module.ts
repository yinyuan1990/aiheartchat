import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { PublishAgentController, PublishAgentGuard } from './publish-agent.controller';
import { PublishMediaService } from './publish-media.service';
import { PublishService } from './publish.service';

/** 内容分发（推广）：树洞新帖 → AI 改写 → 各平台；后台接口挂在 AdminController，发布机接口在 PublishAgentController */
@Module({
  imports: [UploadModule],
  controllers: [PublishAgentController],
  providers: [PublishService, PublishMediaService, PublishAgentGuard],
  exports: [PublishService],
})
export class PublishModule {}
