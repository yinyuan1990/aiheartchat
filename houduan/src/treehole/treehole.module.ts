import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TreeholeController } from './treehole.controller';
import { TreeholeService } from './treehole.service';

@Module({
  imports: [AuthModule],
  controllers: [TreeholeController],
  providers: [TreeholeService],
  exports: [TreeholeService],
})
export class TreeholeModule {}
