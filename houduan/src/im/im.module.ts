import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { ConnectionRegistry } from './connection.registry';
import { GroupService } from './group.service';
import { ImController } from './im.controller';
import { ImGateway } from './im.gateway';
import { ImService } from './im.service';
import { VoiceRoomService } from './voiceroom.service';
import { ChannelService } from './channel.service';
import { StickerModule } from '../sticker/sticker.module';

@Module({
  imports: [AuthModule, WalletModule, StickerModule],
  controllers: [ImController],
  providers: [ConnectionRegistry, ImService, GroupService, ImGateway, VoiceRoomService, ChannelService],
  exports: [ConnectionRegistry, ImService, ChannelService],
})
export class ImModule {}
