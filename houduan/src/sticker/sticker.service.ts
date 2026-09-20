import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { TelegramClientService } from '../telegram/telegram.service';

/** 客户端拿到的单张贴纸（聊天消息 content / 评论 sticker 列都存这个 JSON，自包含，不用回查） */
export interface StickerPayload {
  id: string;
  /** webp=静态 WebP；lottie=Lottie JSON（TGS 已解压）；awebp=动态 WebP（视频贴纸转码） */
  format: 'webp' | 'lottie' | 'awebp';
  url: string;
  /** 静态缩略图（面板网格 / 老设备兜底）；为空时用 url */
  thumb: string;
  w: number;
  h: number;
  emoji: string;
}

/** 最多收多少个贴纸集（面板 tab 太多也没法用） */
const MAX_SETS = 40;
/** 单张贴纸原文件上限（静态 ≤512KB、TGS ≤64KB、视频一般 ≤1MB） */
const MAX_STICKER_BYTES = 4 * 1024 * 1024;
/** 视频贴纸转动态 WebP 的边长 / 帧率（显示尺寸 128~160dp，320px 够 2x） */
const AWEBP_SIZE = 320;
const AWEBP_FPS = 20;
/** 并行下载数（文件都很小，主要是省往返） */
const POOL = 4;
const VERSION_KEY = 'sticker_version';

type Kind = 'static' | 'animated' | 'video';
type TgClient = Awaited<ReturnType<TelegramClientService['authorized']>>;

interface TgSticker {
  doc: Api.Document;
  /** downloadMedia 的类型只收 MessageMedia，包一层（运行时对 Document 本身也支持） */
  media: Api.MessageMediaDocument;
  tgDocId: string;
  emoji: string;
  mime: string;
  w: number;
  h: number;
  size: number;
  thumb?: Api.TypePhotoSize;
}

/** 后台浏览（热门 / 搜索 / 解析）用的集合摘要 */
export interface SetBrief {
  shortName: string;
  title: string;
  count: number;
  kind: Kind;
  official: boolean;
  /** 已在库里 */
  added: boolean;
  /** 封面 data URL（一张缩略图，直接给 <img>） */
  cover: string;
}

/**
 * 表情包：Telegram 公开贴纸集（t.me/addstickers/xxx），后台精选后通过已登录的 Telegram 账号整包拉下来转存 MinIO。
 * 三端格式统一：静态 WebP 原样；TGS 解压成 Lottie JSON；WebM 视频贴纸用 ffmpeg 转成带透明的动态 WebP
 * （AVPlayer 不认 WebM、ExoPlayer/WebView 不画 alpha，所以视频类必须转）。
 * 聊天消息 type=sticker、动态/树洞评论 sticker 列都存 StickerPayload JSON。
 */
