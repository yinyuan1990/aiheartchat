import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { callModel } from './publish.service';

const WANX_BASE = 'https://dashscope.aliyuncs.com/api/v1';
/** 万相 2.7 组图，0.2 元/张 */
const WANX_MODEL = 'wan2.7-image';
const MIN_SHOTS = 4;
const MAX_SHOTS = 7;
/** 大约多少字旁白配一张图 */
const CHARS_PER_SHOT = 55;
/** 只给这么久以内要发的视频任务出图：排到三天后的任务可能被删 / 跳过，别白花钱 */
const LOOKAHEAD_MS = 6 * 3_600_000;
const STYLE = '电影感写实组图，竖版，35mm胶片质感，自然光影，浅景深，轻微胶片颗粒，当代中国。';

export interface VideoMedia {
  paragraphs: string[];
  images: string[];
  scenes: string[];
}

/**
 * 视频任务出图：DeepSeek 把文案按顺序切成 4~7 段旁白、每段配一个画面描述 → 万相 2.7 组图一次出一组人物 / 画风一致的竖版剧照
 * → 存 MinIO，写进 publish_job.media。发布机领到后用这组图 + 旁白合成配音字幕视频（publisher/video/slides.py）。
 * 同一帖子的另一个视频平台已经出过图就直接复用。每分钟最多处理一条（一组图要一两分钟）。
 */
