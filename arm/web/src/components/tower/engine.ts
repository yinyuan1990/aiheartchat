// Tower Building: a port of iamkun/tower_game (MIT, see public/tower/License-tower_game.txt) to a dt-driven canvas
// engine. The original runs per frame at 60 fps (cooljs `pixelsPerFrame`); every rate here is that value per second.
import { TowerAudio, recordingAudio, renderLog, type AudioLog } from "./audio";

export type Phase = "ready" | "playing" | "over";

type Hooks = {
  onPhase: (p: Phase, score: number) => void;
  onRequestStart: () => void;
};

export const SUCCESS_SCORE = 25;
/** each perfect in a row adds another 25, at most this many times (the original has no cap) */
export const PERFECT_MAX = 5;
/** a floor never scores more than this */
export const MAX_FLOOR_SCORE = SUCCESS_SCORE * (1 + PERFECT_MAX);
/** seconds of game time at the least between the drop of a floor that landed and the next drop. The block needs ~0.3 s
 *  to fall, the camera 0.5 s to follow and the hook 0.5 s to come down, so play never gets near it; it just makes the
 *  bound below hard. */
export const DROP_GAP = 1.2;
/** Most points a run can have after s seconds. The indexer clamps scores with the same formula against the run's
 *  wall-clock time, so keep the two in step: arm/indexer/src/boat.ts `towerBudget`. */
export const towerBudget = (s: number) => MAX_FLOOR_SCORE * (1 + Math.floor(s / DROP_GAP));

const BG_RATIO = 1050 / 750;
const IMAGES = [
  "background", "block", "block-perfect", "block-rope", "hook", "heart", "score", "tutorial", "tutorial-arrow", "main-bg",
  "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "f1", "f2", "f3", "f4", "f5", "f6", "f7",
] as const;
type Img = (typeof IMAGES)[number];
/** sky colours from the ground up; the gradient walks through them as the tower grows */
const SKY = [[200, 255, 150], [105, 230, 240], [90, 190, 240], [85, 100, 190], [55, 20, 35], [75, 25, 35], [25, 0, 10]];
/** floor → [plane / balloon image, path] */
const FLIGHTS: Record<number, [number, "lr" | "rl" | "bt" | "rtl"]> = { 2: [1, "lr"], 6: [2, "rl"], 8: [3, "lr"], 14: [4, "bt"], 18: [5, "bt"], 22: [6, "bt"], 25: [7, "rtl"] };

type BlockState = "swing" | "drop" | "land" | "rotL" | "rotR" | "out";
type Block = {
  state: BlockState;
  /** top-left corner */
  x: number; y: number; vy: number;
  dropT: number;
  perfect: boolean;
  rot: number; off: number; a0: number; hyp: number;
};
type Cloud = { x: number; y: number; ox: number; vx: number; count: number; img: Img };
type Flight = { img: Img; x: number; y: number; vx: number; vy: number };
type Pop = { x: number; y: number; text: string; life: number; big: boolean };
type Tween = { t0: number; dur: number; from: number; to: number };
type TweenKey = "hook" | "move" | "bgInit" | "tutorial" | "flash";

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sign = () => (Math.random() < 0.5 ? -1 : 1);
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const skyAt = (i: number, p: number) => {
  // same index clamping as the original's getLinearGradientColorRgb
  const cur = i + 1 >= SKY.length ? SKY.length - 1 : i;
  const next = cur + 1 >= SKY.length - 1 ? cur : cur + 1;
  const c = (k: number) => Math.round(SKY[cur][k] + (SKY[next][k] - SKY[cur][k]) * p);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
};

export class TowerEngine {
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private img: Partial<Record<Img, HTMLImageElement>> = {};
  private pattern: CanvasPattern | null = null;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  /** the play field, laid out at the start of each run: at most 1 : 1.5, centred */
  private W = 360;
  private H = 640;

  private phase: Phase = "ready";
  /** seconds since the engine started; tweens and the swing run on it */
  private t = 0;
  /** game seconds since start(): drops and the score bound run on it */
  private gt = 0;
  private tw: Record<TweenKey, Tween | null> = { hook: null, move: null, bgInit: null, tutorial: null, flash: null };
  private hookY = 0;
  private angle = 0;
  private angle0 = 0;
  private blocks: Block[] = [];
  private cur: Block | null = null;
  private line = { x: 0, cx: 0, y: 0 };
  private bgY = 0;
  private skyOff = 0;
  private scroll = 0;
  private clouds: Cloud[] = [];
  private flights: Flight[] = [];
  private flightN = 0;
  private pops: Pop[] = [];
  private tutorial = false;
  private rope = 0;
  private hard = false;

