import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isIP } from 'node:net';

/**
 * IP → 国家 / 地区：用 APNIC 公开的地址分配表（亚太地区，每天更新），只用来给官网选默认语言。
 * 不在表里的公网 IP 属于亚太以外的地区；表还没下载好时返回 null，由前端退回浏览器语言。
 */
const SOURCE = process.env.GEO_SOURCE ?? 'https://ftp.apnic.net/stats/apnic/delegated-apnic-latest';
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
/** 这些地区默认中文，其他默认英文 */
const ZH = new Set(['CN', 'HK', 'MO', 'TW']);

type Ranges = { start: bigint[]; end: bigint[]; cc: string[] };

function v4(ip: string): bigint {
  return ip.split('.').reduce((n, p) => (n << 8n) + BigInt(Number(p)), 0n);
}
function v6(ip: string): bigint {
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  if (b.length && b[b.length - 1].includes('.')) {
    const x = v4(b.pop()!);
    b.push((x >> 16n).toString(16), (x & 0xffffn).toString(16));
  }
  if (a.length && a[a.length - 1].includes('.')) {
    const x = v4(a.pop()!);
    a.push((x >> 16n).toString(16), (x & 0xffffn).toString(16));
  }
  const parts = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return parts.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}
function sortRanges(rows: [bigint, bigint, string][]): Ranges {
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { start: rows.map((r) => r[0]), end: rows.map((r) => r[1]), cc: rows.map((r) => r[2]) };
}
function find(r: Ranges, n: bigint): string | null {
  let lo = 0;
  let hi = r.start.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r.start[mid] <= n) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && n <= r.end[hi] ? r.cc[hi] : null;
}
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
  return /^(::1?$|f[cd]|fe[89ab])/i.test(ip);
}

@Injectable()
export class GeoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Geo');
  private ipv4: Ranges | null = null;
  private ipv6: Ranges | null = null;
  private timer: NodeJS.Timeout | null = null;

  onModuleInit() {
    void this.refresh();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async refresh() {
    let next = REFRESH_MS;
    try {
      const r = await fetch(SOURCE, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v4rows: [bigint, bigint, string][] = [];
      const v6rows: [bigint, bigint, string][] = [];
      for (const line of (await r.text()).split('\n')) {
        // apnic|CN|ipv4|1.0.1.0|256|20110414|allocated   ipv6 的第 5 列是前缀长度
        const f = line.split('|');
        if (f.length < 7 || f[1].length !== 2 || f[1] === '*' || (f[6] !== 'allocated' && f[6] !== 'assigned')) continue;
        if (f[2] === 'ipv4') {
          const s = v4(f[3]);
          v4rows.push([s, s + BigInt(f[4]) - 1n, f[1]]);
        } else if (f[2] === 'ipv6') {
          const s = v6(f[3]);
          v6rows.push([s, s + (1n << BigInt(128 - Number(f[4]))) - 1n, f[1]]);
        }
      }
      if (v4rows.length < 1000) throw new Error(`only ${v4rows.length} ipv4 rows`);
      this.ipv4 = sortRanges(v4rows);
      this.ipv6 = sortRanges(v6rows);
      this.log.log(`APNIC ranges loaded: ipv4 ${v4rows.length}, ipv6 ${v6rows.length}`);
    } catch (e) {
      next = this.ipv4 ? REFRESH_MS : RETRY_MS;
      this.log.warn(`APNIC ranges load failed: ${(e as Error).message}`);
    }
    this.timer = setTimeout(() => void this.refresh(), next);
    this.timer.unref?.();
  }

  /** country：APNIC 里的地区代码，亚太以外为 null；lang：建议语言，查不了时为 null */
  lookup(rawIp: string): { country: string | null; lang: 'zh' | 'en' | null } {
    const ip = rawIp.replace(/^::ffff:(?=\d+\.)/i, '').trim();
    const kind = isIP(ip);
    if (!kind || isPrivate(ip) || !this.ipv4) return { country: null, lang: null };
    const country = kind === 4 ? find(this.ipv4, v4(ip)) : this.ipv6 ? find(this.ipv6, v6(ip)) : null;
    return { country, lang: country && ZH.has(country) ? 'zh' : 'en' };
  }
}
