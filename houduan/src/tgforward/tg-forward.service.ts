import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Api, helpers } from 'telegram';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClientService } from '../telegram/telegram.service';
import { normalizeChannel } from '../music/music.service';

/** 目标频道默认值（操作者自己的推广频道） */
const DEFAULT_TARGET = 'smsd2030';
const TARGET_KEY = 'tg_forward_target';
/** 首次 / 手动「补几条」最多回灌多少条 */
const MAX_BACKFILL = 20;
/** 每条转发之间歇一下，别触发 FLOOD_WAIT */
const GAP_MS = 2500;
/** 每轮扫描来源新消息的上限 */
const SCAN_LIMIT = 50;

/**
 * 频道转发（推广小功能，和 App 内容无关）：
 * 后台配置若干别人的公开频道当「来源」，服务端每 10 分钟用已登录的 Telegram 账号把它们的新消息
 * `messages.ForwardMessages` 到我们自己的推广频道（目标，默认 @smsd2030，后台可改）。
 * - 账号必须是目标频道的管理员且有「发布消息」权限，否则 status() 会提示；
 * - 默认 dropAuthor：去掉「转发自 xx」头，看起来像自己发的；相册（groupedId 相同）整组一起转，保持是一条相册；
 * - 添加来源时游标定在当前最新一条，只转之后新发的（可选「补最近 N 条」立刻转几条看看效果）；
 * - 每来源每轮最多 maxPerRun 条、每条之间歇 2.5 秒，来源开了「禁止转发」会报错记在 lastError。
 */
