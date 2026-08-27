import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { TaskService } from './task.service';

class PublishTaskDto {
  @IsString()
  @Length(1, 60)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  detail?: string;

  @IsString()
  meetAt!: string;

  @IsString()
  cityCode!: string;

  @IsString()
  @Length(1, 30)
  cityName!: string;

  @IsString()
  @Length(1, 200)
  address!: string;

  @IsString()
  @Matches(/^[1-9]\d*$/, { message: '报酬必须为正整数积分' })
  reward!: string;
}

class ApplyDto {
  @IsOptional()
  @IsString()
  @Length(0, 200)
  message?: string;
}

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Post()
  publish(@CurrentUser() userId: bigint, @Body() dto: PublishTaskDto) {
    return this.tasks.publish(userId, dto);
  }

  @Get('hall')
  hall(@CurrentUser() userId: bigint, @Query('cityCode') cityCode?: string, @Query('beforeId') beforeId?: string) {
    return this.tasks.hall(userId, cityCode || undefined, beforeId ? BigInt(beforeId) : undefined);
  }

  @Get('mine')
  mine(@CurrentUser() userId: bigint) {
    return this.tasks.mine(userId);
  }

  @Get('taken')
  taken(@CurrentUser() userId: bigint) {
    return this.tasks.taken(userId);
  }

  @Get(':id')
  detail(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.tasks.detail(userId, BigInt(id));
  }

  @Post(':id/apply')
  apply(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: ApplyDto) {
    return this.tasks.apply(userId, BigInt(id), dto.message ?? '');
  }

  @Post(':id/choose/:applyId')
  choose(@CurrentUser() userId: bigint, @Param('id') id: string, @Param('applyId') applyId: string) {
    return this.tasks.choose(userId, BigInt(id), BigInt(applyId));
  }

  @Post(':id/finish')
  finish(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.tasks.finish(userId, BigInt(id));
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.tasks.cancel(userId, BigInt(id));
  }
}
