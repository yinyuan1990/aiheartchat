import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { NotifyModule } from '../notify/notify.module';
import { MomentController } from './moment.controller';
import { MomentService } from './moment.service';

@Module({
  imports: [AuthModule, NotifyModule, ImModule],
  controllers: [MomentController],
  providers: [MomentService],
})
export class MomentModule {}