@Injectable()
export class TgForwardService implements OnModuleInit {
  private readonly logger = new Logger('TgForward');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tg: TelegramClientService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.tick(), 90_000);
    setInterval(() => void this.tick(), 10 * 60 * 1000);
  }

  // ---------- 设置 ----------

  async target(): Promise<string> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: TARGET_KEY } });
    return normalizeChannel(row?.value ?? '') || DEFAULT_TARGET;
  }

  /** 后台：目标频道 + 账号在目标频道里的权限（能不能发） */
  async status() {
    const target = await this.target();
    const sources = await this.prisma.tgForwardSource.count();
    let title = '', subscribers = 0, canPost = false, error = '';
    try {
      const info = await this.tg.resolveChannel(target);
      title = info.title; subscribers = info.subscribers;
      canPost = await this.canPost(info.entity);
      if (!canPost) error = `登录的 Telegram 账号不是 @${target} 的管理员（或没有「发布消息」权限），转发会失败`;
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    return { target, title, subscribers, canPost, error, sources, running: this.running };
  }

  async saveTarget(raw: string) {
    const channel = normalizeChannel(raw);
    if (!channel) throw new BadRequestException('请填写目标频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    if (!(await this.canPost(info.entity))) throw new BadRequestException(`登录的 Telegram 账号不是 @${info.username} 的管理员（或没有「发布消息」权限）`);
    await this.prisma.sysSetting.upsert({ where: { key: TARGET_KEY }, create: { key: TARGET_KEY, value: info.username }, update: { value: info.username } });
    return this.status();
  }

  private async canPost(channel: Api.Channel): Promise<boolean> {
    if (channel.creator) return true;
    if (channel.adminRights?.postMessages) return true;
    // Channel 对象上的 adminRights 有时不带，问一次参与者信息
    try {
      const client = await this.tg.authorized();
      const r = await client.invoke(new Api.channels.GetParticipant({ channel, participant: new Api.InputPeerSelf() }));
      const p = r.participant;
      if (p instanceof Api.ChannelParticipantCreator) return true;
      if (p instanceof Api.ChannelParticipantAdmin) return !!p.adminRights.postMessages;
    } catch { /* 不是成员 */ }
    return false;
  }

  // ---------- 来源 ----------

  async listSources() {
    const rows = await this.prisma.tgForwardSource.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => ({ ...r, syncing: this.running }));
  }

  /** 预览：频道信息 + 最近几条消息（不入库），保存前核对 */
  async preview(channelRaw: string) {
    const channel = normalizeChannel(channelRaw);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    const client = await this.tg.authorized();
    const msgs = await client.getMessages(info.entity, { limit: 30 });
    const groups = groupMessages([...msgs].filter((m) => !(m instanceof Api.MessageService)).sort((a, b) => a.id - b.id)).reverse();
    return {
      channel: info.username,
      title: info.title,
      subscribers: info.subscribers,
      about: info.about.slice(0, 300),
      noforwards: !!info.entity.noforwards,
      latestMsgId: Math.max(0, ...msgs.map((m) => m.id)),
      samples: groups.slice(0, 8).map((g) => ({
        msgId: g.last,
        text: (g.text || '').replace(/\s+/g, ' ').slice(0, 100),
        media: g.msgs.filter(hasMedia).length,
        date: new Date(g.msgs[0].date * 1000).toISOString(),
      })),
    };
  }

  /**
   * 保存来源（先解析频道，解析不到不保存）。新建时游标 = 当前最新消息 id，只转之后新发的；
   * backfill>0 表示保存后立刻把最近 N 条转过去（看效果用）。
   */
  async saveSource(data: { id?: number; channel: string; enabled?: boolean; dropAuthor?: boolean; mediaOnly?: boolean; maxPerRun?: number; blockWords?: string; backfill?: number }) {
    const channel = normalizeChannel(data.channel);
    if (!channel) throw new BadRequestException('请填写频道用户名（t.me/ 后面那段）');
    const info = await this.tg.resolveChannel(channel);
    if (info.username.toLowerCase() === (await this.target()).toLowerCase()) throw new BadRequestException('来源不能是目标频道自己');
    if (info.entity.noforwards) throw new BadRequestException(`@${info.username} 开了「禁止转发」，Telegram 不允许转发它的内容`);
    const clean = {
      channel: info.username,
      title: info.title.slice(0, 120),
      subscribers: info.subscribers,
      enabled: data.enabled ?? true,
      dropAuthor: data.dropAuthor ?? true,
      mediaOnly: data.mediaOnly ?? false,
      maxPerRun: Math.min(20, Math.max(1, Number(data.maxPerRun) || 3)),
      blockWords: String(data.blockWords ?? '').trim().slice(0, 500),
    };
    const backfill = Math.min(MAX_BACKFILL, Math.max(0, Number(data.backfill) || 0));
    let row;
    if (data.id) {
      const old = await this.prisma.tgForwardSource.findUnique({ where: { id: Number(data.id) } });
      if (!old) throw new NotFoundException('来源不存在');
      const changed = old.channel.toLowerCase() !== clean.channel.toLowerCase();
      row = await this.prisma.tgForwardSource.update({
        where: { id: old.id },
        data: changed ? { ...clean, lastMsgId: await this.latestId(info.entity), lastError: '' } : clean,
      });
    } else {
      const exists = await this.prisma.tgForwardSource.findUnique({ where: { channel: clean.channel } });
      if (exists) throw new BadRequestException(`@${clean.channel} 已经在来源里`);
      row = await this.prisma.tgForwardSource.create({ data: { ...clean, lastMsgId: await this.latestId(info.entity) } });
    }
    if (backfill > 0) void this.runOne(row.id, backfill);
    return row;
  }

  async removeSource(id: number) {
    await this.prisma.tgForwardSource.delete({ where: { id } });
    return { ok: true };
  }

  /** 手动：立即转发新消息；backfill>0 = 不管游标，把最近 N 条转过去 */
  async syncOne(id: number, backfill = 0) {
    const src = await this.prisma.tgForwardSource.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('来源不存在');
    if (this.running) return { started: false, running: true };
    void this.runOne(id, Math.min(MAX_BACKFILL, Math.max(0, backfill)));
    return { started: true, running: true };
  }

  private async runOne(id: number, backfill: number) {
    if (this.running) return;
    this.running = true;
    try {
      const src = await this.prisma.tgForwardSource.findUnique({ where: { id } });
      if (src) await this.forwardSource(src, backfill);
    } catch (e: any) {
      this.logger.warn(`manual forward #${id}: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  private async latestId(entity: Api.Channel): Promise<number> {
    const client = await this.tg.authorized();
    const msgs = await client.getMessages(entity, { limit: 1 });
    return msgs[0]?.id ?? 0;
  }

  // ---------- 定时 ----------

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const sources = await this.prisma.tgForwardSource.findMany({ where: { enabled: true } });
      if (!sources.length) return;
      if (!(await this.tg.isLoggedIn())) { this.logger.warn('Telegram 未登录，跳过频道转发'); return; }
      for (const s of sources) {
        try { await this.forwardSource(s, 0); } catch (e: any) { this.logger.warn(`forward ${s.channel}: ${e?.message ?? e}`); }
      }
    } finally {
      this.running = false;
    }
  }

  /** 转发一个来源的新消息：backfill>0 时取最近 N 组（不看游标），否则取游标之后的、最多 maxPerRun 组 */
  private async forwardSource(src: { id: number; channel: string; lastMsgId: number; maxPerRun: number; dropAuthor: boolean; mediaOnly: boolean; blockWords: string }, backfill: number) {
    const client = await this.tg.authorized();
    const target = await this.target();
    const blockWords = (src.blockWords ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    let forwarded = 0, maxId = src.lastMsgId, error = '';
    try {
      const from = await client.getEntity(src.channel);
      const to = await client.getEntity(target);
      const msgs = backfill > 0
        ? await client.getMessages(from, { limit: Math.min(SCAN_LIMIT, backfill * 4) })
        : await client.getMessages(from, { limit: SCAN_LIMIT, minId: src.lastMsgId || 0 });
      const fresh = [...msgs]
        .filter((m) => !(m instanceof Api.MessageService) && (backfill > 0 || m.id > src.lastMsgId))
        .sort((a, b) => a.id - b.id);
      const groups = groupMessages(fresh);
      const limit = backfill > 0 ? backfill : src.maxPerRun;
      // 过滤：只要媒体 / 屏蔽词 / 空消息
      const eligible = (g: MsgGroup) => {
        if (src.mediaOnly && !g.msgs.some(hasMedia)) return false;
        if (!g.text && !g.msgs.some(hasMedia)) return false;
        if (blockWords.length && blockWords.some((w) => g.text.toLowerCase().includes(w.toLowerCase()))) return false;
        return true;
      };
      const forward = async (g: MsgGroup) => {
        await client.invoke(new Api.messages.ForwardMessages({
          fromPeer: from,
          toPeer: to,
          id: g.msgs.map((m) => m.id),
          randomId: g.msgs.map(() => helpers.generateRandomBigInt()),
          dropAuthor: src.dropAuthor,
          silent: false,
        }));
        forwarded++;
        await sleep(GAP_MS);
      };

      if (backfill > 0) {
        // 补最近 N 条：取最新的 N 组，不动游标
        for (const g of groups.filter(eligible).slice(-limit)) await forward(g);
      } else {
        // 日常：按时间顺序走，不合格的跳过（游标推进），合格的转完再推进游标；满 maxPerRun 就停，剩下的下一轮再来。
        // 中途报错时游标停在最后一条成功的，下一轮从那儿继续，不丢不重
        for (const g of groups) {
          if (eligible(g)) {
            if (forwarded >= limit) break;
            await forward(g);
          }
          maxId = Math.max(maxId, g.last);
        }
      }
    } catch (e: any) {
      error = humanForwardError(e);
      this.logger.warn(`forward ${src.channel} → ${target}: ${error}`);
    }
    await this.prisma.tgForwardSource.update({
      where: { id: src.id },
      data: { lastMsgId: maxId, lastSyncAt: new Date(), lastError: error.slice(0, 300), forwardedCount: { increment: forwarded } },
    });
    if (forwarded) this.logger.log(`@${src.channel} → @${target}: forwarded ${forwarded}`);
    return { forwarded, error };
  }
}

interface MsgGroup { key: string; msgs: Api.Message[]; last: number; text: string }

/** 相册（groupedId 相同）合成一组，一起转才还是一条相册；文案取组里第一条有字的 */
function groupMessages(msgs: Api.Message[]): MsgGroup[] {
  const out: MsgGroup[] = [];
  for (const m of msgs) {
    const key = m.groupedId ? `g${m.groupedId.toString()}` : `m${m.id}`;
    const g = out.find((x) => x.key === key);
    if (g) { g.msgs.push(m); g.last = Math.max(g.last, m.id); if (!g.text && m.message) g.text = m.message; }
    else out.push({ key, msgs: [m], last: m.id, text: m.message || '' });
  }
  return out;
}

function hasMedia(m: Api.Message): boolean {
  return m.media instanceof Api.MessageMediaPhoto || m.media instanceof Api.MessageMediaDocument;
}

function humanForwardError(e: any): string {
  const raw = String(e?.errorMessage ?? e?.message ?? e);
  if (/CHAT_FORWARDS_RESTRICTED/.test(raw)) return '来源频道开了「禁止转发」';
  if (/CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED/.test(raw)) return '账号在目标频道没有发布权限';
  if (/CHANNEL_PRIVATE/.test(raw)) return '频道是私有的或已被限制';
  const fw = raw.match(/FLOOD_WAIT_(\d+)/);
  if (fw) return `被 Telegram 限流，${fw[1]} 秒后再试`;
  return raw.slice(0, 200);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
