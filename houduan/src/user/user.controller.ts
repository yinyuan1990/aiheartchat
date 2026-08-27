import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { UserService } from './user.service';
import { UpdateAlbumsDto, UpdateProfileDto } from './user.dto';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('me')
  me(@CurrentUser() userId: bigint) {
    return this.users.getMe(userId);
  }

  @Put('me')
  update(@CurrentUser() userId: bigint, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  /** 照片墙整组保存（最多 8 张，按数组顺序排序） */
  @Put('albums')
  updateAlbums(@CurrentUser() userId: bigint, @Body() dto: UpdateAlbumsDto) {
    return this.users.updateAlbums(userId, dto.photos);
  }

  /** 实名认证（仅女生，免费本地核验） */
  @Post('realname')
  realname(@CurrentUser() userId: bigint, @Body() body: { name: string; idCard: string }) {
    return this.users.verifyRealname(userId, body.name, body.idCard);
  }

  /** GPS 位置上报（客户端每分钟一次），用于距离展示 */
  @Post('location')
  reportLocation(@CurrentUser() userId: bigint, @Body() body: { latitude?: number; longitude?: number }) {
    return this.users.reportLocation(userId, body.latitude, body.longitude);
  }

  /** 关注/取消关注（toggle） */
  @Post(':id/follow')
  follow(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.users.toggleFollow(userId, BigInt(id));
  }

  /** 关注/粉丝列表 type=following|fans */
  @Get('follows/list')
  follows(@CurrentUser() userId: bigint, @Query('type') type = 'following') {
    return this.users.listFollows(userId, type === 'fans' ? 'fans' : 'following');
  }

  /** 遇见列表 tab=all|new|city|intimacy（city 可带 ?city=城市名） */
  @Get('meet/list')
  meet(@CurrentUser() userId: bigint, @Query('tab') tab = 'all', @Query('city') city?: string) {
    return this.users.meetList(userId, tab, city);
  }

  /** 查看他人主页（服务端强制性别隔离：仅可见异性） */
  @Get(':id')
  profile(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.users.getProfile(userId, BigInt(id));
  }
}
