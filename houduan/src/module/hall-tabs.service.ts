import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 大厅固定的几个 tab（内容都在 H5 里写死，后台只调顺序） */
export const HALL_TAB_KEYS = ['guide', 'games', 'gallery', 'treehole'] as const;
export type HallTabKey = (typeof HALL_TAB_KEYS)[number];
const KEY = 'hall_tabs';

/** 大厅 tab 顺序：sys_setting.hall_tabs 存 JSON 数组；没配就是默认顺序，漏掉的 key 排到最后 */
@Injectable()
export class HallTabsService {
  constructor(private readonly prisma: PrismaService) {}

  async order(): Promise<HallTabKey[]> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: KEY } });
    return normalize(safeParse(row?.value));
  }

  async save(order: unknown): Promise<HallTabKey[]> {
    const next = normalize(Array.isArray(order) ? order : []);
    await this.prisma.sysSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
    return next;
  }
}

function safeParse(v: string | undefined): unknown[] {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function normalize(list: unknown[]): HallTabKey[] {
  const seen = new Set<string>();
  const out: HallTabKey[] = [];
  for (const k of list) {
    if (typeof k === 'string' && (HALL_TAB_KEYS as readonly string[]).includes(k) && !seen.has(k)) { seen.add(k); out.push(k as HallTabKey); }
  }
  for (const k of HALL_TAB_KEYS) if (!seen.has(k)) out.push(k);
  return out;
}
