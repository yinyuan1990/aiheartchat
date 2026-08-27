import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { WalletModule } from '../wallet/wallet.module';
import { GiftController } from './gift.controller';
import { GiftService } from './gift.service';

@Module({
  imports: [AuthModule, ImModule, WalletModule],
  controllers: [GiftController],
  providers: [GiftService],
})
export class GiftModule {}