  private score = 0;
  private success = 0;
  private failed = 0;
  private perfectRun = 0;
  /** game time of the drop that made the top floor */
  private lastLand = -99;
  /** shortest time between two landed drops this run, for the capture checks */
  private minGap = Infinity;
  /** taps refused only because of DROP_GAP */
  private gapBlocked = 0;
  private overAt = -1;

  zh = true;
  readonly audio: TowerAudio;
  private audioLog: AudioLog = [];
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private local = window.location.hostname === "localhost";
  private params = new URLSearchParams(window.location.search);
  // local only: ?demo=1 plays itself; ?capture=1 also stops the clock so a script can step fixed 1/60 s frames and
  // screenshot each one (window.__tower.step); ?floor=20 starts with the difficulty of floor 20
  private capture = this.local && this.params.get("capture") === "1";
  private demo = this.local && (this.params.get("demo") === "1" || this.capture);
  /** ?fast=1: no swing, and the autopilot drops the moment the hook is ready (checks that DROP_GAP never bites) */
  private fast = this.local && this.params.get("fast") === "1";
  private aim = 0;
  private aimD: number | null = null;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    const sound = new TowerAudio();
    this.audio = this.capture ? recordingAudio(sound, this.audioLog, () => this.t) : sound;
    this.cv = document.createElement("canvas");
    Object.assign(this.cv.style, { display: "block", width: "100%", height: "100%", touchAction: "none" });
    host.appendChild(this.cv);
    this.g = this.cv.getContext("2d")!;
    for (const k of IMAGES) {
      const im = new Image();
      im.src = `/tower/${k}.png`;
      if (k === "main-bg") im.onload = () => { this.pattern = this.g.createPattern(im, "repeat"); };
      this.img[k] = im;
    }
    try {
      const font = new FontFace("wenxue", "url(/tower/wenxue.woff)");
      void font.load().then((f) => document.fonts.add(f)).catch(() => {});
    } catch { /* no FontFace: falls back to Arial */ }
    this.dpr = this.capture ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.bindInput();
    this.render();
    this.last = performance.now();
    if (this.capture) {
      (window as unknown as { __tower: unknown }).__tower = {
        step: (n = 1) => { for (let i = 0; i < n; i++) this.tick(1 / 60); this.render(); },
        info: () => ({ phase: this.phase, score: this.score, floor: this.success, failed: this.failed, perfectRun: this.perfectRun, gt: this.gt, t: this.t, hard: this.hard, minGap: this.minGap, gapBlocked: this.gapBlocked, budget: towerBudget(this.gt) }),
        start: () => this.hooks.onRequestStart(),
        tap: () => this.tap(),
        time: () => this.t,
        audio: async (t0: number, seconds: number) => {
          const bytes = await renderLog(this.audioLog, t0, seconds);
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
      };
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  start() {
    this.audio.unlock();
    if (this.phase === "playing") return;
    this.layout();
    this.gt = 0;
    this.score = 0; this.failed = 0; this.perfectRun = 0; this.lastLand = -99; this.minGap = Infinity; this.gapBlocked = 0; this.overAt = -1;
    this.success = this.local ? Math.max(0, Math.floor(Number(this.params.get("floor")) || 0)) : 0;
    this.tw.bgInit = { t0: this.t, dur: 0.5, from: this.bgY, to: this.bgY + this.bgH / 4 };
    this.tw.tutorial = { t0: this.t, dur: 0.5, from: 0, to: 0 };
    this.tutorial = true;
    this.phase = "playing";
    this.audio.bgm();
    this.hooks.onPhase("playing", 0);
  }

  dispose() {
    this.audio.dispose();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
    this.cv.remove();
  }

  // ---------------------------------------------------------------- layout

  private get bw() { return this.W * 0.25; }
  private get bh() { return this.bw * 0.71; }
  private get bgH() { return this.W * BG_RATIO; }

  /** fresh scene at the current screen size: house on the ground, clouds, empty tower */
  private layout() {
    this.W = Math.min(this.cssW, this.cssH / 1.5);
    this.H = this.cssH;
    const { W, H } = this;
    this.rope = H * 0.4;
    this.hard = false;
    this.blocks = []; this.cur = null; this.flights = []; this.flightN = 0; this.pops = [];
    this.tw = { hook: null, move: null, bgInit: null, tutorial: null, flash: null };
    this.hookY = -1.5 * this.rope;
    this.angle = 0; this.angle0 = 0;
    this.bgY = H - this.bgH;
    this.skyOff = 0;
    this.scroll = 0;
    this.line = { x: 0, cx: W - this.bw, y: H - this.bgH * 0.394 };
    const size = W * 0.3;
    const spots = [[0.1 * W, -0.66 * H], [0.65 * W, -0.33 * H], [0.1 * W, 0], [0.65 * W, 0.33 * H]];
    this.clouds = spots.map(([px, py], i) => {
      const x = rand(px, px * 1.2);
      return { x, ox: x, y: rand(py, py * 1.2), vx: size * rand(0.05, 0.08) * sign(), count: 4 - i, img: pick(["c1", "c2", "c3"] as const) };
    });
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.cssW = w; this.cssH = h;
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    if (this.phase !== "playing") this.layout();
    this.render();
  }

  // ---------------------------------------------------------------- input

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (this.phase === "playing" && (e.key === " " || e.key === "ArrowDown" || e.key === "Enter")) { this.tap(); e.preventDefault(); }
    else if ((e.key === "Enter" || e.key === " ") && this.phase !== "playing") { this.hooks.onRequestStart(); e.preventDefault(); }
  };

  private bindInput() {
    window.addEventListener("keydown", this.onKey);
    this.cv.addEventListener("pointerdown", () => {
      this.audio.unlock();
      if (this.phase === "playing") this.tap();
    });
  }

  private active(k: TweenKey) {
    const w = this.tw[k];
    return !!w && this.t <= w.t0 + w.dur;
  }
  private val(k: TweenKey) {
    const w = this.tw[k]!;
    return w.from + (w.to - w.from) * Math.min(1, Math.max(0, (this.t - w.t0) / w.dur));
  }

  /** release the swinging block, if the hook is ready */
  private tap() {
    const b = this.cur;
    if (this.phase !== "playing" || this.overAt >= 0 || !b || b.state !== "swing") return;
    if (this.active("hook")) return;
    if (this.gt - this.lastLand < DROP_GAP) { this.gapBlocked++; return; }
    this.tutorial = false;
    b.dropT = this.gt;
    this.tw.hook = { t0: this.t, dur: 0.5, from: this.hookY, to: this.hookY - this.rope };
    const [wx, wy] = this.weight();
    b.x = wx - this.bw / 2;
    b.y = wy + 0.3 * this.bh;
    b.vy = 0;
    b.state = "drop";
  }

  private weight(): [number, number] {
    return [this.W / 2 + Math.sin(this.angle) * this.rope, this.hookY + Math.cos(this.angle) * this.rope];
  }

  // ---------------------------------------------------------------- loop

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.tick(dt);
    this.render();
  };

