import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { GuideService } from './guide.service';

class GuideApplyDto {
  @IsString()
  @Length(2, 30)
  realName!: string;

  @IsString()
  @Length(6, 30)
  idCardNo!: string;

  @IsString()
  @Length(1, 500)
  intro!: string;
}

@Controller('guide')
@UseGuards(JwtAuthGuard)
export class GuideController {
  constructor(private readonly guides: GuideService) {}

  @Post('apply')
  apply(@CurrentUser() userId: bigint, @Body() dto: GuideApplyDto) {
    return this.guides.apply(userId, dto);
  }

  @Get('apply/mine')
  myApply(@CurrentUser() userId: bigint) {
    return this.guides.myApply(userId);
  }

  @Get('list')
  list(@CurrentUser() userId: bigint, @Query('cityCode') cityCode?: string, @Query('beforeId') beforeId?: string) {
    return this.guides.list(userId, cityCode || undefined, beforeId ? BigInt(beforeId) : undefined);
  }

  /** 找人（发现异性用户，可打招呼开聊） */
  @Get('discover')
  discover(@CurrentUser() userId: bigint, @Query('cityCode') cityCode?: string, @Query('beforeId') beforeId?: string) {
    return this.guides.discover(userId, cityCode || undefined, beforeId ? BigInt(beforeId) : undefined);
  }
}
