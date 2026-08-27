import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { NewsService } from './news.service';

@Controller('news')
@UseGuards(JwtAuthGuard)
export class NewsController {
  constructor(private readonly news: NewsService) {}

  @Get()
  list(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.news.list(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  /** 每日一句励志（注意声明在 :id 之前，避免被通配吃掉） */
  @Get('quote')
  quote(@CurrentUser() userId: bigint) {
    return this.news.quoteToday(userId);
  }

  /** 励志行：历史每日一句列表（beforeId 翻页） */
  @Get('quotes')
  quotes(@CurrentUser() userId: bigint, @Query('beforeId') beforeId?: string) {
    return this.news.quotes(userId, beforeId ? BigInt(beforeId) : undefined);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.news.detail(BigInt(id));
  }
}
