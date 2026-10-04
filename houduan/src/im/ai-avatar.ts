import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 头像小工具（币群头像、机器人头像）：下载图片、Pollinations（Flux，免费、不要 key）按提示词画图、ffmpeg 统一成 256×256 PNG。
 * Pollinations 免费档会在右下角打水印，所以画高一点、只留上面的正方形。
 */

const SIZE = 256;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchImage(url: string, timeout: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'Peiwan/1.0' } });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) throw new Error(`${res.status} ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || buf.length > 8 * 1024 * 1024) throw new Error(`size ${buf.length}`);
  return buf;
}

/** 按提示词画一张，返回去掉水印的 PNG；seedKey 相同画出来就相同 */
export async function paintPollinations(prompt: string, seedKey: string): Promise<Buffer> {
  const seed = createHash('sha256').update(seedKey).digest().readUInt32BE(0) % 1_000_000_000;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=576&nologo=true&model=flux&seed=${seed}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await toPng(await fetchImage(url, 120_000), true);
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(8_000 * (attempt + 1));
    }
  }
}

/** 任意图片 → 256×256 PNG（居中裁成正方形）；topSquare 先只取上面的正方形 */
export async function toPng(input: Buffer, topSquare: boolean): Promise<Buffer> {
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
