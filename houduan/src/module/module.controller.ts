import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

/** 大厅页模块入口，后台配置、按性别可见性下发（游戏等新模块由此接入） */
@Controller('modules')
@UseGuards(JwtAuthGuard)
export class ModuleController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return this.prisma.appModule.findMany({
      where: {
        enabled: true,
        OR: [{ visibleGender: 0 }, { visibleGender: user?.gender ?? 0 }],
      },
      orderBy: { sort: 'asc' },
    });
  }

  /**
   * 大厅 H5 地址：App 端大厅 tab 用 WebView 加载此页，业务模块网页端热更、无需发版。
   * env HALL_H5_URL 可覆盖；返回空串时客户端回退默认 {BASE_URL}/site/#/hall-embed。
   */
  @Get('hall')
  hall() {
    return { url: process.env.HALL_H5_URL ?? '' };
  }
}
