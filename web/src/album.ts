/**
 * 聊天多图（相册）：一次选多张图时每张仍是一条 image 消息，地址后面带 `#g=相册id&w=宽&h=高`。
 * 同一个人连续发、g 相同的图片在气泡里合成一组，按 Telegram 的分组规则排版。
 * 老版本客户端加载图片时会忽略 # 后面的部分，照常一张张显示。
 * Android（ui/screen/ChatAlbum.kt）、iOS（ChatAlbum.swift）是同一套算法，改的话三端一起改。
 */

export interface ImageMeta {
  url: string;
  g?: string;
  w?: number;
  h?: number;
}

export const MAX_ALBUM = 10;

export function parseImage(content: string): ImageMeta {
  const i = content.indexOf('#');
  if (i < 0) return { url: content };
  const out: ImageMeta = { url: content.slice(0, i) };
  for (const kv of content.slice(i + 1).split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k === 'g' && v) out.g = v;
    else if (k === 'w' && +v > 0) out.w = +v;
    else if (k === 'h' && +v > 0) out.h = +v;
  }
  return out;
}

export function imageContent(url: string, meta: { g?: string; w?: number; h?: number }): string {
  const kv: string[] = [];
  if (meta.g) kv.push(`g=${meta.g}`);
  if (meta.w && meta.h) kv.push(`w=${Math.round(meta.w)}`, `h=${Math.round(meta.h)}`);
  return kv.length ? `${url}#${kv.join('&')}` : url;
}

export const imageUrl = (content: string) => parseImage(content).url;

export function newAlbumId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 把消息列表切成行：普通消息一行一条，同一相册的连续图片合成一行 */
export function groupAlbums<T extends { type: string; content: string; senderId: string }>(list: T[]): T[][] {
  const rows: T[][] = [];
  let cur: T[] | null = null;
  let curG = '';
  for (const m of list) {
    const g = m.type === 'image' ? parseImage(m.content).g ?? '' : '';
    if (g && cur && g === curG && cur[0].senderId === m.senderId && cur.length < MAX_ALBUM) {
      cur.push(m);
      continue;
    }
    cur = [m];
    curG = g;
    rows.push(cur);
  }
  return rows;
}

/** 相册里一格的位置，单位是相册宽度（x、w 在 0～1，y、h 也按宽度算） */
export interface AlbumRect { x: number; y: number; w: number; h: number }

const MAX_H = 1.02;
const MIN_W = 0.27;

