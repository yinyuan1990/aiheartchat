import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { TreeholeService } from './treehole.service';

/** 私密树洞（大厅 tab）：匿名投稿列表 / 详情 / 发布 / 评论 */
@Controller('treehole')
@UseGuards(JwtAuthGuard)
export class TreeholeController {
  constructor(private readonly treehole: TreeholeService) {}

  @Get()
  list(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.treehole.list(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  @Get('mine')
  mine(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.treehole.mine(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  /** 玩家匿名投稿；按 IP 限频防刷（10 分钟 5 条） */
  @Post()
  @Throttle(5, 600)
  publish(@CurrentUser() userId: bigint, @Body() body: { content: string }) {
    return this.treehole.publish(userId, body?.content ?? '');
  }

  @Get(':id')
  detail(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.treehole.detail(userId, BigInt(id));
  }

  @Delete(':id')
  remove(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.treehole.remove(userId, BigInt(id));
  }

  @Get(':id/comments')
  comments(@Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.treehole.comments(BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  @Post(':id/comments')
  @Throttle(30, 600)
  comment(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() body: { content: string; replyToId?: string }) {
    return this.treehole.addComment(userId, BigInt(id), body?.content ?? '', body?.replyToId);
  }
}
