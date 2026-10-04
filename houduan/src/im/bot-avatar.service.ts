import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { paintPollinations, sleep } from './ai-avatar';

/**
 * 没头像的机器人（用户建的机器人、系统账号「币群助手」）用 Pollinations 画一个小机器人头像，转存到自己的 MinIO。
 * 配色 / 画风按账号 id 的哈希挑，每个机器人不一样；只在头像还是空的时候写，主人自己设过的不动。
 * 新建机器人没传头像时排队画；启动后把没头像的机器人补一遍。
 */

const SYSTEM_SUBJECT: Record<string, string> = {
  sys_coin_groups: 'a cute little robot hugging a big shiny gold crypto coin',
};
const PALETTES = ['mint and teal', 'coral and peach', 'electric blue and violet', 'gold and amber', 'pink and lilac', 'lime and emerald', 'navy and cyan', 'sunset orange and magenta', 'lavender and sky blue', 'turquoise and yellow'];
const STYLES = ['flat vector mascot', '3D clay render', 'kawaii sticker', 'glossy toy figure', 'soft gradient illustration'];
const MAX_QUEUE = 100;

@Injectable()
export class BotAvatarService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BotAvatar');
  private queue: bigint[] = [];
  private queued = new Set<string>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.backfill().catch((e) => this.logger.warn(`backfill: ${e?.message ?? e}`)), 45_000);
  }

  ensure(userId: bigint) {
    const id = userId.toString();
    if (this.queued.has(id) || this.queue.length >= MAX_QUEUE) return;
    this.queued.add(id);
    this.queue.push(userId);
    void this.drain();
  }

  private async backfill() {
    const rows = await this.prisma.user.findMany({ where: { isBot: true, status: 0, avatar: '' }, select: { id: true }, take: MAX_QUEUE });
    rows.forEach((r) => this.ensure(r.id));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          await this.paint(id);
        } catch (e: any) {
          this.logger.warn(`${id}: ${e?.message ?? e}`);
        }
        this.queued.delete(id.toString());
        await sleep(2_000);
      }
    } finally {
      this.running = false;
    }
  }

  private async paint(id: bigint) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { isBot: true, avatar: true, deviceId: true } });
    if (!u?.isBot || u.avatar) return;
    const h = createHash('sha256').update(`bot-avatar:${id}`).digest();
    const subject = SYSTEM_SUBJECT[u.deviceId] ?? 'a cute friendly robot assistant';
    const prompt = `Avatar of ${subject}, ${STYLES[h[0] % STYLES.length]}, ${PALETTES[h[1] % PALETTES.length]} color palette, centered, bold shapes, high contrast, simple plain background, no text, no letters, no watermark.`;
    const png = await paintPollinations(prompt, `bot-avatar:${id}`);
    const { url } = await this.upload.putInternal('avatar', 'png', png, 'image/png');
    // 画的这几十秒里主人可能自己设了头像
    await this.prisma.user.updateMany({ where: { id, avatar: '' }, data: { avatar: url } });
  }
}