@Injectable()
export class StickerService {
  private readonly logger = new Logger('Sticker');
  /** 正在同步的集合 id（后台轮询显示） */
  private readonly syncing = new Set<number>();
  private queue: number[] = [];
  private pumping = false;
  private featuredCache?: { at: number; list: SetBrief[] };

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
    private readonly tg: TelegramClientService,
  ) {}

  // ---------- 用户端 ----------

  async version(): Promise<number> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: VERSION_KEY } });
    return Number(row?.value) || 1;
  }

  private async bumpVersion() {
    const v = (await this.version()) + 1;
    await this.prisma.sysSetting.upsert({ where: { key: VERSION_KEY }, create: { key: VERSION_KEY, value: String(v) }, update: { value: String(v) } });
    return v;
  }

  /** 全部启用的集合 + 贴纸（一次给全，客户端按 version 缓存；ver 一致回 notModified） */
  async catalog(ver?: number) {
    const version = await this.version();
    if (ver && ver === version) return { version, notModified: true, sets: [] as any[] };
    const sets = await this.prisma.stickerSet.findMany({ where: { enabled: true }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    const items = await this.prisma.sticker.findMany({
      where: { setId: { in: sets.map((s) => s.id) } },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      select: { id: true, setId: true, emoji: true, format: true, url: true, thumb: true, w: true, h: true },
    });
    return {
      version,
      notModified: false,
      sets: sets
        .map((s) => ({
          id: s.id,
          title: s.title,
          kind: s.kind,
          thumb: s.thumb,
          items: items.filter((i) => i.setId === s.id).map((i) => this.toPayload(i)),
        }))
        .filter((s) => s.items.length > 0),
    };
  }

  /** 评论 / 其它模块拿一张贴纸的载荷（集合需启用） */
  async payloadOf(idRaw: string | number | bigint | undefined | null): Promise<StickerPayload | null> {
    if (idRaw === undefined || idRaw === null || idRaw === '') return null;
    let id: bigint;
    try { id = BigInt(idRaw); } catch { throw new BadRequestException('贴纸 id 不合法'); }
    const s = await this.prisma.sticker.findUnique({ where: { id } });
    if (!s) throw new BadRequestException('贴纸不存在');
    const set = await this.prisma.stickerSet.findUnique({ where: { id: s.setId }, select: { enabled: true } });
    if (!set?.enabled) throw new BadRequestException('该表情包已下架');
    return this.toPayload(s);
  }

  private toPayload(s: { id: bigint; emoji: string; format: string; url: string; thumb: string; w: number; h: number }): StickerPayload {
    return { id: s.id.toString(), format: s.format as StickerPayload['format'], url: s.url, thumb: s.thumb, w: s.w, h: s.h, emoji: s.emoji };
  }

  // ---------- 后台：浏览 ----------

  async listSets() {
    const sets = await this.prisma.stickerSet.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    const counts = await this.prisma.sticker.groupBy({ by: ['setId'], _count: { _all: true } });
    const cmap = new Map(counts.map((c) => [c.setId, c._count._all]));
    return sets.map((s) => ({ ...s, stickers: cmap.get(s.id) ?? 0, syncing: this.syncing.has(s.id) || this.queue.includes(s.id) }));
  }

  async items(setId: number) {
    const rows = await this.prisma.sticker.findMany({ where: { setId }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => ({ ...this.toPayload(r), size: r.size, tgDocId: r.tgDocId }));
  }

  /** 解析一个集合（不入库）：标题/张数/类型 + 前 12 张缩略图，添加前核对内容 */
  async preview(input: string) {
    const shortName = parseShortName(input);
    if (!shortName) throw new BadRequestException('请填写贴纸集链接（t.me/addstickers/xxx）或名称');
    const { set, stickers, kind } = await this.fetchSet(shortName);
    const client = await this.tg.authorized();
    const samples = await pool(stickers.slice(0, 12), POOL, async (s) => ({ emoji: s.emoji, thumb: await this.thumbDataUrl(client, s) }));
    const exists = await this.prisma.stickerSet.findUnique({ where: { shortName: set.shortName }, select: { id: true } });
    return {
      shortName: set.shortName,
      title: set.title,
      count: set.count,
      kind,
      official: !!set.official,
      added: !!exists,
      samples: samples.filter((s) => s.thumb),
    };
  }

  /** Telegram 官方「热门」贴纸集（缓存 10 分钟） */
  async featured(): Promise<SetBrief[]> {
    if (this.featuredCache && Date.now() - this.featuredCache.at < 10 * 60_000) return this.markAdded(this.featuredCache.list);
    const client = await this.tg.authorized();
    const r = await this.guarded(client.invoke(new Api.messages.GetFeaturedStickers({ hash: bigInt(0) })));
    if (!(r instanceof Api.messages.FeaturedStickers)) return [];
    const list = await this.briefs(client, r.sets.slice(0, 40));
    this.featuredCache = { at: Date.now(), list };
    return this.markAdded(list);
  }

  // 注意：不要加 messages.SearchStickerSets —— 线上实测其返回里有 GramJS 2.26 不认识的新构造器，
  // 反序列化报错后整个 MTProto 接收循环卡死（后续所有请求超时，只能重启 api）。热门榜（GetFeaturedStickers）没这个问题。

  private async markAdded(list: SetBrief[]) {
    const names = list.map((s) => s.shortName);
    const rows = await this.prisma.stickerSet.findMany({ where: { shortName: { in: names } }, select: { shortName: true } });
    const have = new Set(rows.map((r) => r.shortName.toLowerCase()));
    return list.map((s) => ({ ...s, added: have.has(s.shortName.toLowerCase()) }));
  }

  private async briefs(client: TgClient, covered: Api.TypeStickerSetCovered[]) {
    const usable = covered.filter((c) => {
      const set = (c as any).set as Api.TypeStickerSet;
      return set instanceof Api.StickerSet && !set.masks && !set.emojis;
    });
    return pool(usable, POOL, async (c) => {
      const set = (c as any).set as Api.StickerSet;
      let coverDoc: Api.TypeDocument | undefined;
      if (c instanceof Api.StickerSetCovered) coverDoc = c.cover;
      else if (c instanceof Api.StickerSetMultiCovered) coverDoc = c.covers[0];
      else if (c instanceof Api.StickerSetFullCovered) coverDoc = c.documents[0];
      const s = coverDoc instanceof Api.Document ? describe(coverDoc) : null;
      const brief: SetBrief = {
        shortName: set.shortName,
        title: set.title,
        count: set.count,
        kind: s ? kindOfMime(s.mime) : 'static',
        official: !!set.official,
        added: false,
        cover: s ? await this.thumbDataUrl(client, s).catch(() => '') : '',
      };
      return brief;
    });
  }

  // ---------- 后台：增删改 ----------

  /** 添加集合并开始同步（已存在则只是重新同步） */
  async addSet(input: string) {
    const shortName = parseShortName(input);
    if (!shortName) throw new BadRequestException('请填写贴纸集链接（t.me/addstickers/xxx）或名称');
    const total = await this.prisma.stickerSet.count();
    const existed = await this.prisma.stickerSet.findUnique({ where: { shortName } });
    if (!existed && total >= MAX_SETS) throw new BadRequestException(`最多收 ${MAX_SETS} 个表情包，先删掉一些`);
    const { set, kind } = await this.fetchSet(shortName);
    const maxSort = await this.prisma.stickerSet.aggregate({ _max: { sort: true } });
    const row = await this.prisma.stickerSet.upsert({
      where: { shortName: set.shortName },
      create: { shortName: set.shortName, title: set.title.slice(0, 120), kind, count: set.count, sort: (maxSort._max.sort ?? 0) + 1 },
      update: { title: set.title.slice(0, 120), kind, count: set.count, lastError: '' },
    });
    this.enqueue(row.id);
    return { ...row, syncing: true };
  }

  async syncOne(id: number) {
    const set = await this.prisma.stickerSet.findUnique({ where: { id } });
    if (!set) throw new NotFoundException('表情包不存在');
    this.enqueue(id);
    return { started: true };
  }

  async updateSet(id: number, data: { title?: string; enabled?: boolean; sort?: number }) {
    const set = await this.prisma.stickerSet.findUnique({ where: { id } });
    if (!set) throw new NotFoundException('表情包不存在');
    const patch: any = {};
    if (data.title !== undefined) patch.title = String(data.title).trim().slice(0, 120) || set.title;
    if (data.enabled !== undefined) patch.enabled = !!data.enabled;
    if (data.sort !== undefined) patch.sort = Number(data.sort) || 0;
    const row = await this.prisma.stickerSet.update({ where: { id }, data: patch });
    await this.bumpVersion();
    return row;
  }

  /** 整体排序：按 ids 顺序写 sort */
  async reorder(ids: number[]) {
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.stickerSet.update({ where: { id }, data: { sort: i + 1 } })));
    await this.bumpVersion();
    return { ok: true };
  }

  /**
   * 移除集合：默认只删记录、保留文件（已发出的聊天/评论里的贴纸靠 url 还能显示）；
   * purge=true 连文件一起删（老消息会裂图）。
   */
  async removeSet(id: number, purge: boolean) {
    const set = await this.prisma.stickerSet.findUnique({ where: { id } });
    if (!set) throw new NotFoundException('表情包不存在');
    if (this.syncing.has(id)) throw new BadRequestException('正在同步，稍后再删');
    this.queue = this.queue.filter((x) => x !== id);
    const rows = await this.prisma.sticker.findMany({ where: { setId: id }, select: { url: true, thumb: true } });
    await this.prisma.sticker.deleteMany({ where: { setId: id } });
    await this.prisma.stickerSet.delete({ where: { id } });
    await this.bumpVersion();
    if (purge) {
      for (const r of rows) {
        await this.uploads.remove(r.url);
        if (r.thumb) await this.uploads.remove(r.thumb);
      }
      if (set.thumb) await this.uploads.remove(set.thumb);
    }
    return { ok: true, removedFiles: purge ? rows.length : 0 };
  }

  // ---------- 同步 ----------

  private enqueue(id: number) {
    if (this.syncing.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    void this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        this.syncing.add(id);
        try {
          await this.syncSet(id);
        } catch (e: any) {
          this.logger.warn(`sync set#${id}: ${e?.message ?? e}`);
          await this.prisma.stickerSet.update({ where: { id }, data: { lastError: String(e?.message ?? e).slice(0, 300), lastSyncAt: new Date() } }).catch(() => {});
        } finally {
          this.syncing.delete(id);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async syncSet(id: number) {
    const set = await this.prisma.stickerSet.findUnique({ where: { id } });
    if (!set) return;
    const client = await this.tg.authorized();
    const { set: tgSet, stickers, kind } = await this.fetchSet(set.shortName);
    if (kind === 'video' && !(await hasFfmpeg())) throw new Error('服务器没有 ffmpeg，无法转码视频贴纸');

    const existing = new Set((await this.prisma.sticker.findMany({ where: { setId: id }, select: { tgDocId: true } })).map((r) => r.tgDocId));
    let imported = 0;
    const errors: string[] = [];
    // 顺序号按 Telegram 里的排列
    const indexed = stickers.map((s, i) => ({ s, sort: i + 1 }));
    await pool(indexed.filter((x) => !existing.has(x.s.tgDocId)), POOL, async ({ s, sort }) => {
      try {
        const saved = await this.importOne(client, s);
        await this.prisma.sticker.create({ data: { setId: id, tgDocId: s.tgDocId, emoji: s.emoji, sort, ...saved } });
        imported++;
      } catch (e: any) {
        errors.push(`#${sort}: ${String(e?.message ?? e).slice(0, 80)}`);
        this.logger.warn(`sticker ${set.shortName}#${sort}: ${e?.message ?? e}`);
      }
    });
    // 已有的也按最新顺序修一遍 sort（集合可能重排）
    for (const { s, sort } of indexed) {
      if (existing.has(s.tgDocId)) await this.prisma.sticker.updateMany({ where: { setId: id, tgDocId: s.tgDocId }, data: { sort } });
    }
    const first = await this.prisma.sticker.findFirst({ where: { setId: id }, orderBy: [{ sort: 'asc' }, { id: 'asc' }], select: { thumb: true, url: true, format: true } });
    const thumb = first ? first.thumb || (first.format === 'webp' ? first.url : '') : '';
    const total = await this.prisma.sticker.count({ where: { setId: id } });
    await this.prisma.stickerSet.update({
      where: { id },
      data: {
        title: tgSet.title.slice(0, 120), kind, count: tgSet.count, thumb, importedCount: total, lastSyncAt: new Date(),
        lastError: errors.length ? `${errors.length} 张失败：${errors.slice(0, 3).join('；')}`.slice(0, 300) : '',
      },
    });
    await this.bumpVersion();
    this.logger.log(`sync ${set.shortName}: +${imported}, total ${total}/${tgSet.count}, failed ${errors.length}`);
  }

  /** 下载 + 转格式 + 转存一张（含缩略图） */
  private async importOne(client: TgClient, s: TgSticker) {
    if (s.size > MAX_STICKER_BYTES) throw new Error(`文件过大 ${Math.round(s.size / 1024)}KB`);
    const buf = await client.downloadMedia(s.media, {});
    if (!Buffer.isBuffer(buf) || buf.length < 64) throw new Error('下载失败');

    let format: StickerPayload['format'];
    let url: string;
    let size: number;
    const mime = s.mime.toLowerCase();
    if (mime === 'application/x-tgsticker') {
      const json = gunzipSync(buf);
      JSON.parse(json.toString('utf8')); // 校验是合法 Lottie
      ({ url } = await this.uploads.putInternal('sticker', 'json', json, 'application/json'));
      format = 'lottie'; size = json.length;
    } else if (mime === 'video/webm') {
      const out = await webmToAnimatedWebp(buf);
      ({ url } = await this.uploads.putInternal('sticker', 'webp', out, 'image/webp'));
      format = 'awebp'; size = out.length;
    } else if (mime === 'image/webp' || isWebp(buf)) {
      ({ url } = await this.uploads.putInternal('sticker', 'webp', buf, 'image/webp'));
      format = 'webp'; size = buf.length;
    } else if (mime === 'image/png') {
      ({ url } = await this.uploads.putInternal('sticker', 'png', buf, 'image/png'));
      format = 'webp'; size = buf.length; // 客户端按普通图片处理
    } else {
      throw new Error(`不支持的格式 ${s.mime}`);
    }

    // 缩略图：静态贴纸直接用自身；动态/视频用 Telegram 给的静态帧
    let thumb = '';
    if (format !== 'webp' && s.thumb) {
      try {
        const t = await client.downloadMedia(s.media, { thumb: s.thumb });
        if (Buffer.isBuffer(t) && t.length > 100) {
          const ext = isWebp(t) ? 'webp' : isPng(t) ? 'png' : 'jpg';
          thumb = (await this.uploads.putInternal('sticker-thumb', ext, t, ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg')).url;
        }
      } catch (e: any) {
        this.logger.warn(`thumb ${s.tgDocId}: ${e?.message ?? e}`);
      }
    }
    return { format, url, thumb, w: s.w, h: s.h, size };
  }

  /** 拉整个集合并解析每张贴纸 */
  private async fetchSet(shortName: string): Promise<{ set: Api.StickerSet; stickers: TgSticker[]; kind: Kind }> {
    const client = await this.tg.authorized();
    let r: Api.messages.TypeStickerSet;
    try {
      r = await this.guarded(client.invoke(new Api.messages.GetStickerSet({ stickerset: new Api.InputStickerSetShortName({ shortName }), hash: 0 })));
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      const msg = String(e?.errorMessage ?? e?.message ?? e);
      if (/STICKERSET_INVALID/.test(msg)) throw new BadRequestException(`找不到贴纸集「${shortName}」`);
      throw new BadRequestException(`读取贴纸集失败：${msg.slice(0, 120)}`);
    }
    if (!(r instanceof Api.messages.StickerSet) || !(r.set instanceof Api.StickerSet)) throw new BadRequestException('贴纸集读取异常');
    if (r.set.masks) throw new BadRequestException('这是「面具」贴纸集（贴在照片上用的），不适合当表情');
    if (r.set.emojis) throw new BadRequestException('这是自定义 emoji 集（Telegram Premium 专用），不是贴纸集');
    const stickers = r.documents.filter((d): d is Api.Document => d instanceof Api.Document).map(describe);
    if (!stickers.length) throw new BadRequestException('贴纸集是空的');
    const kind: Kind = stickers.some((s) => s.mime === 'video/webm') ? 'video' : stickers.some((s) => s.mime === 'application/x-tgsticker') ? 'animated' : 'static';
    return { set: r.set, stickers, kind };
  }

  /**
   * 带超时的 Telegram 请求：GramJS 遇到不认识的构造器会让接收循环卡死、请求永远不回，
   * 超时就强制重连并报错，避免整个 Telegram 功能一直挂着直到重启。
   */
  private async guarded<T>(p: Promise<T>, ms = 40_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TG_TIMEOUT')), ms); });
    try {
      return await Promise.race([p, timeout]);
    } catch (e: any) {
      if (String(e?.message) === 'TG_TIMEOUT') {
        await this.tg.recover();
        throw new BadRequestException('Telegram 响应超时（已自动重连），请重试');
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 缩略图转 data URL（后台预览用，不落盘） */
  private async thumbDataUrl(client: TgClient, s: TgSticker): Promise<string> {
    let buf: any;
    if (s.thumb) buf = await client.downloadMedia(s.media, { thumb: s.thumb }).catch(() => undefined);
    if (!Buffer.isBuffer(buf) && s.mime === 'image/webp' && s.size < 400 * 1024) buf = await client.downloadMedia(s.media, {}).catch(() => undefined);
    if (!Buffer.isBuffer(buf) || buf.length < 50) return '';
    const mime = isWebp(buf) ? 'image/webp' : isPng(buf) ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
}

// ---------- 工具 ----------

/** 解析一张贴纸文档：emoji / 尺寸 / 最大静态缩略图 */
function describe(doc: Api.Document): TgSticker {
  let emoji = '', w = 512, h = 512;
  for (const a of doc.attributes) {
    if (a instanceof Api.DocumentAttributeSticker) emoji = a.alt ?? '';
    if (a instanceof Api.DocumentAttributeImageSize) { w = a.w; h = a.h; }
    if (a instanceof Api.DocumentAttributeVideo) { w = a.w; h = a.h; }
  }
  let thumb: Api.TypePhotoSize | undefined, best = -1;
  for (const t of doc.thumbs ?? []) {
    const b = t instanceof Api.PhotoSize ? t.size : t instanceof Api.PhotoSizeProgressive ? Math.max(...t.sizes) : -1;
    if (b > best) { best = b; thumb = t; }
  }
  return {
    doc,
    media: new Api.MessageMediaDocument({ document: doc }),
    tgDocId: doc.id.toString(),
    emoji: emoji.slice(0, 16),
    mime: (doc.mimeType || '').toLowerCase(),
    w, h,
    size: Number(doc.size?.toString() ?? 0),
    thumb,
  };
}

function kindOfMime(mime: string): Kind {
  return mime === 'video/webm' ? 'video' : mime === 'application/x-tgsticker' ? 'animated' : 'static';
}

/** 评论表里存的贴纸 JSON → 对象（空/坏数据回 null） */
export function parseStickerJson(s: string | null | undefined): StickerPayload | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o.url === 'string' ? (o as StickerPayload) : null;
  } catch {
    return null;
  }
}

/** 接受 t.me/addstickers/NAME、tg://addstickers?set=NAME、@NAME、NAME */
export function parseShortName(raw: string): string {
  let s = String(raw ?? '').trim();
  const m = s.match(/addstickers\/([A-Za-z0-9_]+)/i) || s.match(/addstickers\?set=([A-Za-z0-9_]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').split(/[/?#\s]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(s) ? s : '';
}

function isWebp(b: Buffer) {
  return b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
}
function isPng(b: Buffer) {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

let ffmpegOk: boolean | undefined;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk !== undefined) return ffmpegOk;
  ffmpegOk = await new Promise<boolean>((res) => execFile('ffmpeg', ['-version'], { timeout: 10_000 }, (err) => res(!err)));
  return ffmpegOk;
}

/**
 * WebM(VP9+alpha) → 动态 WebP（保留透明）。必须用 libvpx-vp9 解码，ffmpeg 自带的 vp9 解码器会丢 alpha。
 * 帧率 20、长边 320，一张 3 秒的贴纸出来 200~500KB。
 */
async function webmToAnimatedWebp(input: Buffer): Promise<Buffer> {
  const base = join(tmpdir(), `stk-${randomUUID()}`);
  const inPath = `${base}.webm`, outPath = `${base}.webp`;
  await fs.writeFile(inPath, input);
  try {
    const scale = `scale=w='if(gte(iw,ih),${AWEBP_SIZE},-2)':h='if(gte(iw,ih),-2,${AWEBP_SIZE})':flags=lanczos`;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-c:v', 'libvpx-vp9', '-i', inPath,
      '-vf', `fps=${AWEBP_FPS},${scale},format=yuva420p`,
      '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '72', '-compression_level', '4', '-loop', '0', '-an', '-t', '4',
      outPath,
    ];
    await new Promise<void>((res, rej) =>
      execFile('ffmpeg', args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) =>
        err ? rej(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : res(),
      ),
    );
    const out = await fs.readFile(outPath);
    if (out.length < 100) throw new Error('ffmpeg 输出为空');
    return out;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

/** 简单并发池（保持输入顺序返回） */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
