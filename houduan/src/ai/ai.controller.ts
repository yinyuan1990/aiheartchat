import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { AiService } from './ai.service';

class AiChatDto {
  @IsString()
  @MaxLength(2000)
  content!: string;
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('messages')
  messages(@CurrentUser() userId: bigint) {
    return this.ai.messages(userId);
  }

  @Post('chat')
  chat(@CurrentUser() userId: bigint, @Body() dto: AiChatDto) {
    return this.ai.chat(userId, dto.content);
  }

  @Post('clear')
  clear(@CurrentUser() userId: bigint) {
    return this.ai.clear(userId);
  }
}
