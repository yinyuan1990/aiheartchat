import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { GalleryService } from './gallery.service';

/** 「养眼图片」（大厅 tab）：按登录用户性别分流 */
@Controller('gallery')
@UseGuards(JwtAuthGuard)
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  /** tab 名称 / 保留天数（大厅渲染 tab 标签用，声明在 @Get() 之前无所谓，路径不同） */
  @Get('settings')
  settings() {
    return this.gallery.settings();
  }

  /** {title, days, source, list:[{id,text,media[],viewCount,postedAt}]}，beforeId 翻页，每页 20 */
  @Get()
  list(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.gallery.list(userId, beforeId ? BigInt(beforeId) : undefined);
  }
}
