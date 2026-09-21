import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Api } from 'telegram';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { TelegramClientService } from '../telegram/telegram.service';
import type { Gif } from '@prisma/client';

/** GIF 给客户端的载荷：与 StickerPayload 同形（format=mp4），聊天 type=sticker / 评论 sticker 列直接复用 */
export interface GifPayload {
  id: string;
  format: 'mp4';
  url: string;
  /** 160px 动态 WebP 预览（面板网格用） */
  thumb: string;
  w: number;
  h: number;
  emoji: '';
}

/** 单个 GIF 上限 */
const MAX_GIF_BYTES = 5 * 1024 * 1024;
/** 库里最多留多少个（LRU 按 lastUsedAt 清） */
const MAX_GIFS = 3000;
/** 一页搜索结果里没缓存的并行下载数 / 首次响应预算 */
const POOL = 6;
const BUDGET_MS = 12_000;
/** 结果页缓存（热门 10 分钟，搜索 30 分钟） */
const TREND_TTL = 10 * 60 * 1000;
const QUERY_TTL = 30 * 60 * 1000;
const THUMB_SIZE = 160;

type TgClient = Awaited<ReturnType<TelegramClientService['authorized']>>;

interface Candidate {
  key: string;
  doc?: Api.Document;
  webUrl?: string;
  mime: string;
  w: number;
  h: number;
  duration: number;
  size: number;
}

interface Page {
  at: number;
  items: GifPayload[];
  next: string;
}

/**
 * GIF：走已登录 Telegram 账号问 @gif inline bot（背后是 Tenor），拿到的是无声 mp4。
 * 国内客户端拿不到 Telegram / Tenor 的文件，所以每条都下载转存 MinIO，再用 ffmpeg 出 160px 动态 WebP 当网格预览。
 * 首次搜索一页要下载几十个文件，给 12 秒预算：来得及的先回，其余后台继续，下次同样的词就全了。
 */