@Injectable()
export class PublishMediaService implements OnModuleInit {
  private readonly logger = new Logger('PublishMedia');
  private filling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
  ) {}

  onModuleInit() {
    setInterval(() => void this.fill(), 60_000);
  }

  private async fill() {
    if (this.filling) return;
    this.filling = true;
    let jobId: bigint | null = null;
    try {
      const job = await this.prisma.publishJob.findFirst({
        where: { status: 0, format: 'video', media: '', scheduledAt: { lte: new Date(Date.now() + LOOKAHEAD_MS) } },
        orderBy: { scheduledAt: 'asc' },
      });
      if (!job) return;
      jobId = job.id;
      const twin = await this.prisma.publishJob.findFirst({ where: { postId: job.postId, format: 'video', media: { not: '' } }, select: { media: true } });
      const media = twin?.media || JSON.stringify(await this.build(job.content));
      await this.prisma.publishJob.update({ where: { id: job.id }, data: { media, error: '' } });
      this.logger.log(`media ready for job #${job.id}${twin ? '（复用同帖另一平台的图）' : ''}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      this.logger.warn(`fill media job #${jobId}: ${msg}`);
      if (jobId) await this.prisma.publishJob.update({ where: { id: jobId }, data: { status: 3, error: `出图失败：${msg}`, doneAt: new Date() } }).catch(() => undefined);
    } finally {
      this.filling = false;
    }
  }

  async build(content: string): Promise<VideoMedia> {
    if (!process.env.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY 未配置');
    if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY 未配置');
    let paragraphs = splitChunks(content);
    const { characters, scenes } = await storyboard(paragraphs);
    const prompt = [
      STYLE + `同一个故事的${scenes.length}张连续画面，人物外貌和服装必须前后一致，女性角色都是二十多岁的年轻美女，画面中不要出现任何文字。`,
      `人物：${characters}`,
      ...scenes.map((s, i) => `第${i + 1}张：${s}`),
    ].join('\n');
    const urls = await wanxSequence(prompt, scenes.length);
    if (!urls.length) throw new Error('万相没有返回图片');
    // 少出了几张：把旁白合并成和图片一样多的段，保证一段一张
    if (urls.length < paragraphs.length) paragraphs = regroup(paragraphs, urls.length);
    const base = (process.env.PUBLIC_RES_BASE || 'https://api.yyheart.com').replace(/\/$/, '');
    const images: string[] = [];
    for (const u of urls.slice(0, paragraphs.length)) {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`下载万相图片 ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const saved = await this.upload.putInternal('publish', 'png', buf, 'image/png');
      images.push(base + saved.url);
    }
    return { paragraphs, images, scenes: scenes.slice(0, images.length) };
  }
}

/** 按句切，再按字数均分成 MIN_SHOTS~MAX_SHOTS 段（不改字） */
export function splitChunks(text: string): string[] {
  const sents = text.replace(/\r/g, '').split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean);
  const total = sents.reduce((a, s) => a + s.length, 0);
  const n = Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, Math.round(total / CHARS_PER_SHOT)));
  if (sents.length <= n) return sents;
  const target = total / n;
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < sents.length; i++) {
    cur += sents[i];
    const left = sents.length - 1 - i;
    const groupsLeft = n - out.length - 1;
    if (out.length < n - 1 && (cur.length >= target || left === groupsLeft)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function regroup(parts: string[], n: number): string[] {
  const out: string[] = [];
  const per = parts.length / n;
  for (let i = 0; i < n; i++) out.push(parts.slice(Math.round(i * per), Math.round((i + 1) * per)).join(''));
  return out.filter(Boolean);
}

async function storyboard(paragraphs: string[]): Promise<{ characters: string; scenes: string[] }> {
  const n = paragraphs.length;
  const system = [
    `你是短视频分镜师。给你一段第一人称的情感故事，已按顺序分成 ${n} 段旁白。请为每段配一张竖版写实剧照的画面描述，交给文生图模型一次生成一组连续图片。`,
    '要求：',
    '1. characters：故事里需要出镜的人物（包括"我"），每人一句：姓名或称呼、性别、年龄、长相气质、发型、固定服装。女性角色一律画成 22~28 岁的年轻漂亮女人（原文年龄更大也按这个年纪画，不要写中年、成熟、阿姨感、皱纹），皮肤白皙、五官精致、身材好，可以性感（吊带裙、湿发、锁骨、修身连衣裙等）；男性按故事年龄，有生活感。',
    `2. scenes：数组长度必须正好是 ${n}，第 i 条对应第 i 段旁白。每条 40~80 字，写清时间、地点、光线、画面里有谁、在做什么、关键道具，具体可画；景别要有变化（远景 / 中景 / 特写 / 主观视角）；室内外、天气要写清楚（比如"门外在下雨"），别自相矛盾。`,
    '3. 人物称呼和 characters 里一致，不要写"我"。',
    '4. 尺度：可以性感暧昧，但不得出现裸露、性行为、性器官；旁白里的亲密情节换成暗示性画面（交握的手、落在地上的外套、关上的门、凌乱床单的一角、窗外夜景等）。未成年人只能出现在日常场景。',
    '5. 画面里不要出现文字、字幕、招牌字。',
    '只输出 JSON：{"characters": string, "scenes": string[]}',
  ].join('\n');
  const user = paragraphs.map((p, i) => `第${i + 1}段：${p}`).join('\n');
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await callModel([{ role: 'system', content: system }, { role: 'user', content: user }], 0.7);
      const j = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
      const characters = String(j.characters ?? '').trim();
      const scenes = (Array.isArray(j.scenes) ? j.scenes : []).map((s: unknown) => String(s).trim()).filter(Boolean);
      if (!characters || scenes.length !== n) throw new Error(`分镜数量不对：${scenes.length}/${n}`);
      return { characters, scenes };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('分镜失败');
}

/** 万相组图（异步任务 + 轮询），返回图片 URL（24 小时有效） */
async function wanxSequence(prompt: string, n: number): Promise<string[]> {
  const headers = { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${WANX_BASE}/services/aigc/image-generation/generation`, {
    method: 'POST',
    headers: { ...headers, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: WANX_MODEL,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: { enable_sequential: true, n, size: '1080*1920', watermark: false },
    }),
  });
  const d: any = await res.json().catch(() => ({}));
  const taskId = d?.output?.task_id;
  if (!taskId) throw new Error(`万相提交失败 ${res.status} ${d?.code ?? ''} ${d?.message ?? ''}`.trim());
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const t: any = await (await fetch(`${WANX_BASE}/tasks/${taskId}`, { headers })).json().catch(() => ({}));
    const st = t?.output?.task_status;
    if (st === 'SUCCEEDED') {
      return (t.output.choices ?? []).flatMap((c: any) => (c?.message?.content ?? []).map((x: any) => x?.image).filter(Boolean));
    }
    if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') throw new Error(`万相任务 ${st} ${t?.output?.code ?? ''} ${t?.output?.message ?? ''}`.trim());
  }
  throw new Error('万相出图超时（15 分钟）');
}
