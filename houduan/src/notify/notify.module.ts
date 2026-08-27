import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';

@Module({
  imports: [AuthModule, ImModule],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}
