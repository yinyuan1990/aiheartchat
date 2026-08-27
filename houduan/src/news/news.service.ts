import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 花边新闻（消息页入口）+ 每日一句励志（主页「遇见」右边）
 *
 * 新闻：每小时按受众关键词从 360 新闻搜索采集一篇真实报道（抓原文正文，抓不到用摘要+原文链接），
 *       采集彻底失败时兜底 AI 生成，保证不断更。
 *       （源选型：Google/Bing RSS 在国内服务器不可达/被重定向，360 新闻实测稳定）
 * 每日一句：AI 每天生成一句，男女不同。
 * 受众按性别分流：
 *   audience=1 男方看：情侣共苦打拼励志 / 女生鼓励 / 富豪女生活
 *   audience=2 女方看：农村女孩逆袭改命
 */
@Injectable()
export class NewsService implements OnModuleInit {
  private readonly logger = new Logger('NewsService');
  private generating = false;

  private static readonly INTERVAL_MS = 60 * 60 * 1000;
  /** 列表最多保留条数（每受众），旧的自动清理 */
  private static readonly KEEP_PER_AUDIENCE = 200;

  /** 采集关键词（按小时轮换，一次跑不出结果就换下一组） */
  private static readonly KEYWORDS: Record<number, string[]> = {
    1: ['情侣 一起吃苦 打拼 励志', '女友 陪男友 奋斗 感动', '夫妻 白手起家 励志', '女企业家 励志 生活'],
    2: ['农村女孩 逆袭', '农村姑娘 创业 逆袭', '打工妹 逆袭 励志', '女孩 逆袭 改变命运'],
  };

  /** 标题相关性词（搜索结果里混着垃圾站/无关内容，标题至少命中一个词才收） */
  private static readonly RELEVANCE: Record<number, string[]> = {
    1: ['励志', '打拼', '吃苦', '奋斗', '夫妻', '情侣', '女友', '女朋友', '企业家', '白手起家', '感动', '爱情', '陪伴'],
    2: ['逆袭', '农村', '打工', '励志', '女孩', '姑娘', '创业', '改变命运', '翻身'],
  };

