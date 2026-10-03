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
import { BotService } from './bot.service';
import { MessageService } from './message.service';
import { ChainCardService } from './chain-card.service';
import { BotApiController } from './bot-api.controller';
import { StickerModule } from '../sticker/sticker.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuthModule, WalletModule, StickerModule, UploadModule],
  controllers: [ImController, BotApiController],
  providers: [ConnectionRegistry, ImService, GroupService, ImGateway, VoiceRoomService, ChannelService, BotService, MessageService, ChainCardService],
  exports: [ConnectionRegistry, ImService, ChannelService, BotService, MessageService],
})
export class ImModule {}
