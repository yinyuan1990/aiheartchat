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
}
