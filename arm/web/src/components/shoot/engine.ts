import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShootAudio, recordingAudio, renderLog, type AudioLog } from "./audio";
import { Batch, createGrid, mix, rgba, withA, type Rgba } from "./gfx";
import { allFx, type Fx, type FxKey } from "./fx";
import { BIG_FRUITS, FRUITS, FRUIT_DEFS, SMALL_FRUITS, drawFruit, drawHalf, isFruit, type Fruit } from "./fruit";

export type Phase = "ready" | "playing" | "over";

type Hooks = {
  onPhase: (p: Phase, score: number) => void;
  onRequestStart: () => void;
};

// The play field is 360 × 640 units, centred on 0; the camera shows at least that much (more on one axis when the
// screen's shape differs). Gameplay x is always clamped to the field width.
const HALF_W = 180;
const HALF_H = 320;
const SHIP_R = 7;
const FIRE_DT = 0.11;
const BULLET_V = 950;
const COMBO_WINDOW = 2.2;
const TWIN_COMBO = 15;
const TRIPLE_COMBO = 30;
/** every 40 combo: fever (rainbow grid and bullets, faster fire) for FEVER_TIME seconds */
const FEVER_COMBO = 40;
const FEVER_TIME = 8;
const WEAPON_TIME = 10;
/** kills this close together count as one multi-kill */
const MULTI_WINDOW = 0.4;

/** Weapon capsules drop from kills; a pickup lasts WEAPON_TIME (bomb goes off at once). They only change how fast
 *  things die — every kill still scores its budgeted points, so the indexer's cap is unaffected. */
export const WEAPONS = ["spread", "laser", "missile", "pierce", "bomb"] as const;
export type Weapon = (typeof WEAPONS)[number];
const WEAPON_C: Record<Weapon, Rgba> = {
  spread: rgba("#ff9a1f"), laser: rgba("#6ef3ff"), missile: rgba("#ff5a3d"), pierce: rgba("#c08bff"), bomb: rgba("#ff3b8a"),
};
/** [中文名, English, 胶囊上的字（中文）, 胶囊上的字（英文）] */
const WEAPON_NAMES: Record<Weapon, [string, string, string, string]> = {
  spread: ["散弹", "SPREAD", "散", "S"],
  laser: ["激光", "LASER", "光", "L"],
  missile: ["追踪导弹", "MISSILES", "弹", "M"],
  pierce: ["穿透速射", "PIERCE", "穿", "P"],
  bomb: ["全屏炸弹", "BOMB", "爆", "B"],
};
const MULTI_TEXT: [number, string, string, string][] = [
  [3, "三连切!", "TRIPLE!", "#9dffb0"],
  [5, "爆汁!!", "JUICY!!", "#ffe14d"],
  [8, "果汁狂欢!!", "FRUIT FRENZY!!", "#ff8ad8"],
  [12, "无双!!!", "UNSTOPPABLE!!!", "#7cf7ff"],
];

/** Enemies are only spawned while their summed base points stay under this (the indexer checks the same formula ×
 *  MAX_MULT against the run's wall-clock time, so keep the two in step: arm/indexer/src/boat.ts `shootBudget`). */
export const spawnBudget = (s: number) => 40 + (s <= 120 ? 15 * s + 0.125 * s * s : 3600 + 45 * (s - 120));
export const MAX_MULT = 3;
export const multFor = (combo: number) => Math.min(MAX_MULT, 1 + 0.5 * Math.floor(combo / 10));

type Kind = "dart" | "hex" | "elite" | Fruit;
type KindDef = { r: number; sides: number; hp: number; pts: number; color: Rgba; mass: number };
/** color = what the hit sparks, rings and numbers take: the neon outline, or a fruit's juice */
const KINDS = {
  dart: { r: 11, sides: 4, hp: 60, pts: 5, color: rgba("#ff3fa4"), mass: 1 },
  hex: { r: 16, sides: 6, hp: 200, pts: 15, color: rgba("#ff9a1f"), mass: 2.2 },
  elite: { r: 27, sides: 4, hp: 1200, pts: 100, color: rgba("#4dff6a"), mass: 7 },
  ...Object.fromEntries(FRUITS.map((f) => {
    const d = FRUIT_DEFS[f];
    return [f, { r: d.r, sides: 0, hp: d.hp, pts: d.pts, color: d.juice, mass: d.mass }];
  })),
} as Record<Kind, KindDef>;
const pickFruit = () => SMALL_FRUITS[Math.floor(Math.random() * SMALL_FRUITS.length)];
const pickBig = () => BIG_FRUITS[Math.floor(Math.random() * BIG_FRUITS.length)];
const pickWeapon = (noBomb = false): Weapon => {
  const list = noBomb ? WEAPONS.filter((w) => w !== "bomb") : WEAPONS;
  return list[Math.floor(Math.random() * list.length)];
};

type Enemy = {
  kind: Kind;
  x: number; y: number;
  /** knockback offset from the path, a damped spring */
  ox: number; oy: number; ovx: number; ovy: number;
  /** squash: + = wide and flat, − = tall and thin */
  sq: number; sqv: number;
  rot: number; vr: number;
  hp: number; flash: number;
  state: "enter" | "hover" | "dive";
  t: number;
  x0: number; y0: number; x1: number; y1: number; arc: number; enterDur: number;
  hoverDur: number; swayA: number; swayF: number; ph: number;
  vx: number; vy: number; diveV: number;
  fireT: number;
  /** last frame's drawn position, for the autopilot's velocity estimate */
  px: number; py: number;
};
type Planned = { kind: Kind; at: number; x0: number; x1: number; y1: number; arc: number; hover: number; dive?: boolean };
/** c = the bullet's colour (weapon / fever rainbow); pierce = enemies it can still go through; missile = homing */
type Bullet = {
  x: number; y: number; vx: number; vy: number; life: number; seed?: boolean;
  c?: Rgba; pierce?: number; hitList?: Enemy[]; missile?: boolean; target?: Enemy | null;
};
/** kind 0 spark streak, 1 shard, 2 flash, 3 juice drop, 4 seed, 5 fruit half (f, side), 6 star. g = gravity */
type Particle = {
  x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; c: Rgba;
  kind: 0 | 1 | 2 | 3 | 4 | 5 | 6; rot: number; vr: number; drag: number; g?: number; f?: Fruit; side?: 1 | -1;
};
/** a weapon capsule drifting down; fly into it to pick it up */
type Capsule = { w: Weapon; x: number; y: number; t: number };
/** the white blade line across a fruit as it splits */
type Slash = { x: number; y: number; a: number; len: number; life: number; max: number; c: Rgba };
/** juice splashed onto the screen glass (CSS px), dripping down */
type Splash = {
  x: number; y: number; r: number; c: string; life: number; max: number;
  drips: { dx: number; len: number; v: number; w: number }[];
  /** splatter droplets round the edge: offset (in r) and size */
  dots: [number, number, number][];
};
/** big centre text: multi-kills, pickups, fever */
type Banner = { text: string; life: number; max: number; color: string; size: number; y: number };
/** juice splat left on the floor, drifting down with the grid */
type Stain = { x: number; y: number; blobs: [number, number, number][]; c: Rgba; life: number; max: number };
type Text = { x: number; y: number; vy: number; text: string; life: number; max: number; size: number; color: string; glow: string };
type Wave = { x: number; y: number; r: number; max: number; life: number; maxLife: number; w: number; c: Rgba; grid: number };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** halfway to white, as a CSS colour */
const paleHex = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * 0.55);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** a bright saturated colour at hue h (0..1): the fever rainbow */
const hueRgb = (h: number): Rgba => {
  const f = (n: number) => { const k = (n + h * 12) % 12; return 0.62 - 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4), 1];
};
const rgbHex = (c: Rgba) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
/** distance from (px, py) to the segment a→b: swept hit tests for fast or curving bullets */
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};
const WHITE: Rgba = [1, 1, 1, 1];
const SHIP_C = rgba("#38e8ff");
const BULLET_C = rgba("#ffd84a");
const EBULLET_C = rgba("#ff4fd8");

