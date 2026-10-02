/**
 * Telegram 式删除动画：把消息气泡按像素拆成粒子，从左到右依次化成灰飘走。
 * 不依赖截图库：按 DOM 自己画一张快照（背景色 + 圆角、逐字文字、图片 / 视频帧），再从快照取像素生成粒子。
 * 返回的 Promise 在气泡「碎完」时 resolve，调用方这时再把它从列表里移掉（粒子在全屏画布上继续飘）。
 */

const STEP = 2; // 取样间隔（CSS 像素），越小越细腻、越费
const MAX_PARTICLES = 9000;
const SWEEP = 0.45; // 从左扫到右用时（秒）
const LIFE = 0.9; // 每颗粒子存活（秒）
const JITTER = 0.08; // 起飞时间的随机抖动，让碎裂边缘是颗粒状的

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  delay: number;
  life: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const running = new WeakMap<Element, Promise<void>>();

function parseRadius(cs: CSSStyleDeclaration, w: number, h: number): [number, number, number, number] {
  const px = (v: string) => Math.min(parseFloat(v) || 0, w / 2, h / 2);
  return [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  ctx.beginPath();
  ctx.moveTo(x + r[0], y);
  ctx.lineTo(x + w - r[1], y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r[1]);
  ctx.lineTo(x + w, y + h - r[2]);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
  ctx.lineTo(x + r[3], y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r[3]);
  ctx.lineTo(x, y + r[0]);
  ctx.quadraticCurveTo(x, y, x + r[0], y);
  ctx.closePath();
}

function visibleColor(c: string) {
  return !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
}

/** 按 DOM 画快照：原点是 root 的左上角 */
function paint(ctx: CanvasRenderingContext2D, root: HTMLElement, ox: number, oy: number) {
  const walk = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const x = r.left - ox;
    const y = r.top - oy;
    if (visibleColor(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      roundRect(ctx, x, y, r.width, r.height, parseRadius(cs, r.width, r.height));
      ctx.fill();
    }
    if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) {
      ctx.save();
      roundRect(ctx, x, y, r.width, r.height, parseRadius(cs, r.width, r.height));
      ctx.clip();
      try {
        ctx.drawImage(el, x, y, r.width, r.height);
      } catch {
        ctx.fillStyle = '#c8c8cf';
        ctx.fillRect(x, y, r.width, r.height);
      }
      ctx.restore();
      return;
    }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) paintText(ctx, n as Text, cs, ox, oy);
      else if (n.nodeType === Node.ELEMENT_NODE) walk(n as Element);
    }
  };
  walk(root);
}

function paintText(ctx: CanvasRenderingContext2D, node: Text, cs: CSSStyleDeclaration, ox: number, oy: number) {
  const text = node.data;
  if (!text.trim()) return;
  ctx.fillStyle = cs.color;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  const range = document.createRange();
  // 逐个字符取位置（按码点，emoji 不拆开），最多 800 个，够一条消息用
  let i = 0;
  let count = 0;
  for (const ch of text) {
    const len = ch.length;
    if (count++ > 800) break;
    if (ch.trim()) {
      range.setStart(node, i);
      range.setEnd(node, i + len);
      const rects = range.getClientRects();
      const rr = rects[0];
      if (rr && rr.width > 0) {
        const size = parseFloat(cs.fontSize) || 15;
        // 基线大约在字框底部往上 22%
        ctx.fillText(ch, rr.left - ox, rr.bottom - oy - rr.height * 0.22 + (rr.height - size * 1.2) * 0.1);
      }
    }
    i += len;
  }
  range.detach?.();
}

/** 按设备像素画一张清晰快照（还没碎的部分直接画它，粒子只在扫过的地方出现） */
function snapshot(el: HTMLElement, rect: DOMRect) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  paint(ctx, el, rect.left, rect.top);
  try {
    return { canvas: c, img: ctx.getImageData(0, 0, c.width, c.height), dpr };
  } catch {
    // 图片跨域把画布污染了：拿不到像素，退回纯色
    const c2 = document.createElement('canvas');
    c2.width = c.width;
    c2.height = c.height;
    const ctx2 = c2.getContext('2d')!;
    ctx2.fillStyle = '#d8d8de';
    roundRect(ctx2, 0, 0, c2.width, c2.height, [14 * dpr, 14 * dpr, 14 * dpr, 14 * dpr]);
    ctx2.fill();
    return { canvas: c2, img: ctx2.getImageData(0, 0, c2.width, c2.height), dpr };
  }
}