/** ratios：每张图的宽 / 高。返回每格的位置和相册总高度（相对宽度） */
export function albumLayout(raw: number[]): { rects: AlbumRect[]; height: number } {
  const n = raw.length;
  const r = raw.map((x) => (Number.isFinite(x) && x > 0 ? Math.min(Math.max(x, 0.2), 5) : 1));
  if (n === 1) {
    const h = Math.min(1 / r[0], MAX_H * 1.2);
    return { rects: [{ x: 0, y: 0, w: 1, h }], height: h };
  }
  const prop = r.map((x) => (x > 1.2 ? 'w' : x < 0.8 ? 'n' : 'q')).join('');
  const avg = r.reduce((a, b) => a + b, 0) / n;
  const force = r.some((x) => x > 2);

  if (!force && n === 2) {
    if (prop === 'ww' && avg > 1.4 / MAX_H && Math.abs(r[1] - r[0]) < 0.2) {
      const h = Math.min(1 / r[0], 1 / r[1], MAX_H / 2);
      return { rects: [{ x: 0, y: 0, w: 1, h }, { x: 0, y: h, w: 1, h }], height: h * 2 };
    }
    if (prop === 'ww' || prop === 'qq') {
      const h = Math.min(0.5 / r[0], 0.5 / r[1], MAX_H);
      return { rects: [{ x: 0, y: 0, w: 0.5, h }, { x: 0.5, y: 0, w: 0.5, h }], height: h };
    }
    const w1 = Math.max(0.4, r[1] / (r[0] + r[1]));
    const w0 = 1 - w1;
    const h = Math.min(MAX_H, w0 / r[0], w1 / r[1]);
    return { rects: [{ x: 0, y: 0, w: w0, h }, { x: w0, y: 0, w: w1, h }], height: h };
  }

  if (!force && n === 3) {
    if (prop[0] === 'n') {
      // 左边一张大图占满高度，右边上下两张
      const h2 = Math.min(MAX_H * 0.5, (r[1] * 1) / (r[2] + r[1]));
      const h1 = MAX_H - h2;
      const rw = Math.max(MIN_W, Math.min(0.5, Math.min(h2 * r[2], h1 * r[1])));
      const lw = 1 - rw;
      return {
        rects: [{ x: 0, y: 0, w: lw, h: MAX_H }, { x: lw, y: 0, w: rw, h: h1 }, { x: lw, y: h1, w: rw, h: h2 }],
        height: MAX_H,
      };
    }
    // 上面一张通栏，下面两张并排
    const h0 = Math.min(1 / r[0], MAX_H * 0.66);
    const h1 = Math.min(MAX_H - h0, 0.5 / r[1], 0.5 / r[2]);
    return {
      rects: [{ x: 0, y: 0, w: 1, h: h0 }, { x: 0, y: h0, w: 0.5, h: h1 }, { x: 0.5, y: h0, w: 0.5, h: h1 }],
      height: h0 + h1,
    };
  }

  if (!force && n === 4) {
    if (prop[0] === 'w') {
      // 上面一张通栏，下面三张并排
      const h0 = Math.min(1 / r[0], MAX_H * 0.66);
      let h = 1 / (r[1] + r[2] + r[3]);
      const w0 = Math.max(MIN_W, h * r[1]);
      const w2 = Math.max(MIN_W, h * r[3]);
      const w1 = Math.max(0.1, 1 - w0 - w2);
      h = Math.min(MAX_H - h0, h);
      return {
        rects: [
          { x: 0, y: 0, w: 1, h: h0 },
          { x: 0, y: h0, w: w0, h },
          { x: w0, y: h0, w: w1, h },
          { x: w0 + w1, y: h0, w: 1 - w0 - w1, h },
        ],
        height: h0 + h,
      };
    }
    // 左边一张大图，右边三张竖排
    const rw = Math.min(0.5, Math.max(MIN_W, MAX_H / (1 / r[1] + 1 / r[2] + 1 / r[3])));
    const h0 = Math.min(0.33 * MAX_H, rw / r[1]);
    const h1 = Math.min(0.33 * MAX_H, rw / r[2]);
    const h2 = MAX_H - h0 - h1;
    const lw = 1 - rw;
    return {
      rects: [
        { x: 0, y: 0, w: lw, h: MAX_H },
        { x: lw, y: 0, w: rw, h: h0 },
        { x: lw, y: h0, w: rw, h: h1 },
        { x: lw, y: h0 + h1, w: rw, h: h2 },
      ],
      height: MAX_H,
    };
  }

  // 5 张以上（或有特别宽的图）：枚举 2～4 行的切法，选总高度最接近 4:3 的
  const cr = r.map((x) => (avg > 1.1 ? Math.max(1, x) : Math.min(1, x)));
  const rowH = (start: number, count: number) => {
    let s = 0;
    for (let i = start; i < start + count; i++) s += cr[i];
    return 1 / s;
  };
  const attempts: number[][] = [];
  for (let a = 1; a < n; a++) {
    const b = n - a;
    if (a <= 3 && b <= 3) attempts.push([a, b]);
  }
  for (let a = 1; a < n - 1; a++) {
    for (let b = 1; b < n - a; b++) {
      const c = n - a - b;
      if (a <= 3 && b <= (avg < 0.85 ? 4 : 3) && c <= 3) attempts.push([a, b, c]);
    }
  }
  for (let a = 1; a < n - 2; a++) {
    for (let b = 1; b < n - a - 1; b++) {
      for (let c = 1; c < n - a - b; c++) {
        const d = n - a - b - c;
        if (a <= 3 && b <= 3 && c <= 3 && d <= 3) attempts.push([a, b, c, d]);
      }
    }
  }
  const target = (1 / 3) * 4;
  let best: number[] = attempts[0] ?? [n];
  let bestDiff = Infinity;
  for (const counts of attempts) {
    let start = 0;
    let total = 0;
    let minH = Infinity;
    for (const c of counts) {
      const h = rowH(start, c);
      total += h;
      minH = Math.min(minH, h);
      start += c;
    }
    let diff = Math.abs(total - target);
    if (counts.length > 1 && (counts[0] > counts[1] || (counts.length > 2 && counts[1] > counts[2]) || (counts.length > 3 && counts[2] > counts[3]))) diff *= 1.2;
    if (minH < MIN_W) diff *= 1.5;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = counts;
    }
  }
  const rects: AlbumRect[] = [];
  let start = 0;
  let y = 0;
  for (const c of best) {
    const h = rowH(start, c);
    let x = 0;
    for (let i = start; i < start + c; i++) {
      const w = i === start + c - 1 ? 1 - x : cr[i] * h;
      rects.push({ x, y, w, h });
      x += w;
    }
    y += h;
    start += c;
  }
  return { rects, height: y };
}

/** 最多 limit 个同时上传，传完按 keys 的顺序发出（send 等到服务端确认再发下一张；失败的跳过，留给重试） */
export async function uploadInOrder(
  keys: string[],
  upload: (key: string) => Promise<string | null>,
  send: (key: string, url: string) => void | Promise<unknown>,
  limit = 3,
) {
  const jobs: Promise<string | null>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const i = next++;
      jobs[i] = upload(keys[i]);
      await jobs[i];
    }
  };
  const workers = Array.from({ length: Math.min(limit, keys.length) }, worker);
  for (let i = 0; i < keys.length; i++) {
    while (!jobs[i]) await new Promise((res) => setTimeout(res, 30));
    const url = await jobs[i];
    if (url) await send(keys[i], url);
  }
  await Promise.all(workers);
}

/** 本地选的图：读宽高（用来排版） */
export function readImageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });
}

/** 长边超过 1600 的图压一下再传（GIF 原样传，保住动画） */
export async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  if (file.type === 'image/gif' || !file.type.startsWith('image/')) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long <= maxSide && file.size < 1.5 * 1024 * 1024) return file;
    const s = Math.min(1, maxSide / long);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
