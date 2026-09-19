import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { TreeholeController } from './treehole.controller';
import { TreeholeService } from './treehole.service';
import { TreeholeSyncService } from './treehole-sync.service';

@Module({
  imports: [AuthModule, UploadModule],
  controllers: [TreeholeController],
  providers: [TreeholeService, TreeholeSyncService],
  exports: [TreeholeService, TreeholeSyncService],
})
export class TreeholeModule {}
