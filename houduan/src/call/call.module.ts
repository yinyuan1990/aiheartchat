import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { WalletModule } from '../wallet/wallet.module';
import { CallController } from './call.controller';
import { CallService } from './call.service';

@Module({
  imports: [AuthModule, ImModule, WalletModule],
  controllers: [CallController],
  providers: [CallService],
})
export class CallModule {}
