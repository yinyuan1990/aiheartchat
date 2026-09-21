import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GifService } from './gif.service';

/** GIF（用户端）：热门 / 搜索，结果为 StickerPayload 同形（format=mp4） */
@Controller('gifs')
@UseGuards(JwtAuthGuard)
export class GifController {
  constructor(private readonly gifs: GifService) {}

  /** q 空 = 热门；offset 传上一页 next。返回 {items, next} */
  @Get()
  search(@Query('q') q?: string, @Query('offset') offset?: string) {
    return this.gifs.search(q ?? '', offset ?? '');
  }
}
