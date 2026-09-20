import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StickerService } from './sticker.service';

/** 表情包（用户端）：一次拿全部启用的集合与贴纸，客户端按 version 缓存 */
@Controller('stickers')
@UseGuards(JwtAuthGuard)
export class StickerController {
  constructor(private readonly stickers: StickerService) {}

  /** {version, notModified, sets:[{id,title,kind,thumb,items:[{id,format,url,thumb,w,h,emoji}]}]}；带 ver 且未变化时 notModified=true、sets 空 */
  @Get()
  catalog(@Query('ver') ver?: string) {
    return this.stickers.catalog(ver ? Number(ver) || 0 : undefined);
  }
}
