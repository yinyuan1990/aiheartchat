import { Global, Module } from '@nestjs/common';
import { SrsService } from './srs.service';

/** SRS 节点调度（通话 / 语音房 / 后台管理共用） */
@Global()
@Module({
  providers: [SrsService],
  exports: [SrsService],
})
export class SrsModule {}