@Injectable()
export class GifService implements OnModuleInit {
  private readonly logger = new Logger('Gif');
  private readonly pages = new Map<string, Page>();
  private readonly inflight = new Map<string, Promise<{ items: GifPayload[]; next: string }>>();
  private readonly downloading = new Map<string, Promise<Gif | null>>();
  private bot?: Api.TypeInputUser;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
    private readonly tg: TelegramClientService,
  ) {}

  onModuleInit() {
    // 预热热门页；每小时 LRU 清理
    setTimeout(() => void this.search('', '').catch((e) => this.logger.warn(`prewarm: ${e?.message ?? e}`)), 60_000);
    setInterval(() => void this.search('', '').catch(() => {}), TREND_TTL);
    setInterval(() => void this.cleanup().catch((e) => this.logger.warn(`cleanup: ${e?.message ?? e}`)), 60 * 60 * 1000);
  }

  // ---------- 用户端 ----------

  /** 搜索 / 热门（q 空）。offset 为上一页返回的 next */
  async search(qRaw: string, offset: string): Promise<{ items: GifPayload[]; next: string }> {
    const q = String(qRaw ?? '').trim().slice(0, 60);
    const off = String(offset ?? '').slice(0, 64);
    const key = `${q}|${off}`;
    const hit = this.pages.get(key);
    if (hit && Date.now() - hit.at < (q ? QUERY_TTL : TREND_TTL)) return { items: hit.items, next: hit.next };
    let p = this.inflight.get(key);
    if (!p) {
      p = this.doSearch(q, off).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async doSearch(q: string, offset: string): Promise<{ items: GifPayload[]; next: string }> {
    const client = await this.tg.authorized();
    if (!this.bot) {
      const peer = await client.getInputEntity('gif');
      if (!(peer instanceof Api.InputPeerUser)) throw new BadRequestException('找不到 @gif 机器人');
      this.bot = new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
    }
    let r: Api.messages.TypeBotResults;
    try {
      r = await this.guarded(client.invoke(new Api.messages.GetInlineBotResults({ bot: this.bot, peer: new Api.InputPeerSelf(), query: q, offset })));
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`GIF 搜索失败：${String(e?.errorMessage ?? e?.message ?? e).slice(0, 120)}`);
    }
    const next = r.nextOffset ?? '';
    const cands = r.results.map(describe).filter((c): c is Candidate => !!c);
    if (!cands.length) {
      this.pages.set(`${q}|${offset}`, { at: Date.now(), items: [], next });
      return { items: [], next };
    }

    const rows = await this.prisma.gif.findMany({ where: { key: { in: cands.map((c) => c.key) } } });
    const byKey = new Map(rows.map((x) => [x.key, x]));
    // 没缓存的并行下载，超过预算的留在后台继续
    const settled: (Gif | null)[] = new Array(cands.length).fill(null);
    const work = pool(cands, POOL, async (c, i) => {
      const row = byKey.get(c.key);
      settled[i] = row?.url ? row : row?.blocked ? null : await this.ensure(client, c, q);
    });
    await Promise.race([work, sleep(BUDGET_MS)]);
    work.catch(() => {});

    const items = settled.filter((x): x is Gif => !!x && !!x.url && !x.blocked).map(toPayload);
    const touched = settled.filter((x): x is Gif => !!x).map((x) => x.id);
    if (touched.length) void this.prisma.gif.updateMany({ where: { id: { in: touched } }, data: { lastUsedAt: new Date() } }).catch(() => {});
    // 还有在后台下载的就只缓存很短，让下一次请求能拿到补齐的
    const complete = settled.every((x, i) => x || byKey.get(cands[i].key)?.blocked);
    this.pages.set(`${q}|${offset}`, { at: complete ? Date.now() : Date.now() - (q ? QUERY_TTL : TREND_TTL) + 15_000, items, next });
    return { items, next };
  }

  /** 下载 + 转存 + 出预览；同一 key 并发只做一次 */
  private ensure(client: TgClient, c: Candidate, q: string): Promise<Gif | null> {
    let p = this.downloading.get(c.key);
    if (!p) {
      p = this.importOne(client, c, q)
        .catch((e) => { this.logger.warn(`gif ${c.key}: ${e?.message ?? e}`); return null; })
        .finally(() => this.downloading.delete(c.key));
      this.downloading.set(c.key, p);
    }
    return p;
  }

  private async importOne(client: TgClient, c: Candidate, q: string): Promise<Gif | null> {
    if (c.size > MAX_GIF_BYTES) return null;
    let buf: Buffer | undefined;
    if (c.doc) {
      const b = await client.downloadMedia(new Api.MessageMediaDocument({ document: c.doc }), {});
      if (Buffer.isBuffer(b)) buf = b;
    } else if (c.webUrl) {
      const res = await fetch(c.webUrl, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    }
    if (!buf || buf.length < 100) throw new Error('下载失败');
    if (buf.length > MAX_GIF_BYTES) return null;

    let mp4 = buf;
    if (isGif(buf)) mp4 = await gifToMp4(buf);
    else if (!isMp4(buf)) throw new Error(`不支持的格式 ${c.mime}`);
    const dims = c.w && c.h ? { w: c.w, h: c.h } : await probe(mp4).catch(() => ({ w: 0, h: 0 }));
    const [{ url }, thumb] = await Promise.all([
      this.uploads.putInternal('gif', 'mp4', mp4, 'video/mp4'),
      mp4ToAnimatedWebp(mp4).then((t) => this.uploads.putInternal('gif-thumb', 'webp', t, 'image/webp')).then((x) => x.url).catch((e) => { this.logger.warn(`thumb ${c.key}: ${e?.message ?? e}`); return ''; }),
    ]);
    return this.prisma.gif.upsert({
      where: { key: c.key },
      create: { key: c.key, url, thumb, w: dims.w, h: dims.h, duration: c.duration, size: mp4.length, query: q.slice(0, 120) },
      update: { url, thumb, w: dims.w, h: dims.h, duration: c.duration, size: mp4.length, query: q.slice(0, 120), lastUsedAt: new Date() },
    });
  }

  /** LRU：超过上限删最久没用的；连文件删 */
  async cleanup() {
    const total = await this.prisma.gif.count({ where: { blocked: false } });
    if (total <= MAX_GIFS) return;
    const victims = await this.prisma.gif.findMany({ where: { blocked: false }, orderBy: { lastUsedAt: 'asc' }, take: total - MAX_GIFS, select: { id: true, url: true, thumb: true } });
    for (const v of victims) {
      await Promise.all([this.uploads.remove(v.url), this.uploads.remove(v.thumb)]);
    }
    await this.prisma.gif.deleteMany({ where: { id: { in: victims.map((v) => v.id) } } });
    this.pages.clear();
    this.logger.log(`cleanup: removed ${victims.length}`);
  }

  // ---------- 后台 ----------

  async adminList(page = 1, size = 40, q = '') {
    const where = q ? { query: { contains: q } } : {};
    const [total, list] = await Promise.all([
      this.prisma.gif.count({ where }),
      this.prisma.gif.findMany({ where, orderBy: { lastUsedAt: 'desc' }, skip: (page - 1) * size, take: size }),
    ]);
    return { total, list };
  }

  async adminStats() {
    const [total, blocked, agg] = await Promise.all([
      this.prisma.gif.count({ where: { blocked: false } }),
      this.prisma.gif.count({ where: { blocked: true } }),
      this.prisma.gif.aggregate({ _sum: { size: true } }),
    ]);
    return { total, blocked, bytes: agg._sum.size ?? 0, max: MAX_GIFS };
  }

  /** 屏蔽：删文件，保留记录避免再次入库 */
  async block(id: number) {
    const g = await this.prisma.gif.findUnique({ where: { id } });
    if (!g) return;
    await Promise.all([this.uploads.remove(g.url), this.uploads.remove(g.thumb)]);
    await this.prisma.gif.update({ where: { id }, data: { blocked: true, url: '', thumb: '' } });
    this.pages.clear();
  }

  async unblock(id: number) {
    await this.prisma.gif.update({ where: { id }, data: { blocked: false } });
  }

  /** 清空缓存（屏蔽记录保留） */
  async purge() {
    const rows = await this.prisma.gif.findMany({ where: { blocked: false }, select: { id: true, url: true, thumb: true } });
    for (const r of rows) await Promise.all([this.uploads.remove(r.url), this.uploads.remove(r.thumb)]);
    await this.prisma.gif.deleteMany({ where: { blocked: false } });
    this.pages.clear();
    return { removed: rows.length };
  }

  private async guarded<T>(p: Promise<T>, ms = 40_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TG_TIMEOUT')), ms); });
    try {
      return await Promise.race([p, timeout]);
    } catch (e: any) {
      if (String(e?.message) === 'TG_TIMEOUT') {
        await this.tg.recover();
        this.bot = undefined;
        throw new BadRequestException('Telegram 响应超时（已自动重连），请重试');
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ---------- 工具 ----------

function toPayload(g: Gif): GifPayload {
  return { id: `g${g.id}`, format: 'mp4', url: g.url, thumb: g.thumb, w: g.w, h: g.h, emoji: '' };
}

/** 解析一条 inline 结果：@gif 通常回 BotInlineMediaResult(document)，也兼容 BotInlineResult(WebDocument) */
function describe(r: Api.TypeBotInlineResult): Candidate | null {
  if (r instanceof Api.BotInlineMediaResult) {
    const doc = r.document;
    if (!(doc instanceof Api.Document)) return null;
    const a = attrs(doc.attributes);
    return { key: doc.id.toString(), doc, mime: (doc.mimeType || '').toLowerCase(), size: Number(doc.size?.toString() ?? 0), ...a };
  }
  if (r instanceof Api.BotInlineResult) {
    const c = r.content;
    if (!c || !('url' in c) || !c.url) return null;
    const mime = (c.mimeType || '').toLowerCase();
    if (!/video\/mp4|image\/gif/.test(mime)) return null;
    const a = attrs(c.attributes ?? []);
    return { key: `w${createHash('sha1').update(c.url).digest('hex').slice(0, 32)}`, webUrl: c.url, mime, size: Number(c.size ?? 0), ...a };
  }
  return null;
}

function attrs(list: Api.TypeDocumentAttribute[]) {
  let w = 0, h = 0, duration = 0;
  for (const a of list) {
    if (a instanceof Api.DocumentAttributeVideo) { w = a.w; h = a.h; duration = Math.round(Number(a.duration) || 0); }
    else if (a instanceof Api.DocumentAttributeImageSize) { w = a.w; h = a.h; }
  }
  return { w, h, duration };
}

function isGif(b: Buffer) {
  return b.length > 6 && b.toString('ascii', 0, 3) === 'GIF';
}
function isMp4(b: Buffer) {
  return b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp';
}

function ffmpeg(args: string[], timeout = 60_000): Promise<string> {
  return new Promise((res, rej) =>
    execFile('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) =>
      err ? rej(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : res(String(out)),
    ),
  );
}

async function withTemp<T>(inputExt: string, input: Buffer, outExt: string, fn: (inPath: string, outPath: string) => Promise<T>): Promise<T> {
  const base = join(tmpdir(), `gif-${randomUUID()}`);
  const inPath = `${base}.${inputExt}`, outPath = `${base}.out.${outExt}`;
  await fs.writeFile(inPath, input);
  try {
    return await fn(inPath, outPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

/** GIF 图 → mp4（yuv420p 需偶数边） */
function gifToMp4(gif: Buffer): Promise<Buffer> {
  return withTemp('gif', gif, 'mp4', async (i, o) => {
    await ffmpeg(['-i', i, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-an', o]);
    return fs.readFile(o);
  });
}

/** mp4 → 160px / 12fps / 前 3 秒 的动态 WebP（网格预览） */
function mp4ToAnimatedWebp(mp4: Buffer): Promise<Buffer> {
  return withTemp('mp4', mp4, 'webp', async (i, o) => {
    const scale = `scale=w='if(gte(iw,ih),${THUMB_SIZE},-2)':h='if(gte(iw,ih),-2,${THUMB_SIZE})':flags=lanczos`;
    await ffmpeg(['-i', i, '-vf', `fps=12,${scale}`, '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '60', '-compression_level', '4', '-loop', '0', '-an', '-t', '3', o]);
    const out = await fs.readFile(o);
    if (out.length < 100) throw new Error('预览为空');
    return out;
  });
}

/** 缺尺寸时用 ffprobe 读 */
function probe(mp4: Buffer): Promise<{ w: number; h: number }> {
  return withTemp('mp4', mp4, 'txt', async (i) => {
    const out = await new Promise<string>((res, rej) =>
      execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', i], { timeout: 15_000 }, (err, o) => (err ? rej(err) : res(String(o)))),
    );
    const [w, h] = out.trim().split(',').map(Number);
    return { w: w || 0, h: h || 0 };
  });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}
