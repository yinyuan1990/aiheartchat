import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { MomentService } from './moment.service';
import { CommentDto, PublishMomentDto } from './moment.dto';

@Controller('moments')
@UseGuards(JwtAuthGuard)
export class MomentController {
  constructor(private readonly moments: MomentService) {}

  @Post()
  publish(@CurrentUser() userId: bigint, @Body() dto: PublishMomentDto) {
    return this.moments.publish(userId, dto);
  }

  /** 广场流；onlyVideo=1 抖音模式；follow=1 关注流；online=1 仅在线 */
  @Get('feed')
  feed(
    @CurrentUser() userId: bigint,
    @Query('cityCode') cityCode?: string,
    @Query('beforeId') beforeId?: string,
    @Query('onlyVideo') onlyVideo?: string,
    @Query('follow') follow?: string,
    @Query('online') online?: string,
  ) {
    return this.moments.feed(userId, {
      cityCode: cityCode || undefined,
      beforeId: beforeId ? BigInt(beforeId) : undefined,
      onlyVideo: onlyVideo === '1',
      onlyFollowed: follow === '1',
      onlyOnline: online === '1',
    });
  }

  @Get('mine')
  mine(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.moments.mine(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  /** 他人主页动态列表 */
  @Get('user/:id')
  byUser(@CurrentUser() userId: bigint, @Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.moments.byUser(userId, BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  @Get(':id')
  detail(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.moments.detail(userId, BigInt(id));
  }

  /** 删除自己的动态（软删除） */
  @Delete(':id')
  remove(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.moments.remove(userId, BigInt(id));
  }

  @Post(':id/like')
  like(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.moments.toggleLike(userId, BigInt(id));
  }

  @Get(':id/comments')
  comments(@Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.moments.comments(BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  @Post(':id/comments')
  comment(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: CommentDto) {
    return this.moments.addComment(userId, BigInt(id), dto);
  }
}
