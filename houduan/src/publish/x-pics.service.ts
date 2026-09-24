import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Api } from 'telegram';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClientService } from '../telegram/telegram.service';
import { UploadService } from '../upload/upload.service';
import { normalizeChannel } from '../music/music.service';
import { PublishService, bjDayStart } from './publish.service';

const DEFAULT_CHANNEL = 'GSSDJLR888';
/** X 一条帖子最多 4 张图 */
const X_MAX_IMAGES = 4;
/** 一次拉取最多下载多少张（频道一天发几百张时别把存储吃满） */
const MAX_FETCH = 150;
/** 比这小的多半是缩略图 / 表情，不要 */
const MIN_BYTES = 15 * 1024;
/** 手动「立即发一条」的任务打这个标记，不占每日次数 */
const MANUAL_TAG = 'manual';
/** 拉取失败后隔多久再自动重试 */
const RETRY_MS = 30 * 60_000;

interface XPicsSettings {
  enabled: boolean;
  channel: string;
  /** 每天发几次 */
  daily: number;
  /** 每次几张图（X 最多 4 张） */
  min: number;
  max: number;
  /** 每天几点（北京时间）拉取最近 24 小时的图 */
  fetchHour: number;
  /** 最近一次成功拉取的日期（北京时间 YYYY-MM-DD） */
  lastFetch: string;
  /** 最近一次拉取结果（给后台看） */
  lastResult: string;
}

/**
 * X 美女图（推广，只发 X，国内平台不碰）：
 * 每天 fetchHour 点用已登录的 Telegram 账号拉来源频道最近 24 小时的图片 → 存 MinIO（xpics/日期/）+ 记 x_pic 表当图片池
 * → 按「每日次数」把当天的帖子在发布时段（内容分发的时段设置）里平均排开，每条从池子里取 min~max 张（同一相册的尽量放一起）
 * → 写成 publish_job（platform=x, format=pics, 无文字），外网发布机领走后纯图发 X。
 * 后台可「立即获取」「立即发一条」（手动的不占每日次数）。
 */
