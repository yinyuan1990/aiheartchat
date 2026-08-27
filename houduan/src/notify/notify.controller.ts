import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { NotifyService } from './notify.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotifyController {
  constructor(private readonly notify: NotifyService) {}

  /** kind: comment | task，拉取即标记已读 */
  @Get()
  list(@CurrentUser() userId: bigint, @Query('kind') kind = 'comment', @Query('beforeId') beforeId?: string) {
    return this.notify.list(userId, kind, beforeId ? BigInt(beforeId) : undefined);
  }

  @Get('unread')
  unread(@CurrentUser() userId: bigint) {
    return this.notify.unreadCounts(userId);
  }
}
