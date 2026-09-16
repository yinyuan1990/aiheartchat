import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Platform = 'android' | 'ios';

const DEFAULTS: Record<Platform, { latest: string; url: string; channel: string }> = {
  android: { latest: '1.0', url: 'https://yyheart.com/app/peiwan.apk', channel: 'apk' },
  ios: { latest: '1.0', url: '', channel: 'testflight' },
};

/** "1.2.10" vs "1.3" → 负数/0/正数（按段比较，缺位补 0，非数字段按 0） */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((s) => parseInt(s, 10) || 0);
  const pb = b.split(/[.\-+]/).map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

@Injectable()
export class AppVersionService {
  constructor(private readonly prisma: PrismaService) {}

  private norm(p: string): Platform {
    return p?.toLowerCase() === 'ios' ? 'ios' : 'android';
  }

  async get(platform: string) {
    const p = this.norm(platform);
    const row = await this.prisma.appVersion.findUnique({ where: { platform: p } });
    return row ?? { platform: p, ...DEFAULTS[p], minVersion: '', force: false, notes: '', updatedAt: null };
  }

  /** 客户端启动检查 */
  async check(platform: string, current: string) {
    const cfg = await this.get(platform);
    const cur = (current ?? '').trim() || '0';
    const hasUpdate = !!cfg.latest && compareVersion(cur, cfg.latest) < 0;
    const belowMin = !!cfg.minVersion && compareVersion(cur, cfg.minVersion) < 0;
    const force = hasUpdate && (cfg.force || belowMin);
    return {
      platform: cfg.platform,
      current: cur,
      latest: cfg.latest,
      hasUpdate,
      force,
      url: cfg.url,
      channel: cfg.channel,
      notes: cfg.notes,
    };
  }

  /** 官网下载区用：两个平台的当前发布信息（无鉴权） */
  async publicInfo() {
    const [android, ios] = await Promise.all([this.get('android'), this.get('ios')]);
    const pick = (c: Awaited<ReturnType<AppVersionService['get']>>) => ({ latest: c.latest, url: c.url, channel: c.channel, notes: c.notes });
    return { android: pick(android), ios: pick(ios) };
  }

  async adminList() {
    return Promise.all([this.get('android'), this.get('ios')]);
  }

  async adminSave(platform: string, data: { latest?: string; minVersion?: string; force?: boolean; url?: string; channel?: string; notes?: string }) {
    const p = this.norm(platform);
    const clean = {
      latest: (data.latest ?? '').trim().slice(0, 20),
      minVersion: (data.minVersion ?? '').trim().slice(0, 20),
      force: !!data.force,
      url: (data.url ?? '').trim().slice(0, 500),
      channel: (data.channel ?? (p === 'ios' ? 'testflight' : 'apk')).trim().slice(0, 20),
      notes: (data.notes ?? '').trim().slice(0, 1000),
    };
    if (!clean.latest) clean.latest = DEFAULTS[p].latest;
    return this.prisma.appVersion.upsert({
      where: { platform: p },
      update: clean,
      create: { platform: p, ...clean },
    });
  }
}