@Injectable()
export class XPicsService implements OnModuleInit {
  private readonly logger = new Logger('XPics');
  private busy = false;
  private lastFailAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tg: TelegramClientService,
    private readonly upload: UploadService,
    private readonly publish: PublishService,
  ) {}

  onModuleInit() {
    setInterval(() => void this.tick(), 60_000);
  }

  // ---------- 设置 ----------

  async settings(): Promise<XPicsSettings> {
    const rows = await this.prisma.sysSetting.findMany({ where: { key: { startsWith: 'xpics_' } } });
    const get = (k: string) => rows.find((r) => r.key === `xpics_${k}`)?.value ?? '';
    const min = clamp(get('min'), 1, X_MAX_IMAGES, 2);
    return {
      enabled: get('enabled') === '1',
      channel: get('channel') || DEFAULT_CHANNEL,
      daily: clamp(get('daily'), 1, 20, 5),
      min,
      max: clamp(get('max'), min, X_MAX_IMAGES, X_MAX_IMAGES),
      fetchHour: clamp(get('fetch_hour'), 0, 23, 0),
      lastFetch: get('last_fetch'),
      lastResult: get('last_result'),
    };
  }

  private async set(key: string, value: string) {
    await this.prisma.sysSetting.upsert({ where: { key: `xpics_${key}` }, create: { key: `xpics_${key}`, value }, update: { value } });
  }

  async saveSettings(d: { enabled?: boolean; channel?: string; daily?: number; min?: number; max?: number; fetchHour?: number }) {
    const cur = await this.settings();
    if (d.channel !== undefined) {
      const ch = normalizeChannel(d.channel);
      if (!ch) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
      if (ch.toLowerCase() !== cur.channel.toLowerCase()) {
        const info = await this.tg.resolveChannel(ch);
        await this.set('channel', info.username);
        await this.set('last_fetch', '');
      }
    }
    if (d.enabled !== undefined) await this.set('enabled', d.enabled ? '1' : '0');
    if (d.daily !== undefined) await this.set('daily', String(clamp(d.daily, 1, 20, cur.daily)));
    const min = d.min !== undefined ? clamp(d.min, 1, X_MAX_IMAGES, cur.min) : cur.min;
    if (d.min !== undefined) await this.set('min', String(min));
    if (d.max !== undefined || d.min !== undefined) await this.set('max', String(clamp(d.max ?? cur.max, min, X_MAX_IMAGES, X_MAX_IMAGES)));
    if (d.fetchHour !== undefined) await this.set('fetch_hour', String(clamp(d.fetchHour, 0, 23, cur.fetchHour)));
    return this.status();
  }

  /** 后台：设置 + 池子剩余 + 今天的排期 + 池子里最新几张预览 */
  async status() {
    const s = await this.settings();
    const dayStart = bjDayStart(Date.now(), 0);
    const [pool, today, samples] = await Promise.all([
      this.prisma.xPic.count({ where: { jobId: null } }),
      this.prisma.publishJob.findMany({
        where: { platform: 'x', format: 'pics', scheduledAt: { gte: new Date(dayStart), lt: new Date(dayStart + 86_400_000) } },
        orderBy: { scheduledAt: 'asc' },
        select: { id: true, status: true, scheduledAt: true, tags: true, resultUrl: true, error: true },
      }),
      this.prisma.xPic.findMany({ where: { jobId: null }, orderBy: { postedAt: 'desc' }, take: 12, select: { url: true } }),
    ]);
    return {
      settings: s, pool, busy: this.busy,
      today: today.map((j) => ({ ...j, id: j.id.toString(), manual: j.tags === MANUAL_TAG })),
      samples: samples.map((x) => x.url),
    };
  }

  // ---------- 手动 ----------

  /** 立即拉取（后台跑，拉完顺便把今天没排满的排上） */
  async fetchNow() {
    if (this.busy) return { started: false, busy: true };
    void this.run(async () => {
      await this.fetch();
      if ((await this.settings()).enabled) await this.plan();
    });
    return { started: true, busy: true };
  }

  /** 立即发一条：从池子取图排一条马上发的任务（不占每日次数） */
  async postNow() {
    const job = await this.makeJob(new Date(), true);
    if (!job) throw new BadRequestException('图片池里的图不够一条了，先点「立即获取」');
    return { id: job.id.toString(), images: job.count };
  }

  // ---------- 定时 ----------

  private async tick() {
    if (this.busy) return;
    const s = await this.settings();
    if (!s.enabled) return;
    await this.run(async () => {
      const now = Date.now();
      const due = s.lastFetch !== bjDate(now) && bjHour(now) >= s.fetchHour;
      if (due && now - this.lastFailAt > RETRY_MS) await this.fetch();
      // 今天拉过了才排（没拉到就先用池子里剩下的，也照排）
      if ((await this.settings()).lastFetch === bjDate(now) || !due) await this.plan();
    });
  }

  private async run(fn: () => Promise<void>) {
    this.busy = true;
    try {
      await fn();
    } catch (e: any) {
      this.logger.warn(`xpics: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  /** 拉来源频道最近 24 小时的图片进池子（已经拉过的消息跳过） */
  private async fetch() {
    const s = await this.settings();
    let added = 0;
    try {
      const client = await this.tg.authorized();
      const entity = await client.getEntity(s.channel);
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const photos: Api.Message[] = [];
      let offsetId = 0;
      // 从最新往回翻，翻到 24 小时前为止
      outer: for (let page = 0; page < 10; page++) {
        const msgs = await client.getMessages(entity, { limit: 100, offsetId });
        if (!msgs.length) break;
        for (const m of msgs) {
          if (m.date < since) break outer;
          if (m.media instanceof Api.MessageMediaPhoto && m.media.photo instanceof Api.Photo) photos.push(m);
        }
        offsetId = msgs[msgs.length - 1].id;
      }
      const known = new Set(
        (await this.prisma.xPic.findMany({ where: { channel: s.channel, msgId: { in: photos.map((m) => m.id) } }, select: { msgId: true } })).map((r) => r.msgId),
      );
      const base = (process.env.PUBLIC_RES_BASE || 'https://api.yyheart.com').replace(/\/$/, '');
      for (const m of photos.filter((p) => !known.has(p.id)).slice(0, MAX_FETCH)) {
        try {
          const buf = await client.downloadMedia(m, {});
          if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) continue;
          const { url } = await this.upload.putInternal('xpics', 'jpg', buf, 'image/jpeg');
          await this.prisma.xPic.create({
            data: { channel: s.channel, msgId: m.id, groupKey: m.groupedId ? `g${m.groupedId.toString()}` : `m${m.id}`, url: base + url, postedAt: new Date(m.date * 1000) },
          });
          added++;
        } catch (e: any) {
          this.logger.warn(`download @${s.channel}/${m.id}: ${e?.message ?? e}`);
        }
      }
      await this.set('last_fetch', bjDate(Date.now()));
      await this.set('last_result', `${new Date().toISOString()}|最近 24 小时 ${photos.length} 张图，新增 ${added} 张`);
      this.logger.log(`fetched @${s.channel}: ${photos.length} photos, +${added}`);
    } catch (e: any) {
      this.lastFailAt = Date.now();
      const msg = String(e?.message ?? e).slice(0, 200);
      await this.set('last_result', `${new Date().toISOString()}|拉取失败：${msg}`);
      this.logger.warn(`fetch @${s.channel}: ${msg}`);
    }
  }

  /** 把今天没排满的次数在发布时段里平均排开（已过去的时间点不补） */
  private async plan() {
    const s = await this.settings();
    const ps = await this.publish.settings();
    const now = Date.now();
    const dayStart = bjDayStart(now, 0);
    const existing = await this.prisma.publishJob.count({
      where: { platform: 'x', format: 'pics', tags: { not: MANUAL_TAG }, status: { in: [0, 1, 2] }, scheduledAt: { gte: new Date(dayStart), lt: new Date(dayStart + 86_400_000) } },
    });
    const need = s.daily - existing;
    if (need <= 0) return;
    const span = ((ps.hourEnd - ps.hourStart) * 3_600_000) / s.daily;
    const slots = Array.from({ length: s.daily }, (_, i) => dayStart + ps.hourStart * 3_600_000 + span * (i + 0.5)).filter((t) => t > now);
    for (const t of slots.slice(0, need)) {
      // 前后抖 10 分钟，别每天都卡在同一分钟
      const job = await this.makeJob(new Date(t + (Math.random() * 20 - 10) * 60_000), false);
      if (!job) break;
      this.logger.log(`planned x pics job #${job.id} @ ${new Date(t).toISOString()} (${job.count} 张)`);
    }
  }

  /** 从池子取 min~max 张（最新的相册先用，一组不够再拿下一组补）排一条任务；不够 min 张返回 null */
  private async makeJob(when: Date, manual: boolean) {
    const s = await this.settings();
    const want = s.min + Math.floor(Math.random() * (s.max - s.min + 1));
    const pool = await this.prisma.xPic.findMany({ where: { jobId: null }, orderBy: [{ postedAt: 'desc' }, { msgId: 'asc' }], take: 300 });
    const groups = new Map<string, typeof pool>();
    for (const p of pool) groups.set(p.groupKey, [...(groups.get(p.groupKey) ?? []), p]);
    const picked: typeof pool = [];
    for (const g of groups.values()) {
      for (const p of g) if (picked.length < want) picked.push(p);
      if (picked.length >= want) break;
    }
    if (picked.length < s.min) return null;
    const job = await this.prisma.publishJob.create({
      data: {
        // 没有对应的树洞帖：postId 用负的图片 id，保证 (postId, platform) 唯一
        postId: BigInt(-picked[0].id), platform: 'x', title: '', content: '', tags: manual ? MANUAL_TAG : '',
        format: 'pics', media: JSON.stringify({ images: picked.map((p) => p.url) }), scheduledAt: when,
      },
    });
    await this.prisma.xPic.updateMany({ where: { id: { in: picked.map((p) => p.id) } }, data: { jobId: job.id } });
    return { id: job.id, count: picked.length };
  }
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** 北京时间日期 YYYY-MM-DD */
function bjDate(t: number): string {
  return new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
}

function bjHour(t: number): number {
  return new Date(t + 8 * 3_600_000).getUTCHours();
}