export class ShootEngine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, -10, 10);
  private grid = createGrid();
  private solid = new Batch(30000, false);
  /** cartoon fruit, juice and seeds: drawn after the bloom so the flat colours and outlines stay crisp */
  private cartoon = new Batch(90000, false);
  private over = new THREE.Scene();
  private glow = new Batch(60000, true);
  private overlay: HTMLCanvasElement;
  private g2: CanvasRenderingContext2D;
  private viewW = HALF_W * 2;
  private viewH = HALF_H * 2;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;

  private phase: Phase = "ready";
  /** game time: stops during hit stop. Spawning and difficulty run on it. */
  private gt = 0;
  /** wall time since the engine started: flashes, shake and the audio log run on it */
  private wall = 0;
  private freeze = 0;
  private freezeEnd = -1;
  private trauma = 0;
  private camX = 0;
  private camY = 0;

  private sx = 0;
  private sy = -200;
  private svx = 0;
  private tx = 0;
  private ty = -200;
  private tilt = 0;
  private recoil = 0;
  private fireT = 0;
  private muzzle = 0;
  private dyingT = -1;
  private keys = new Set<string>();

  private enemies: Enemy[] = [];
  private queue: Planned[] = [];
  private bullets: Bullet[] = [];
  private ebullets: Bullet[] = [];
  private particles: Particle[] = [];
  private texts: Text[] = [];
  private waves: Wave[] = [];
  private stains: Stain[] = [];
  private capsules: Capsule[] = [];
  private slashes: Slash[] = [];
  private splashes: Splash[] = [];
  private banners: Banner[] = [];
  private weapon: Weapon | null = null;
  private weaponT = 0;
  private fever = 0;
  private nextFever = FEVER_COMBO;
  private recentKills: number[] = [];
  private multiShown = 0;
  /** game time of the last capsule drop: a long dry spell forces the next one */
  private lastDrop = 0;
  private laserT = 0;
  private missileT = 0;
  private hitSoundAt = -1;
  private bombing = false;
  private spent = 0;
  private plan: { cost: number; enemies: Planned[] } | null = null;
  private nextWave = 0;
  private lastElite = -99;

  private score = 0;
  private scoreShown = 0;
  private combo = 0;
  private comboT = 0;
  private comboPop = 9;
  private breakT = 9;
  private breakN = 0;
  private multPop = 9;
  private kills = 0;
  private hits = 0;

  fx: Fx = allFx(true);
  zh = true;
  readonly audio: ShootAudio;
  private audioLog: AudioLog = [];
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private disposed = false;
  private local = window.location.hostname === "localhost";
  private params = new URLSearchParams(window.location.search);
  // local only: ?demo=1 plays itself; ?capture=1 also stops the clock so a script can step fixed 1/60 s frames and
  // screenshot each one (window.__shoot.step); ?t=60 starts the run 60 s in
  private capture = this.local && this.params.get("capture") === "1";
  private demo = this.local && (this.params.get("demo") === "1" || this.capture);
  // ?lab=1 (local): three targets that stand still and respawn, the ship can't die — for judging each effect
  // ?lab=fruit: one of each fruit instead
  private lab = this.local && !!this.params.get("lab") && this.params.get("lab") !== "0";
  private labRespawn: Partial<Record<Kind, number>> = {};

  constructor(private host: HTMLElement, private hooks: Hooks, fx?: Fx | null) {
    if (fx) this.fx = { ...fx };
    const sound = new ShootAudio();
    this.audio = this.capture ? recordingAudio(sound, this.audioLog, () => this.wall) : sound;
    this.audio.setEnabled(this.fx.sound);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: this.capture });
    this.dpr = this.capture ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    // the shaders write display colours directly; keep the bloom chain linear so glow on / off look the same
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    host.appendChild(this.renderer.domElement);
    const cv = this.renderer.domElement;
    cv.style.display = "block";
    cv.style.touchAction = "none";

    this.overlay = document.createElement("canvas");
    Object.assign(this.overlay.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
    host.appendChild(this.overlay);
    this.g2 = this.overlay.getContext("2d")!;

    this.solid.mesh.renderOrder = 0;
    this.glow.mesh.renderOrder = 1;
    this.scene.add(this.grid.mesh, this.solid.mesh, this.glow.mesh);
    this.over.add(this.cartoon.mesh);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.35, 0.42);
    this.composer.addPass(this.bloom);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.bindInput();
    this.tick(0.001);
    this.render();
    this.last = performance.now();
    if (this.capture) {
      (window as unknown as { __shoot: unknown }).__shoot = {
        step: (n = 1) => { for (let i = 0; i < n; i++) this.tick(1 / 60); this.render(); },
        info: () => ({
          phase: this.phase, score: this.score, gt: this.gt, wall: this.wall, combo: this.combo, enemies: this.enemies.length, kills: this.kills, hits: this.hits,
          spent: this.spent, budget: spawnBudget(this.gt), weapon: this.weapon, weaponT: this.weaponT, fever: this.fever, capsules: this.capsules.length, particles: this.particles.length,
        }),
        /** pick up a weapon right now, as if the ship had flown into its capsule */
        give: (w: Weapon) => this.pickUp({ w, x: this.sx, y: this.sy, t: 1 }),
        /** jump the combo (e.g. to 39 so the next kill starts fever) */
        combo: (n: number) => { this.combo = n; this.comboT = COMBO_WINDOW; },
        /** the combo that starts the next fever (a big number holds it off while scripting a video) */
        feverAt: (n: number) => { this.nextFever = n; },
        start: () => this.hooks.onRequestStart(),
        fx: (k: FxKey, on: boolean) => this.setFx(k, on),
        time: () => this.wall,
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

  setFx(k: FxKey, on: boolean) {
    this.fx[k] = on;
    if (k === "sound") this.audio.setEnabled(on);
  }

  start() {
    this.audio.unlock();
    if (this.phase === "playing") return;
    this.enemies = []; this.queue = []; this.bullets = []; this.ebullets = []; this.particles = []; this.texts = []; this.waves = []; this.stains = [];
    this.capsules = []; this.slashes = []; this.splashes = []; this.banners = []; this.recentKills = [];
    // local only: ?weapon=laser keeps that weapon on for the whole run (judging each one)
    const forced = this.local ? this.params.get("weapon") as Weapon | null : null;
    this.weapon = forced && (WEAPONS as readonly string[]).includes(forced) && forced !== "bomb" ? forced : null;
    this.weaponT = this.weapon ? Infinity : 0;
    this.fever = 0; this.nextFever = FEVER_COMBO; this.multiShown = 0; this.laserT = 0; this.missileT = 0;
    this.gt = this.local ? Number(this.params.get("t")) || 0 : 0;
    this.spent = this.gt > 0 ? spawnBudget(this.gt) - 40 : 0;
    this.plan = null;
    this.nextWave = this.gt + 0.6;
    this.lastElite = -99;
    this.lastDrop = this.gt;
    this.score = 0; this.scoreShown = 0; this.combo = 0; this.comboT = 0; this.kills = 0; this.breakT = 9;
    this.sx = 0; this.sy = this.homeY(); this.tx = 0; this.ty = this.sy; this.svx = 0;
    this.fireT = 0.25; this.dyingT = -1; this.freeze = 0; this.trauma = 0;
    this.phase = "playing";
    this.audio.start();
    this.hooks.onPhase("playing", 0);
  }

  dispose() {
    this.disposed = true;
    this.audio.dispose();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.composer.dispose();
    this.bloom.dispose();
    for (const sc of [this.scene, this.over]) sc.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  // ---------------------------------------------------------------- input

  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "d", "w", "s"].includes(k)) { this.keys.add(k); e.preventDefault(); }
    else if ((e.key === "Enter" || e.key === " ") && this.phase !== "playing" && !e.repeat) { this.hooks.onRequestStart(); e.preventDefault(); }
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); };

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    const el = this.renderer.domElement;
    // touch / pen: relative drag, so the finger never covers the ship. Mouse: the ship follows the pointer.
    let drag: { px: number; py: number; sx: number; sy: number } | null = null;
    const toWorld = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: ((cx - r.left) / r.width - 0.5) * this.viewW, y: (0.5 - (cy - r.top) / r.height) * this.viewH };
    };
    el.addEventListener("pointerdown", (e) => {
      this.audio.unlock();
      if (this.phase !== "playing") return;
      const p = toWorld(e.clientX, e.clientY);
      drag = { px: p.x, py: p.y, sx: this.tx, sy: this.ty };
      if (e.pointerType === "mouse") { this.tx = p.x; this.ty = p.y; }
    });
    el.addEventListener("pointermove", (e) => {
      if (this.phase !== "playing") return;
      const p = toWorld(e.clientX, e.clientY);
      if (e.pointerType === "mouse") { this.tx = p.x; this.ty = p.y; return; }
      if (!drag) return;
      this.tx = drag.sx + (p.x - drag.px) * 1.25;
      this.ty = drag.sy + (p.y - drag.py) * 1.25;
    });
    const up = () => { drag = null; };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.cssW = w; this.cssH = h;
    const aspect = w / h;
    if (aspect < HALF_W / HALF_H) { this.viewW = HALF_W * 2; this.viewH = this.viewW / aspect; }
    else { this.viewH = HALF_H * 2; this.viewW = this.viewH * aspect; }
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.grid.mesh.scale.set(this.viewW + 80, this.viewH + 80, 1);
    this.overlay.width = Math.round(w * this.dpr);
    this.overlay.height = Math.round(h * this.dpr);
    if (this.phase !== "playing") { this.sy = this.homeY(); this.ty = this.sy; }
  }

  private get hh() { return this.viewH / 2; }
  private homeY() { return -this.hh + Math.min(130, this.viewH * 0.2); }

  // ---------------------------------------------------------------- loop

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.tick(dt);
    this.render();
  };

  private tick(dt: number) {
    this.wall += dt;
    for (const e of this.enemies) e.flash = Math.max(0, e.flash - dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    this.comboPop += dt; this.multPop += dt; this.breakT += dt;
    if (this.freeze > 0) {
      this.freeze -= dt;
      if (this.freeze <= 0) this.freezeEnd = this.wall;
      return;
    }
    this.update(dt);
  }

  private hitStop(s: number, force = false) {
    if (!this.fx.hitstop || this.capture && (window as unknown as { __noStop?: boolean }).__noStop) return;
    // back-to-back bullet hits would otherwise freeze the game a third of the time
    if (!force && this.wall - this.freezeEnd < 0.25) return;
    this.freeze = Math.max(this.freeze, s);
  }

  private addTrauma(v: number) {
    if (this.fx.shake) this.trauma = Math.min(1, this.trauma + v);
  }

  private update(dt: number) {
    const playing = this.phase === "playing";
    const alive = playing && this.dyingT < 0;
    if (playing) this.gt += dt;
    this.grid.uniforms.uTime.value = this.wall;

    // ship
    if (alive) {
      if (this.demo) this.autopilot();
      const kx = (this.keys.has("ArrowRight") || this.keys.has("d") ? 1 : 0) - (this.keys.has("ArrowLeft") || this.keys.has("a") ? 1 : 0);
      const ky = (this.keys.has("ArrowUp") || this.keys.has("w") ? 1 : 0) - (this.keys.has("ArrowDown") || this.keys.has("s") ? 1 : 0);
      if (kx || ky) { this.tx = this.sx + kx * 40; this.ty = this.sy + ky * 40; }
      this.tx = clamp(this.tx, -HALF_W + 14, HALF_W - 14);
      this.ty = clamp(this.ty, -this.hh + 40, -this.hh + this.viewH * 0.55);
      const k = Math.min(1, dt * (kx || ky ? 9 : 22));
      const nx = this.sx + (this.tx - this.sx) * k;
      this.svx = (nx - this.sx) / Math.max(dt, 1e-4);
      this.sx = nx;
      this.sy += (this.ty - this.sy) * k;
      this.fireWeapons(dt);
    } else if (!playing) {
      // idle on the title screen: drift a little
      this.sx = Math.sin(this.wall * 0.7) * 30;
      this.svx = Math.cos(this.wall * 0.7) * 21;
    }
    this.tilt += (clamp(-this.svx / 900, -0.35, 0.35) - this.tilt) * Math.min(1, dt * 12);
    this.recoil = Math.max(0, this.recoil - dt * 14);
    this.muzzle = Math.max(0, this.muzzle - dt);

    if (playing) this.director();
    this.updateEnemies(dt, alive);
    this.updateBullets(dt, alive);
    this.updateCapsules(dt, alive);
    this.updateFx(dt);
    if (this.fever > 0) this.fever = Math.max(0, this.fever - dt);
    const fu = this.grid.uniforms.uFever;
    fu.value += ((this.fever > 0 && this.fx.glow ? 1 : 0) - fu.value) * Math.min(1, dt * 3);

    // combo timer
    if (this.combo > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) {
        if (this.combo >= 5) { this.breakT = 0; this.breakN = this.combo; if (this.fx.combo) this.audio.comboBreak(); }
        this.combo = 0;
      }
    }
    this.scoreShown = this.fx.combo ? this.scoreShown + (this.score - this.scoreShown) * Math.min(1, dt * 10) : this.score;
    if (Math.abs(this.score - this.scoreShown) < 1) this.scoreShown = this.score;

    if (this.dyingT >= 0) {
      this.dyingT += dt;
      if (this.dyingT > 1.3 && this.phase === "playing") {
        this.phase = "over";
        this.hooks.onPhase("over", this.score);
      }
    }
  }

  // ---------------------------------------------------------------- weapons

  /** bullet colour right now: a cycling rainbow in fever, otherwise the weapon's colour */
  private bulletColor(w: Weapon | null): Rgba {
    if (this.fever > 0) return hueRgb((this.wall * 0.9 + Math.random() * 0.12) % 1);
    return w ? WEAPON_C[w] : BULLET_C;
  }

  private gunLevel() { return this.combo >= TRIPLE_COMBO ? 3 : this.combo >= TWIN_COMBO ? 2 : 1; }

  private fireWeapons(dt: number) {
    const w = this.weapon;
    const rate = this.fever > 0 ? 0.62 : 1;
    if (w === "laser") { this.laserTick(dt); return; }
    if (w === "missile") {
      this.missileT -= dt;
      if (this.missileT <= 0) {
        this.missileT += 0.32 * rate;
        for (const s of [-1, 1]) this.bullets.push({ x: this.sx + s * 12, y: this.sy + 4, vx: s * 260, vy: 160, life: 3, missile: true, target: null, c: WEAPON_C.missile });
        this.audio.missile();
      }
    }
    this.fireT -= dt;
    if (this.fireT > 0) return;
    this.fireT += FIRE_DT * rate * (w === "pierce" ? 0.55 : 1);
    const c = this.bulletColor(w);
    const level = this.gunLevel();
    if (w === "spread") {
      for (const a of [-0.34, -0.17, 0, 0.17, 0.34]) this.bullets.push({ x: this.sx, y: this.sy + 16, vx: Math.sin(a) * BULLET_V, vy: Math.cos(a) * BULLET_V, life: 1.2, c });
    } else {
      const offs = level === 3 ? [-11, 0, 11] : level === 2 ? [-7, 7] : [0];
      for (const off of offs) {
        const a = off * 0.006;
        const v = BULLET_V * (w === "pierce" ? 1.15 : 1);
        this.bullets.push({ x: this.sx + off, y: this.sy + 16, vx: Math.sin(a) * v, vy: Math.cos(a) * v, life: 1.2, c, ...(w === "pierce" ? { pierce: 3, hitList: [] } : {}) });
      }
    }
    this.recoil = 1;
    this.muzzle = 0.05;
    this.audio.shot(level > 1 || !!w);
  }

  /** the beam cuts everything in a column above the ship, ticking damage */
  private laserTick(dt: number) {
    this.laserT -= dt;
    if (this.laserT > 0) return;
    this.laserT += 0.09;
    this.audio.laserZap();
    for (const e of [...this.enemies]) {
      if (e.hp <= 0) continue;
      const k = KINDS[e.kind];
      const ex = e.x + e.ox, ey = e.y + e.oy;
      if (ey < this.sy || ey > this.hh + k.r || Math.abs(ex - this.sx) > 10 + k.r) continue;
      this.hitEnemy(e, { x: this.sx, y: ey - k.r, vx: 0, vy: 1, life: 0 }, { dmg: Math.round(rand(24, 32) * (this.fever > 0 ? 1.4 : 1)), quiet: true });
    }
  }

  private pickUp(c: Capsule) {
    const name = WEAPON_NAMES[c.w];
    const col = WEAPON_C[c.w];
    this.audio.pickup();
    this.addBanner(this.zh ? `${name[0]}!` : `${name[1]}!`, rgbHex(col), 40, 0.15);
    if (this.fx.wave) this.waves.push({ x: this.sx, y: this.sy, r: 10, max: 110, life: 0, maxLife: 0.4, w: 5, c: mix(WHITE, col, 0.5), grid: 0.6 });
    if (this.fx.particles) for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(120, 420);
      this.particles.push({ x: this.sx, y: this.sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.6), max: 0.6, size: rand(4, 7), c: mix(WHITE, col, rand(0.3, 0.9)), kind: 6, rot: rand(0, 6), vr: rand(-10, 10), drag: 3 });
    }
    if (c.w === "bomb") { this.bomb(); return; }
    // the same weapon again adds time; a different one replaces it
    this.weaponT = this.weapon === c.w ? Math.min(20, this.weaponT + WEAPON_TIME) : WEAPON_TIME;
    this.weapon = c.w;
    this.laserT = 0; this.missileT = 0;
  }

  /** clears the screen: every enemy takes a huge hit, enemy bullets turn into sparkles, juice everywhere */
  private bomb() {
    this.audio.bomb();
    this.hitStop(0.12, true);
    this.addTrauma(1);
    if (this.fx.particles) this.particles.push({ x: this.sx, y: this.sy, vx: 0, vy: 0, life: 0.3, max: 0.3, size: 420, c: withA(mix(WHITE, WEAPON_C.bomb, 0.3), 0.9), kind: 2, rot: 0, vr: 0, drag: 0 });
    if (this.fx.wave) {
      this.waves.push({ x: this.sx, y: this.sy, r: 20, max: 700, life: 0, maxLife: 0.9, w: 12, c: mix(WHITE, WEAPON_C.bomb, 0.4), grid: 2.2 });
      this.waves.push({ x: this.sx, y: this.sy, r: 10, max: 480, life: -0.1, maxLife: 0.8, w: 6, c: rgba("#ffe14d"), grid: 1.2 });
    }
    for (const b of this.ebullets) {
      if (this.fx.particles) this.particles.push({ x: b.x, y: b.y, vx: rand(-60, 60), vy: rand(40, 160), life: 0.6, max: 0.6, size: 5, c: rgba("#ffe14d"), kind: 6, rot: 0, vr: rand(-8, 8), drag: 2 });
    }
    this.ebullets = [];
    this.bombing = true;
    for (const e of [...this.enemies]) {
      if (e.y + e.oy > this.hh + 10) continue;
      this.hitEnemy(e, { x: e.x, y: e.y, vx: 0, vy: 1, life: 0 }, { dmg: 420, quiet: true });
    }
    this.bombing = false;
    for (let i = 0; i < 4; i++) this.addSplash(rgbHex(FRUIT_DEFS[pickFruit()].juice), true);
  }

  /** maybe drop a capsule where something died */
  private maybeDrop(e: Enemy, ex: number, ey: number) {
    if (this.lab || this.weaponDropBlocked()) return;
    const big = e.kind === "elite" || e.kind === "golden";
    const chance = big ? 1 : BIG_FRUITS.includes(e.kind as Fruit) ? 0.4 : e.kind === "hex" ? 0.08 : 0.03;
    // a long dry spell (no drop for 22 s) forces one
    const due = this.gt - this.lastDrop > 22;
    if (!big && !due && Math.random() > chance) return;
    this.lastDrop = this.gt;
    // bombs are rarer: one pick in 8
    const w = Math.random() < 0.125 ? "bomb" : pickWeapon(true);
    this.capsules.push({ w, x: clamp(ex, -HALF_W + 20, HALF_W - 20), y: ey, t: 0 });
  }

  private weaponDropBlocked() { return this.capsules.length >= 2 || this.dyingT >= 0; }

  private updateCapsules(dt: number, alive: boolean) {
    for (let i = this.capsules.length - 1; i >= 0; i--) {
      const c = this.capsules[i];
      c.t += dt;
      // pops up a little, then drifts down with a sway
      c.y += (c.t < 0.35 ? 140 * (1 - c.t / 0.35) : -70) * dt;
      c.x = clamp(c.x + Math.sin(c.t * 3) * 30 * dt, -HALF_W + 16, HALF_W - 16);
      if (alive && Math.hypot(c.x - this.sx, c.y - this.sy) < 26) { this.capsules.splice(i, 1); this.pickUp(c); continue; }
      if (c.y < -this.hh - 30) this.capsules.splice(i, 1);
    }
    if (this.weapon && this.weaponT !== Infinity) {
      this.weaponT -= dt;
      if (this.weaponT <= 0) { this.weapon = null; this.weaponT = 0; }
    }
  }

  private addBanner(text: string, color: string, size: number, y = 0.3) {
    this.banners.push({ text, color, size, life: 1.1, max: 1.1, y });
    if (this.banners.length > 4) this.banners.shift();
  }

  /** juice on the screen glass; big = a bigger blob with more drips */
  private addSplash(color: string, big: boolean) {
    if (!this.fx.particles) return;
    const drips = Array.from({ length: big ? 4 : 2 }, () => ({ dx: rand(-0.65, 0.65), len: 0, v: rand(14, 42), w: rand(0.06, 0.12) }));
    const fl = this.toScreen(-HALF_W, 0)[0], fr = this.toScreen(HALF_W, 0)[0];
    const dots = Array.from({ length: big ? 9 : 6 }, (): [number, number, number] => {
      const a = rand(0, Math.PI * 2), d = rand(1.05, 1.6);
      return [Math.cos(a) * d, Math.sin(a) * d, rand(0.06, 0.18)];
    });
    this.splashes.push({ x: rand(fl + 30, fr - 30), y: rand(this.cssH * 0.12, this.cssH * 0.7), r: big ? rand(34, 58) : rand(20, 34), c: color, life: 2.4, max: 2.4, drips, dots });
    if (this.splashes.length > 8) this.splashes.shift();
  }

  // ---------------------------------------------------------------- spawning

  /** Plans one wave at a time; it is only released once its points fit under spawnBudget(gt). */
  private director() {
    const t = this.gt;
    if (this.lab) {
      const labMode = this.params.get("lab");
      // ?lab=power: a capsule of each kind keeps dropping above the ship
      if (labMode === "power" && this.capsules.length === 0) {
        const w = WEAPONS[Math.floor(t / 4) % WEAPONS.length];
        this.capsules.push({ w, x: Number(this.params.get("aim")) || 0, y: this.homeY() + 160, t: 0.35 });
      }
      const spots: Partial<Record<Kind, [number, number]>> = labMode === "fruit"
        ? {
          apple: [-130, 150], orange: [-65, 150], lemon: [0, 150], grape: [65, 150], strawberry: [130, 150],
          kiwi: [-130, 85], banana: [-65, 85], cherry: [0, 85], peach: [65, 85], blueberry: [130, 85],
          dragonfruit: [-120, 15], melon: [-50, 15], pineapple: [25, 15], coconut: [90, 15], golden: [150, 15],
        }
        : { dart: [-110, 40], hex: [0, 70], elite: [110, 40] };
      for (const kind of Object.keys(spots) as Kind[]) {
        if (this.enemies.some((e) => e.kind === kind) || t < (this.labRespawn[kind] ?? 0)) continue;
        const [x, y] = spots[kind]!;
        this.spawn({ kind, at: t, x0: x, x1: x, y1: y, arc: 0, hover: Infinity });
        const e = this.enemies[this.enemies.length - 1];
        e.swayA = 0; e.vr = 0; e.rot = kind === "hex" || isFruit(kind) ? 0 : Math.PI / 4;
        e.state = "hover"; e.x = x; e.y = y; e.sqv = 6;
        this.labRespawn[kind] = Infinity;
      }
      return;
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (t >= q.at) { this.spawn(q); this.queue.splice(i, 1); }
    }
    if (this.dyingT >= 0 || t < this.nextWave) return;
    const cap = Math.min(36, 8 + t / 4);
    if (this.enemies.length + this.queue.length >= cap) return;
    this.plan ??= this.planWave(t);
    if (this.spent + this.plan.cost > spawnBudget(t)) return;
    this.spent += this.plan.cost;
    for (const p of this.plan.enemies) this.queue.push({ ...p, at: t + p.at });
    this.plan = null;
    this.nextWave = t + Math.max(0.35, 1.5 - t * 0.01);
  }

  private planWave(t: number): { cost: number; enemies: Planned[] } {
    const top = this.hh;
    const hover = () => Math.max(2, 7 - t * 0.04) + rand(-0.8, 1.2);
    const list: Planned[] = [];
    const types: [string, number][] = [["row", 3], ["vee", 2]];
    if (t >= 12) types.push(["hex", 2 + t / 40]);
    if (t >= 40 && t - this.lastElite > Math.max(12, 24 - t * 0.06) && !this.enemies.some((e) => e.kind === "elite")) types.push(["elite", 4]);
    if (t >= 60) types.push(["rain", 1 + t / 60]);
    if (t >= 90) types.push(["mixed", 2]);
    types.push(["fruit", 3]);
    if (t >= 25) types.push(["melon", 1.5]);
    // local only, for promo clips: ?waves=fruit plays nothing but fruit
    if (this.local && this.params.get("waves") === "fruit") types.splice(0, types.length, ["fruit", 3], ["melon", 1.2]);
    let r = Math.random() * types.reduce((s, x) => s + x[1], 0);
    let type = types[0][0];
    for (const [k, w] of types) { r -= w; if (r <= 0) { type = k; break; } }
    const side = Math.random() < 0.5 ? -1 : 1;
    if (type === "row") {
      const n = 4 + Math.floor(rand(0, Math.min(4, 1 + t / 25)));
      const y1 = top - rand(170, 290);
      for (let i = 0; i < n; i++) {
        const x1 = (i - (n - 1) / 2) * Math.min(46, 300 / n);
        list.push({ kind: "dart", at: i * 0.12, x0: x1 + side * 120, x1, y1: y1 + Math.sin(i) * 8, arc: -side * 60, hover: hover() + i * 0.15 });
      }
    } else if (type === "vee") {
      const y1 = top - rand(170, 250);
      const cx = rand(-60, 60);
      for (let i = 0; i < 5; i++) {
        const d = i - 2;
        list.push({ kind: "dart", at: Math.abs(d) * 0.15, x0: cx + d * 30, x1: cx + d * 40, y1: y1 - Math.abs(d) * 26, arc: d * 30, hover: hover() });
      }
    } else if (type === "hex") {
      const n = t > 50 ? 3 : 2;
      const y1 = top - rand(190, 300);
      for (let i = 0; i < n; i++) {
        const x1 = (i - (n - 1) / 2) * 110 + rand(-15, 15);
        list.push({ kind: "hex", at: i * 0.25, x0: x1 - side * 80, x1, y1: y1 + rand(-20, 20), arc: side * 50, hover: hover() + 2 });
      }
      if (t > 30) for (let i = 0; i < 2; i++) list.push({ kind: "dart", at: 0.4 + i * 0.15, x0: (i ? 1 : -1) * 150, x1: (i ? 1 : -1) * 140, y1: y1 - 60, arc: 0, hover: hover() });
    } else if (type === "elite") {
      this.lastElite = t;
      list.push({ kind: "elite", at: 0, x0: 0, x1: rand(-40, 40), y1: top - 210, arc: side * 40, hover: 14 + Math.min(8, t / 20) });
      for (let i = 0; i < 4; i++) list.push({ kind: "dart", at: 0.3 + i * 0.12, x0: (i - 1.5) * 60, x1: (i - 1.5) * 70, y1: top - 150, arc: 0, hover: hover() });
    } else if (type === "rain") {
      const n = 5 + Math.floor(rand(0, Math.min(5, t / 40)));
      for (let i = 0; i < n; i++) {
        const x = rand(-HALF_W + 20, HALF_W - 20);
        list.push({ kind: Math.random() < 0.4 ? pickFruit() : "dart", at: i * rand(0.15, 0.3), x0: x, x1: x, y1: top - 20, arc: 0, hover: 0, dive: true });
      }
    } else if (type === "fruit") {
      // a basket of mixed fruit swung in from one side
      const n = 4 + Math.floor(rand(0, Math.min(4, 1 + t / 30)));
      const y1 = top - rand(170, 280);
      for (let i = 0; i < n; i++) {
        const x1 = (i - (n - 1) / 2) * Math.min(50, 300 / n);
        // now and then a golden apple hides in the basket (always drops a weapon)
        const kind: Kind = i === 1 && Math.random() < 0.12 ? "golden" : pickFruit();
        list.push({ kind, at: i * 0.14, x0: -side * 200, x1, y1: y1 + Math.sin(i * 1.3) * 18, arc: side * 40, hover: hover() + i * 0.12 });
      }
    } else if (type === "melon") {
      // the big ones: watermelon, pineapple, coconut
      const n = t > 60 ? 2 : 1;
      const y1 = top - rand(190, 270);
      for (let i = 0; i < n; i++) list.push({ kind: pickBig(), at: i * 0.3, x0: (i - (n - 1) / 2) * 120, x1: (i - (n - 1) / 2) * 120, y1, arc: side * 30, hover: hover() + 3 });
      for (let i = 0; i < 3; i++) list.push({ kind: pickFruit(), at: 0.4 + i * 0.15, x0: (i - 1) * 70, x1: (i - 1) * 70, y1: y1 + 70, arc: 0, hover: hover() });
    } else {
      const y1 = top - rand(200, 270);
      for (let i = 0; i < 2; i++) list.push({ kind: "hex", at: i * 0.2, x0: (i ? 1 : -1) * 200, x1: (i ? 1 : -1) * 70, y1, arc: 0, hover: hover() + 2 });
      for (let i = 0; i < 4; i++) list.push({ kind: "dart", at: 0.3 + i * 0.12, x0: (i - 1.5) * 50, x1: (i - 1.5) * 50, y1: y1 + 70, arc: (i - 1.5) * 30, hover: hover() });
    }
    return { cost: list.reduce((s, e) => s + KINDS[e.kind].pts, 0), enemies: list };
  }

  private spawn(p: Planned) {
    const k = KINDS[p.kind];
    const t = this.gt;
    const y0 = this.hh + k.r + 20;
    this.enemies.push({
      kind: p.kind, x: p.x0, y: y0, ox: 0, oy: 0, ovx: 0, ovy: 0, sq: 0, sqv: 0,
      // fruit stays roughly upright and only wobbles; the neon shapes spin
      rot: isFruit(p.kind) ? rand(-0.3, 0.3) : rand(0, Math.PI), vr: p.kind === "elite" ? 0.9 : isFruit(p.kind) ? rand(-0.4, 0.4) : rand(-1.5, 1.5),
      hp: k.hp, flash: 0, state: p.dive ? "dive" : "enter", t: 0,
      x0: p.x0, y0, x1: clamp(p.x1, -HALF_W + k.r, HALF_W - k.r), y1: p.y1, arc: p.arc, enterDur: p.kind === "elite" ? 1.6 : rand(0.9, 1.2),
      hoverDur: p.hover, swayA: p.kind === "elite" ? 90 : rand(10, 26), swayF: p.kind === "elite" ? 0.5 : rand(0.8, 1.6), ph: rand(0, 6),
      vx: 0, vy: p.dive ? -(220 + Math.min(220, t * 1.6)) : 0, diveV: 150 + Math.min(220, t * 1.5),
      fireT: rand(0.8, 2), px: p.x0, py: y0,
    });
  }

  // ---------------------------------------------------------------- enemies

  private updateEnemies(dt: number, alive: boolean) {
    const t = this.gt;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const k = KINDS[e.kind];
      e.px = e.x + e.ox; e.py = e.y + e.oy;
      e.t += dt;
      if (isFruit(e.kind)) e.vr += (-e.rot * 14 - e.vr * 2.2) * dt;
      e.rot += e.vr * dt;
      if (e.state === "enter") {
        const u = Math.min(1, e.t / e.enterDur);
        const s = 1 - (1 - u) ** 3;
        e.x = e.x0 + (e.x1 - e.x0) * s + Math.sin(Math.PI * s) * e.arc;
        e.y = e.y0 + (e.y1 - e.y0) * s;
        // stretched while it drops in, then a landing squash
        e.sq = -0.3 * (1 - u);
        if (u >= 1) { e.state = "hover"; e.t = 0; if (this.fx.squash) e.sqv += 5; }
      } else if (e.state === "hover") {
        e.x = e.x1 + Math.sin(e.ph + e.t * e.swayF) * e.swayA;
        e.y = this.lab ? e.y1 : e.y1 + Math.sin(e.ph * 1.7 + e.t * 1.3) * 6 - e.t * 3;
        if (e.kind === "elite") e.x = clamp(e.x, -HALF_W + k.r + 10, HALF_W - k.r - 10);
        if (alive) this.enemyFire(e, dt, t);
        if (e.t > e.hoverDur && alive) {
          e.state = "dive";
          const dx = this.sx - e.x, dy = this.sy - e.y;
          const l = Math.hypot(dx, dy) || 1;
          e.vx = (dx / l) * e.diveV * 0.6;
          e.vy = Math.min(-e.diveV * 0.5, (dy / l) * e.diveV);
        }
      } else {
        e.vy -= (e.kind === "elite" ? 20 : 160) * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (this.fx.squash) e.sq += (-0.18 - e.sq) * Math.min(1, dt * 6);
        if (e.y < -this.hh - 60) { this.enemies.splice(i, 1); continue; }
      }
      // springs: knockback offset and squash
      const kk = 120, c = 2 * Math.sqrt(kk) * 0.75;
      e.ovx += (-e.ox * kk - e.ovx * c) * dt; e.ovy += (-e.oy * kk - e.ovy * c) * dt;
      e.ox += e.ovx * dt; e.oy += e.ovy * dt;
      if (e.state !== "enter") {
        const ks = 360, cs = 2 * Math.sqrt(ks) * 0.28;
        e.sqv += (-e.sq * ks - e.sqv * cs) * dt;
        e.sq = clamp(e.sq + e.sqv * dt, -0.45, 0.45);
      }
      // ship collision
      if (alive) {
        const ex = e.x + e.ox, ey = e.y + e.oy;
        if (Math.hypot(ex - this.sx, ey - this.sy) < SHIP_R + k.r * 0.75) this.die();
      }
    }
  }

  private enemyFire(e: Enemy, dt: number, t: number) {
    if (this.lab || e.kind === "dart" && t < 100) return;
    if (e.kind === "hex" && t < 20) return;
    // of the fruit only the melon shoots: seeds, from 30 s
    if (isFruit(e.kind) && (e.kind !== "melon" || t < 30)) return;
    e.fireT -= dt;
    if (e.fireT > 0 || e.y < this.sy + 140) return;
    const ex = e.x + e.ox, ey = e.y + e.oy;
    const dx = this.sx - ex, dy = this.sy - ey;
    const a = Math.atan2(dy, dx);
    const v = 150 + Math.min(130, t);
    if (e.kind === "elite") {
      e.fireT = Math.max(1.1, 2.4 - (t - 40) * 0.01);
      const n = t > 100 ? 7 : 5;
      for (let i = 0; i < n; i++) {
        const b = a + (i - (n - 1) / 2) * 0.2;
        this.ebullets.push({ x: ex, y: ey - 10, vx: Math.cos(b) * v, vy: Math.sin(b) * v, life: 8 });
      }
      if (this.fx.squash) e.sqv -= 4;
    } else if (e.kind === "melon") {
      e.fireT = Math.max(1.4, 2.6 - (t - 30) * 0.01) + rand(0, 0.6);
      for (const s of [-0.12, 0.12]) this.ebullets.push({ x: ex, y: ey - 12, vx: Math.cos(a + s) * v, vy: Math.sin(a + s) * v, life: 8, seed: true });
      if (this.fx.squash) e.sqv -= 6;
    } else {
      e.fireT = e.kind === "hex" ? Math.max(1.1, 3 - t * 0.015) + rand(0, 0.8) : rand(3, 6);
      this.ebullets.push({ x: ex, y: ey - 8, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 8 });
    }
    this.audio.enemyShot();
  }

  // ---------------------------------------------------------------- bullets, hits, kills

  private updateBullets(dt: number, alive: boolean) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.missile) this.steerMissile(b, dt);
      const ox = b.x, oy = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let hit: Enemy | null = null;
      for (const e of this.enemies) {
        if (e.hp <= 0 || b.hitList?.includes(e)) continue;
        const r = KINDS[e.kind].r + 4;
        const ex = e.x + e.ox, ey = e.y + e.oy;
        // swept along this frame's travel so fast bullets can't skip a dart
        if (Math.abs(b.x - ex) > r + Math.abs(b.vx * dt) || segDist(ex, ey, ox, oy, b.x, b.y) >= r) continue;
        hit = e;
        break;
      }
      if (hit) {
        if (b.missile) { this.explode(b.x, b.y); this.bullets.splice(i, 1); continue; }
        this.hitEnemy(hit, b);
        if (b.pierce && b.pierce > 0) { b.pierce--; b.hitList!.push(hit); continue; }
        this.bullets.splice(i, 1);
        continue;
      }
      if (b.missile && b.life <= 0) { this.explode(b.x, b.y); this.bullets.splice(i, 1); continue; }
      if (b.life <= 0 || b.y > this.hh + 30 || Math.abs(b.x) > this.viewW / 2 + 30 || b.y < -this.hh - 40) this.bullets.splice(i, 1);
    }
    for (let i = this.ebullets.length - 1; i >= 0; i--) {
      const b = this.ebullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (alive && Math.hypot(b.x - this.sx, b.y - this.sy) < SHIP_R + 4) { this.ebullets.splice(i, 1); this.die(); continue; }
      if (b.life <= 0 || b.y < -this.hh - 20 || b.y > this.hh + 20 || Math.abs(b.x) > this.viewW / 2 + 20) this.ebullets.splice(i, 1);
    }
  }

  /** homing: turn toward the nearest live enemy ahead, speeding up; a smoke-and-fire trail */
  private steerMissile(b: Bullet, dt: number) {
    if (!b.target || b.target.hp <= 0 || !this.enemies.includes(b.target)) {
      let best: Enemy | null = null, bd = Infinity;
      for (const e of this.enemies) {
        const ex = e.x + e.ox, ey = e.y + e.oy;
        if (ey < b.y - 40 || ey > this.hh) continue;
        const d = Math.hypot(ex - b.x, ey - b.y);
        if (d < bd) { bd = d; best = e; }
      }
      b.target = best;
    }
    const sp = Math.min(760, Math.hypot(b.vx, b.vy) + 900 * dt);
    let a = Math.atan2(b.vy, b.vx);
    const t = b.target;
    const want = t ? Math.atan2(t.y + t.oy - b.y, t.x + t.ox - b.x) : Math.PI / 2;
    let d = want - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    a += clamp(d, -7 * dt, 7 * dt);
    b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
    if (this.fx.trail && Math.random() < 0.7) {
      this.particles.push({ x: b.x, y: b.y, vx: -b.vx * 0.08 + rand(-20, 20), vy: -b.vy * 0.08 + rand(-20, 20), life: rand(0.18, 0.32), max: 0.32, size: rand(3, 5), c: Math.random() < 0.5 ? withA(rgba("#ffd27a"), 0.8) : withA(WEAPON_C.missile, 0.7), kind: 2, rot: 0, vr: 0, drag: 3 });
    }
  }

  /** a missile goes off: area damage, fireball, small shockwave */
  private explode(x: number, y: number) {
    this.audio.boom();
    this.addTrauma(0.18);
    for (const e of [...this.enemies]) {
      const ex = e.x + e.ox, ey = e.y + e.oy;
      if (e.hp > 0 && Math.hypot(ex - x, ey - y) < 48 + KINDS[e.kind].r) this.hitEnemy(e, { x, y, vx: ex - x, vy: ey - y + 1, life: 0 }, { dmg: Math.round(rand(40, 55)), quiet: true });
    }
    if (this.fx.particles) {
      this.particles.push({ x, y, vx: 0, vy: 0, life: 0.14, max: 0.14, size: 70, c: withA(rgba("#ffcf6a"), 0.85), kind: 2, rot: 0, vr: 0, drag: 0 });
      for (let i = 0; i < 16; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(150, 460);
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.15, 0.35), max: 0.35, size: 2.4, c: mix(WHITE, WEAPON_C.missile, rand(0.2, 0.8)), kind: 0, rot: 0, vr: 0, drag: 4 });
      }
    }
    if (this.fx.wave) this.waves.push({ x, y, r: 6, max: 70, life: 0, maxLife: 0.3, w: 3.5, c: mix(WHITE, WEAPON_C.missile, 0.4), grid: 0.5 });
  }

  /** opts.dmg overrides the gun's damage roll; quiet = laser / missile / bomb hits: lighter effects, no hit stop */
  private hitEnemy(e: Enemy, b: Bullet, opts: { dmg?: number; quiet?: boolean } = {}) {
    const k = KINDS[e.kind];
    const quiet = !!opts.quiet;
    const crit = Math.random() < (quiet ? 0.1 : 0.15);
    const dmg = opts.dmg !== undefined ? Math.round(opts.dmg * (crit ? 1.8 : 1)) : Math.round(rand(18, 26.99) * (crit ? 2.5 : 1));
    e.hp -= dmg;
    this.hits++;
    const ex = e.x + e.ox, ey = e.y + e.oy;
    const l = Math.hypot(b.vx, b.vy) || 1;
    const dx = b.vx / l, dy = b.vy / l;
    if (this.fx.flash) e.flash = 0.034;
    if (this.fx.knock) { const imp = (crit ? 420 : 260) / k.mass; e.ovx += dx * imp; e.ovy += dy * imp; e.vr += rand(-1, 1) * (crit ? 6 : 3) / k.mass; }
    if (this.fx.squash) e.sqv += (crit ? 13 : 9) / Math.sqrt(k.mass);
    const fruit = isFruit(e.kind) ? FRUIT_DEFS[e.kind] : null;
    if (this.fx.numbers) this.addDamageText(ex + rand(-10, 10), ey + k.r * 0.4, dmg, crit, fruit?.juiceHex);
    if (this.fx.particles) {
      const hx = b.x, hy = ey - k.r * 0.7;
      // sparks: bullet yellow off the neon shapes, the fruit's juice off fruit
      const spark = fruit ? fruit.juice : b.c ?? BULLET_C;
      const many = quiet ? 0.45 : 1;
      for (let i = 0; i < (crit ? 16 : 9) * many; i++) {
        const a = -Math.PI / 2 + rand(-1.3, 1.3);
        const sp = rand(260, crit ? 760 : 560);
        this.particles.push({ x: hx, y: hy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.14, 0.32), max: 0.32, size: crit ? 2.8 : 2.3, c: mix(WHITE, spark, rand(0.3, 0.9)), kind: 0, rot: 0, vr: 0, drag: 6 });
      }
      if (fruit) {
        for (let i = 0; i < (crit ? 9 : 5) * many; i++) {
          const a = -Math.PI / 2 + rand(-1.1, 1.1), sp = rand(120, 320);
          this.particles.push({ x: hx, y: hy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.35, 0.6), max: 0.6, size: rand(2, 3.6), c: fruit.juice, kind: 3, rot: 0, vr: 0, drag: 1.5, g: 700 });
        }
      } else {
        for (let i = 0; i < (crit ? 6 : 3); i++) {
          const a = rand(0, Math.PI * 2), sp = rand(80, 220);
          this.particles.push({ x: hx, y: hy + k.r * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 60, life: rand(0.25, 0.45), max: 0.45, size: rand(2.5, 4), c: k.color, kind: 1, rot: rand(0, 6), vr: rand(-15, 15), drag: 3 });
        }
      }
      this.particles.push({ x: hx, y: hy, vx: 0, vy: 0, life: 0.07, max: 0.07, size: crit ? 18 : 11, c: withA(spark, 0.8), kind: 2, rot: 0, vr: 0, drag: 0 });
    }
    if (e.hp <= 0) { this.kill(e, crit, quiet); return; }
    if (!quiet) this.hitStop(crit ? 0.06 : 0.04);
    this.addTrauma(quiet ? 0.03 : crit ? 0.14 : dmg / 450);
    // a laser / spread volley would otherwise stack dozens of hit sounds
    if (this.wall - this.hitSoundAt > (quiet ? 0.07 : 0.025)) { this.hitSoundAt = this.wall; this.audio.hit(crit, !!fruit); }
  }

  /** a fruit bursts: juice drops in its colour, chunks of skin and flesh, seeds, and a splat on the floor */
  private fruitBurst(f: Fruit, ex: number, ey: number) {
    const d = FRUIT_DEFS[f];
    const big = BIG_FRUITS.includes(f);
    const s = big ? 1.6 : 1;
    const cut = rand(-0.7, 0.7);
    if (this.fx.trail) {
      this.slashes.push({ x: ex, y: ey, a: cut, len: d.r * 3.4 * s, life: 0.16, max: 0.16, c: mix(WHITE, d.juice, 0.2) });
      if (this.slashes.length > 12) this.slashes.shift();
      if (!this.bombing) this.audio.slice();
    }
    if (this.fx.particles) {
      // split in two, Fruit Ninja style: the halves fly apart from the cut and spin away
      for (const side of [1, -1] as const) {
        const nx = -Math.sin(cut) * side, ny = Math.cos(cut) * side;
        const sp = rand(110, 170) * (big ? 1.2 : 1);
        this.particles.push({ x: ex + nx * 3, y: ey + ny * 3, vx: nx * sp + rand(-30, 30), vy: ny * sp + 160, life: 1.1, max: 1.1, size: 0, c: WHITE, kind: 5, rot: cut, vr: side * rand(3, 7), drag: 0.4, g: 820, f, side });
      }
      if (f === "golden") for (let i = 0; i < 22; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(120, 480);
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 0.9), max: 0.9, size: rand(5, 9), c: mix(WHITE, d.juice, rand(0.2, 0.8)), kind: 6, rot: rand(0, 6), vr: rand(-8, 8), drag: 2 });
      }
      // juice on the screen: always for the big ones and the golden apple, sometimes in fever or a long streak
      if (big || f === "golden" || (this.fever > 0 && Math.random() < 0.25) || (this.combo >= 20 && Math.random() < 0.08)) this.addSplash(d.juiceHex, big);
      for (let i = 0; i < (big ? 46 : 26); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(90, 380) * s;
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 80, life: rand(0.5, 0.95), max: 0.95, size: rand(2.4, 5.5) * (big ? 1.2 : 1), c: i % 4 ? d.juice : mix(d.juice, WHITE, 0.45), kind: 3, rot: 0, vr: 0, drag: 1.4, g: 650 });
      }
      for (let i = 0; i < (big ? 16 : 9); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(70, 240) * s;
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 120, life: rand(0.7, 1.1), max: 1.1, size: rand(3.5, 6.5) * (big ? 1.4 : 1), c: i % 2 ? d.skin : d.flesh, kind: 1, rot: rand(0, 6), vr: rand(-12, 12), drag: 1, g: 520 });
      }
      if (d.seeds) for (let i = 0; i < (big ? 14 : 6); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(120, 330) * s;
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 90, life: rand(0.6, 1), max: 1, size: big ? 3 : 2, c: f === "strawberry" ? rgba("#ffe66b") : [0.08, 0.06, 0.05, 1], kind: 4, rot: a, vr: rand(-10, 10), drag: 1.2, g: 600 });
      }
      for (let i = 0; i < (big ? 24 : 12); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(240, 620) * s;
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.12, 0.3), max: 0.3, size: 2.2, c: mix(WHITE, d.juice, 0.6), kind: 0, rot: 0, vr: 0, drag: 5 });
      }
      this.particles.push({ x: ex, y: ey, vx: 0, vy: 0, life: 0.1, max: 0.1, size: d.r * (big ? 3 : 2.4), c: withA(mix(WHITE, d.juice, 0.55), 0.55), kind: 2, rot: 0, vr: 0, drag: 0 });
      const blobs: [number, number, number][] = [[0, 0, d.r * 0.9 * s]];
      for (let i = 0; i < (big ? 9 : 6); i++) { const a = rand(0, Math.PI * 2), r = rand(0.6, 1.5) * d.r * s; blobs.push([Math.cos(a) * r, Math.sin(a) * r, rand(0.18, 0.42) * d.r * s]); }
      this.stains.push({ x: ex, y: ey, blobs, c: d.juice, life: 2.4, max: 2.4 });
      if (this.stains.length > 24) this.stains.shift();
    }
    if (this.fx.wave) {
      this.waves.push({ x: ex, y: ey, r: d.r, max: big ? 170 : 100, life: 0, maxLife: big ? 0.55 : 0.42, w: big ? 6 : 4, c: mix(WHITE, d.juice, 0.55), grid: big ? 1 : 0.6 });
      if (big) this.waves.push({ x: ex, y: ey, r: d.r, max: 120, life: -0.07, maxLife: 0.45, w: 3, c: d.juice, grid: 0 });
    }
  }

  private kill(e: Enemy, crit: boolean, quiet = false) {
    const k = KINDS[e.kind];
    const big = e.kind === "elite";
    const ex = e.x + e.ox, ey = e.y + e.oy;
    this.enemies.splice(this.enemies.indexOf(e), 1);
    this.kills++;
    if (this.lab) this.labRespawn[e.kind] = this.gt + 0.8;
    const before = multFor(this.combo);
    this.combo++;
    this.comboT = COMBO_WINDOW;
    this.comboPop = 0;
    const mult = multFor(this.combo);
    const pts = Math.round(k.pts * mult);
    this.score += pts;
    const fruit = isFruit(e.kind) ? e.kind : null;
    if (this.fx.combo) {
      const col = fruit ? FRUIT_DEFS[fruit].juiceHex : "#fff3a0";
      this.addText(ex + 18, ey + k.r + 18, `+${pts}`, fruit ? 16 : 14, col, fruit ? col : "rgba(255,200,40,0.8)", 0.7);
      if (mult > before) { this.multPop = 0; this.audio.levelUp(mult); }
      this.multiKill();
      // every 40 combo: fever
      if (this.combo >= this.nextFever) {
        this.nextFever += FEVER_COMBO;
        this.fever = FEVER_TIME;
        this.audio.fever();
        this.addBanner(this.zh ? "狂热模式!" : "FEVER!", "#ff7ae0", 46, 0.42);
      }
    }
    this.maybeDrop(e, ex, ey);
    const heavy = big || BIG_FRUITS.includes(e.kind as Fruit);
    // a bomb kills a screenful at once: one hit stop and a few sounds, not one per enemy
    if (!this.bombing) this.hitStop(big ? 0.16 : heavy ? 0.11 : quiet ? 0.03 : crit ? 0.09 : 0.065, !quiet || heavy);
    this.addTrauma(big ? 0.75 : heavy ? 0.45 : e.kind === "hex" ? 0.32 : quiet ? 0.12 : 0.22);
    const sound = !this.bombing || Math.random() < 0.3;
    if (fruit) {
      if (sound) this.audio.splat(this.combo, heavy);
      this.fruitBurst(fruit, ex, ey);
      return;
    }
    if (sound) this.audio.kill(this.combo, big);
    if (this.fx.particles) {
      const n = big ? 60 : e.kind === "hex" ? 30 : 20;
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(60, big ? 420 : 300);
        this.particles.push({ x: ex + Math.cos(a) * k.r * 0.4, y: ey + Math.sin(a) * k.r * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, big ? 1.2 : 0.8), max: big ? 1.2 : 0.8, size: rand(3, big ? 8 : 6), c: k.color, kind: 1, rot: rand(0, 6), vr: rand(-14, 14), drag: 2.2 });
      }
      for (let i = 0; i < (big ? 50 : 18); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(200, big ? 800 : 560);
        this.particles.push({ x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.15, 0.45), max: 0.45, size: 2.2, c: mix(WHITE, k.color, rand(0, 0.5)), kind: 0, rot: 0, vr: 0, drag: 4 });
      }
      this.particles.push({ x: ex, y: ey, vx: 0, vy: 0, life: 0.1, max: 0.1, size: big ? 60 : k.r * 2.2, c: withA(mix(WHITE, k.color, 0.5), 0.5), kind: 2, rot: 0, vr: 0, drag: 0 });
    }
    if (this.fx.wave) {
      this.waves.push({ x: ex, y: ey, r: k.r, max: big ? 260 : e.kind === "hex" ? 130 : 95, life: 0, maxLife: big ? 0.7 : 0.42, w: big ? 7 : 4, c: mix(WHITE, k.color, 0.25), grid: big ? 1.3 : 0.7 });
      if (big) this.waves.push({ x: ex, y: ey, r: k.r, max: 160, life: -0.08, maxLife: 0.55, w: 3, c: k.color, grid: 0 });
    }
  }

  /** kills within MULTI_WINDOW of each other: TRIPLE / JUICY / FRENZY / UNSTOPPABLE, each level shown once per burst */
  private multiKill() {
    const now = this.wall;
    this.recentKills.push(now);
    while (this.recentKills.length && now - this.recentKills[0] > MULTI_WINDOW) this.recentKills.shift();
    if (this.recentKills.length === 1) this.multiShown = 0;
    const n = this.recentKills.length;
    let level = 0;
    for (let i = 0; i < MULTI_TEXT.length; i++) if (n >= MULTI_TEXT[i][0]) level = i + 1;
    if (level <= this.multiShown) return;
    this.multiShown = level;
    const [, zh, en, col] = MULTI_TEXT[level - 1];
    this.addBanner(this.zh ? zh : en, col, 34 + level * 6, 0.3);
    this.audio.multiKill(level);
  }

  private die() {
    if (this.dyingT >= 0 || this.lab) return;
    this.dyingT = 0;
    this.audio.die();
    this.hitStop(0.22, true);
    this.addTrauma(1);
    if (this.fx.particles) {
      for (let i = 0; i < 70; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(80, 520);
        this.particles.push({ x: this.sx, y: this.sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 1.4), max: 1.4, size: rand(3, 7), c: i % 3 ? SHIP_C : WHITE, kind: i % 2 ? 1 : 0, rot: rand(0, 6), vr: rand(-12, 12), drag: 1.8 });
      }
      this.particles.push({ x: this.sx, y: this.sy, vx: 0, vy: 0, life: 0.25, max: 0.25, size: 150, c: withA(WHITE, 1), kind: 2, rot: 0, vr: 0, drag: 0 });
    }
    if (this.fx.wave) this.waves.push({ x: this.sx, y: this.sy, r: 10, max: 320, life: 0, maxLife: 0.9, w: 8, c: mix(WHITE, SHIP_C, 0.4), grid: 1.6 });
    if (this.combo >= 5) { this.breakT = 0; this.breakN = this.combo; }
    this.combo = 0;
    this.weapon = null; this.weaponT = 0; this.fever = 0;
  }

  private updateFx(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      if (p.g) p.vy -= p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const x = this.texts[i];
      x.life -= dt;
      if (x.life <= 0) { this.texts.splice(i, 1); continue; }
      x.y += x.vy * dt;
      x.vy *= Math.exp(-3 * dt);
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.life += dt;
      if (w.life >= w.maxLife) this.waves.splice(i, 1);
    }
    for (let i = this.stains.length - 1; i >= 0; i--) {
      const s = this.stains[i];
      s.life -= dt;
      // the grid scrolls down at 6 units / s; the splat sits on it
      s.y -= 6 * dt;
      if (s.life <= 0) this.stains.splice(i, 1);
    }
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      this.slashes[i].life -= dt;
      if (this.slashes[i].life <= 0) this.slashes.splice(i, 1);
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.life -= dt;
      // drips run down the glass, slowing as they go
      for (const d of s.drips) d.len += d.v * dt * (0.4 + s.life / s.max);
      if (s.life <= 0) this.splashes.splice(i, 1);
    }
    for (let i = this.banners.length - 1; i >= 0; i--) {
      this.banners[i].life -= dt;
      if (this.banners[i].life <= 0) this.banners.splice(i, 1);
    }
  }

  /** juice = the fruit's colour: crits take it in full, normal hits a pale tint of it */
  private addDamageText(x: number, y: number, dmg: number, crit: boolean, juice?: string) {
    if (crit) this.addText(x, y, `${dmg}!`, 34, juice ?? "#ff6a3d", juice ?? "rgba(255,80,40,0.95)", 0.8);
    else this.addText(x, y, String(dmg), 20, juice ? paleHex(juice) : "#ffffff", juice ?? "rgba(255,255,255,0.6)", 0.6);
  }

  private addText(x: number, y: number, text: string, size: number, color: string, glow: string, life: number) {
    this.texts.push({ x, y, vy: 90, text, life, max: life, size, color, glow });
    if (this.texts.length > 60) this.texts.shift();
  }

  // ---------------------------------------------------------------- autopilot (local demo / capture)

  private autopilot() {
    if ((window as unknown as { __shootAuto?: boolean }).__shootAuto === false) return;
    if (this.lab) { this.tx = Number(this.params.get("aim")) || 0; this.ty = this.homeY(); return; }
    let aim = this.sx, best = Infinity;
    for (const e of this.enemies) {
      const ex = e.x + e.ox, ey = e.y + e.oy;
      if (ey < this.sy + 70 || ey > this.hh) continue;
      const s = Math.abs(ex - this.sx) + (ey - this.sy) * 0.25 + (e.kind === "elite" ? -60 : 0);
      if (s < best) { best = s; aim = ex; }
    }
    // a capsule coming down near the ship beats any target
    for (const c of this.capsules) if (c.y > this.sy - 10 && c.y < this.sy + 260) { aim = c.x; break; }
    const threats: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    for (const b of this.ebullets) threats.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 6 });
    for (const e of this.enemies) {
      const ex = e.x + e.ox, ey = e.y + e.oy;
      threats.push({ x: ex, y: ey, vx: (ex - e.px) * 60, vy: (ey - e.py) * 60, r: KINDS[e.kind].r });
    }
    let bx = this.sx, bs = Infinity;
    for (let cx = -HALF_W + 16; cx <= HALF_W - 16; cx += 12) {
      let danger = 0;
      // walking there takes time: sample the threats along the way too
      for (const tt of [0.1, 0.2, 0.35, 0.5]) {
        const px = this.sx + (cx - this.sx) * Math.min(1, tt / 0.25);
        for (const th of threats) {
          const d = Math.hypot(th.x + th.vx * tt - px, th.y + th.vy * tt - this.sy) - th.r - SHIP_R;
          if (d < 26) danger += (26 - d) / (tt + 0.05);
        }
      }
      const s = danger * 20 + Math.abs(cx - aim) * 0.6 + Math.abs(cx - this.sx) * 0.15;
      if (s < bs) { bs = s; bx = cx; }
    }
    this.tx = bx;
    this.ty = this.homeY();
  }

  // ---------------------------------------------------------------- render

  private render() {
    const shake = this.trauma * this.trauma;
    const n = this.wall * 60;
    this.camX = shake * 16 * (Math.sin(n * 1.7) * 0.6 + Math.sin(n * 3.1 + 1) * 0.4);
    this.camY = shake * 16 * (Math.sin(n * 2.3 + 2) * 0.6 + Math.sin(n * 2.9 + 4) * 0.4);
    const cam = this.camera;
    cam.left = -this.viewW / 2 + this.camX; cam.right = this.viewW / 2 + this.camX;
    cam.top = this.hh + this.camY; cam.bottom = -this.hh + this.camY;
    cam.updateProjectionMatrix();
    this.grid.mesh.position.set(this.camX, this.camY, 0);

    // grid ripples from the newest shockwaves
    const gw = this.grid.waves;
    let gi = 0;
    for (let i = this.waves.length - 1; i >= 0 && gi < gw.length; i--) {
      const w = this.waves[i];
      if (!w.grid || w.life < 0) continue;
      const u = w.life / w.maxLife;
      gw[gi++].set(w.x, w.y, w.r + (w.max * 1.15 - w.r) * (1 - (1 - u) ** 2), w.grid * (1 - u));
    }
    for (; gi < gw.length; gi++) gw[gi].w = 0;

    const S = this.solid, G = this.glow;
    const C = this.cartoon;
    S.begin(); G.begin(); C.begin();
    const glowOn = this.fx.glow;

    // field edges when the screen is wider than the field
    if (this.viewW > HALF_W * 2 + 4) {
      for (const sx of [-1, 1]) {
        const x = sx * (HALF_W + 2);
        S.line(x, -this.hh - 20, x, this.hh + 20, 2, [0.25, 0.3, 0.6, 0.5]);
        S.tri(x, -this.hh - 20, x + sx * 2000, -this.hh - 20, x, this.hh + 20, [0, 0, 0, 0.35]);
        S.tri(x + sx * 2000, -this.hh - 20, x + sx * 2000, this.hh + 20, x, this.hh + 20, [0, 0, 0, 0.35]);
      }
    }

    // shockwave rings
    for (const w of this.waves) {
      if (w.life < 0) continue;
      const u = w.life / w.maxLife;
      const r = w.r + (w.max - w.r) * (1 - (1 - u) ** 2);
      G.ring(w.x, w.y, r, w.w * (1 - u * 0.6), withA(w.c, (1 - u) ** 1.5));
      if (glowOn) G.ring(w.x, w.y, r * 0.95, w.w * 3, withA(w.c, 0.08 * (1 - u)));
    }

    // juice splats on the floor, under everything that moves
    for (const s of this.stains) {
      const u = s.life / s.max;
      const a = 0.42 * Math.min(1, u * 2.5);
      const grow = 1 + (1 - u) * 0.15;
      for (const [bx, by, br] of s.blobs) S.polyFill(s.x + bx * grow, s.y + by * grow, br * grow, 12, 0, 1, 1, withA(s.c, a));
    }

    // enemies
    for (const e of this.enemies) {
      const k = KINDS[e.kind];
      const ex = e.x + e.ox, ey = e.y + e.oy;
      const sq = this.fx.squash ? e.sq : 0;
      const sx = 1 + sq, sy = 1 - sq;
      const white = e.flash > 0;
      if (isFruit(e.kind)) {
        if (glowOn && !white) G.dot(ex, ey, k.r * 2.2, withA(k.color, 0.07));
        drawFruit(C, e.kind, ex, ey, e.rot, sx, sy, white);
        continue;
      }
      const c = white ? WHITE : k.color;
      if (glowOn && !white) G.dot(ex, ey, k.r * 2.4, withA(c, 0.1));
      S.polyFill(ex, ey, k.r, k.sides, e.rot, sx, sy, white ? [0.92, 0.92, 0.92, 1] : withA(mix([0, 0, 0, 1], k.color, 0.18), 0.85));
      G.polyOutline(ex, ey, k.r, k.sides, e.rot, sx, sy, e.kind === "elite" ? 3.2 : 2.6, c);
      if (e.kind === "elite") {
        G.polyOutline(ex, ey, k.r * 0.55, 4, -e.rot * 1.6, sx, sy, 2.4, c);
        const w = 56, f = Math.max(0, e.hp / k.hp);
        S.line(ex - w / 2, ey + k.r + 14, ex + w / 2, ey + k.r + 14, 5, [0.25, 0.02, 0.05, 0.9]);
        S.line(ex - w / 2, ey + k.r + 14, ex - w / 2 + w * f, ey + k.r + 14, 5, rgba("#ff3048"));
      } else if (e.kind === "hex") {
        G.polyOutline(ex, ey, k.r * 0.45, 6, e.rot, sx, sy, 2, withA(c, 0.8));
      }
    }

    // enemy bullets
    for (const b of this.ebullets) {
      if (b.seed) {
        // a watermelon seed: dark with a pale pink rim so it reads on the dark floor
        if (glowOn) G.dot(b.x, b.y, 13, withA(rgba("#ff3b5c"), 0.3));
        C.polyFill(b.x, b.y, 6.2, 10, 0, 1, 1.3, rgba("#ffd0d8"));
        C.polyFill(b.x, b.y, 4.6, 10, 0, 1, 1.3, [0.08, 0.05, 0.05, 1]);
        continue;
      }
      if (glowOn) G.dot(b.x, b.y, 14, withA(EBULLET_C, 0.35));
      S.polyFill(b.x, b.y, 4.5, 10, 0, 1, 1, EBULLET_C);
      S.polyFill(b.x, b.y, 2.2, 8, 0, 1, 1, WHITE);
    }

    // weapon capsules: a spinning hexagon in the weapon's colour (the letter goes on the text layer)
    for (const c of this.capsules) {
      const col = WEAPON_C[c.w];
      const pulse = 1 + Math.sin(this.wall * 8 + c.t) * 0.08;
      if (glowOn) G.dot(c.x, c.y, 36 * pulse, withA(col, 0.35));
      S.polyFill(c.x, c.y, 15 * pulse, 6, c.t * 1.5, 1, 1, withA(mix([0, 0, 0, 1], col, 0.3), 0.92));
      G.polyOutline(c.x, c.y, 15 * pulse, 6, c.t * 1.5, 1, 1, 2.6, col);
      G.ring(c.x, c.y, 21 + Math.sin(this.wall * 5) * 2, 1.6, withA(col, 0.6));
    }

    // laser beam: wide soft glow, a coloured body, a white-hot core, light running up it
    const trail = this.fx.trail;
    if (this.weapon === "laser" && this.phase === "playing" && this.dyingT < 0) {
      const lc = this.fever > 0 ? hueRgb((this.wall * 0.9) % 1) : WEAPON_C.laser;
      const fl = 1 + Math.sin(this.wall * 60) * 0.12 + Math.random() * 0.1;
      const y0 = this.sy + 18, y1 = this.hh + 30;
      if (glowOn) G.line(this.sx, y0, this.sx, y1, 34 * fl, withA(lc, 0.12));
      G.line(this.sx, y0, this.sx, y1, 14 * fl, withA(lc, 0.6));
      G.line(this.sx, y0, this.sx, y1, 5 * fl, withA(WHITE, 0.95));
      G.dot(this.sx, y0, 26 * fl, withA(lc, 0.85));
      if (trail) for (let i = 0; i < 6; i++) G.dot(this.sx, y0 + ((this.wall * 900 + i * 120) % (y1 - y0)), 12, withA(WHITE, 0.35));
    }

    // player bullets (pierce shots get a longer tail; missiles a small hot body)
    for (const b of this.bullets) {
      const c = b.c ?? BULLET_C;
      const l = Math.hypot(b.vx, b.vy) || 1, ux = b.vx / l, uy = b.vy / l;
      if (b.missile) {
        if (glowOn) G.dot(b.x, b.y, 15, withA(c, 0.4));
        G.streak(b.x - ux * 5, b.y - uy * 5, ux, uy, 9, 3.6, withA(c, 0.95));
        G.streak(b.x, b.y, ux, uy, 5, 2.2, WHITE);
        continue;
      }
      if (trail) {
        const pierce = b.pierce !== undefined;
        const tl = pierce ? 70 : 46;
        G.line(b.x - ux * tl, b.y - uy * tl, b.x, b.y, pierce ? 4.6 : 3.2, withA(c, 0), withA(c, 0.85));
        G.streak(b.x, b.y, ux, uy, pierce ? 14 : 11, 4.5, withA(c, 1));
        G.streak(b.x, b.y, ux, uy, 7, 2.2, WHITE);
        if (glowOn) G.dot(b.x, b.y, 16, withA(c, 0.22));
      } else {
        S.polyFill(b.x, b.y, 2.4, 8, 0, 1, 1, WHITE);
      }
    }

    // particles
    for (const p of this.particles) {
      const a = Math.min(1, p.life / p.max * 1.6);
      if (p.kind === 0) {
        G.line(p.x - p.vx * 0.045, p.y - p.vy * 0.045, p.x, p.y, p.size, withA(p.c, 0), withA(p.c, a));
      } else if (p.kind === 1) {
        // fruit chunks (they fall: g) are solid cartoon bits, neon shards glow
        if (p.g) C.polyFill(p.x, p.y, p.size * (0.6 + 0.4 * a), 4, p.rot, 1, 0.7, withA(p.c, Math.min(1, a * 1.5)));
        else G.polyFill(p.x, p.y, p.size * (0.5 + 0.5 * a), 3, p.rot, 1, 0.6, withA(p.c, a));
      } else if (p.kind === 3) {
        const sz = p.size * (0.45 + 0.55 * a);
        C.polyFill(p.x, p.y, sz, 10, 0, 1, 1 + Math.min(0.8, Math.abs(p.vy) / 900), withA(p.c, Math.min(1, a * 1.4)));
        C.polyFill(p.x - sz * 0.3, p.y + sz * 0.3, sz * 0.32, 6, 0, 1, 1, [1, 1, 1, 0.6 * a]);
      } else if (p.kind === 4) {
        C.polyFill(p.x, p.y, p.size, 8, p.rot, 1.6, 1, withA(p.c, Math.min(1, a * 1.5)));
      } else if (p.kind === 5) {
        drawHalf(C, p.f!, p.x, p.y, p.rot, p.side!, Math.min(1, a * 1.5));
      } else if (p.kind === 6) {
        // four-point twinkle
        const cs = Math.cos(p.rot), sn = Math.sin(p.rot), sz = p.size * (0.5 + 0.5 * a);
        G.streak(p.x, p.y, cs, sn, sz, sz * 0.22, withA(p.c, a));
        G.streak(p.x, p.y, -sn, cs, sz, sz * 0.22, withA(p.c, a));
      } else {
        G.dot(p.x, p.y, p.size * (1.4 - a * 0.4), withA(p.c, a));
      }
    }

    // blade slashes across sliced fruit
    for (const s of this.slashes) {
      const u = 1 - s.life / s.max;
      const dx = Math.cos(s.a), dy = Math.sin(s.a);
      const L = s.len * (0.55 + u * 0.6);
      G.line(s.x - dx * L, s.y - dy * L, s.x + dx * L, s.y + dy * L, 8 * (1 - u) + 1, withA(s.c, 0.5 * (1 - u)));
      G.line(s.x - dx * L, s.y - dy * L, s.x + dx * L, s.y + dy * L, 2.6 * (1 - u) + 0.6, withA(WHITE, 1 - u));
    }

    // ship
    if (this.dyingT < 0) {
      const rc = this.fx.squash ? this.recoil : 0;
      const ssx = 1 + rc * 0.14 + Math.abs(this.tilt) * 0.1, ssy = 1 - rc * 0.16;
      const cs = Math.cos(this.tilt), sn = Math.sin(this.tilt);
      const P = (px: number, py: number): [number, number] => {
        const qx = px * ssx, qy = py * ssy - rc * 3;
        return [this.sx + qx * cs - qy * sn, this.sy + qx * sn + qy * cs];
      };
      const [ax, ay] = P(0, 17), [bx, by] = P(-14, -11), [cx, cy] = P(14, -11);
      if (trail) {
        const fl = 0.7 + Math.sin(this.wall * 70) * 0.2 + Math.random() * 0.15;
        const [fx, fy] = P(0, -14);
        G.streak(fx, fy - 7 * fl, 0, 1, 10 * fl, 4, withA(rgba("#ff9a3a"), 0.9));
        G.streak(fx, fy - 4 * fl, 0, 1, 5 * fl, 2, withA(WHITE, 0.9));
      }
      if (glowOn) G.dot(this.sx, this.sy, 40, withA(SHIP_C, 0.14));
      S.tri(ax, ay, bx, by, cx, cy, withA(mix([0, 0, 0, 1], SHIP_C, 0.2), 0.85));
      G.line(ax, ay, bx, by, 2.8, SHIP_C); G.line(bx, by, cx, cy, 2.8, SHIP_C); G.line(cx, cy, ax, ay, 2.8, SHIP_C);
      if (trail && this.muzzle > 0 && this.weapon !== "laser") {
        const m = this.muzzle / 0.05;
        const level = this.gunLevel();
        for (const off of this.weapon === "spread" ? [0] : level === 3 ? [-11, 0, 11] : level === 2 ? [-7, 7] : [0]) {
          const mx = this.sx + off, my = this.sy + 20;
          G.dot(mx, my, 18 * m + 6, withA(rgba("#fff1b0"), 0.9));
          G.streak(mx, my + 6, 0, 1, 14 * m, 2.5, WHITE);
          G.streak(mx, my, 1, 0, 9 * m, 1.6, withA(BULLET_C, 0.9));
        }
      }
    }

    S.end(); G.end(); C.end();
    if (glowOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.over, this.camera);
    this.renderer.autoClear = true;
    this.draw2d();
  }

  private toScreen(x: number, y: number): [number, number] {
    return [((x - this.camX) / this.viewW + 0.5) * this.cssW, (0.5 - (y - this.camY) / this.viewH) * this.cssH];
  }

  /** text layer: damage numbers, score, combo */
  private draw2d() {
    const g = this.g2;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.cssW, this.cssH);
    const font = (px: number) => `italic 900 ${px}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const glowOn = this.fx.glow;
    const pxPerUnit = this.cssW / this.viewW;

    // juice splashed onto the screen glass: a blob, drips running down, a glassy highlight
    for (const s of this.splashes) {
      const u = s.life / s.max;
      const a = Math.min(1, u * 1.8) * 0.4;
      const r = s.r * (1 + (1 - u) * 0.08);
      g.globalAlpha = a;
      g.fillStyle = s.c;
      // one path, one fill: overlapping parts don't stack up darker
      g.beginPath();
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      for (const [dx, dy, dr] of s.dots) {
        g.moveTo(s.x + dx * r + dr * r, s.y + dy * r);
        g.arc(s.x + dx * r, s.y + dy * r, dr * r, 0, Math.PI * 2);
      }
      for (const d of s.drips) {
        // each drip leaves from the blob's lower edge, a thin trail with a round drop at the end
        const x = s.x + d.dx * r, w = r * d.w;
        const y0 = s.y + Math.sqrt(1 - d.dx * d.dx) * r * 0.85;
        const y1 = y0 + d.len;
        g.rect(x - w * 0.55, s.y, w * 1.1, y1 - s.y);
        g.moveTo(x + w, y1);
        g.arc(x, y1, w, 0, Math.PI * 2);
      }
      g.fill();
      g.globalAlpha = a * 0.9;
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.beginPath(); g.arc(s.x - r * 0.38, s.y - r * 0.38, r * 0.17, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    // the letter on each weapon capsule
    for (const c of this.capsules) {
      const [x, y] = this.toScreen(c.x, c.y);
      g.font = `900 ${Math.round(15 * Math.min(1.3, Math.max(0.8, pxPerUnit)))}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
      g.fillStyle = "#fff";
      g.fillText(WEAPON_NAMES[c.w][this.zh ? 2 : 3], x, y + 1);
    }
    for (const t of this.texts) {
      const age = t.max - t.life;
      const pop = age < 0.09 ? 1.7 - (age / 0.09) * 0.7 : 1;
      const a = Math.min(1, t.life / (t.max * 0.45));
      const [x, y] = this.toScreen(t.x, t.y);
      const size = t.size * pop * Math.min(1.25, Math.max(0.8, pxPerUnit));
      g.font = font(size);
      g.globalAlpha = a;
      g.lineWidth = Math.max(3, size * 0.16);
      g.strokeStyle = "rgba(10,6,20,0.85)";
      g.strokeText(t.text, x, y);
      if (glowOn) { g.shadowColor = t.glow; g.shadowBlur = size * 0.5; }
      g.fillStyle = t.color;
      g.fillText(t.text, x, y);
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    if (this.phase === "ready") return;

    // shaken with the camera, like the world under it
    const ox = -this.camX * pxPerUnit, oy = this.camY * pxPerUnit;
    const fieldL = this.toScreen(-HALF_W, 0)[0], fieldR = this.toScreen(HALF_W, 0)[0];
    const cx = (fieldL + fieldR) / 2;
    g.textAlign = "center";
    g.font = `600 13px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.fillText(this.zh ? "分数" : "SCORE", cx + ox, 72 + oy);
    g.font = font(40);
    g.fillStyle = "#fff";
    if (glowOn) { g.shadowColor = "rgba(120,220,255,0.8)"; g.shadowBlur = 14; }
    g.fillText(Math.round(this.scoreShown).toLocaleString("en-US"), cx + ox, 100 + oy);
    g.shadowBlur = 0;

    // active weapon and the time left on it, bottom left of the field
    if (this.weapon) {
      const col = rgbHex(WEAPON_C[this.weapon]);
      const x = fieldL + 14 + ox, y = this.cssH - 46 + oy;
      g.textAlign = "left";
      g.font = font(18);
      g.lineWidth = 4;
      g.strokeStyle = "rgba(10,6,20,0.85)";
      const name = WEAPON_NAMES[this.weapon][this.zh ? 0 : 1];
      g.strokeText(name, x, y);
      if (glowOn) { g.shadowColor = col; g.shadowBlur = 12; }
      g.fillStyle = col;
      g.fillText(name, x, y);
      g.shadowBlur = 0;
      if (this.weaponT !== Infinity) {
        const f = clamp(this.weaponT / WEAPON_TIME, 0, 1), bw = 110;
        g.fillStyle = "rgba(255,255,255,0.15)";
        g.fillRect(x, y + 14, bw, 5);
        g.fillStyle = this.weaponT < 2.5 && Math.sin(this.wall * 20) > 0 ? "#fff" : col;
        g.fillRect(x, y + 14, bw * f, 5);
      }
    }

    // fever: a pulsing rainbow frame round the field
    if (this.fever > 0 && glowOn) {
      g.strokeStyle = rgbHex(hueRgb((this.wall * 0.6) % 1));
      g.globalAlpha = (0.4 + 0.25 * Math.sin(this.wall * 10)) * Math.min(1, this.fever);
      g.lineWidth = 10;
      g.strokeRect(fieldL + 5 + ox, 5 + oy, fieldR - fieldL - 10, this.cssH - 10);
      g.globalAlpha = 1;
    }

    // centre banners: multi-kills, pickups, fever (pop in, drift up, fade)
    this.banners.forEach((b, i) => {
      const age = b.max - b.life;
      const pop = age < 0.12 ? 0.4 + (age / 0.12) * 0.95 : age < 0.22 ? 1.35 - ((age - 0.12) / 0.1) * 0.35 : 1;
      g.save();
      g.globalAlpha = Math.min(1, b.life / 0.35);
      g.translate(cx + ox, this.cssH * (b.y + i * 0.07) + oy - age * 24);
      g.rotate(-0.06);
      g.scale(pop, pop);
      g.textAlign = "center";
      g.font = font(b.size);
      g.lineWidth = Math.max(4, b.size * 0.15);
      g.strokeStyle = "rgba(10,6,20,0.85)";
      g.strokeText(b.text, 0, 0);
      if (glowOn) { g.shadowColor = b.color; g.shadowBlur = b.size * 0.6; }
      g.fillStyle = b.color;
      g.fillText(b.text, 0, 0);
      g.restore();
    });

    if (!this.fx.combo) return;
    const right = fieldR - 14 + ox;
    const top = 150 + oy;
    const zh = this.zh;
    if (this.combo >= 2) {
      const mult = multFor(this.combo);
      const heat = Math.min(1, (mult - 1) / (MAX_MULT - 1));
      const col = `rgb(255,${Math.round(150 - heat * 90)},${Math.round(60 + heat * 40)})`;
      const pop = this.comboPop < 0.14 ? 1.45 - (this.comboPop / 0.14) * 0.45 : 1;
      g.save();
      g.translate(right, top);
      g.scale(pop, pop);
      g.textAlign = "right";
      g.font = font(34);
      g.lineWidth = 6;
      g.strokeStyle = "rgba(20,5,10,0.8)";
      const label = `${zh ? "连击" : "COMBO"} x${this.combo}`;
      g.strokeText(label, 0, 0);
      if (glowOn) { g.shadowColor = col; g.shadowBlur = 18; }
      g.fillStyle = col;
      g.fillText(label, 0, 0);
      g.restore();
      g.shadowBlur = 0;
      // time left to keep the streak
      const bw = 130, f = clamp(this.comboT / COMBO_WINDOW, 0, 1);
      g.fillStyle = "rgba(255,255,255,0.15)";
      g.fillRect(right - bw, top + 22, bw, 5);
      g.fillStyle = f < 0.3 ? "#ff4b4b" : col;
      g.fillRect(right - bw * f, top + 22, bw * f, 5);
      const mp = this.multPop < 0.25 ? 1.6 - (this.multPop / 0.25) * 0.6 : 1;
      g.save();
      g.translate(right, top + 46);
      g.scale(mp, mp);
      g.textAlign = "right";
      g.font = font(20);
      g.fillStyle = mult > 1 ? "#ffe36b" : "rgba(255,255,255,0.75)";
      g.fillText(`×${mult}`, 0, 0);
      g.restore();
    }
    if (this.breakT < 0.9) {
      const a = 1 - this.breakT / 0.9;
      g.globalAlpha = a;
      g.textAlign = "right";
      g.font = font(22);
      g.fillStyle = "#9aa3c7";
      g.fillText(zh ? `连击中断 ×${this.breakN}` : `COMBO LOST ×${this.breakN}`, right + this.breakT * 30 * Math.sin(this.breakT * 40) * a, top + (this.combo >= 2 ? 78 : 0));
      g.globalAlpha = 1;
    }
  }
}