  private tick(dt: number) {
    this.t += dt;
    const playing = this.phase === "playing";
    if (playing) this.gt += dt;
    const { W, H } = this;
    const ms = this.t * 1000;

    // camera: everything on the ground slides down while the tower grows
    if (this.tw.move) {
      const s = this.val("move");
      const d = s - this.scroll;
      this.scroll = s;
      if (d) {
        this.line.y += d;
        this.bgY += d;
        this.skyOff += d * 1.5;
        for (const c of this.clouds) c.y += d * 1.2;
        for (const b of this.blocks) if (b.state === "land") b.y += d;
      }
      if (!this.active("move")) this.tw.move = null;
    }
    if (this.tw.bgInit) {
      this.bgY = this.val("bgInit");
      if (!this.active("bgInit")) this.tw.bgInit = null;
    }

    // clouds, then rocks once they are high enough
    const size = W * 0.3;
    for (const c of this.clouds) {
      c.x += c.vx * dt;
      if (c.x >= c.ox + size || c.x <= c.ox - size) c.vx *= -1;
      if (c.y >= H) {
        c.y = -0.66 * H;
        c.count += 4;
        c.img = c.count > 6 ? pick(["c4", "c5", "c6", "c7", "c8"] as const) : pick(["c1", "c2", "c3"] as const);
      }
    }
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.x += f.vx * dt; f.y += f.vy * dt;
      if (f.y + size < 0 || f.y > H || f.x + size < 0 || f.x > W) this.flights.splice(i, 1);
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.life -= dt;
      p.y -= 50 * dt;
      if (p.life <= 0) this.pops.splice(i, 1);
    }