function particlesOf(img: ImageData, dpr: number, rect: DOMRect, budget: number): Particle[] {
  const { width: w, height: h, data } = img;
  // 取样间隔按设备像素算，换回 CSS 像素当粒子大小
  let step = Math.max(1, Math.round(STEP * dpr * 0.75));
  while ((w / step) * (h / step) > budget) step += 1;
  const out: Particle[] = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 24) continue;
      const ang = -Math.PI / 2 + (Math.random() - 0.15) * 1.6; // 主要往上、偏右
      const speed = 30 + Math.random() * 90;
      out.push({
        x: rect.left + x / dpr,
        y: rect.top + y / dpr,
        vx: Math.cos(ang) * speed + 25,
        vy: Math.sin(ang) * speed,
        delay: (x / w) * SWEEP + Math.random() * JITTER,
        life: LIFE * (0.6 + Math.random() * 0.6),
        size: step / dpr,
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
        a: a / 255,
      });
    }
  }
  return out;
}

interface Cloud {
  ps: Particle[];
  /** 清晰快照：扫描线右边还没碎的部分直接画它 */
  snap: HTMLCanvasElement;
  dpr: number;
  rect: DOMRect;
  t0: number;
}

let layer: HTMLCanvasElement | null = null;
let active: Cloud[] = [];
let raf = 0;
let last = 0;
let clock = 0;

function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement('canvas');
  Object.assign(layer.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '9999' });
  document.body.appendChild(layer);
  return layer;
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  const cv = ensureLayer();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(innerWidth * dpr) || cv.height !== Math.round(innerHeight * dpr)) {
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  active = active.filter((c) => {
    const t = clock - c.t0;
    const { rect, snap } = c;
    // 扫描线：左边的粒子都已起飞（减去抖动），右边画原图
    const cut = Math.max(0, Math.min(1, (t - JITTER) / SWEEP)) * rect.width;
    let alive = cut < rect.width;
    if (alive) {
      const sx = cut * c.dpr;
      ctx.drawImage(snap, sx, 0, snap.width - sx, snap.height, rect.left + cut, rect.top, rect.width - cut, rect.height);
    }
    for (const p of c.ps) {
      const age = t - p.delay;
      if (age > p.life) continue;
      if (age <= 0 && p.x - rect.left >= cut) continue;
      alive = true;
      let x = p.x;
      let y = p.y;
      let k = 1;
      if (age > 0) {
        const f = age / p.life;
        // 先慢后快地散开，带一点湍流
        x += p.vx * age + Math.sin((p.y + age * 60) * 0.08) * 6 * f;
        y += p.vy * age - 18 * age * age;
        k = 1 - f;
      }
      const s = age > 0 ? p.size * (0.5 + 0.5 * k) : p.size;
      ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.a * (age > 0 ? k * k : 1)})`;
      ctx.fillRect(x, y, s, s);
    }
    return alive;
  });
  if (active.length) raf = requestAnimationFrame(frame);
  else {
    raf = 0;
    layer?.remove();
    layer = null;
  }
}

/** 把元素化成灰；元素不在屏幕上 / 用户关了动画就直接 resolve */
export function dust(el: Element | null | undefined, budget = MAX_PARTICLES): Promise<void> {
  if (!(el instanceof HTMLElement)) return Promise.resolve();
  const busy = running.get(el);
  if (busy) return busy;
  const rect = el.getBoundingClientRect();
  const offscreen = rect.bottom < 0 || rect.top > innerHeight || rect.width < 2 || rect.height < 2;
  if (offscreen || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  const snap = snapshot(el, rect);
  if (!snap) return Promise.resolve();
  const ps = particlesOf(snap.img, snap.dpr, rect, budget);
  el.style.visibility = 'hidden';
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  active.push({ ps, snap: snap.canvas, dpr: snap.dpr, rect, t0: clock });
  const p = new Promise<void>((resolve) => setTimeout(resolve, SWEEP * 1000 + 120));
  running.set(el, p);
  return p;
}

/** 删除接口失败时把已经藏起来的元素放回来 */
export function undust(els: (Element | null | undefined)[]) {
  for (const e of els) {
    if (e instanceof HTMLElement) {
      e.style.visibility = '';
      running.delete(e);
    }
  }
}

/** 先把这些 id 对应的元素化成灰，再执行 remove（更新列表） */
export function dustThen(els: (Element | null | undefined)[], remove: () => void) {
  const list = els.filter(Boolean);
  if (!list.length) return remove();
  // 一次清很多条时按条数分摊粒子，总量控制在 3 万颗左右
  const budget = Math.max(1200, Math.min(MAX_PARTICLES, Math.floor(30000 / list.length)));
  void Promise.all(list.map((e) => dust(e, budget))).then(remove);
}
