import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { GalleryService } from './gallery.service';

/** 「养眼图片」（大厅 tab）：按登录用户性别分流 */
@Controller('gallery')
@UseGuards(JwtAuthGuard)
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  /** tab 名称 / 保留天数（大厅渲染 tab 标签用，声明在 @Get() 之前无所谓，路径不同） */
  @Get('settings')
  settings(@CurrentUser() userId: bigint) {
    return this.gallery.userSettings(userId);
  }

  /** {title, days, source, list:[{id,text,media[],viewCount,postedAt}]}，beforeId 翻页，每页 20 */
  @Get()
  list(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.gallery.list(userId, beforeId ? BigInt(beforeId) : undefined);
  }
}

/** 公开：分享落地页（app.yyheart.com/#/gallery/share/:id）不用登录取一条 */
@Controller('app/gallery')
export class GalleryPublicController {
  constructor(private readonly gallery: GalleryService) {}

  @Get(':id')
  @Throttle(60, 60)
  post(@Param('id') id: string) {
    return this.gallery.publicPost(BigInt(id));
  }
}
