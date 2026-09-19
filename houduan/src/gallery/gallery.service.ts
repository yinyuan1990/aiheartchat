import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Api } from 'telegram';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { TelegramClientService } from '../telegram/telegram.service';
import { looksLikeSpam, stripLinkLines } from '../treehole/treehole-sync.service';
import { normalizeChannel } from '../music/music.service';

/** 单个视频上限（频道里的短视频一般几 MB 到几十 MB） */
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
/** 每个来源每轮最多下载的媒体文件数 / 字节数（一轮别拖太久） */
const MAX_FILES_PER_ROUND = 60;
const MAX_BYTES_PER_ROUND = 500 * 1024 * 1024;
/** 每个受众最多保留的帖子数（磁盘保护） */
const MAX_POSTS_PER_AUDIENCE = 500;
/** 首次同步往前扫的消息条数 */
const FIRST_SCAN = 60;
const DEFAULT_TITLE = '养眼图片';
const DEFAULT_DAYS = 3;

export interface GalleryMedia {
  type: 'image' | 'video';
  url: string;
  cover?: string;
  w: number;
  h: number;
  duration?: number;
  size: number;
}

/** 从一条消息解析出的媒体（下载前） */
interface TgMedia {
  msg: Api.Message;
  kind: 'photo' | 'video';
  w: number;
  h: number;
  duration: number;
  size: number;
  mime: string;
  thumb?: Api.TypePhotoSize;
}

/**
 * 「养眼图片」：大厅里一个按性别分流的 tab（男看来源 A，女看来源 B），内容来自 Telegram 公开频道的图片/视频。
 * 通过已登录的 Telegram 账号读取（网页预览拿不到视频、也抓不到关闭预览的频道），相册（多图）合成一条帖子，
 * 媒体转存 MinIO；只保留最近 N 天（后台可调，默认 3），tab 名称后台可改。
 */
