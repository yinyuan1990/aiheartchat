import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { NotifyModule } from '../notify/notify.module';
import { WalletModule } from '../wallet/wallet.module';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';

@Module({
  imports: [AuthModule, ImModule, NotifyModule, WalletModule],
  controllers: [TaskController],
  providers: [TaskService],
})
export class TaskModule {}
