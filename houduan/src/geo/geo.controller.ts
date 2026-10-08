import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GeoService } from './geo.service';

@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** 官网按访客 IP 选默认语言：{ country, lang }，查不了时都是 null */
  @Get()
  lookup(@Req() req: Request) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const ip = (req.headers['x-real-ip'] as string) || fwd || req.socket?.remoteAddress || '';
    return this.geo.lookup(ip);
  }
}
