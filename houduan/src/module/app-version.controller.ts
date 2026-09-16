import { Controller, Get, Query } from '@nestjs/common';
import { AppVersionService } from './app-version.service';

/**
 * App 版本检查（无需登录：启动时用户可能还没注册）。
 * GET /app/version?platform=ios&version=1.0 → { hasUpdate, force, latest, url, channel, notes }
 * GET /app/download → 官网下载区两个平台的最新地址
 */
@Controller('app')
export class AppVersionController {
  constructor(private readonly svc: AppVersionService) {}

  @Get('version')
  check(@Query('platform') platform = 'android', @Query('version') version = '0') {
    return this.svc.check(platform, version);
  }

  @Get('download')
  download() {
    return this.svc.publicInfo();
  }
}
