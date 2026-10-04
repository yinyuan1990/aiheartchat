import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { GroupService } from './group.service';
import { fetchImage, paintPollinations, sleep, toPng } from './ai-avatar';

/**
 * 币群头像：转存到自己的 MinIO（国内打得开），一个群一次，后台排队做。
 * 来源依次：钱包传来的代币图标 → 合约群按币种符号取 CoinCap 图标 → Pollinations 按币名画一个（ai-avatar.ts）。
 * 失败的群 1 小时内不再试；启动后把还没转存的币群补一遍。
 */

export type CoinAvatarJob = { groupId: bigint; key: string; perp: boolean; symbol: string; name?: string; image?: string };

const RETRY_AFTER_MS = 3_600_000;
const MAX_QUEUE = 200;
const isOwn = (url: string) => url.startsWith('/res/');

@Injectable()
export class CoinAvatarService implements OnApplicationBootstrap {
  private readonly logger = new Logger('CoinAvatar');
  private queue: CoinAvatarJob[] = [];
  private queued = new Set<string>();
  private failedAt = new Map<string, number>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
    private readonly groups: GroupService,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.backfill().catch((e) => this.logger.warn(`backfill: ${e?.message ?? e}`)), 30_000);
  }

  /** 群头像还不是自己存储里的图，就排队转存 / 生成一张 */
  ensure(job: CoinAvatarJob, current = '') {
    if (isOwn(current)) return;
    const id = job.groupId.toString();
    if (this.queued.has(id) || this.queue.length >= MAX_QUEUE) return;
    if (Date.now() - (this.failedAt.get(id) ?? 0) < RETRY_AFTER_MS) return;
    this.queued.add(id);
    this.queue.push(job);
    void this.drain();
  }

  private async backfill() {
    const rows = await this.prisma.coinGroup.findMany({ select: { chain: true, address: true, groupId: true }, take: 500 });
    if (!rows.length) return;
    const groups = await this.prisma.chatGroup.findMany({ where: { id: { in: rows.map((r) => r.groupId) }, status: 0 }, select: { id: true, name: true, avatar: true } });
    const byId = new Map(groups.map((g) => [g.id.toString(), g]));
    for (const r of rows) {
      const g = byId.get(r.groupId.toString());
      if (!g || isOwn(g.avatar)) continue;
      const perp = r.chain === 'hl';
      const symbol = perp ? r.address : g.name.replace(/^\$/, '').replace(/\s*讨论群$/, '');
      this.ensure({ groupId: g.id, key: `${r.chain}:${r.address}`, perp, symbol, image: g.avatar || undefined }, g.avatar);
    }
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        const id = job.groupId.toString();
        try {
          const png = await this.paint(job);
          const { url } = await this.upload.putInternal('group-avatar', 'png', png, 'image/png');
          await this.groups.setAvatar(job.groupId, url);
          this.failedAt.delete(id);
        } catch (e: any) {
          this.failedAt.set(id, Date.now());
          this.logger.warn(`${job.key}: ${e?.message ?? e}`);
        }
        this.queued.delete(id);
        await sleep(2_000);
      }
    } finally {
      this.running = false;
    }
  }

  private async paint(job: CoinAvatarJob): Promise<Buffer> {
    const sources: string[] = [];
    if (job.image && /^https:\/\//.test(job.image)) sources.push(job.image);
    // Hyperliquid 的 kPEPE = 1000 PEPE
    if (job.perp) sources.push(`https://assets.coincap.io/assets/icons/${job.symbol.replace(/^k(?=[A-Z])/, '').toLowerCase()}@2x.png`);
    for (const url of sources) {
      try {
        return await toPng(await fetchImage(url, 20_000), false);
      } catch {}
    }
    const what = job.perp ? `the ${job.symbol} cryptocurrency` : `a crypto meme token called ${job.name || job.symbol} ($${job.symbol})`;
    return paintPollinations(`Round coin logo for ${what}, one simple mascot or symbol in the centre, flat vector, bold shapes, high contrast, plain background, no text, no letters, no watermark.`, `coin-avatar:${job.key}`);
  }
}
