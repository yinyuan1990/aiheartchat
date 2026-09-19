import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Api } from 'telegram';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { TelegramClientService } from '../telegram/telegram.service';

/** 单个音频文件上限（频道里的 DJ 曲一般 80~120MB） */
const MAX_FILE_BYTES = 300 * 1024 * 1024;
/** 每个来源每轮最多下载的条数（一首 100MB 要下载几十秒，别一次拖太多） */
const MAX_PER_ROUND = 10;
/** 曲目只按数量保留：超过 100 首才删最旧的（连文件一起），与天数无关 */
export const MAX_TRACKS = 100;
/** 首次同步往前扫的消息条数 */
const FIRST_SCAN = 60;

/** 从频道消息里解析出的一条音频（预览/同步共用） */
export interface TgAudio {
  msgId: number;
  title: string;
  performer: string;
  duration: number;
  size: number;
  mime: string;
  fileName: string;
  date: Date;
  hasCover: boolean;
}

/**
 * 音乐频道（消息页「私聊」tab 置顶入口，替代原花边新闻）
 *
 * 通过已登录的 Telegram 用户账号读取来源频道的音频消息，文件转存到 MinIO 后入库，
 * 客户端直接拿 /res/ 地址播放。曲目最多保留 MAX_TRACKS 首，超出删最旧的。
 */
