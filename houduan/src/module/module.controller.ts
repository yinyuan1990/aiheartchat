import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { langOf } from '../i18n/translate';
import { PrismaService } from '../prisma/prisma.service';
import { HallTabsService } from './hall-tabs.service';

/**
 * 大厅页模块入口，后台配置、按性别可见性下发。
 * type=native/h5 为横幅项目卡；type=game 为小游戏（图标 icon + 链接 entry + 说明 desc），大厅按宫格展示。
 */
@Controller('modules')
@UseGuards(JwtAuthGuard)
export class ModuleController {
  constructor(private readonly prisma: PrismaService, private readonly hallTabs: HallTabsService) {}

  /** 大厅 tab 顺序（后台可调）：{order:['guide','games','gallery','treehole']} */
  @Get('hall-tabs')
  async hallTabOrder() {
    return { order: await this.hallTabs.order() };
  }

  /** 非中文请求：后台填了英文名 / 简介就换成英文（没填的照旧中文，种子项目再由 DATA_EN 兜底） */
  @Get()
  async list(@CurrentUser() userId: bigint, @Headers('accept-language') acceptLang?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const rows = await this.prisma.appModule.findMany({
      where: {
        enabled: true,
        OR: [{ visibleGender: 0 }, { visibleGender: user?.gender ?? 0 }],
      },
      orderBy: { sort: 'asc' },
    });
    if (!langOf(acceptLang)) return rows;
    return rows.map((m) => ({ ...m, name: m.nameEn || m.name, desc: m.descEn || m.desc }));
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
