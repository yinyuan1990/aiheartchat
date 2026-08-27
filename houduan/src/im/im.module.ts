import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { ConnectionRegistry } from './connection.registry';
import { GroupService } from './group.service';
import { ImController } from './im.controller';
import { ImGateway } from './im.gateway';
import { ImService } from './im.service';
import { VoiceRoomService } from './voiceroom.service';

@Module({
  imports: [AuthModule, WalletModule],
  controllers: [ImController],
  providers: [ConnectionRegistry, ImService, GroupService, ImGateway, VoiceRoomService],
  exports: [ConnectionRegistry, ImService],
})
export class ImModule {}