    if (playing && this.overAt < 0) this.spawn();

    // hook and the swing
    if (this.tw.hook) {
      this.hookY = this.val("hook");
      if (!this.active("hook")) this.tw.hook = null;
    }
    this.angle = this.angle0 * this.swing(ms);

    // the tower top sways from floor 5 on
    const sway = this.towerSway(ms) * 60 * dt;
    this.line.x += sway;
    this.line.cx += sway;
    for (const b of this.blocks) {
      if (b.state === "land") b.x += sway;
      else this.updateBlock(b, dt);
    }
    this.blocks = this.blocks.filter((b) => b.state !== "out" && !(b.state === "land" && b.y > H));

    if (playing && this.demo && this.overAt < 0) this.autopilot();
    if (playing && this.overAt >= 0 && this.t - this.overAt > 1) {
      this.phase = "over";
      this.hooks.onPhase("over", this.score);
    }
  }

  private swing(ms: number) {
    let k = this.success < 1 ? 0 : this.success < 10 ? 1 : this.success < 20 ? 0.8 : this.success < 30 ? 0.7 : 0.74;
    if (this.hard) k = 1.1;
    return k ? Math.sin((ms * k) / 200) : 0;
  }

  private towerSway(ms: number) {
    const s = this.success;
    const k = s < 5 ? 0 : s < 13 ? 0.001 : s < 23 ? 0.002 : 0.003;
    return Math.cos(ms / 200) * k * this.W;
  }

  /** the next block once the last one has landed or fallen, the camera has settled and the hook is back up */
  private spawn() {
    const b = this.cur;
    if (b && b.state !== "land" && b.state !== "out") return;
    if (this.active("move") || this.active("hook")) return;
    const base = this.hard ? 90 : this.success < 10 ? 30 : this.success < 20 ? 60 : 80;
    this.angle0 = this.fast ? 0 : (Math.PI * rand(base, base + 5) * sign()) / 180;
    this.hookY = -1.5 * this.rope;
    this.tw.hook = { t0: this.t, dur: 0.5, from: this.hookY, to: this.hookY + this.rope };
    this.cur = { state: "swing", x: 0, y: 0, vy: 0, dropT: 0, perfect: false, rot: 0, off: 0, a0: 0, hyp: 0 };
    this.blocks.push(this.cur);
    this.aimD = null;
    // the autopilot aims a bit off, more so the higher it gets
    this.aim = Math.random() < Math.max(0.15, 0.6 - this.success * 0.01) ? 0 : rand(-1, 1) * (0.12 + this.success * 0.006) * this.bw;
    const fl = FLIGHTS[this.success];
    if (fl && this.flightN !== fl[0]) this.addFlight(...fl);
  }

  private addFlight(n: number, path: "lr" | "rl" | "bt" | "rtl") {
    const { W, H } = this;
    const size = W * 0.3;
    const f: Flight = path === "bt" ? { img: `f${n}` as Img, x: W * rand(0.3, 0.7), y: H, vx: 0, vy: -0.7 * H }
      : path === "lr" ? { img: `f${n}` as Img, x: -size, y: H * rand(0.3, 0.6), vx: 0.4 * W, vy: -0.1 * H }
      : path === "rl" ? { img: `f${n}` as Img, x: W, y: H * rand(0.2, 0.5), vx: -0.4 * W, vy: 0.1 * H }
      : { img: `f${n}` as Img, x: W, y: 0, vx: -0.6 * W, vy: 0.5 * H };
    this.flights.push(f);
    this.flightN = n;
  }

  private updateBlock(b: Block, dt: number) {
    const { W, H, bw, bh, line } = this;
    if (b.state === "drop") {
      b.vy += 5 * H * dt;
      b.y += b.vy * dt;
      if (b.y + bh < line.y) return;
      // where the block's left edge is against the top floor's: line.x .. line.cx spans ±half a block around it
      if (b.x < line.x - bw / 2 || b.x > line.cx + bw / 2) { if (b.y >= H) this.fail(b); return; }
      if (b.x < line.x || b.x > line.cx) {
        const right = b.x > line.cx;
        b.state = right ? "rotR" : "rotL";
        b.y = line.y - bh;
        b.off = (right ? line.cx : line.x) + bw / 2 - b.x;
        b.a0 = Math.atan(bh / b.off);
        b.hyp = Math.hypot(bh, b.off);
        this.audio.rotate();
        return;
      }
      const perfect = b.x > line.x + bw * 0.4 && b.x < line.x + bw * 0.6;
      this.land(b, perfect);
    } else if (b.state === "rotL" || b.state === "rotR") {
      const right = b.state === "rotR";
      const dir = right ? 1 : -1;
      const speed = Math.PI * 4;
      if (right ? b.rot > 1.3 : b.rot < -1.3) {
        b.rot += (speed / 8) * dir * dt;
        b.y += H * 0.7 * dt;
        b.x += W * 0.3 * dt * dir;
      } else {
        const ratio = Math.max(0.5, (bw / 2 - b.off) / (bw / 2));
        b.rot += speed * ratio * dir * dt;
        const a = b.a0 + b.rot;
        const ax = (right ? line.cx : line.x) + bw / 2;
        b.x = ax - Math.cos(a) * b.hyp;
        b.y = line.y - Math.sin(a) * b.hyp;
      }
      if (right ? b.y >= H : b.y - bw >= H) this.fail(b);
    }
  }

  private land(b: Block, perfect: boolean) {
    const { W, bw, bh, line } = this;
    const before = this.success;
    b.state = "land";
    b.perfect = perfect;
    if (this.lastLand >= 0) this.minGap = Math.min(this.minGap, b.dropT - this.lastLand);
    this.lastLand = b.dropT;
    b.y = line.y - bh;
    this.success++;
    if (this.hard) this.rope = this.H * rand(0.35, 0.55);
    const d = bh * (this.success <= 4 ? 1.25 : 1);
    this.tw.move = { t0: this.t, dur: 0.5, from: this.scroll, to: this.scroll + d };
    if (before === 10 || before === 15) this.tw.flash = { t0: this.t, dur: 0.15, from: 0, to: 0 };
    line.y = b.y;
    line.x = b.x - bw / 2;
    line.cx = line.x + bw;
    // the original's "cheat" check: a tower leaning a third of a block off screen gets the hard swing
    if (b.x > W - bw * 0.6 || b.x < -bw * 0.3) this.hard = true;
    this.perfectRun = perfect ? this.perfectRun + 1 : 0;
    const pts = SUCCESS_SCORE * (1 + Math.min(this.perfectRun, PERFECT_MAX));
    this.score += pts;
    this.pops.push({ x: b.x + bw / 2, y: b.y - 6, text: perfect ? `${this.zh ? "完美" : "Perfect"} +${pts}` : `+${pts}`, life: 0.9, big: perfect });
    this.audio.drop(perfect);
  }

  private fail(b: Block) {
    b.state = "out";
    this.failed++;
    this.perfectRun = 0;
    if (this.failed >= 3 && this.overAt < 0) {
      this.overAt = this.t;
      this.audio.over();
    }
  }

  // ---------------------------------------------------------------- autopilot (local demo / capture)

  private autopilot() {
    const b = this.cur;
    if (this.fast) { if (b?.state === "swing" && !this.active("hook")) this.tap(); return; }
    if (!b || b.state !== "swing" || this.active("hook") || this.gt - this.lastLand < DROP_GAP) { this.aimD = null; return; }
    const [wx] = this.weight();
    const target = this.success === 0 ? wx - this.bw / 2 : this.line.x + this.bw / 2 + this.aim;
    const d = wx - this.bw / 2 - target;
    if (this.success === 0 || Math.abs(d) < this.bw * 0.03 || (this.aimD !== null && Math.sign(d) !== Math.sign(this.aimD))) this.tap();
    this.aimD = d;
  }

  // ---------------------------------------------------------------- render

  private draw(k: Img, x: number, y: number, w: number, h: number) {
    const im = this.img[k];
    if (im?.complete && im.naturalWidth) this.g.drawImage(im, x, y, w, h);
  }

  private render() {
    const g = this.g;
    const { W, H, cssW, cssH, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#f95240";
    g.fillRect(0, 0, cssW, cssH);
    if (this.pattern) { g.fillStyle = this.pattern; g.fillRect(0, 0, cssW, cssH); }
    const s = Math.min(cssW / W, cssH / H);
    const ox = (cssW - W * s) / 2, oy = (cssH - H * s) / 2;
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();

    // sky, a white flash at floors 10 and 15, the house
    const i = Math.floor(this.skyOff / H), p = (this.skyOff % H) / H;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, skyAt(i + 1, p));
    grad.addColorStop(1, skyAt(i, p));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    if (this.active("flash")) { g.fillStyle = "rgba(255,255,255,0.7)"; g.fillRect(0, 0, W, H); }
    if (this.bgY <= H) this.draw("background", 0, this.bgY, W, this.bgH);

    const size = W * 0.3;
    for (const f of this.flights) this.draw(f.img, f.x, f.y, size, size);
    for (const c of this.clouds) this.draw(c.img, c.x, c.y, size, size);

    // hook: the rope image swings about its top
    if (this.phase === "playing") {
      const rw = this.rope * 0.1;
      g.save();
      g.translate(W / 2, this.hookY);
      g.rotate(-this.angle);
      this.draw("hook", -rw / 2, 0, rw, this.rope + 5);
      g.restore();
    }

    const { bw, bh } = this;
    for (const b of this.blocks) {
      if (b.state === "swing") {
        const [wx, wy] = this.weight();
        this.draw("block-rope", wx - bw / 2, wy, bw, bh * 1.3);
      } else if (b.state === "rotL" || b.state === "rotR") {
        g.save();
        g.translate(b.x, b.y);
        g.rotate(b.rot);
        this.draw("block", 0, 0, bw, bh);
        g.restore();
      } else if (b.state !== "out") {
        this.draw(b.perfect ? "block-perfect" : "block", b.x, b.y, bw, bh);
      }
    }

    if (this.phase === "playing" && this.tutorial && !this.active("tutorial") && !this.active("hook")) {
      const tw = W * 0.2, th = tw * 0.46, tx = W / 2 - tw / 2, ty = H * 0.45;
      this.draw("tutorial", tx, ty, tw, th);
      this.draw("tutorial-arrow", tx, ty + th * 1.2 + Math.sin(this.t * 5) * th * 0.12, tw, th);
    }

    for (const pop of this.pops) {
      g.globalAlpha = Math.min(1, pop.life / 0.3);
      this.yellow(pop.text, pop.big ? W * 0.065 : W * 0.055, pop.x, pop.y, "center", "bold", "wenxue, Arial");
    }
    g.globalAlpha = 1;

    if (this.phase === "playing") this.hud();
    g.restore();
  }

  /** the original's score style: orange gradient fill with a white outline */
  private yellow(text: string, size: number, x: number, y: number, align: CanvasTextAlign, weight = "normal", font = "wenxue, Arial", maxW = Infinity) {
    const g = this.g;
    g.save();
    g.font = `${weight} ${size}px ${font}`;
    const tw = g.measureText(text).width;
    if (tw > maxW) size *= maxW / tw;
    const grad = g.createLinearGradient(0, y - size, 0, y);
    grad.addColorStop(0, "#FAD961");
    grad.addColorStop(1, "#F76B1C");
    g.fillStyle = grad;
    g.lineWidth = size * 0.1;
    g.strokeStyle = "#FFF";
    g.lineJoin = "round";
    g.textAlign = align;
    g.textBaseline = "alphabetic";
    g.font = `${weight} ${size}px ${font}`;
    g.strokeText(text, x, y);
    g.fillText(text, x, y);
    g.restore();
  }

  /** floor count on the left, score and hearts on the right, below the page's back / mute buttons */
  private hud() {
    const { W } = this;
    const top = Math.min(64, W * 0.18);
    const wide = this.success > 99 ? W * 0.1 : 0;
    this.yellow(this.zh ? "层" : "floor", W * 0.06, W * 0.24 + wide, top + W * 0.12, "left", "bold", this.zh ? "\"PingFang SC\", \"Microsoft YaHei\", sans-serif" : "Arial");
    this.yellow(String(this.success), W * 0.17, W * 0.22 + wide, top + W * 0.2, "right");
    const sw = W * 0.35;
    this.draw("score", W * 0.61, top + W * 0.038, sw, (sw * 131) / 409);
    // in the blank right part of the SCORE plate
    this.yellow(String(this.score), W * 0.06, W * 0.87, top + W * 0.11, "center", "normal", "wenxue, Arial", W * 0.13);
    const hw = W * 0.08, hh = (hw * 53) / 60;
    for (let i = 0; i < 3; i++) {
      this.g.globalAlpha = i < this.failed ? 0.2 : 1;
      this.draw("heart", W * 0.66 + i * hw, top + W * 0.16, hw, hh);
    }
    this.g.globalAlpha = 1;
  }
}
