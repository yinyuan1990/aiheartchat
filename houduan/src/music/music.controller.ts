import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Throttle } from '../common/rate-limit.guard';
import { MusicService } from './music.service';

@Controller('music')
@UseGuards(JwtAuthGuard)
export class MusicController {
  constructor(private readonly music: MusicService) {}

  /** 曲目列表（最新在前，beforeId 翻页）+ 来源标题 */
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

/** 公开：分享落地页（app.yyheart.com/#/music/share/:id）不用登录取一首的信息 */
@Controller('app/music')
export class MusicPublicController {
  constructor(private readonly music: MusicService) {}

  @Get(':id')
  @Throttle(60, 60)
  track(@Param('id') id: string) {
    return this.music.publicTrack(BigInt(id));
  }
}
