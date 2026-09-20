import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { StickerService } from './sticker.service';

/** 表情包（用户端）：目录一次拿全（按 version 缓存）+ 我加进面板的集合（表情商店） */
@Controller('stickers')
@UseGuards(JwtAuthGuard)
export class StickerController {
  constructor(private readonly stickers: StickerService) {}

  /** 全部启用的集合 {version, notModified, sets:[{id,title,kind,thumb,items:[{id,format,url,thumb,w,h,emoji}]}]}；带 ver 且未变化时 notModified=true、sets 空 */
  @Get()
  catalog(@Query('ver') ver?: string) {
    return this.stickers.catalog(ver ? Number(ver) || 0 : undefined);
  }

  /** 我面板里的集合 id（按我的顺序）；首次会写入后台标的默认包 */
  @Get('mine')
  async mine(@CurrentUser() userId: bigint) {
    return { ids: await this.stickers.mine(userId) };
  }

  /** 整体排序 {ids} */
  @Put('mine')
  reorder(@CurrentUser() userId: bigint, @Body() body: { ids: number[] }) {
    return this.stickers.reorderMine(userId, body?.ids ?? []);
  }

  @Post('mine/:setId')
  add(@CurrentUser() userId: bigint, @Param('setId') setId: string) {
    return this.stickers.addMine(userId, Number(setId));
  }

  @Delete('mine/:setId')
  remove(@CurrentUser() userId: bigint, @Param('setId') setId: string) {
    return this.stickers.removeMine(userId, Number(setId));
  }
}
