import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { GiftService } from './gift.service';

class SendGiftDto {
  @IsString()
  toUserId!: string;

  @IsInt()
  giftId!: number;
}

@Controller('gifts')
@UseGuards(JwtAuthGuard)
export class GiftController {
  constructor(private readonly gifts: GiftService) {}

  @Get()
  list() {
    return this.gifts.list();
  }

  @Post('send')
  send(@CurrentUser() userId: bigint, @Body() dto: SendGiftDto) {
    return this.gifts.send(userId, BigInt(dto.toUserId), dto.giftId);
  }

  @Get('received')
  received(@CurrentUser() userId: bigint) {
    return this.gifts.received(userId);
  }
}