  /** 标题黑名单（赌博/招嫖/引流等垃圾内容） */
  private static readonly TITLE_BLOCK = /注册|开户|棋牌|彩票|博彩|娱乐城|平台|下载app|加微|约炮/i;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // 启动后先补一轮（表空或超过 1 小时没更新时立即采集），之后每 10 分钟检查一次是否到点
    setTimeout(() => void this.tick(), 10_000);
    setInterval(() => void this.tick(), 10 * 60 * 1000);
  }

  // ---------- 对外接口 ----------

  /** 列表：按登录用户性别分流（男=1 看 audience 1，女=2 看 audience 2），最新在前，beforeId 翻页 */
  async list(userId: bigint, beforeId?: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    const audience = me?.gender === 2 ? 2 : 1;
    return this.prisma.newsArticle.findMany({
      where: { audience, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 20,
      // sourceUrl 给客户端判断：有原文链接直接内部网页打开，没有（AI 兜底文）才走解析详情页
      select: { id: true, title: true, summary: true, tag: true, source: true, sourceUrl: true, createdAt: true },
    });
  }

  async detail(id: bigint) {
    const article = await this.prisma.newsArticle.findUnique({ where: { id } });
    if (!article) throw new NotFoundException('文章不存在');
    return article;
  }

  /** 励志行列表：历史每日一句（按性别分流，最新在前，beforeId 翻页） */
  async quotes(userId: bigint, beforeId?: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    const audience = me?.gender === 2 ? 2 : 1;
    // 当天缺了先异步补一条，下次进来能看到
    const day = this.todayCN();
    if (!beforeId && process.env.AI_API_KEY) {
      const hit = await this.prisma.dailyQuote.findUnique({ where: { audience_day: { audience, day } } });
      if (!hit) void this.generateQuote(audience, day).catch(() => {});
    }
    return this.prisma.dailyQuote.findMany({
      where: { audience, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 30,
      select: { id: true, day: true, text: true },
    });
  }

  /** 管理端手动触发：立即采集一轮新闻（两性别，不看间隔；采不到走 AI 兜底） */
  async forceCrawl() {
    const result: Record<string, string> = {};
    for (const audience of [1, 2]) {
      const ok = await this.crawlOne(audience).catch(() => false);
      if (ok) {
        result[`audience${audience}`] = 'crawled';
      } else if (process.env.AI_API_KEY) {
        await this.generateFallback(audience).catch(() => {});
        result[`audience${audience}`] = 'fallback';
      } else {
        result[`audience${audience}`] = 'failed';
      }
    }
    return result;
  }

  /** 管理端手动触发：重新生成今天的励志语句（两性别，覆盖当天已有） */
  async forceQuote() {
    const day = this.todayCN();
    for (const audience of [1, 2]) {
      await this.generateQuote(audience, day, true).catch(() => {});
    }
    const list = await this.prisma.dailyQuote.findMany({ where: { day } });
    return list.map((q) => ({ audience: q.audience, text: q.text }));
  }

  /** 每日一句励志：男看女生口吻的鼓励，女看情感励志。当天没有时先回最近一条并异步补生成 */
  async quoteToday(userId: bigint) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    const audience = me?.gender === 2 ? 2 : 1;
    const day = this.todayCN();
    const hit = await this.prisma.dailyQuote.findUnique({ where: { audience_day: { audience, day } } });
    if (hit) return { text: hit.text };
    if (process.env.AI_API_KEY) void this.generateQuote(audience, day).catch(() => {});
    const latest = await this.prisma.dailyQuote.findFirst({ where: { audience }, orderBy: { id: 'desc' } });
    return {
      text:
        latest?.text ??
        (audience === 2 ? '先把自己活成光，再去照亮值得的人。' : '累了就歇一歇，但别停下，有人在等你发光。'),
    };
  }

  // ---------- 定时任务 ----------

  private async tick() {
    if (this.generating) return;
    this.generating = true;
    try {
      const day = this.todayCN();
      for (const audience of [1, 2]) {
        const latest = await this.prisma.newsArticle.findFirst({
          where: { audience },
          orderBy: { id: 'desc' },
          select: { createdAt: true },
        });
        const stale = !latest || Date.now() - latest.createdAt.getTime() >= NewsService.INTERVAL_MS;
        if (stale) {
          const ok = await this.crawlOne(audience).catch((e) => {
            this.logger.warn(`采集异常（audience=${audience}）: ${(e as Error).message}`);
            return false;
          });
          if (!ok && process.env.AI_API_KEY) await this.generateFallback(audience);
        }
        // 每日一句：当天缺了就补（AI 生成）
        if (process.env.AI_API_KEY) {
          const quote = await this.prisma.dailyQuote.findUnique({ where: { audience_day: { audience, day } } });
          if (!quote) await this.generateQuote(audience, day).catch(() => {});
        }
      }
    } catch (e) {
      this.logger.warn(`定时任务失败: ${(e as Error).message}`);
    } finally {
      this.generating = false;
    }
  }

  // ---------- 新闻采集 ----------

  /** 从 360 新闻搜索采集一篇（去重、抓正文），成功返回 true */
  private async crawlOne(audience: number): Promise<boolean> {
    const keywords = NewsService.KEYWORDS[audience] ?? [];
    const start = new Date().getHours() % keywords.length;
    // 从本小时对应的关键词开始轮，一组没有新内容就换下一组
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[(start + i) % keywords.length];
      const items = await this.fetchSearch(kw).catch(() => [] as RssItem[]);
      for (const item of items) {
        if (!item.title || !item.link) continue;
        if (NewsService.TITLE_BLOCK.test(item.title)) continue;
        if (!(NewsService.RELEVANCE[audience] ?? []).some((t) => item.title.includes(t))) continue;
        const dup = await this.prisma.newsArticle.findFirst({ where: { title: item.title }, select: { id: true } });
        if (dup) continue;
        if (item.description.length < 20) continue;

        // 不解析原文正文：客户端拿 sourceUrl 直接内部网页打开，content 只存摘要备用
        await this.prisma.newsArticle.create({
          data: {
            audience,
            title: item.title.slice(0, 120),
            summary: item.description.slice(0, 300),
            tag: audience === 2 ? '逆袭' : '励志',
            content: item.description.slice(0, 300),
            source: item.source.slice(0, 60),
            sourceUrl: item.link.slice(0, 500),
          },
        });
        this.logger.log(`已采集（audience=${audience}, 来源=${item.source}）: ${item.title}`);
        await this.trim(audience);
        return true;
      }
    }
    return false;
  }

  /** 360 新闻搜索：返回条目（标题/链接/摘要/来源） */
  private async fetchSearch(keyword: string): Promise<RssItem[]> {
    const url = `https://news.so.com/ns?q=${encodeURIComponent(keyword)}&src=tab_www`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) return [];
    const html = await res.text();
    const items: RssItem[] = [];
    // 结果项：<li class="…res-list…" data-from="news" data-url="…"><a … title="标题">…summary…sitename…
    for (const seg of html.split('<li class="')) {
      if (!seg.includes('data-from="news"')) continue;
      const link = seg.match(/data-url="([^"]+)"/)?.[1] ?? '';
      const title = this.decodeEntities(seg.match(/\stitle="([^"]+)"/)?.[1] ?? '');
      const summaryRaw = seg.match(/class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
      const description = this.decodeEntities(summaryRaw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const source = this.decodeEntities(seg.match(/<cite class="sitename">([^<]+)<\/cite>/)?.[1] ?? '').trim();
      if (title && link) items.push({ title, link, description, source });
    }
    return items;
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private async trim(audience: number) {
    const old = await this.prisma.newsArticle.findMany({
      where: { audience },
      orderBy: { id: 'desc' },
      skip: NewsService.KEEP_PER_AUDIENCE,
      select: { id: true },
    });
    if (old.length) {
      await this.prisma.newsArticle.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    }
  }

  // ---------- AI 兜底与每日一句 ----------

  /** 采集失败时的兜底：AI 写一篇新闻风格软文 */
  private async generateFallback(audience: number) {
    const themes =
      audience === 2
        ? [
            '一个农村出身的女孩通过自己的努力逆袭改变命运的真实感新闻故事（进城打拼、直播带货、考学、创业等方向任选）',
            '一个大山里的女孩靠拼劲走出农村、让全家过上好日子的励志新闻故事',
          ]
        : [
            '一个女生陪男朋友从一无所有一起吃苦打拼、不离不弃最终苦尽甘来的暖心新闻故事',
            '一位白手起家的富豪女企业家的日常生活见闻与情感观（对感情专一、欣赏踏实肯干的男生）',
          ];
    const theme = themes[Math.floor(Math.random() * themes.length)];

    const raw = await this.callModel([
      {
        role: 'system',
        content:
          '你是一名资讯编辑，为社交 App 的资讯栏目撰写新闻风格的软文。要求：新闻报道口吻、有具体人物（化名）和细节、真实感强、正能量、通俗易读；正文 500-800 字，分 4-6 个自然段。' +
          '严格只输出 JSON 对象：{"title":"标题（18字内）","summary":"摘要（40字内）","tag":"分类标签（2-4字，如 励志/情感/逆袭）","content":"正文，段落之间用\\n\\n分隔"}',
      },
      { role: 'user', content: `写一篇：${theme}。` },
    ]);

    const parsed = this.parseJson(raw);
    if (!parsed?.title || !parsed?.content) {
      this.logger.warn(`AI 兜底返回无法解析（audience=${audience}）: ${raw.slice(0, 120)}`);
      return;
    }
    await this.prisma.newsArticle.create({
      data: {
        audience,
        title: String(parsed.title).slice(0, 120),
        summary: String(parsed.summary ?? '').slice(0, 300),
        tag: String(parsed.tag ?? (audience === 2 ? '逆袭' : '励志')).slice(0, 8),
        content: String(parsed.content).slice(0, 12000),
      },
    });
    this.logger.log(`AI 兜底已生成（audience=${audience}）: ${parsed.title}`);
    await this.trim(audience);
  }

  /** 生成当天的每日一句（force=true 覆盖当天已有） */
  private async generateQuote(audience: number, day: string, force = false) {
    const prompt =
      audience === 2
        ? '写一句给女生看的情感励志话：关于爱自己、经营感情、越来越好，温柔有力量。'
        : '以温柔女生的口吻写一句鼓励正在打拼的男生的话：懂他的辛苦、给他力量。';
    const raw = await this.callModel([
      {
        role: 'system',
        content: '你是文案作者。只输出一句话本身，25字以内，不要引号、不要任何解释和前后缀。',
      },
      { role: 'user', content: prompt },
    ], false);
    const text = raw.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').split('\n')[0].slice(0, 60);
    if (!text) return;
    await this.prisma.dailyQuote.upsert({
      where: { audience_day: { audience, day } },
      create: { audience, day, text },
      update: force ? { text } : {},
    });
    this.logger.log(`每日一句（audience=${audience}）: ${text}`);
  }

  /** 东八区今天的 YYYY-MM-DD */
  private todayCN(): string {
    return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  }

  private fetchWithTimeout(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    return fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }).finally(() => clearTimeout(timer));
  }

  private parseJson(raw: string): any {
    // 容错：模型可能包 markdown 代码块
    const text = raw.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch {}
      }
      return null;
    }
  }

  private async callModel(messages: { role: string; content: string }[], json = true): Promise<string> {
    const base = (process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const model = process.env.AI_MODEL ?? 'deepseek-chat';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 2000,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`上游 ${res.status}`);
      const data: any = await res.json();
      return data?.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  source: string;
}
