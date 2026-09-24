import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** 支持的平台（发布机按这个 key 认） */
export const PLATFORMS = ['xiaohongshu', 'douyin', 'kuaishou', 'zhihu', 'shipinhao'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_NAMES: Record<Platform, string> = { xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', zhihu: '知乎', shipinhao: '视频号' };

/** 排期最多往后推几天，再排不进就跳过（树洞一天十几条，四个平台全发会被限流） */
const MAX_DAYS_AHEAD = 3;
/** 一次 AI 改写失败重试次数 */
const AI_RETRY = 2;
/** 发布失败最多重试几次（每次顺延 30 分钟） */
const MAX_ATTEMPTS = 3;
/** 领走后多久没回结果算发布机挂了，放回队列 */
const CLAIM_TIMEOUT_MS = 30 * 60_000;
/** 正文太短的树洞帖不发 */
const MIN_TEXT = 30;
/** 出稿兜底过滤：引流 / 交友 / 联系方式相关词（小红书第一条就因「非官方渠道导流 + 高风险交友」把号冻了） */
const BANNED = /https?:\/\/|www\.|t\.me|微信|vx|wx|QQ|扣扣|手机号|电话|下载|关注我|私信|私聊|评论区找|加我|扩列|处对象|找对象|想认识|脱单|相亲|交友|约会|同城|约炮|心之音|树洞|App|app|应用/;

interface Settings {
  enabled: boolean;
  platforms: Platform[];
  /** 每平台每天最多几条（各平台没单独设时的默认值） */
  dailyMax: number;
  /** 各平台每天最多几条 */
  dailyMaxes: Record<Platform, number>;
  /** 允许发布的小时段 [start, end)，如 9~23 */
  hourStart: number;
  hourEnd: number;
  /** 同平台两条之间至少隔几分钟 */
  gapMin: number;
  /** 发布机鉴权 token */
  token: string;
  /** 只处理这个 id 之后的树洞帖（开启时定在当前最新，旧帖不发） */
  lastPostId: string;
  /** 每个平台的文案模式：raw = 原文直发（不改写、不过滤，只按平台截长度）；ai = DeepSeek 按平台改写 + 敏感词过滤 */
  modes: Record<Platform, Mode>;
}

type Mode = 'raw' | 'ai';

interface AgentState {
  lastSeen: string;
  host: string;
  accounts: Record<string, { ok: boolean; msg: string; checkedAt: string }>;
  /** 发布机出口 IP 检查：ok=false（开着 VPN，出口在国外）时发布机自己会停发 */
  ip: { ok: boolean; ip: string; where: string; msg: string } | null;
}

interface Draft { title: string; content: string; tags: string[] }

/**
 * 内容分发：私密树洞里 **同步进来的新帖（source=2）** 一条不落地自动发到各平台（操作者要求不挑不审）。
 *
 * 流程：每分钟扫一次新帖 → 每个启用的平台各出一稿（DeepSeek 按平台模板改写 + 敏感词软化）→ 按「每日上限 / 发布时段 / 间隔」算排期入队
 * → 发布机（操作者本机 `publisher/`，真实浏览器 + 扫码 cookie 模拟点发）轮询 `GET /publish/agent/next` 领走到点的任务
 * → 本地把文案渲染成 3:4 卡片图（抖音 / 快手 / 小红书没有纯文字帖，最少一张图；知乎「想法」发纯文本）→ 发布 → `POST /publish/agent/result` 回写。
 * 后台「内容分发」页：开关 / 平台 / 上限 / 时段、发布机在线与各平台登录状态、任务列表（重试 / 跳过）、「测试发布」。
 */
@Injectable()
export class PublishService implements OnModuleInit {
  private readonly logger = new Logger('Publish');
  private scanning = false;
  private agent: AgentState = { lastSeen: '', host: '', accounts: {}, ip: null };

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setTimeout(() => void this.scan(), 70_000);
    setInterval(() => void this.scan(), 60_000);
  }

  // ---------- 设置 ----------

  async settings(): Promise<Settings> {
    const rows = await this.prisma.sysSetting.findMany({ where: { key: { startsWith: 'publish_' } } });
    const get = (k: string) => rows.find((r) => r.key === `publish_${k}`)?.value ?? '';
    let token = get('token');
    if (!token) {
      token = randomBytes(24).toString('hex');
      await this.set('token', token);
    }
    const platforms = get('platforms').split(',').map((s) => s.trim()).filter((s): s is Platform => (PLATFORMS as readonly string[]).includes(s));
    const hours = get('hours').split('-').map((n) => Number(n));
    // publish_modes = "xiaohongshu:ai,zhihu:raw"；没写到的平台沿用旧的全局 publish_mode，再没有就是 raw
    const fallback: Mode = get('mode') === 'ai' ? 'ai' : 'raw';
    const stored = Object.fromEntries(get('modes').split(',').map((kv) => kv.split(':').map((x) => x.trim())));
    const modes = Object.fromEntries(PLATFORMS.map((p) => [p, stored[p] === 'ai' ? 'ai' : stored[p] === 'raw' ? 'raw' : fallback])) as Record<Platform, Mode>;
    // publish_daily_maxes = "kuaishou:1,shipinhao:1"；没写到的平台用 publish_daily_max
    const dailyMax = clampDaily(get('daily_max'), 5);
    const storedMax = Object.fromEntries(get('daily_maxes').split(',').map((kv) => kv.split(':').map((x) => x.trim())));
    const dailyMaxes = Object.fromEntries(PLATFORMS.map((p) => [p, clampDaily(storedMax[p], dailyMax)])) as Record<Platform, number>;
    return {
      enabled: get('enabled') === '1',
      platforms: platforms.length ? platforms : ['xiaohongshu', 'zhihu'],
      dailyMax,
      dailyMaxes,
      hourStart: Number.isFinite(hours[0]) && hours.length === 2 ? Math.min(23, Math.max(0, hours[0])) : 9,
      hourEnd: Number.isFinite(hours[1]) && hours.length === 2 ? Math.min(24, Math.max(1, hours[1])) : 23,
      gapMin: Math.min(600, Math.max(0, Number(get('gap_min')) || 45)),
      token,
      lastPostId: get('last_post_id') || '0',
      modes,
    };
  }

  private async set(key: string, value: string) {
    await this.prisma.sysSetting.upsert({ where: { key: `publish_${key}` }, create: { key: `publish_${key}`, value }, update: { value } });
  }

  async saveSettings(data: { enabled?: boolean; platforms?: string[]; dailyMax?: number; hourStart?: number; hourEnd?: number; gapMin?: number; modes?: Record<string, string>; dailyMaxes?: Record<string, number> }) {
    const cur = await this.settings();
    if (data.enabled !== undefined) {
      // 从关到开：水位定在当前最新一条，之前同步进来的旧帖不发
      if (data.enabled && !cur.enabled) {
        const latest = await this.prisma.treeholePost.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
        await this.set('last_post_id', (latest?.id ?? BigInt(0)).toString());
      }
      await this.set('enabled', data.enabled ? '1' : '0');
    }
    if (data.platforms) await this.set('platforms', data.platforms.filter((p) => (PLATFORMS as readonly string[]).includes(p)).join(','));
    if (data.dailyMax !== undefined) await this.set('daily_max', String(Math.min(50, Math.max(1, Number(data.dailyMax) || 5))));
    if (data.hourStart !== undefined || data.hourEnd !== undefined) {
      const s = Math.min(23, Math.max(0, Number(data.hourStart ?? cur.hourStart)));
      const e = Math.min(24, Math.max(s + 1, Number(data.hourEnd ?? cur.hourEnd)));
      await this.set('hours', `${s}-${e}`);
    }
    if (data.gapMin !== undefined) await this.set('gap_min', String(Math.min(600, Math.max(0, Number(data.gapMin) || 0))));
    if (data.modes && typeof data.modes === 'object') {
      const m = data.modes;
      await this.set('modes', PLATFORMS.map((p) => `${p}:${m[p] === undefined ? cur.modes[p] : m[p] === 'ai' ? 'ai' : 'raw'}`).join(','));
    }
    if (data.dailyMaxes && typeof data.dailyMaxes === 'object') {
      const m = data.dailyMaxes;
      await this.set('daily_maxes', PLATFORMS.map((p) => `${p}:${m[p] === undefined ? cur.dailyMaxes[p] : clampDaily(m[p], cur.dailyMaxes[p])}`).join(','));
    }
    return this.overview();
  }

  async rotateToken() {
    await this.set('token', randomBytes(24).toString('hex'));
    return this.overview();
  }

  /** 后台总览：设置 + 发布机状态 + 各状态计数 */
  async overview() {
    const s = await this.settings();
    const counts = await this.prisma.publishJob.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus: Record<number, number> = {};
    for (const c of counts) byStatus[c.status] = c._count._all;
    const online = !!this.agent.lastSeen && Date.now() - new Date(this.agent.lastSeen).getTime() < 6 * 60_000;
    return { settings: s, agent: { ...this.agent, online }, counts: byStatus, platforms: PLATFORMS.map((p) => ({ key: p, name: PLATFORM_NAMES[p] })) };
  }

  // ---------- 后台：任务 ----------

  async jobs(status?: number, platform?: string, beforeId?: bigint) {
    const rows = await this.prisma.publishJob.findMany({
      where: { ...(status !== undefined ? { status } : {}), ...(platform ? { platform } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 60,
    });
    const posts = await this.prisma.treeholePost.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.postId))] } }, select: { id: true, content: true } });
    return rows.map((r) => ({ ...r, platformName: PLATFORM_NAMES[r.platform as Platform] ?? r.platform, source: posts.find((p) => p.id === r.postId)?.content.slice(0, 120) ?? '' }));
  }

  async retry(id: bigint) {
    const j = await this.prisma.publishJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('任务不存在');
    await this.prisma.publishJob.update({ where: { id }, data: { status: 0, attempts: 0, error: '', scheduledAt: new Date(), claimedAt: null } });
    return { ok: true };
  }

  async skip(id: bigint) {
    await this.prisma.publishJob.update({ where: { id }, data: { status: 4, error: '后台手动跳过', doneAt: new Date() } });
    return { ok: true };
  }

  async remove(id: bigint) {
    await this.prisma.publishJob.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * 测试发布：拿最近一条树洞帖（或指定 id），给指定平台（默认全部启用的）立刻排一条任务（不受上限 / 时段限制）。
   * 已经有任务的会先删掉再排，方便反复试。
   */
  async testPublish(postId?: bigint, platforms?: string[]) {
    const s = await this.settings();
    const post = postId
      ? await this.prisma.treeholePost.findUnique({ where: { id: postId } })
      : await this.prisma.treeholePost.findFirst({ where: { status: 0, content: { not: '' } }, orderBy: { id: 'desc' } });
    if (!post) throw new NotFoundException('没有可用的树洞帖');
    const targets = (platforms?.length ? platforms : s.platforms).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    if (!targets.length) throw new BadRequestException('没有选择平台');
    const out: { platform: string; id: string; title: string }[] = [];
    for (const p of targets) {
      const draft = await this.draft(post.content, p, s);
      await this.prisma.publishJob.deleteMany({ where: { postId: post.id, platform: p } });
      const j = await this.prisma.publishJob.create({
        data: { postId: post.id, platform: p, title: draft.title, content: draft.content, tags: draft.tags.join(','), scheduledAt: new Date() },
      });
      out.push({ platform: p, id: j.id.toString(), title: draft.title });
    }
    return { postId: post.id.toString(), jobs: out };
  }

  // ---------- 扫新帖 → 入队 ----------

  private async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.releaseStale();
      const s = await this.settings();
      if (!s.enabled || !s.platforms.length) return;
      // 只发 Telegram 同步进来的（source=2）、正常状态、水位之后的帖子；一次最多 5 条，剩下的下一分钟
      const posts = await this.prisma.treeholePost.findMany({
        where: { id: { gt: BigInt(s.lastPostId) }, source: 2, status: 0 },
        orderBy: { id: 'asc' },
        take: 5,
      });
      for (const post of posts) {
        await this.enqueue(post, s).catch((e) => this.logger.warn(`enqueue #${post.id}: ${e?.message ?? e}`));
        await this.set('last_post_id', post.id.toString());
      }
    } finally {
      this.scanning = false;
    }
  }

  /** 领走超过 30 分钟没回结果的任务放回队列（发布机中途挂了） */
  private async releaseStale() {
    const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    const r = await this.prisma.publishJob.updateMany({ where: { status: 1, claimedAt: { lt: cutoff } }, data: { status: 0, claimedAt: null, error: '发布机超时未回结果，重排' } });
    if (r.count) this.logger.warn(`released ${r.count} stale jobs`);
  }

  private async enqueue(post: { id: bigint; content: string; images: string }, s: Settings) {
    const text = post.content.replace(/\s+\n/g, '\n').trim();
    if (text.length < MIN_TEXT) { this.logger.log(`skip #${post.id}: 正文太短`); return; }
    for (const p of s.platforms) {
      const exists = await this.prisma.publishJob.findUnique({ where: { postId_platform: { postId: post.id, platform: p } }, select: { id: true } });
      if (exists) continue;
      const when = await this.nextSlot(p, s);
      if (!when) {
        await this.prisma.publishJob.create({ data: { postId: post.id, platform: p, content: text.slice(0, 500), status: 4, error: `${MAX_DAYS_AHEAD} 天内排期已满，跳过`, scheduledAt: new Date(), doneAt: new Date() } });
        continue;
      }
      let draft: Draft;
      try {
        draft = await this.draft(text, p, s);
      } catch (e: any) {
        await this.prisma.publishJob.create({ data: { postId: post.id, platform: p, content: text.slice(0, 500), status: 3, error: `AI 改写失败：${String(e?.message ?? e).slice(0, 200)}`, scheduledAt: new Date(), doneAt: new Date() } });
        continue;
      }
      await this.prisma.publishJob.create({ data: { postId: post.id, platform: p, title: draft.title, content: draft.content, tags: draft.tags.join(','), scheduledAt: when } });
      this.logger.log(`queued #${post.id} → ${p} @ ${when.toISOString()}`);
    }
  }

  /**
   * 该平台下一个可用时间：从今天起最多往后 MAX_DAYS_AHEAD 天，找一天已排 < dailyMax 的，
   * 时间 = max(现在, 该天时段开始, 该平台最后一条排期 + gapMin)，且必须落在时段内，否则去下一天。
   * 时间按服务器本地时区（容器 TZ 默认 UTC，这里用北京时间算）。
   */
  private async nextSlot(platform: Platform, s: Settings): Promise<Date | null> {
    const now = Date.now();
    const last = await this.prisma.publishJob.findFirst({ where: { platform, status: { in: [0, 1, 2] } }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } });
    const minByGap = last ? last.scheduledAt.getTime() + s.gapMin * 60_000 : 0;
    for (let d = 0; d <= MAX_DAYS_AHEAD; d++) {
      const dayStart = bjDayStart(now, d);
      const winStart = dayStart + s.hourStart * 3_600_000;
      const winEnd = dayStart + s.hourEnd * 3_600_000;
      const count = await this.prisma.publishJob.count({ where: { platform, status: { in: [0, 1, 2] }, scheduledAt: { gte: new Date(dayStart), lt: new Date(dayStart + 86_400_000) } } });
      if (count >= s.dailyMaxes[platform]) continue;
      // 随机抖 3~25 分钟：别每条都卡在整点 / 固定间隔上（小红书按"操作习惯不像真人"给过警告）
      const jitter = (3 + Math.random() * 22) * 60_000;
      const t = Math.max(now, winStart, minByGap) + jitter;
      if (t < winEnd) return new Date(t);
    }
    return null;
  }

  // ---------- 出稿：原文 / AI 改写 ----------

  /** 各平台标题上限（原文模式取第一句当标题）与正文上限 */
  private static readonly TITLE_MAX: Record<Platform, number> = { xiaohongshu: 20, douyin: 20, kuaishou: 30, zhihu: 0, shipinhao: 22 };
  private static readonly CONTENT_MAX: Record<Platform, number> = { xiaohongshu: 1000, douyin: 1000, kuaishou: 1000, zhihu: 2000, shipinhao: 1000 };

  private async draft(text: string, platform: Platform, s: Settings): Promise<Draft> {
    if (s.modes[platform] !== 'ai') return this.draftRaw(text, platform);
    if (!process.env.AI_API_KEY) throw new BadRequestException(`${PLATFORM_NAMES[platform]} 设为 AI 改写，但 AI_API_KEY 未配置`);
    return this.draftAi(text, platform);
  }

  /** 原文直发：一个字不改、不过滤（操作者要求）；只做平台硬性限制——标题取第一句截到上限，正文截到上限，tags 固定三个 */
  private draftRaw(text: string, platform: Platform): Draft {
    const tmax = PublishService.TITLE_MAX[platform];
    const cmax = PublishService.CONTENT_MAX[platform];
    const firstLine = text.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    const firstSentence = firstLine.split(/[。！？!?；;]/)[0] || firstLine;
    const title = tmax > 0 ? firstSentence.replace(/[，,、：:\s]+$/, '').slice(0, tmax) : '';
    return { title, content: text.slice(0, cmax), tags: ['情感', '心事', '故事'] };
  }

  private async draftAi(text: string, platform: Platform): Promise<Draft> {
    // tags 只从这个池子里挑：小红书对「交友 / 相亲 / 脱单 / 树洞」这类词直接判「高风险交友」
    const TAG_POOL = '情感、心事、成长、生活感悟、随笔、故事、治愈、文字、日常、人生、亲密关系、自我成长、情绪';
    const spec: Record<Platform, string> = {
      xiaohongshu: `小红书图文笔记：title 不超过 20 个字、口语化有钩子可带 1 个 emoji；content 120~300 字，分 3~5 个短段，每段可用 emoji 开头，结尾一句引发共鸣或提问；tags 从「${TAG_POOL}」里挑 5 个。`,
      douyin: `抖音图文：title 不超过 20 个字有悬念；content 80~200 字，短句分行；tags 从「${TAG_POOL}」里挑 4 个。`,
      kuaishou: `快手图文：title 不超过 30 个字直白接地气；content 80~200 字，短句分行；tags 从「${TAG_POOL}」里挑 4 个。`,
      zhihu: `知乎「想法」（纯文本短帖）：title 留空字符串；content 150~400 字，像在知乎认真聊天的语气，有观点有细节，段落之间空一行，结尾可以抛一个问题；tags 从「${TAG_POOL}」里挑 3 个。`,
      shipinhao: `微信视频号图文动态：title 不超过 22 个字、平实不猎奇（微信用户偏成熟）；content 80~200 字，短句分行；tags 从「${TAG_POOL}」里挑 3 个。`,
    };
    const system = [
      '你是一个情感类自媒体运营，把一段匿名的个人心事改写成适合平台发布的文案（像博主自己在分享感悟）。',
      '硬性要求：',
      '1. 第一人称保留倾诉感，但不要编造原文没有的事实；不得出现真实人名、手机号、地名门牌等隐私。',
      '2. 不得出现平台违禁或极端词（自杀、自残、约炮、性暗示、出轨细节、脏话、政治），涉及的用委婉说法软化。',
      '3. 绝对不能有任何引流 / 交友含义：不出现链接、二维码、微信、QQ、手机号、App 名、品牌名、"下载""关注我""私信""评论区找我""加我""扩列""处对象""找对象""想认识""脱单""相亲""交友""约会""同城"等词，也不要邀请读者联系或见面。',
      '4. 不要用"树洞""投稿""匿名"之类的元描述，直接讲事。',
      '只输出 JSON：{"title": string, "content": string, "tags": string[]}。',
    ].join('\n');
    const user = `平台要求：${spec[platform]}\n\n原文：\n${text.slice(0, 1500)}`;
    let lastErr: any;
    for (let i = 0; i <= AI_RETRY; i++) {
      try {
        const raw = await callModel([{ role: 'system', content: system }, { role: 'user', content: user }], 0.9);
        const j = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
        const title = String(j.title ?? '').replace(/\s+/g, ' ').trim().slice(0, PublishService.TITLE_MAX[platform] || 30);
        const content = String(j.content ?? '').trim();
        const tags = (Array.isArray(j.tags) ? j.tags : []).map((t: unknown) => String(t).replace(/^#/, '').replace(/[#\s,，]/g, '').trim()).filter(Boolean).slice(0, 5);
        if (content.length < 20) throw new Error('正文过短');
        if (platform !== 'zhihu' && !title) throw new Error('缺标题');
        // 兜底过滤：AI 偶尔不听话，命中引流 / 交友词就重来
        const hit = `${title} ${content} ${tags.join(' ')}`.match(BANNED);
        if (hit) throw new Error(`命中敏感词「${hit[0]}」`);
        return { title: platform === 'zhihu' ? '' : title, content: content.slice(0, 1000), tags };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('AI 无输出');
  }

  // ---------- 发布机接口 ----------

  async checkToken(token: string): Promise<boolean> {
    if (!token) return false;
    const s = await this.settings();
    return token === s.token;
  }

  async heartbeat(body: { host?: string; accounts?: Record<string, { ok: boolean; msg?: string; checkedAt?: string }>; ip?: { ok?: boolean; ip?: string; where?: string; msg?: string } }) {
    const now = new Date().toISOString();
    this.agent.lastSeen = now;
    this.agent.host = String(body.host ?? '').slice(0, 60);
    if (body.ip && typeof body.ip === 'object' && Object.keys(body.ip).length) {
      this.agent.ip = { ok: !!body.ip.ok, ip: String(body.ip.ip ?? '').slice(0, 60), where: String(body.ip.where ?? '').slice(0, 80), msg: String(body.ip.msg ?? '').slice(0, 160) };
    }
    if (body.accounts) {
      for (const [k, v] of Object.entries(body.accounts)) {
        if (!(PLATFORMS as readonly string[]).includes(k)) continue;
        this.agent.accounts[k] = { ok: !!v.ok, msg: String(v.msg ?? '').slice(0, 200), checkedAt: v.checkedAt || now };
      }
    }
    const s = await this.settings();
    return { ok: true, platforms: s.platforms, enabled: s.enabled };
  }

  /** 领一条到点的任务（按 scheduledAt 最早）。platforms = 发布机本地已登录的平台 */
  async claim(platforms: string[]) {
    this.agent.lastSeen = new Date().toISOString();
    const list = platforms.filter((p) => (PLATFORMS as readonly string[]).includes(p));
    if (!list.length) return null;
    const j = await this.prisma.publishJob.findFirst({
      where: { status: 0, platform: { in: list }, scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
    });
    if (!j) return null;
    // 乐观锁：status 仍为 0 才领得到
    const r = await this.prisma.publishJob.updateMany({ where: { id: j.id, status: 0 }, data: { status: 1, claimedAt: new Date(), attempts: { increment: 1 } } });
    if (!r.count) return null;
    const tmax = PublishService.TITLE_MAX[j.platform as Platform];
    return { id: j.id.toString(), platform: j.platform, title: tmax ? j.title.slice(0, tmax) : j.title, content: j.content, tags: j.tags ? j.tags.split(',') : [], attempts: j.attempts + 1 };
  }

  async result(body: { id: string; ok: boolean; url?: string; error?: string }) {
    const id = BigInt(body.id);
    const j = await this.prisma.publishJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('任务不存在');
    if (body.ok) {
      await this.prisma.publishJob.update({ where: { id }, data: { status: 2, doneAt: new Date(), error: '', resultUrl: String(body.url ?? '').slice(0, 300) } });
      this.logger.log(`published job #${id} (${j.platform})`);
    } else {
      const err = String(body.error ?? '发布失败').slice(0, 500);
      if (j.attempts >= MAX_ATTEMPTS) {
        await this.prisma.publishJob.update({ where: { id }, data: { status: 3, doneAt: new Date(), error: err } });
      } else {
        await this.prisma.publishJob.update({ where: { id }, data: { status: 0, claimedAt: null, error: err, scheduledAt: new Date(Date.now() + 30 * 60_000) } });
      }
      this.logger.warn(`job #${id} (${j.platform}) failed: ${err}`);
    }
    return { ok: true };
  }
}

function clampDaily(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(50, n) : fallback;
}

/** 北京时间 d 天后那天的 0 点（毫秒时间戳） */
function bjDayStart(now: number, d: number): number {
  const off = 8 * 3_600_000;
  const local = now + off;
  const day = Math.floor(local / 86_400_000) + d;
  return day * 86_400_000 - off;
}

async function callModel(messages: { role: string; content: string }[], temperature?: number): Promise<string> {
  const base = (process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL ?? 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: 1200, ...(temperature != null ? { temperature } : {}), response_format: { type: 'json_object' } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`上游 ${res.status}`);
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}
