import { Controller, Get, Header, Query } from '@nestjs/common';
import data from './emoji-data.json';

/**
 * 三端共用的 Unicode emoji 分类数据（Telegram 式 8 组，含中英文关键词供搜索）。
 * 由 emojibase-data 生成（脚本见接力文档），静态、无需登录；客户端按 version 缓存。
 * 结构：{version, groups:[{key,name,icon,items:[[emoji,label,keywords]]}]}
 */
@Controller('emojis')
export class EmojiController {
  @Get()
  @Header('Cache-Control', 'public, max-age=86400')
  all(@Query('ver') ver?: string) {
    if (ver && Number(ver) === data.version) return { version: data.version, notModified: true, groups: [] };
    return { version: data.version, notModified: false, groups: data.groups };
  }
}