@Injectable()
export class GalleryService implements OnModuleInit {
  private readonly logger = new Logger('Gallery');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
    private readonly tg: TelegramClientService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.tick(), 45_000);
    setInterval(() => void this.tick(), 10 * 60 * 1000);
  }

  // ---------- 设置 ----------

  /** 后台设置：tab 名称按受众分开（titleM 男看 / titleF 女看，空则用 DEFAULT_TITLE）+ 保留天数 */
  async settings(): Promise<{ titleM: string; titleF: string; days: number }> {
    const rows = await this.prisma.sysSetting.findMany({ where: { key: { in: ['gallery_title_m', 'gallery_title_f', 'gallery_title', 'gallery_days'] } } });
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? '';
    const days = Number(get('gallery_days')) || DEFAULT_DAYS;
    const legacy = get('gallery_title') || DEFAULT_TITLE;
    return { titleM: get('gallery_title_m') || legacy, titleF: get('gallery_title_f') || legacy, days: Math.min(60, Math.max(1, days)) };
  }

  /** 某个受众看到的 tab 名 */
  async titleFor(audience: number): Promise<string> {
    const s = await this.settings();
    return audience === 2 ? s.titleF : s.titleM;
  }

  /** 用户端：按自己性别拿 tab 名称与天数 */
  async userSettings(userId: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    const s = await this.settings();
    return { title: me?.gender === 2 ? s.titleF : s.titleM, days: s.days };
  }

  async saveSettings(data: { titleM?: string; titleF?: string; days?: number }) {
    const titleM = String(data.titleM ?? '').trim().slice(0, 12);
    const titleF = String(data.titleF ?? '').trim().slice(0, 12);
    const days = Math.min(60, Math.max(1, Number(data.days) || DEFAULT_DAYS));
    const set = (key: string, value: string) => this.prisma.sysSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    await set('gallery_title_m', titleM);
    await set('gallery_title_f', titleF);
    await set('gallery_days', String(days));
    return this.settings();
  }

  // ---------- 对外接口（登录用户） ----------

  /** 按登录用户性别分流（男看 audience 1，女看 2），只出保留期内的，最新在前，beforeId 翻页 */
  async list(userId: bigint, beforeId?: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    const audience = me?.gender === 2 ? 2 : 1;
    const s = await this.settings();
    const title = audience === 2 ? s.titleF : s.titleM;
    const days = s.days;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.galleryPost.findMany({
      where: { audience, postedAt: { gte: cutoff }, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: 20,
      select: { id: true, text: true, media: true, viewCount: true, postedAt: true },
    });
    const src = await this.prisma.gallerySource.findFirst({ where: { audience, enabled: true }, select: { title: true, channel: true }, orderBy: { id: 'asc' } });
    return {
      title,
      days,
      source: src ? { title: src.title || src.channel } : null,
      list: rows.map((r) => ({ ...r, media: safeJson<GalleryMedia[]>(r.media, []) })),
    };
  }

  // ---------- 后台：来源 ----------

  async listSources() {
    const rows = await this.prisma.gallerySource.findMany({ orderBy: [{ audience: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => ({ ...r, syncing: this.running }));
  }

  /** 预览：解析频道 + 最近消息里的图片/视频统计（不入库），改来源前核对 */
  async preview(channelRaw: string) {
    const channel = normalizeChannel(channelRaw);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    const client = await this.tg.authorized();
    const msgs = await client.getMessages(info.entity, { limit: 40 });
    let photos = 0, videos = 0, posts = 0;
    const groups = new Set<string>();
    const samples: { msgId: number; text: string; photos: number; videos: number; date: string }[] = [];
    for (const m of msgs) {
      const media = parseMedia(m);
      if (!media) continue;
      if (media.kind === 'photo') photos++; else videos++;
      const g = m.groupedId?.toString() ?? `m${m.id}`;
      if (!groups.has(g)) {
        groups.add(g); posts++;
        if (samples.length < 8) samples.push({ msgId: m.id, text: cleanText(m.message || '').slice(0, 80), photos: media.kind === 'photo' ? 1 : 0, videos: media.kind === 'video' ? 1 : 0, date: new Date(m.date * 1000).toISOString() });
      } else {
        const s = samples.find((x) => x.msgId >= m.id - 12 && x.msgId <= m.id + 12);
        if (s) { if (media.kind === 'photo') s.photos++; else s.videos++; }
      }
    }
    return { channel: info.username, title: info.title, subscribers: info.subscribers, about: info.about.slice(0, 300), scanned: msgs.length, photos, videos, posts, samples };
  }

  /** 保存来源（先解析频道，解析不到不保存；换频道会清掉旧帖子） */
  async saveSource(data: { id?: number; channel: string; audience: number; enabled?: boolean; blockWords?: string }) {
    const channel = normalizeChannel(data.channel);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const audience = Number(data.audience) === 2 ? 2 : 1;
    const info = await this.tg.resolveChannel(channel);
    const clean = {
      channel: info.username, title: info.title.slice(0, 120), subscribers: info.subscribers, audience,
      enabled: data.enabled ?? true, blockWords: String(data.blockWords ?? '').trim().slice(0, 500),
    };
    if (data.id) {
      const old = await this.prisma.gallerySource.findUnique({ where: { id: Number(data.id) } });
      if (!old) throw new NotFoundException('来源不存在');
      if (old.channel.toLowerCase() !== clean.channel.toLowerCase() || old.audience !== audience) {
        await this.removePostsOf(old.id);
        return this.prisma.gallerySource.update({ where: { id: old.id }, data: { ...clean, lastMsgId: 0, lastError: '', importedCount: 0 } });
      }
      return this.prisma.gallerySource.update({ where: { id: old.id }, data: clean });
    }
    return this.prisma.gallerySource.upsert({ where: { channel_audience: { channel: clean.channel, audience } }, update: clean, create: clean });
  }

  async removeSource(id: number) {
    await this.removePostsOf(id);
    await this.prisma.gallerySource.delete({ where: { id } });
    return { ok: true };
  }

  /** 手动同步（后台异步跑，前端轮询 sources.syncing） */
  async syncOne(id: number) {
    const src = await this.prisma.gallerySource.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('来源不存在');
    if (this.running) return { started: false, running: true };
    this.running = true;
    void (async () => {
      try { await this.syncSource(src); } catch (e: any) { this.logger.warn(`manual sync ${src.channel}: ${e?.message ?? e}`); } finally { this.running = false; }
    })();
    return { started: true, running: true };
  }

  async adminPosts(audience?: number, beforeId?: bigint) {
    const rows = await this.prisma.galleryPost.findMany({
      where: { ...(audience ? { audience } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 60,
    });
    return rows.map((r) => ({ ...r, media: safeJson<GalleryMedia[]>(r.media, []) }));
  }

  async adminDeletePost(id: bigint) {
    const p = await this.prisma.galleryPost.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('帖子不存在');
    await this.prisma.galleryPost.delete({ where: { id } });
    await this.removeFiles([p.media]);
    return { ok: true };
  }

  // ---------- 定时 ----------

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.purgeOld().catch((e) => this.logger.warn(`purge: ${e?.message ?? e}`));
      const sources = await this.prisma.gallerySource.findMany({ where: { enabled: true } });
      if (!sources.length) return;
      if (!(await this.tg.isLoggedIn())) { this.logger.warn('Telegram 未登录，跳过养眼图片同步'); return; }
      for (const s of sources) {
        try { await this.syncSource(s); } catch (e: any) { this.logger.warn(`sync ${s.channel}: ${e?.message ?? e}`); }
      }
    } finally {
      this.running = false;
    }
  }

  /** 保留期 + 每受众总量上限：超出的帖子连文件删 */
  async purgeOld() {
    const { days } = await this.settings();
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const old = await this.prisma.galleryPost.findMany({ where: { postedAt: { lt: cutoff } }, select: { id: true, media: true }, take: 500 });
    const over: { id: bigint; media: string }[] = [];
    for (const audience of [1, 2]) {
      over.push(...(await this.prisma.galleryPost.findMany({ where: { audience }, orderBy: { id: 'desc' }, skip: MAX_POSTS_PER_AUDIENCE, select: { id: true, media: true }, take: 500 })));
    }
    const all = new Map<string, { id: bigint; media: string }>();
    for (const p of [...old, ...over]) all.set(p.id.toString(), p);
    if (!all.size) return { removed: 0 };
    const rows = [...all.values()];
    await this.prisma.galleryPost.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    await this.removeFiles(rows.map((r) => r.media));
    this.logger.log(`purged ${rows.length} gallery posts (older than ${days} days / over limit)`);
    return { removed: rows.length };
  }

  private async removePostsOf(sourceId: number) {
    const rows = await this.prisma.galleryPost.findMany({ where: { sourceId }, select: { media: true } });
    if (!rows.length) return;
    await this.prisma.galleryPost.deleteMany({ where: { sourceId } });
    await this.removeFiles(rows.map((r) => r.media));
  }

  private async removeFiles(mediaJsons: string[]) {
    for (const j of mediaJsons) {
      for (const m of safeJson<GalleryMedia[]>(j, [])) {
        await this.uploads.remove(m.url);
        if (m.cover) await this.uploads.remove(m.cover);
      }
    }
  }

  // ---------- 同步 ----------

  private async syncSource(src: { id: number; channel: string; audience: number; lastMsgId: number; blockWords?: string }) {
    const client = await this.tg.authorized();
    const { days } = await this.settings();
    const cutoff = Date.now() - days * 86_400_000;
    const blockWords = (src.blockWords ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    let imported = 0, skipped = 0, maxId = src.lastMsgId;
    let error = '';
    try {
      const entity = await client.getEntity(src.channel);
      const msgs = await client.getMessages(entity, { limit: src.lastMsgId ? 100 : FIRST_SCAN, minId: src.lastMsgId || 0 });
      const fresh = [...msgs].filter((m) => m.id > src.lastMsgId).sort((a, b) => a.id - b.id);

      // 相册（groupedId 相同）合成一条；纯文字消息也算一组（但没媒体会被跳过）
      const groups: { key: string; msgs: Api.Message[] }[] = [];
      for (const m of fresh) {
        const key = m.groupedId ? `g${m.groupedId.toString()}` : `m${m.id}`;
        const g = groups.find((x) => x.key === key);
        if (g) g.msgs.push(m); else groups.push({ key, msgs: [m] });
      }

      let files = 0, bytes = 0;
      for (const g of groups) {
        const last = Math.max(...g.msgs.map((m) => m.id));
        const first = g.msgs[0];
        const date = new Date(first.date * 1000);
        if (date.getTime() < cutoff) { maxId = Math.max(maxId, last); skipped++; continue; }
        const medias = g.msgs.map(parseMedia).filter((x): x is TgMedia => !!x && (x.kind === 'photo' || x.size <= MAX_VIDEO_BYTES));
        if (!medias.length) { maxId = Math.max(maxId, last); skipped++; continue; }
        const groupBytes = medias.reduce((s, m) => s + m.size, 0);
        if (files > 0 && (files + medias.length > MAX_FILES_PER_ROUND || bytes + groupBytes > MAX_BYTES_PER_ROUND)) break; // 下一轮接着
        const text = cleanText(g.msgs.map((m) => m.message || '').find((t) => t.trim()) ?? '', blockWords);
        // 文案像广告只是把文案丢掉，图片/视频照样进（这类频道的图没问题，问题都在文字）
        const sourceKey = `tg:${src.channel}:${g.key}`.slice(0, 120);
        if (await this.prisma.galleryPost.findUnique({ where: { sourceKey }, select: { id: true } })) { maxId = Math.max(maxId, last); continue; }

        const saved: GalleryMedia[] = [];
        for (const m of medias) {
          try {
            const item = await this.download(client, m);
            if (item) { saved.push(item); files++; bytes += item.size; }
          } catch (e: any) {
            this.logger.warn(`media ${src.channel}#${m.msg.id}: ${e?.message ?? e}`);
          }
        }
        if (!saved.length) { maxId = Math.max(maxId, last); skipped++; continue; }
        await this.prisma.galleryPost.create({
          data: {
            sourceId: src.id, audience: src.audience, sourceKey,
            text: looksLikeSpam(text) ? '' : text.slice(0, 2000), media: JSON.stringify(saved),
            viewCount: first.views ?? 0, postedAt: date,
          },
        });
        imported++;
        maxId = Math.max(maxId, last);
        await this.prisma.gallerySource.update({ where: { id: src.id }, data: { lastMsgId: maxId } });
      }
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
      throw e;
    } finally {
      await this.prisma.gallerySource.update({
        where: { id: src.id },
        data: { lastMsgId: maxId, lastSyncAt: new Date(), lastError: error, importedCount: { increment: imported } },
      });
    }
    this.logger.log(`sync ${src.channel}(a${src.audience}): +${imported} skipped ${skipped} lastMsgId=${maxId}`);
    return { imported, skipped, lastMsgId: maxId };
  }

  /** 下载一张图 / 一个视频（含封面）并转存 */
  private async download(client: Awaited<ReturnType<TelegramClientService['authorized']>>, m: TgMedia): Promise<GalleryMedia | null> {
    const buf = await client.downloadMedia(m.msg, {});
    if (!Buffer.isBuffer(buf) || buf.length < 512) return null;
    if (m.kind === 'photo') {
      const { url } = await this.uploads.putInternal('gallery', 'jpg', buf, 'image/jpeg');
      return { type: 'image', url, w: m.w, h: m.h, size: buf.length };
    }
    const ext = m.mime.includes('quicktime') ? 'mov' : 'mp4';
    const { url } = await this.uploads.putInternal('gallery-video', ext, buf, m.mime || 'video/mp4');
    let cover = '';
    if (m.thumb) {
      try {
        const t = await client.downloadMedia(m.msg, { thumb: m.thumb });
        if (Buffer.isBuffer(t) && t.length > 100) cover = (await this.uploads.putInternal('gallery-cover', 'jpg', t, 'image/jpeg')).url;
      } catch { /* 没封面也能播 */ }
    }
    return { type: 'video', url, cover, w: m.w, h: m.h, duration: m.duration, size: buf.length };
  }
}

/** 解析一条消息的媒体：图片 或 视频（不含语音、圆形视频、贴纸、GIF 以外的文件） */
function parseMedia(msg: Api.Message): TgMedia | null {
  const media = msg.media;
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    let w = 0, h = 0;
    for (const s of media.photo.sizes) {
      if (s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive) { if (s.w > w) { w = s.w; h = s.h; } }
    }
    return { msg, kind: 'photo', w, h, duration: 0, size: 0, mime: 'image/jpeg' };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    if (!/^video\//.test(doc.mimeType ?? '')) return null;
    let w = 0, h = 0, duration = 0, round = false, animated = false;
    for (const a of doc.attributes) {
      if (a instanceof Api.DocumentAttributeVideo) { w = a.w; h = a.h; duration = Math.round(a.duration ?? 0); round = !!a.roundMessage; }
      if (a instanceof Api.DocumentAttributeAnimated) animated = true;
    }
    if (round) return null;
    let thumb: Api.TypePhotoSize | undefined, best = -1;
    for (const t of doc.thumbs ?? []) {
      const b = t instanceof Api.PhotoSize ? t.size : t instanceof Api.PhotoSizeProgressive ? Math.max(...t.sizes) : -1;
      if (b > best) { best = b; thumb = t; }
    }
    return { msg, kind: 'video', w, h, duration: animated ? 0 : duration, size: Number(doc.size?.toString() ?? 0), mime: doc.mimeType || 'video/mp4', thumb };
  }
  return null;
}

/** 内置的广告/引流行特征：VPN、防走丢、广告联系/合作、投稿、👉、订阅/关注频道、加群、下载、telegram/tg 引流、空的「频道:」 */
const AD_LINE = /VPN|防走丢|防失联|广告(联系|合作|投放)|商务合作|投稿|👉|👇|订阅频道|关注频道|加群|进群|下载(安装|地址|链接)|telegram|电报群|tg群|频道\s*[:：]\s*$/i;

/**
 * 文案清洗：去掉带链接/@ 的行（频道签名），再去掉命中内置广告特征或来源自定义屏蔽词的行；
 * 只删行不删帖，图片/视频照常进。
 */
function cleanText(raw: string, blockWords: string[] = []): string {
  return stripLinkLines(raw)
    .split('\n')
    .filter((l) => !AD_LINE.test(l) && !blockWords.some((w) => l.includes(w)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
