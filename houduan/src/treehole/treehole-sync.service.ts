import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';

/** 从 t.me/s/频道 网页预览里解析出的一条帖子 */
export interface TgPost {
  msgId: number;
  text: string;
  photos: string[];
  views: number;
  date: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** 树洞只保留最近 3 天：更早的帖子连同评论、图片一起物理删除 */
const RETENTION_MS = 3 * 24 * 3600 * 1000;

/**
 * 私密树洞 · Telegram 公开频道自动同步。
 * 不需要是频道管理员、不需要 Bot、不需要登录：只要频道有 @用户名，
 * Telegram 就提供网页预览 https://t.me/s/<频道>，这里定时抓取解析（文字 + 图片 + 阅读数），
 * 图片转存到自己的 MinIO 后以 source=2 匿名写入树洞；按消息 id 去重，只同步比上次更新的。
 */
@Injectable()
export class TreeholeSyncService implements OnModuleInit {
  private readonly logger = new Logger('TreeholeSync');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.tick(), 20_000);
    setInterval(() => void this.tick(), 10 * 60 * 1000);
  }

  // ---------- 后台配置 ----------

  listSources() {
    return this.prisma.treeholeSource.findMany({ orderBy: { id: 'asc' } });
  }

  async saveSource(data: { id?: number; channel: string; enabled?: boolean; minViews?: number; stripLinks?: boolean; blockWords?: string }) {
    const channel = normalizeChannel(data.channel);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const clean = {
      channel,
      enabled: data.enabled ?? true,
      minViews: Math.max(0, Number(data.minViews) || 0),
      stripLinks: data.stripLinks ?? true,
      blockWords: (data.blockWords ?? '').trim().slice(0, 500),
    };
    if (data.id) return this.prisma.treeholeSource.update({ where: { id: Number(data.id) }, data: clean });
    return this.prisma.treeholeSource.upsert({ where: { channel }, update: clean, create: clean });
  }

  async removeSource(id: number) {
    await this.prisma.treeholeSource.delete({ where: { id } });
    return { ok: true };
  }

  /** 预览：抓一页解析出来给后台看（不入库），顺便验证频道是否公开可抓 */
  async preview(channelRaw: string) {
    const channel = normalizeChannel(channelRaw);
    if (!channel) throw new BadRequestException('请填写频道用户名');
    const posts = await this.fetchPage(channel);
    return { channel, count: posts.length, posts: posts.slice(-10).reverse() };
  }

  /** 手动同步一个来源（后台按钮）；full=true 时从头往前翻最多 N 页做首次回灌 */
  async syncOne(id: number, full = false) {
    const src = await this.prisma.treeholeSource.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('来源不存在');
    return this.syncSource(src, full);
  }

  // ---------- 定时 ----------

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.purgeOld().catch((e) => this.logger.warn(`purge failed: ${e?.message ?? e}`));
      const sources = await this.prisma.treeholeSource.findMany({ where: { enabled: true } });
      for (const s of sources) {
        try { await this.syncSource(s, false); } catch (e: any) { this.logger.warn(`sync ${s.channel} failed: ${e?.message ?? e}`); }
      }
    } finally {
      this.running = false;
    }
  }

  /** 3 天保留期：删除过期帖子（所有来源）+ 其评论 + 转存的图片 */
  async purgeOld() {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const old = await this.prisma.treeholePost.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, images: true },
      take: 500,
    });
    if (!old.length) return { removed: 0 };
    const ids = old.map((p) => p.id);
    await this.prisma.$transaction([
      this.prisma.treeholeComment.deleteMany({ where: { postId: { in: ids } } }),
      this.prisma.treeholePost.deleteMany({ where: { id: { in: ids } } }),
    ]);
    for (const p of old) {
      let imgs: string[] = [];
      try { imgs = JSON.parse(p.images || '[]'); } catch { /* ignore */ }
      for (const u of imgs) await this.uploads.remove(u);
    }
    this.logger.log(`purged ${old.length} treehole posts older than 3 days`);
    return { removed: old.length };
  }

  private async syncSource(src: { id: number; channel: string; minViews: number; stripLinks: boolean; blockWords: string; lastMsgId: number }, full: boolean) {
    const block = src.blockWords.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    let imported = 0, skipped = 0, maxId = src.lastMsgId;
    let error = '';
    try {
      // 首次（lastMsgId=0）或 full：往前翻最多 5 页（≈100 条）；平时只看最新一页
      const pages = full || src.lastMsgId === 0 ? 5 : 1;
      let before: number | undefined;
      const all: TgPost[] = [];
      for (let i = 0; i < pages; i++) {
        const page = await this.fetchPage(src.channel, before);
        if (!page.length) break;
        all.push(...page);
        const minOnPage = Math.min(...page.map((p) => p.msgId));
        if (!full && minOnPage <= src.lastMsgId) break;
        before = minOnPage;
      }
      const fresh = all.filter((p) => p.msgId > src.lastMsgId).sort((a, b) => a.msgId - b.msgId);
      const cutoff = Date.now() - RETENTION_MS;
      for (const p of fresh) {
        maxId = Math.max(maxId, p.msgId);
        const text = src.stripLinks ? stripLinkLines(p.text) : p.text;
        // 超过保留期的历史帖不导（导进来也会被清理）
        if (p.date && new Date(p.date).getTime() < cutoff) { skipped++; continue; }
        if (p.views < src.minViews) { skipped++; continue; }
        if (!text.trim() && p.photos.length === 0) { skipped++; continue; }
        if (block.some((w) => text.includes(w)) || looksLikeSpam(text)) { skipped++; continue; }
        const key = `tg:${src.channel}:${p.msgId}`;
        const exists = await this.prisma.treeholePost.findUnique({ where: { sourceKey: key }, select: { id: true } });
        if (exists) continue;
        const images: string[] = [];
        for (const url of p.photos.slice(0, 9)) {
          const saved = await this.mirrorPhoto(url).catch((e) => { this.logger.warn(`photo ${url}: ${e?.message}`); return ''; });
          if (saved) images.push(saved);
        }
        if (!text.trim() && images.length === 0) { skipped++; continue; }
        await this.prisma.treeholePost.create({
          data: {
            authorId: null, source: 2, sourceKey: key,
            content: text.trim().slice(0, 3000),
            images: JSON.stringify(images),
            // 沿用频道里的阅读数当初始值，看起来更真实
            viewCount: p.views,
            createdAt: p.date ? new Date(p.date) : new Date(),
          },
        });
        imported++;
      }
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
      throw e;
    } finally {
      await this.prisma.treeholeSource.update({
        where: { id: src.id },
        data: { lastMsgId: maxId, lastSyncAt: new Date(), lastError: error, importedCount: { increment: imported } },
      });
    }
    this.logger.log(`sync ${src.channel}: +${imported} skipped ${skipped} lastMsgId=${maxId}`);
    return { imported, skipped, lastMsgId: maxId };
  }

  // ---------- 抓取与解析 ----------

  /** 抓一页（默认最新约 20 条；before=消息 id 时抓更早的一页） */
  async fetchPage(channel: string, before?: number): Promise<TgPost[]> {
    const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`t.me 返回 ${res.status}`);
    const html = await res.text();
    if (!html.includes('tgme_widget_message_wrap')) {
      if (html.includes('tgme_page_description') || html.includes('tgme_action')) throw new Error('该频道没有开放网页预览（可能是私有频道或群组，需要 @用户名 的公开频道）');
      throw new Error('没有解析到消息，频道名是否正确？');
    }
    return parseChannelPage(html);
  }

  /** 把 Telegram CDN 图片转存到自己的对象存储，返回 /res/ 路径 */
  private async mirrorPhoto(url: string): Promise<string> {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`图片下载失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mimetype = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const { url: saved } = await this.uploads.upload('image', { buffer: buf, mimetype, size: buf.length });
    return saved;
  }
}

/** 内置垃圾识别：赌博/担保/引流广告（关键词 或 emoji 刷屏） */
const SPAM_RE = /担保|充提|飞投|博彩|棋牌|娱乐城|开户|USDT|\.COM\b|\.VIP\b|加微|约炮|赌|下注|返水|上分|代理招募|一手盘|菠菜/i;
export function looksLikeSpam(text: string): boolean {
  if (SPAM_RE.test(text)) return true;
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  return emojis >= 8 && emojis * 4 > text.replace(/\s/g, '').length;
}

export function normalizeChannel(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^https?:\/\/(www\.)?t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{3,63}$/.test(s) ? s : '';
}

/** 去掉含 @用户名 / t.me 链接的整行（频道签名、投稿引流），并压缩多余空行 */
export function stripLinkLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/(^|\s)@[A-Za-z0-9_]{4,}/.test(line) && !/t\.me\//i.test(line) && !/https?:\/\//i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解析 t.me/s 页面：每条 .tgme_widget_message_wrap 里取 data-post、正文、图片、阅读数、时间 */
export function parseChannelPage(html: string): TgPost[] {
  const out: TgPost[] = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const idM = b.match(/data-post="[^"/]+\/(\d+)"/);
    if (!idM) continue;
    const msgId = Number(idM[1]);
    const textM = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = textM ? htmlToText(textM[1]) : '';
    const photos: string[] = [];
    const photoRe = /tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/g;
    let m: RegExpExecArray | null;
    while ((m = photoRe.exec(b))) photos.push(m[1]);
    const viewsM = b.match(/tgme_widget_message_views">([^<]+)</);
    const dateM = b.match(/<time[^>]*datetime="([^"]+)"/);
    out.push({ msgId, text, photos, views: parseViews(viewsM?.[1] ?? '0'), date: dateM?.[1] ?? '' });
  }
  return out;
}

function parseViews(s: string): number {
  const t = s.trim().toUpperCase();
  const n = parseFloat(t.replace(/[^\d.]/g, '')) || 0;
  return Math.round(t.endsWith('M') ? n * 1_000_000 : t.endsWith('K') ? n * 1000 : n);
}

function htmlToText(h: string): string {
  return h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
