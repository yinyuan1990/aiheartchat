import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';

@Module({
  imports: [AuthModule, ImModule],
  controllers: [InviteController],
  providers: [InviteService],
})
export class InviteModule {}
