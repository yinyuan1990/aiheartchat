import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MusicService } from './music.service';

@Controller('music')
@UseGuards(JwtAuthGuard)
export class MusicController {
  constructor(private readonly music: MusicService) {}

  /** 曲目列表（最近 3 天，最新在前，beforeId 翻页）+ 来源标题 */
  @Get()
  list(@Query('beforeId') beforeId?: string) {
    return this.music.list(beforeId ? BigInt(beforeId) : undefined);
  }

  /** 播放计数 */
  @Post(':id/play')
  played(@Param('id') id: string) {
    return this.music.played(BigInt(id));
  }
}
