import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { GroupService } from './group.service';

/**
 * 币群头像：转存到自己的 MinIO（国内打得开），一个群一次，后台排队做。
 * 来源依次：钱包传来的代币图标 → 合约群按币种符号取 CoinCap 图标 → Pollinations（Flux，免费、不要 key）按币名画一个。
 * Pollinations 免费档会在右下角打水印，所以画高一点、只留上面的正方形。统一用 ffmpeg 缩成 256×256 PNG。
 * 失败的群 1 小时内不再试；启动后把还没转存的币群补一遍。
 */

export type CoinAvatarJob = { groupId: bigint; key: string; perp: boolean; symbol: string; name?: string; image?: string };

const SIZE = 256;
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
    return toPng(await this.pollinations(job), true);
  }

  private async pollinations(job: CoinAvatarJob): Promise<Buffer> {
    const h = createHash('sha256').update(`coin-avatar:${job.key}`).digest();
    const what = job.perp ? `the ${job.symbol} cryptocurrency` : `a crypto meme token called ${job.name || job.symbol} ($${job.symbol})`;
    const prompt = `Round coin logo for ${what}, one simple mascot or symbol in the centre, flat vector, bold shapes, high contrast, plain background, no text, no letters, no watermark.`;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=576&nologo=true&model=flux&seed=${h.readUInt32BE(0) % 1_000_000_000}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchImage(url, 120_000);
      } catch (e: any) {
        if (attempt === 2) throw e;
        await sleep(8_000 * (attempt + 1));
      }
    }
    throw new Error('pollinations');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchImage(url: string, timeout: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'Peiwan/1.0' } });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) throw new Error(`${res.status} ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || buf.length > 8 * 1024 * 1024) throw new Error(`size ${buf.length}`);
  return buf;
}

/** 任意图片 → 256×256 PNG（居中裁成正方形）；topSquare 先只取上面的正方形（去掉 Pollinations 水印） */
async function toPng(input: Buffer, topSquare: boolean): Promise<Buffer> {
  const base = join(tmpdir(), `cav-${randomUUID()}`);
  const vf = `${topSquare ? 'crop=iw:iw:0:0,' : ''}scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`;
  try {
    await writeFile(`${base}.in`, input);
    await new Promise<void>((res, rej) =>
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.in`, '-frames:v', '1', '-vf', vf, `${base}.png`], { timeout: 60_000 }, (err, _o, stderr) =>
        err ? rej(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : res(),
      ),
    );
    const out = await readFile(`${base}.png`);
    if (out.length < 200) throw new Error('ffmpeg 输出为空');
    return out;
  } finally {
    await rm(`${base}.in`, { force: true });
    await rm(`${base}.png`, { force: true });
  }
}
