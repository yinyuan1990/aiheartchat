import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AI 助手（免费问答）
 * 走 OpenAI 兼容协议，换模型只改环境变量：
 *   AI_BASE_URL 默认 https://api.deepseek.com/v1
 *   AI_MODEL    默认 deepseek-chat
 *   AI_API_KEY  必填，缺失时接口报"AI 服务未配置"
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AiService');
  /** 每用户同时只允许一个进行中的请求 */
  private readonly inflight = new Set<string>();

  private static readonly HISTORY_LIMIT = 20;
  private static readonly MAX_INPUT_LEN = 2000;
  private static readonly SYSTEM_PROMPT =
    '你是「心之音」App 内置的 AI 助手，用中文简洁友好地回答用户的任何问题。回答尽量精炼，不要长篇大论。' +
    '当用户要求你写攻略、页面、海报、卡片等适合做成网页的内容时，输出一个完整可直接渲染的 HTML 文档' +
    '（内联 CSS、移动端适配、深色美观），整段放在 ```html 代码块里，代码块外最多一句话说明，用户点击即可打开预览。';

  constructor(private readonly prisma: PrismaService) {}

  /** 历史记录（升序，最近 100 条） */
  async messages(userId: bigint) {
    const list = await this.prisma.aiMessage.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return list.reverse();
  }

  async clear(userId: bigint) {
    await this.prisma.aiMessage.deleteMany({ where: { userId } });
    return { ok: true };
  }

  async chat(userId: bigint, content: string) {
    const text = content.trim();
    if (!text) throw new BadRequestException('内容不能为空');
    if (text.length > AiService.MAX_INPUT_LEN) throw new BadRequestException('内容过长');

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) throw new BadRequestException('AI 服务未配置，请联系管理员');

    const key = userId.toString();
    if (this.inflight.has(key)) throw new BadRequestException('上一条还在回复中，请稍候');
    this.inflight.add(key);
    try {
      // 取近期上下文（在写入本条之前取，再手动拼上本条）
      const history = await this.prisma.aiMessage.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        take: AiService.HISTORY_LIMIT,
      });
      await this.prisma.aiMessage.create({ data: { userId, role: 'user', content: text } });

      const reply = await this.callModel([
        { role: 'system', content: AiService.SYSTEM_PROMPT },
        ...history.reverse().map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: text },
      ]);

      return await this.prisma.aiMessage.create({
        data: { userId, role: 'assistant', content: reply },
      });
    } finally {
      this.inflight.delete(key);
    }
  }

  private async callModel(messages: { role: string; content: string }[]): Promise<string> {
    const base = (process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const model = process.env.AI_MODEL ?? 'deepseek-chat';

    const ctrl = new AbortController();
    // 写整页 HTML 时输出较长，超时放宽
    const timer = setTimeout(() => ctrl.abort(), 150_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: 4000, stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`AI 上游 ${res.status}: ${(await res.text()).slice(0, 300)}`);
        throw new BadRequestException('AI 暂时不可用，请稍后再试');
      }
      const data: any = await res.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new BadRequestException('AI 暂时不可用，请稍后再试');
      return reply;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`AI 调用失败: ${(e as Error).message}`);
      throw new BadRequestException('AI 暂时不可用，请稍后再试');
    } finally {
      clearTimeout(timer);
    }
  }
}