@Injectable()
export class MusicService implements OnModuleInit {
  private readonly logger = new Logger('Music');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
    private readonly tg: TelegramClientService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.tick(), 30_000);
    setInterval(() => void this.tick(), 10 * 60 * 1000);
  }

  // ---------- 对外接口（登录用户） ----------

  /** 曲目列表：最新在前，beforeId 翻页；附带来源标题给页面标题用 */
  async list(beforeId?: bigint) {
    const [tracks, sources] = await Promise.all([
      this.prisma.musicTrack.findMany({
        where: beforeId ? { id: { lt: beforeId } } : undefined,
        orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
        take: MAX_TRACKS,
        select: { id: true, title: true, performer: true, duration: true, size: true, url: true, cover: true, postedAt: true, playCount: true },
      }),
      this.prisma.musicSource.findMany({ where: { enabled: true }, select: { title: true, channel: true }, orderBy: { id: 'asc' } }),
    ]);
    return {
      source: sources[0] ? { title: sources[0].title || sources[0].channel, channel: sources[0].channel } : null,
      list: tracks,
    };
  }

  /** 播放计数（客户端开始播放时调一下，失败无所谓） */
  async played(id: bigint) {
    await this.prisma.musicTrack.update({ where: { id }, data: { playCount: { increment: 1 } } }).catch(() => {});
    return { ok: true };
  }

  // ---------- 后台：来源管理 ----------

  async listSources() {
    const rows = await this.prisma.musicSource.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => ({ ...r, syncing: this.running }));
  }

  /**
   * 预览：解析频道并列出最近的音频（不入库）。后台改来源时先调这个核对标题/内容对不对得上。
   */
  async preview(channelRaw: string) {
    const channel = normalizeChannel(channelRaw);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    const { audios, scanned } = await this.fetchAudios(info.entity, { limit: 30 });
    // 保存后首次同步会导入的数量（按首次扫描条数与总量上限估算）
    const recent = Math.min(audios.length, FIRST_SCAN, MAX_TRACKS);
    return {
      channel: info.username,
      title: info.title,
      subscribers: info.subscribers,
      about: info.about.slice(0, 300),
      scanned,
      audioCount: audios.length,
      recentCount: recent,
      audios: audios.slice(0, 15).map((a) => ({ ...a, date: a.date.toISOString() })),
    };
  }

  /** 保存来源：会先解析频道，解析不到（拼错/私有/不是频道）直接报错不保存 */
  async saveSource(data: { id?: number; channel: string; enabled?: boolean }) {
    const channel = normalizeChannel(data.channel);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    const clean = { channel: info.username, title: info.title.slice(0, 120), subscribers: info.subscribers, enabled: data.enabled ?? true };
    if (data.id) {
      const old = await this.prisma.musicSource.findUnique({ where: { id: Number(data.id) } });
      if (!old) throw new NotFoundException('来源不存在');
      // 换了频道：老频道的曲目连文件一起清掉，游标归零
      if (old.channel.toLowerCase() !== clean.channel.toLowerCase()) {
        await this.removeTracksOf(old.id);
        return this.prisma.musicSource.update({ where: { id: old.id }, data: { ...clean, lastMsgId: 0, lastError: '', importedCount: 0 } });
      }
      return this.prisma.musicSource.update({ where: { id: old.id }, data: clean });
    }
    return this.prisma.musicSource.upsert({ where: { channel: clean.channel }, update: clean, create: clean });
  }

  async removeSource(id: number) {
    await this.removeTracksOf(id);
    await this.prisma.musicSource.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * 手动同步一个来源（后台按钮）：下载十几首 100MB 的文件要好几分钟，超过 nginx 超时，
   * 所以后台异步跑，立刻返回；前端轮询 sources 的 lastSyncAt / importedCount 看进度。
   */
  async syncOne(id: number) {
    const src = await this.prisma.musicSource.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('来源不存在');
    if (this.running) return { started: false, running: true };
    this.running = true;
    void (async () => {
      try {
        await this.syncSource(src);
      } catch (e: any) {
        this.logger.warn(`manual sync ${src.channel} failed: ${e?.message ?? e}`);
      } finally {
        this.running = false;
      }
    })();
    return { started: true, running: true };
  }

  /** 当前是否有同步任务在跑（后台轮询用） */
  get syncing() {
    return this.running;
  }

  /** 后台曲目列表（含来源） */
  async adminTracks(beforeId?: bigint) {
    return this.prisma.musicTrack.findMany({
      where: beforeId ? { id: { lt: beforeId } } : undefined,
      orderBy: { id: 'desc' },
      take: 100,
    });
  }

  async adminDeleteTrack(id: bigint) {
    const t = await this.prisma.musicTrack.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('曲目不存在');
    await this.prisma.musicTrack.delete({ where: { id } });
    await this.uploads.remove(t.url);
    if (t.cover) await this.uploads.remove(t.cover);
    return { ok: true };
  }

  // ---------- 定时 ----------

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.purgeOld().catch((e) => this.logger.warn(`purge failed: ${e?.message ?? e}`));
      const sources = await this.prisma.musicSource.findMany({ where: { enabled: true } });
      if (!sources.length) return;
      if (!(await this.tg.isLoggedIn())) {
        this.logger.warn('Telegram 未登录，跳过音乐同步');
        return;
      }
      for (const s of sources) {
        try { await this.syncSource(s); } catch (e: any) { this.logger.warn(`sync ${s.channel} failed: ${e?.message ?? e}`); }
      }
    } finally {
      this.running = false;
    }
  }

  /** 只按数量保留：超过 MAX_TRACKS 首时把最旧（按发布时间）的连文件删除；与天数无关 */
  async purgeOld() {
    const rows = await this.prisma.musicTrack.findMany({
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      skip: MAX_TRACKS,
      select: { id: true, url: true, cover: true },
      take: 500,
    });
    if (!rows.length) return { removed: 0 };
    await this.prisma.musicTrack.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const t of rows) {
      await this.uploads.remove(t.url);
      if (t.cover) await this.uploads.remove(t.cover);
    }
    this.logger.log(`purged ${rows.length} tracks (over ${MAX_TRACKS})`);
    return { removed: rows.length };
  }

  private async removeTracksOf(sourceId: number) {
    const rows = await this.prisma.musicTrack.findMany({ where: { sourceId }, select: { id: true, url: true, cover: true } });
    if (!rows.length) return;
    await this.prisma.musicTrack.deleteMany({ where: { sourceId } });
    for (const t of rows) {
      await this.uploads.remove(t.url);
      if (t.cover) await this.uploads.remove(t.cover);
    }
  }

  private async syncSource(src: { id: number; channel: string; lastMsgId: number }) {
    const client = await this.tg.authorized();
    let imported = 0, skipped = 0, maxId = src.lastMsgId;
    let error = '';
    try {
      const entity = await client.getEntity(src.channel);
      // 只看比上次更新的消息；首次同步扫最近 FIRST_SCAN 条
      const { messages } = await this.fetchAudios(entity, { limit: src.lastMsgId ? 100 : FIRST_SCAN, minId: src.lastMsgId || undefined });
      // 旧→新处理，游标只推进到已处理的那条：一轮下不完（MAX_PER_ROUND）的下一轮从断点接着
      const fresh = messages.filter((m) => m.audio.msgId > src.lastMsgId).sort((a, b) => a.audio.msgId - b.audio.msgId);
      let downloaded = 0;
      for (const { msg, audio } of fresh) {
        if (audio.size > MAX_FILE_BYTES || audio.size <= 0) { maxId = Math.max(maxId, audio.msgId); skipped++; continue; }
        if (downloaded >= MAX_PER_ROUND) break; // 剩下的下一轮接着（游标不推进）
        const key = `tg:${src.channel}:${audio.msgId}`;
        const exists = await this.prisma.musicTrack.findUnique({ where: { sourceKey: key }, select: { id: true } });
        if (exists) { maxId = Math.max(maxId, audio.msgId); continue; }
        // 频道隔一两天会把同一批歌重发：同标题 + 同大小视为同一首，把已有那条的发布时间刷新即可，不再下载
        const dup = await this.prisma.musicTrack.findFirst({
          where: { sourceId: src.id, title: audio.title.slice(0, 200), size: audio.size },
          select: { id: true, postedAt: true },
        });
        if (dup) {
          if (audio.date > dup.postedAt) await this.prisma.musicTrack.update({ where: { id: dup.id }, data: { postedAt: audio.date } });
          maxId = Math.max(maxId, audio.msgId); skipped++;
          continue;
        }

        const started = Date.now();
        const buf = await client.downloadMedia(msg, {});
        if (!Buffer.isBuffer(buf) || buf.length < 1024) { maxId = Math.max(maxId, audio.msgId); skipped++; continue; }
        const ext = pickExt(audio.mime, audio.fileName);
        const { url } = await this.uploads.putInternal('music', ext, buf, audio.mime || 'audio/mpeg', {
          // 浏览器/播放器拿到中文文件名
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${audio.title}.${ext}`)}`,
        });
        let cover = '';
        const coverSize = audio.hasCover ? largestThumb(msg) : undefined;
        if (coverSize) {
          try {
            const thumb = await client.downloadMedia(msg, { thumb: coverSize });
            if (Buffer.isBuffer(thumb) && thumb.length > 100) cover = (await this.uploads.putInternal('music-cover', 'jpg', thumb, 'image/jpeg')).url;
          } catch (e: any) {
            this.logger.warn(`cover ${key}: ${e?.message ?? e}`);
          }
        }
        await this.prisma.musicTrack.create({
          data: {
            sourceId: src.id, sourceKey: key,
            title: audio.title.slice(0, 200), performer: audio.performer.slice(0, 120),
            duration: audio.duration, size: buf.length, mime: audio.mime || 'audio/mpeg',
            url, cover, postedAt: audio.date,
          },
        });
        imported++; downloaded++;
        maxId = Math.max(maxId, audio.msgId);
        this.logger.log(`+ ${audio.title} (${(buf.length / 1048576).toFixed(1)}MB, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
        // 边同步边推进游标，进程中途重启不会重复下载
        await this.prisma.musicSource.update({ where: { id: src.id }, data: { lastMsgId: maxId } });
      }
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
      throw e;
    } finally {
      await this.prisma.musicSource.update({
        where: { id: src.id },
        data: { lastMsgId: maxId, lastSyncAt: new Date(), lastError: error, importedCount: { increment: imported } },
      });
    }
    this.logger.log(`sync ${src.channel}: +${imported} skipped ${skipped} lastMsgId=${maxId}`);
    return { imported, skipped, lastMsgId: maxId };
  }

  // ---------- 读取频道音频消息 ----------

  /**
   * 拉取频道最近的音频消息（用 Telegram 的音乐过滤器，语音消息不算）。
   * 返回 messages（含原始 msg 用于下载）与 audios（纯数据，预览用）。
   */
  private async fetchAudios(entity: Api.TypeEntityLike, opt: { limit: number; minId?: number }) {
    const client = await this.tg.authorized();
    const msgs = await client.getMessages(entity, {
      limit: opt.limit,
      minId: opt.minId ?? 0,
      filter: new Api.InputMessagesFilterMusic(),
    });
    const messages: { msg: Api.Message; audio: TgAudio }[] = [];
    for (const msg of msgs) {
      const audio = parseAudio(msg);
      if (audio) messages.push({ msg, audio });
    }
    return { messages, audios: messages.map((m) => m.audio), scanned: msgs.length };
  }
}

/** 从一条消息里取音频信息；不是音频文件（或是语音）返回 null */
export function parseAudio(msg: Api.Message): TgAudio | null {
  const media = msg.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) return null;
  const doc = media.document;
  let title = '', performer = '', duration = 0, fileName = '';
  let isAudio = false;
  for (const a of doc.attributes) {
    if (a instanceof Api.DocumentAttributeAudio) {
      if (a.voice) return null;
      isAudio = true;
      title = a.title ?? '';
      performer = a.performer ?? '';
      duration = a.duration ?? 0;
    } else if (a instanceof Api.DocumentAttributeFilename) {
      fileName = a.fileName ?? '';
    }
  }
  if (!isAudio && !/^audio\//.test(doc.mimeType ?? '')) return null;
  if (!title) title = fileName.replace(/\.[a-z0-9]{2,5}$/i, '') || (msg.message || '').split('\n')[0].trim() || `未命名 ${msg.id}`;
  return {
    msgId: msg.id,
    title: title.trim(),
    performer: performer.trim(),
    duration,
    size: Number(doc.size?.toString() ?? 0),
    mime: doc.mimeType || 'audio/mpeg',
    fileName,
    date: new Date(msg.date * 1000),
    hasCover: (doc.thumbs ?? []).some((t) => t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive),
  };
}

/** 文档内嵌封面里最大的一张（PhotoSize / Progressive），没有返回 undefined */
function largestThumb(msg: Api.Message): Api.TypePhotoSize | undefined {
  const media = msg.media;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) return undefined;
  let best: Api.TypePhotoSize | undefined;
  let bestBytes = -1;
  for (const t of media.document.thumbs ?? []) {
    const bytes = t instanceof Api.PhotoSize ? t.size : t instanceof Api.PhotoSizeProgressive ? Math.max(...t.sizes) : -1;
    if (bytes > bestBytes) { bestBytes = bytes; best = t; }
  }
  return best;
}

export function normalizeChannel(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{3,63}$/.test(s) ? s : '';
}

function pickExt(mime: string, fileName: string): string {
  const fromName = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName && ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'mp4'].includes(fromName)) return fromName;
  const m = (mime || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  return 'mp3';
}
