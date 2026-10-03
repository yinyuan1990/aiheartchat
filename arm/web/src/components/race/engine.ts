import * as THREE from "three";
import { createWater } from "../boat/water";
import { buildIsland, loadPalms } from "../boat/engine";
import { RaceAudio, recordingAudio, renderLog, type AudioLog } from "./audio";
import { DEBRIS, PLAYER_CARS, TRAFFIC, boxCar, instance, isReady, loadModel, type PlayerCar } from "./models";
import {
  LANE, ROAD_HALF, SPAN, TOWER_TOP, TOWER_X, Sprites, TimeOfDay, WATER_Y,
  cableY, createBridge, createMountains, createSky, radialTexture,
} from "./scene";

// Three-lane highway runner on a sea bridge, same rules as the speedboat: the car stays at z = 0 and steers in x,
// the world flows toward the camera (+z). Traffic drives the same way slower; cones only slow you down, barriers,
// crates and cars end the run; ramps throw you over everything; later, wrong-way cars come at you head-on.

export type Phase = "ready" | "playing" | "over";
// same scale as the speedboat so the $BOAT rules (13 m/s cap) hold: game metres = world units x METRE
export const METRE = 0.25;
type Hooks = {
  onPhase: (p: Phase, distance: number) => void;
  onDistance: (m: number, kmh: number) => void;
  onRequestStart: () => void;
  onNearMiss?: (streak: number) => void;
};

const SPAWN_Z = -250;
const KILL_Z = 30;
const CAR_HW = 0.95;
const CAR_FRONT = -2.05;
const CAR_BACK = 2.05;
const JUMP_V = 9.5;
const RAMP_V = 14.5;
const GRAVITY = 24;
const TRAFFIC_V = 10;
const WRONG_V = 30;
const TOP_SPEED = 46;
const TOD0 = 0.1;
const LANECHANGE_FROM = 800; // world units (200 game metres)
const WRONG_FROM = 600; // 150 game metres
const SALVO_FROM = 1500; // 375 game metres

const speedAt = (d: number) => 20 + 26 * (1 - Math.exp(-d / 1800));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const laneOf = (x: number) => Math.max(-1, Math.min(1, Math.round(x / LANE)));

type Kind = "car" | "cone" | "barrier" | "crate" | "ramp" | "wrong";
type Ob = {
  kind: Kind; obj: THREE.Object3D; x: number; z: number; hw: number; hl: number; top: number;
  /** own speed along the road (toward -z); wrong-way cars are negative */
  v: number;
  wheels: THREE.Object3D[];
  lane: number;
  siren?: boolean;
  /** lane change: blink timer, then a 0.9 s move from fromX to the target lane */
  changer?: boolean; blink?: number; target?: number; fromX?: number; moveT?: number;
  passed?: boolean;
  /** ramps after use, cones after being knocked over */
  spent?: boolean;
  warn?: THREE.Mesh;
};
type Flyer = { obj: THREE.Object3D; x: number; y: number; z: number; vx: number; vy: number; vz: number; wx: number; wy: number; wz: number; life: number };
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; grow: number; r: number; g: number; b: number; a: number; smoke: boolean; drag: number };
type Skid = { x: number; z: number; yaw: number; life: number };

const MAX_PARTICLES = 900;
const MAX_SKIDS = 220;

const stripeTexture = (a: string, b: string, n = 8) => {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = a; g.fillRect(0, 0, 128, 32);
  g.fillStyle = b;
  for (let i = -1; i < n; i++) { g.beginPath(); g.moveTo(i * 16, 32); g.lineTo(i * 16 + 8, 32); g.lineTo(i * 16 + 24, 0); g.lineTo(i * 16 + 16, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

function chevronTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 64, 128);
  g.fillStyle = "#fff";
  // arrows pointing at the camera (down the texture = toward +z once laid on the road)
  for (const y of [8, 72]) { g.beginPath(); g.moveTo(4, y); g.lineTo(32, y + 34); g.lineTo(60, y); g.lineTo(60, y + 16); g.lineTo(32, y + 50); g.lineTo(4, y + 16); g.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class RaceEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
  private tod = new TimeOfDay();
  private sky = createSky(this.tod);
  private water = createWater();
  private mountains = createMountains();
  private bridge: ReturnType<typeof createBridge>;
  private hemi = new THREE.HemisphereLight("#fff", "#444", 1);
  private sun = new THREE.DirectionalLight("#fff", 2);
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envTod = -1;
  private glows = new Sprites(1400, true);
  private smoke = new Sprites(500, false);
  private car = new THREE.Group();
  private carModel: { obj: THREE.Object3D; wheels: THREE.Object3D[] } | null = null;
  private carName: PlayerCar = "race";
  private beam: THREE.Mesh;
  private obstacles: Ob[] = [];
  private flyers: Flyer[] = [];
  private particles: Particle[] = [];
  private skids: Skid[] = [];
  private flashes: { x: number; z: number; life: number; size: number }[] = [];
  private skidMesh: THREE.InstancedMesh;
  private lines: THREE.LineSegments;
  private linePos = new Float32Array(80 * 6);
  private lineCol = new Float32Array(80 * 6);
  private lineSeeds = Array.from({ length: 80 }, () => ({ x: 0, y: 0, z: 0, k: 0 }));
  private islands: THREE.Object3D[] = [];
  private nextIsland = 0;
  private coneMat = new THREE.MeshStandardMaterial({ color: "#ff6a1a", roughness: 0.5 });
  private barrierTex = stripeTexture("#f4f4f4", "#e0262b");
  private rampTex = stripeTexture("#ffd23a", "#1d1d22");
  private chevron = chevronTexture();

  private phase: Phase = "ready";
  private time = 0;
  private distance = 0;
  /** where the run started; the sun sets as you drive from here */
  private startD = 0;
  private offset = 0;
  private speed = 0;
  private lane = 0;
  private x = 0;
  private vx = 0;
  private jumpY = 0;
  private jumpV = 0;
  private nextCar = 0;
  private nextHaz = 0;
  private nextRamp = 0;
  private wrongTimer = 0;
  private crashT = 0;
  private crashSent = false;
  private crashVel = new THREE.Vector3();
  private crashSpin = new THREE.Vector3();
  private shake = 0;
  private brake = 0;
  private streak = 0;
  private swerve: { from: number; t: number } | null = null;
  private hudT = 0;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private disposed = false;
  private portrait = false;
  readonly audio: RaceAudio;
  private audioLog: AudioLog = [];
  private local = window.location.hostname === "localhost";
  private params = new URLSearchParams(window.location.search);
  // promo recording only (localhost): ?demo=1 drives itself; ?capture=1 also stops the clock so a script can step
  // fixed 1/60 s frames and screenshot each one (window.__race.step)
  private capture = this.local && this.params.get("capture") === "1";
  private demo = this.local && (this.params.get("demo") === "1" || this.capture);
  private autoT = 0;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    const sound = new RaceAudio();
    this.audio = this.capture ? recordingAudio(sound, this.audioLog, () => this.time) : sound;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: this.capture });
    this.renderer.setPixelRatio(this.capture ? 1 : Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.bridge = createBridge(this.renderer);
    this.water.mesh.position.y = WATER_Y;
    const wu = this.water.uniforms;
    wu.uDeep.value = this.tod.deep; wu.uShallow.value = this.tod.shallow; wu.uHorizon.value = this.tod.horizon;
    wu.uZenith.value = this.tod.zenith; wu.uSunDir.value = this.tod.sunDir; wu.uSunColor.value = this.tod.sun;
    this.scene.fog = new THREE.Fog("#ffc27a", 80, 330);
    // sky first, then the mountain silhouettes over it, then everything else
    this.sky.mesh.renderOrder = -2;
    this.scene.add(this.sky.mesh, this.mountains.group, this.water.mesh, this.bridge.group, this.car, this.hemi, this.sun, this.sun.target);
    this.envScene.add(new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material));

    const big = window.innerWidth * (window.devicePixelRatio || 1) > 1400;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(big ? 2048 : 1024, big ? 2048 : 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;

    this.scene.add(this.glows.points, this.smoke.points);

    // headlight pool on the road ahead of the car, night only
    this.beam = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 22).rotateX(-Math.PI / 2).translate(0, 0.03, -13),
      new THREE.MeshBasicMaterial({ map: radialTexture(), color: "#fff4d6", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.car.add(this.beam);
    this.setCarFallback();

    this.skidMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.32, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#101014", transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      MAX_SKIDS,
    );
    this.skidMesh.count = 0;
    this.skidMesh.frustumCulled = false;
    this.scene.add(this.skidMesh);

    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3));
    lg.setAttribute("color", new THREE.BufferAttribute(this.lineCol, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
    for (const s of this.lineSeeds) this.seedLine(s, true);

    const saved = (() => { try { return localStorage.getItem("arm-race-car"); } catch { return null; } })();
    const q = this.params.get("car") ?? saved;
    this.setCar((PLAYER_CARS as readonly string[]).includes(q ?? "") ? (q as PlayerCar) : "race");
    for (const n of PLAYER_CARS) void loadModel(n);
    for (const n of [...TRAFFIC, "cone", "box", ...DEBRIS]) void loadModel(n);
    void loadPalms().then(() => {
      if (this.disposed) return;
      for (let z = 10; z > -320; z -= 55) this.spawnIsland(z);
      this.nextIsland = 50;
    });

    this.applyTod(this.todAt(), true);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.bindInput();
    this.update(0.001);
    this.last = performance.now();
    if (this.capture) {
      (window as unknown as { __race: unknown }).__race = {
        step: (n = 1) => { for (let i = 0; i < n; i++) { this.time += 1 / 60; this.update(1 / 60); } this.renderer.render(this.scene, this.camera); },
        info: () => ({ phase: this.phase, distance: this.distance, m: Math.floor(this.distance * METRE), speed: this.speed, obstacles: this.obstacles.length, loaded: isReady("sedan") && isReady(this.carName) }),
        start: () => this.hooks.onRequestStart(),
        time: () => this.time,
        /** the recorded sound from game time t0, `seconds` long, as a base64 WAV */
        audio: async (t0: number, seconds: number) => {
          const bytes = await renderLog(this.audioLog, t0, seconds);
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
      };
      this.renderer.render(this.scene, this.camera);
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  get carChoice() { return this.carName; }

  private score() { return Math.floor((this.distance - this.startD) * METRE); }

  /** Switch the player's car (cosmetic). Saved for next time. */
  setCar(name: PlayerCar) {
    this.carName = name;
    try { localStorage.setItem("arm-race-car", name); } catch { /* private mode */ }
    void loadModel(name).then(() => {
      if (this.disposed || this.carName !== name) return;
      const inst = instance(name);
      if (!inst) return;
      if (this.carModel) this.car.remove(this.carModel.obj);
      this.carModel = inst;
      this.car.add(inst.obj);
    });
  }

  private setCarFallback() {
    const f = boxCar("#e23b3b");
    this.carModel = f;
    this.car.add(f.obj);
  }

  start() {
    this.audio.unlock();
    if (this.phase === "playing") return;
    for (const o of this.obstacles) this.removeOb(o);
    this.obstacles = [];
    for (const f of this.flyers) this.scene.remove(f.obj);
    this.flyers = [];
    this.skids = [];
    this.flashes = [];
    // local testing only: ?d=800 starts the run 800 world units in, to reach the later stages quickly
    this.distance = this.local ? Number(this.params.get("d")) || 0 : 0;
    this.startD = this.distance;
    this.speed = Math.max(this.speed, 6);
    this.lane = 0;
    this.x = 0;
    this.vx = 0;
    this.jumpY = 0;
    this.jumpV = 0;
    this.nextCar = 60;
    this.nextHaz = 110;
    this.nextRamp = 260;
    this.wrongTimer = 3;
    this.crashT = 0;
    this.crashSent = false;
    this.streak = 0;
    this.swerve = null;
    this.car.position.set(0, 0, 0);
    this.car.rotation.set(0, 0, 0);
    this.phase = "playing";
    this.hooks.onPhase("playing", 0);
  }

  steer(dir: -1 | 1) {
    if (this.phase === "ready") return this.hooks.onRequestStart();
    if (this.phase !== "playing") return;
    const next = Math.max(-1, Math.min(1, this.lane + dir));
    if (next === this.lane) return;
    this.audio.unlock();
    this.swerve = { from: this.lane, t: this.time };
    this.lane = next;
    if (this.jumpY < 0.2) this.audio.swerve();
  }

  jump() {
    if (this.phase === "ready") return this.hooks.onRequestStart();
    if (this.phase !== "playing" || this.jumpY > 0.01 || this.jumpV > 0) return;
    this.audio.unlock();
    this.jumpV = JUMP_V;
    this.audio.jump();
    for (let i = 0; i < 14; i++) this.puff(this.x + rand(-1, 1), 0.2, rand(0.5, 2), rand(-1.5, 1.5), rand(0.3, 1.2), rand(0, 2), 0.7, 0.75, 0.72, 0.7);
  }

  dispose() {
    this.disposed = true;
    this.audio.dispose();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") { this.steer(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") { this.steer(1); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W" || e.key === " ") { this.jump(); e.preventDefault(); }
    else if (e.key === "Enter" && this.phase !== "playing") { this.hooks.onRequestStart(); e.preventDefault(); }
  };

  private bindInput() {
    window.addEventListener("keydown", this.onKey);
    const el = this.renderer.domElement;
    let sx = 0, sy = 0, moved = false;
    el.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; moved = false; this.audio.unlock(); });
    el.addEventListener("pointermove", (e) => {
      if (moved || (e.buttons === 0 && e.pointerType === "mouse")) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) { moved = true; this.steer(dx < 0 ? -1 : 1); }
      else if (dy < -28 && -dy > Math.abs(dx)) { moved = true; this.jump(); }
    });
    el.addEventListener("pointerup", (e) => {
      if (moved || this.phase !== "playing") return;
      const r = el.getBoundingClientRect();
      this.steer(e.clientX - r.left < r.width / 2 ? -1 : 1);
    });
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.portrait = w / h < 0.85;
    this.camera.updateProjectionMatrix();
    this.pointScale();
  }

  private pointScale() {
    const s = this.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.glows.setScale(s);
    this.smoke.setScale(s);
  }

  // ---------------------------------------------------------------- time of day

  private todAt() {
    const forced = this.local ? Number(this.params.get("tod")) : NaN;
    if (Number.isFinite(forced) && this.params.has("tod")) return forced;
    // promo recording (localhost): ?todRate=3 runs into the night three times sooner
    const k = this.local ? Number(this.params.get("todRate")) || 1 : 1;
    return Math.min(1, TOD0 + ((this.distance - this.startD) * k) / 1800);
  }

  private applyTod(t: number, force = false) {
    const tod = this.tod;
    if (!tod.set(t) && !force) return;
    this.sky.uniforms.uNight.value = tod.night;
    (this.scene.fog as THREE.Fog).color.copy(tod.horizon).lerp(tod.glow, 0.25);
    this.hemi.color.copy(tod.hemiSky);
    this.hemi.groundColor.copy(tod.hemiGround);
    this.hemi.intensity = tod.hemiI;
    this.sun.color.copy(tod.sun);
    this.sun.intensity = tod.sunI;
    this.mountains.update(tod);
    this.renderer.toneMappingExposure = 1.0 + 0.25 * tod.night;
    if (force || Math.abs(t - this.envTod) > 0.05) {
      this.envTod = t;
      const rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 1000);
      this.envTarget?.dispose();
      this.envTarget = rt;
      this.scene.environment = rt.texture;
    }
  }

  // ---------------------------------------------------------------- spawning

  private removeOb(o: Ob) {
    this.scene.remove(o.obj);
    if (o.warn) {
      this.scene.remove(o.warn);
      const m = o.warn.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    }
  }

  private addCar(lane: number, z: number, wrong = false) {
    const name = wrong ? pick(["truck", "garbage-truck", "delivery", "firetruck", "suv"] as const) : pick(TRAFFIC);
    const inst = instance(name) ?? boxCar(pick(["#3b82f6", "#22c55e", "#f59e0b", "#e5e7eb"]));
    if (wrong) inst.obj.rotation.y = Math.PI;
    const x = lane * LANE;
    inst.obj.position.set(x, 0, z);
    this.scene.add(inst.obj);
    const o: Ob = {
      kind: wrong ? "wrong" : "car", obj: inst.obj, x, z, hw: inst.size.x / 2 * 0.9, hl: inst.size.z / 2 * 0.94, top: inst.size.y,
      v: wrong ? -WRONG_V : TRAFFIC_V, wheels: inst.wheels, lane, siren: name === "police" || name === "ambulance" || name === "firetruck",
    };
    if (!wrong && this.distance > LANECHANGE_FROM && Math.random() < Math.min(0.45, 0.15 + (this.distance - LANECHANGE_FROM) / 6000)) o.changer = true;
    this.obstacles.push(o);
    return o;
  }

  /** lanes occupied around z (±w), counting a car's target lane while it changes */
  private lanesNear(z: number, w: number, skip?: Ob) {
    const s = new Set<number>();
    for (const o of this.obstacles) {
      if (o === skip || o.kind === "ramp" || o.kind === "wrong" || Math.abs(o.z - z) > w + o.hl) continue;
      s.add(laneOf(o.x));
      if (o.target !== undefined) s.add(o.target);
    }
    return s;
  }

  private spawnCars() {
    const twoChance = Math.min(0.55, 0.1 + this.distance / 5000);
    const lanes = [-1, 0, 1].sort(() => Math.random() - 0.5).slice(0, Math.random() < twoChance ? 2 : 1);
    const busy = this.lanesNear(SPAWN_Z, 14);
    const free = lanes.filter((l) => !busy.has(l));
    if (busy.size + free.length > 2) free.length = Math.max(0, 2 - busy.size);
    for (const l of free) this.addCar(l, SPAWN_Z - rand(0, 6));
  }

  /**
   * Static hazards approach faster than traffic, so a hazard row spawned behind a row of cars catches up with it
   * somewhere down the road. Pick lanes so that wherever that happens, at least one lane stays open.
   */
  private hazardLanesOk(lanes: number[]) {
    const S = Math.max(this.speed, 15);
    const z0 = SPAWN_Z;
    for (const c of this.obstacles) {
      if (c.kind !== "car" || c.z < z0) continue;
      const t = (c.z - z0) / c.v;
      const zm = z0 + S * t;
      if (zm > CAR_BACK + 8) continue;
      const near = new Set<number>(lanes);
      for (const o of this.obstacles) {
        if (o.kind !== "car" || Math.abs(o.z - c.z) > 16 + o.hl) continue;
        near.add(laneOf(o.x));
        if (o.changer) { near.add(Math.max(-1, laneOf(o.x) - 1)); near.add(Math.min(1, laneOf(o.x) + 1)); }
      }
      if (near.size > 2) return false;
    }
    const busy = this.lanesNear(z0, 12);
    for (const l of lanes) busy.add(l);
    return busy.size <= 2;
  }

  private spawnHazards() {
    const two = Math.random() < Math.min(0.45, 0.08 + this.distance / 6000);
    const order = [-1, 0, 1].sort(() => Math.random() - 0.5);
    let lanes = order.slice(0, two ? 2 : 1);
    if (!this.hazardLanesOk(lanes)) {
      lanes = order.map((l) => [l]).find((l) => this.hazardLanesOk(l)) ?? [];
    }
    for (const l of lanes) {
      const r = Math.random();
      this.addHazard(r < 0.42 ? "cone" : r < 0.72 ? "barrier" : "crate", l, SPAWN_Z);
    }
  }

  private addHazard(kind: "cone" | "barrier" | "crate" | "ramp", lane: number, z: number) {
    const g = new THREE.Group();
    const x = lane * LANE;
    let hw = 1.4, hl = 0.4, top = 1.0;
    if (kind === "cone") {
      for (const dx of [-1.1, 0, 1.1]) {
        const c = instance("cone")?.obj ?? new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 12).translate(0, 0.45, 0), this.coneMat);
        c.position.set(dx + rand(-0.15, 0.15), 0, rand(-0.3, 0.3));
        c.castShadow = true;
        g.add(c);
      }
      hw = 1.45; hl = 0.5; top = 0.96;
    } else if (kind === "barrier") {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.0, 0.55), [
        new THREE.MeshStandardMaterial({ color: "#d9d9d9", roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: "#d9d9d9", roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ color: "#eeeeee", roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: "#d9d9d9", roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ map: this.barrierTex, roughness: 0.6 }), new THREE.MeshStandardMaterial({ map: this.barrierTex, roughness: 0.6 }),
      ]);
      m.position.y = 0.5;
      m.castShadow = true;
      for (const dx of [-1.2, 1.2]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 1.1), new THREE.MeshStandardMaterial({ color: "#333", roughness: 0.8 }));
        leg.position.set(dx, 0.06, 0);
        g.add(leg);
      }
      g.add(m);
      hw = 1.45; hl = 0.35; top = 1.0;
    } else if (kind === "crate") {
      for (const dx of [-0.62, 0.62]) {
        const b = instance("box")?.obj ?? new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1).translate(0, 0.55, 0), new THREE.MeshStandardMaterial({ color: "#c98a4b" }));
        b.position.set(dx, 0, rand(-0.2, 0.2));
        b.rotation.y = rand(-0.3, 0.3);
        b.castShadow = true;
        g.add(b);
      }
      hw = 1.3; hl = 0.6; top = 1.14;
    } else {
      // wedge rising toward -z, striped top
      const shape = new THREE.Shape();
      shape.moveTo(0, 0); shape.lineTo(6, 0); shape.lineTo(6, 1.15); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.8, bevelEnabled: false });
      geo.rotateY(Math.PI / 2);
      geo.translate(-1.4, 0, 0);
      const mat = new THREE.MeshStandardMaterial({ map: this.rampTex, roughness: 0.5 });
      this.rampTex.wrapS = this.rampTex.wrapT = THREE.RepeatWrapping;
      const m = new THREE.Mesh(geo, mat);
      m.position.z = 3;
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      hw = 1.4; hl = 3; top = 0;
    }
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.obstacles.push({ kind, obj: g, x, z, hw, hl, top, v: 0, wheels: [], lane });
  }

  private spawnRamp() {
    const busy = this.lanesNear(SPAWN_Z, 20);
    const free = [-1, 0, 1].filter((l) => !busy.has(l));
    if (free.length) this.addHazard("ramp", pick(free), SPAWN_Z);
  }

  /** A wrong-way truck aimed at a lane: it reaches the car's z in T seconds, so staying in that lane is fatal. */
  private fireWrong(lane: number, T: number) {
    const S = this.speed;
    const z = -(S + WRONG_V) * T - 2;
    const o = this.addCar(lane, Math.max(z, SPAWN_Z - 40), true);
    const warn = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 60).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.chevron.clone(), color: "#ff2a2a", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    (warn.material as THREE.MeshBasicMaterial).map!.repeat.set(1, 8);
    warn.position.set(o.x, 0.05, -34);
    warn.renderOrder = 2;
    this.scene.add(warn);
    o.warn = warn;
    this.audio.horn();
  }

  private wrongWay(dt: number) {
    if (this.distance < WRONG_FROM) return;
    this.wrongTimer -= dt;
    if (this.wrongTimer > 0) return;
    const prog = Math.min(1, (this.distance - WRONG_FROM) / 2400);
    const T = 2.6 - 0.8 * prog;
    const lane = Math.random() < 0.65 ? this.lane : pick([-1, 0, 1]);
    this.fireWrong(lane, T);
    if (this.distance > SALVO_FROM && Math.random() < 0.3 + 0.4 * prog) {
      const others = [-1, 0, 1].filter((l) => l !== lane);
      this.fireWrong(pick(others), T + 0.35);
    }
    this.wrongTimer = rand(0.8, 1.2) * (6.5 - 3.8 * prog);
  }

  private spawnIsland(z: number) {
    const isl = buildIsland();
    const side = Math.random() < 0.5 ? -1 : 1;
    isl.position.set(side * rand(34, 110), WATER_Y + 0.2, z);
    isl.rotation.y = rand(0, 6);
    isl.scale.setScalar(rand(1, 1.8));
    this.islands.push(isl);
    this.scene.add(isl);
  }

  // ---------------------------------------------------------------- effects

  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number, a = 0.35, size = 0.9, grow = 2.2) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ x, y, z, vx, vy, vz, life, max: life, size, grow, r, g, b, a, smoke: true, drag: 1.5 });
  }

  private spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r = 1, g = 0.6, b = 0.2, size = 0.25) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ x, y, z, vx, vy, vz, life, max: life, size, grow: 0, r, g, b, a: 1, smoke: false, drag: 0.3 });
  }

  private fling(obj: THREE.Object3D, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    obj.position.set(x, y, z);
    this.scene.add(obj);
    this.flyers.push({ obj, x, y, z, vx, vy, vz, wx: rand(-9, 9), wy: rand(-6, 6), wz: rand(-9, 9), life: 3.5 });
  }

  private explode(x: number, z: number, big: boolean) {
    this.flashes.push({ x, z, life: big ? 0.5 : 0.35, size: big ? 16 : 10 });
    // fireball: big soft orange blobs rising and fading
    for (let i = 0; i < (big ? 26 : 12); i++) this.spark(x + rand(-1.2, 1.2), rand(0.4, 1.6), z + rand(-1.2, 1.2), rand(-2.5, 2.5), rand(2, 6), rand(-1.5, 2.5), rand(0.35, 0.7), 1, rand(0.3, 0.55), 0.08, rand(2.2, 4.2));
    for (let i = 0; i < (big ? 160 : 70); i++) this.spark(x + rand(-1, 1), rand(0.3, 1.5), z + rand(-1.5, 1.5), rand(-9, 9), rand(2, 12), rand(-6, 10), rand(0.4, 1.1), 1, rand(0.35, 0.75), 0.15, rand(0.15, 0.35));
    for (let i = 0; i < (big ? 46 : 20); i++) this.puff(x + rand(-1.2, 1.2), rand(0.5, 2), z + rand(-1.5, 1.5), rand(-2, 2), rand(1, 4), rand(-1, 3), rand(1.2, 2.4), 0.16, 0.15, 0.16, 0.55, rand(1.2, 2.2), 2.5);
    for (let i = 0; i < 18; i++) this.spark(x + rand(-0.8, 0.8), rand(0.5, 1.8), z + rand(-1, 1), rand(-3, 3), rand(1, 5), rand(-2, 3), rand(0.4, 0.8), 1, 0.45, 0.1, rand(1.2, 2.4));
    const n = big ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const d = instance(pick(DEBRIS));
      if (d) this.fling(d.obj, x + rand(-0.8, 0.8), rand(0.6, 1.4), z + rand(-1, 1), rand(-7, 7), rand(6, 13), rand(-4, 8));
    }
  }

  private crash(o: Ob) {
    this.phase = "over";
    this.crashT = 0;
    this.shake = 0.7;
    this.audio.crash();
    this.explode((o.x + this.x) / 2, Math.min(o.z + o.hl, CAR_FRONT + 0.5), true);
    const side = Math.sign(this.x - o.x) || (Math.random() < 0.5 ? -1 : 1);
    this.crashVel.set(side * rand(2.5, 4.5), rand(7, 9), 0);
    this.crashSpin.set(rand(-3, -1.5), rand(-2, 2), side * rand(3, 6));
    this.jumpV = 0;
  }

  private knockCones(o: Ob) {
    this.speed *= 0.72;
    this.brake = 0.6;
    this.shake = Math.max(this.shake, 0.3);
    this.audio.land();
    const kids = [...o.obj.children];
    for (const c of kids) {
      const wp = c.getWorldPosition(new THREE.Vector3());
      o.obj.remove(c);
      this.fling(c, wp.x, wp.y + 0.2, wp.z, rand(-5, 5) + (wp.x - this.x) * 2, rand(5, 10), -rand(4, 12));
    }
    for (let i = 0; i < 20; i++) this.spark(o.x + rand(-1, 1), 0.3, o.z, rand(-4, 4), rand(1, 4), rand(-4, 2), rand(0.2, 0.5));
  }

  // ---------------------------------------------------------------- autopilot (promo recording only)

  /** seconds until the car would touch the nearest danger in a lane, and whether a hop clears it */
  private threat(lane: number) {
    let t = Infinity, hop = true, ramp = Infinity;
    const lx = lane * LANE;
    const S = Math.max(this.speed, 1);
    for (const o of this.obstacles) {
      const ox = o.target !== undefined && o.blink !== undefined ? o.target * LANE : o.x;
      const inLane = Math.abs(o.x - lx) < CAR_HW + o.hw + 0.25 || Math.abs(ox - lx) < CAR_HW + o.hw + 0.25;
      if (o.spent || !inLane || o.z - o.hl > CAR_BACK + 0.5) continue;
      const rel = S - o.v;
      if (rel <= 0) continue;
      const gap = Math.max(0, CAR_FRONT - (o.z + o.hl));
      const tt = gap / rel;
      if (o.kind === "ramp") { ramp = Math.min(ramp, tt); continue; }
      if (tt < t) { t = tt; hop = o.top < 1.2; }
    }
    return { t, hop, ramp };
  }

  private autopilot(dt: number) {
    if ((window as unknown as { __raceAuto?: boolean }).__raceAuto === false) return;
    this.autoT -= dt;
    if (this.jumpY > 0.4) return;
    const cur = this.threat(this.lane);
    const opts = [this.lane - 1, this.lane + 1].filter((l) => l >= -1 && l <= 1).map((l) => ({ l, t: this.threat(l) }));
    opts.sort((a, b) => b.t.t - a.t.t);
    if (this.autoT <= 0) {
      // go for a ramp in the next lane when that lane is safe
      const rampLane = opts.find((o) => o.t.ramp < 2.2 && o.t.t > o.t.ramp + 1.4 && cur.ramp === Infinity);
      if (rampLane && cur.t > 0.9) { this.steer(rampLane.l > this.lane ? 1 : -1); this.autoT = 0.5; return; }
      if (cur.t < 1.05 && !(cur.hop && cur.t < 0.5)) {
        const best = opts[0];
        if (best && best.t.t > cur.t + 0.3 && best.t.t > 0.45) { this.steer(best.l > this.lane ? 1 : -1); this.autoT = 0.18; return; }
      }
    }
    if (cur.hop && cur.t < 0.2) this.jump();
  }

  // ---------------------------------------------------------------- frame

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private seedLine(s: { x: number; y: number; z: number; k: number }, anywhere = false) {
    // streaks low along both sides of the car, never up in the sky
    s.x = (Math.random() < 0.5 ? -1 : 1) * rand(2.2, 7.5);
    s.y = rand(0.15, 2.4);
    s.z = anywhere ? rand(-70, 8) : rand(-75, -55);
    s.k = rand(0.3, 0.8);
  }

  private update(dt: number) {
    const t = this.time;
    const playing = this.phase === "playing";
    const target = playing ? speedAt(this.distance) : this.phase === "ready" ? 8 : 0;
    const rate = this.phase === "over" ? 2.2 : playing && this.speed < target ? 1.4 : 3;
    this.speed += (target - this.speed) * Math.min(1, rate * dt);
    const S = this.speed;
    const dz = S * dt;
    if (playing) this.distance += dz;
    this.offset += dz;
    const sp = S / TOP_SPEED;
    this.applyTod(this.todAt());
    const night = this.tod.night;
    this.sky.uniforms.uTime.value = t;
    this.water.uniforms.uOffset.value = this.offset;
    this.water.uniforms.uTime.value = t;
    this.bridge.update(this.offset, night);

    // steering: critically damped spring toward the lane centre
    const prevX = this.x;
    const k = 120, c = 2 * Math.sqrt(k);
    this.vx += ((this.lane * LANE - this.x) * k - this.vx * c) * dt;
    this.x += this.vx * dt;
    const car = this.car;

    if (this.phase === "over") {
      this.crashT += dt;
      this.crashVel.y -= GRAVITY * 0.8 * dt;
      car.position.x += this.crashVel.x * dt;
      car.position.y += this.crashVel.y * dt;
      car.rotation.x += this.crashSpin.x * dt;
      car.rotation.y += this.crashSpin.y * dt;
      car.rotation.z += this.crashSpin.z * dt;
      if (car.position.y < 0) {
        car.position.y = 0;
        this.crashVel.y *= -0.35;
        this.crashVel.x *= 0.6;
        this.crashSpin.multiplyScalar(0.55);
        if (Math.abs(this.crashVel.y) > 1.5) { this.shake = Math.max(this.shake, 0.25); for (let i = 0; i < 20; i++) this.spark(car.position.x, 0.2, 0, rand(-4, 4), rand(1, 4), rand(-1, 5), rand(0.2, 0.5)); }
      }
      car.position.x = Math.max(-ROAD_HALF + 1, Math.min(ROAD_HALF - 1, car.position.x));
      // burning wreck
      if (Math.random() < 0.6) this.puff(car.position.x + rand(-0.6, 0.6), car.position.y + 1, rand(-1, 1), rand(-0.4, 0.4), rand(1.5, 3), rand(0, 1), rand(1.4, 2.4), 0.12, 0.11, 0.12, 0.5, rand(1, 1.6), 2.4);
      if (!this.crashSent && this.crashT > 1.1) {
        this.crashSent = true;
        this.hooks.onPhase("over", this.score());
      }
    } else {
      if (this.jumpY > 0 || this.jumpV > 0) {
        this.jumpV -= GRAVITY * dt;
        this.jumpY += this.jumpV * dt;
        if (this.jumpY <= 0) {
          const hard = this.jumpV < -12;
          this.jumpY = 0;
          this.jumpV = 0;
          this.shake = hard ? 0.4 : 0.22;
          this.audio.land();
          for (let i = 0; i < (hard ? 30 : 14); i++) this.puff(this.x + rand(-1.2, 1.2), 0.15, rand(-1.5, 2.5), rand(-3, 3), rand(0.3, 1.5), rand(0, 3), rand(0.5, 1), 0.72, 0.7, 0.68, 0.4);
          if (hard) for (let i = 0; i < 30; i++) this.spark(this.x + rand(-1, 1), 0.1, rand(-1, 2), rand(-5, 5), rand(1, 4), rand(0, 6), rand(0.2, 0.5));
        }
      }
      car.position.set(this.x, this.jumpY + Math.sin(t * 31) * 0.008 * sp, 0);
      const airborne = this.jumpY > 0.05;
      car.rotation.x = airborne ? -0.05 + this.jumpV * 0.012 : -0.012 * sp;
      car.rotation.z = -this.vx * 0.022;
      car.rotation.y = -this.vx * 0.035;
    }
    const air = this.jumpY > 0.25;
    this.audio.update(S, TOP_SPEED, this.phase !== "over", air, dt);
    this.brake = Math.max(0, this.brake - dt);

    // wheels + skid marks + tyre smoke while swerving
    if (this.carModel) for (const w of this.carModel.wheels) w.rotation.x -= (S / 0.48) * dt;
    const swerving = Math.abs(this.vx) > 3 && this.jumpY < 0.05 && this.phase === "playing";
    if (swerving) {
      const yaw = Math.atan2(this.vx, S);
      for (const s of [-0.75, 0.75]) {
        if (this.skids.length >= MAX_SKIDS) this.skids.shift();
        this.skids.push({ x: this.x + s, z: CAR_BACK - 0.6, yaw, life: 1 });
        if (Math.random() < 0.5) this.puff(this.x + s, 0.25, CAR_BACK - 0.4, -this.vx * 0.15 + rand(-0.5, 0.5), rand(0.3, 1), rand(1, 3), rand(0.5, 0.9), 0.85, 0.85, 0.88, 0.28, 0.8, 2.6);
      }
    }
    for (const s of this.skids) { s.z += dz; s.life -= dt * 0.35; }
    this.skids = this.skids.filter((s) => s.life > 0 && s.z < KILL_Z);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
    const skidLen = dz * 1.8 + 0.35;
    this.skids.forEach((s, i) => {
      q.setFromEuler(e3.set(0, -s.yaw, 0));
      this.skidMesh.setMatrixAt(i, m4.compose(pv.set(s.x, 0.02, s.z), q, sc.set(s.life, 1, skidLen)));
    });
    this.skidMesh.count = this.skids.length;
    this.skidMesh.instanceMatrix.needsUpdate = true;

    // ---------------------------------------------------------------- spawning
    if (playing) {
      this.nextCar -= Math.max(0, S - TRAFFIC_V) * dt;
      if (this.nextCar <= 0) { this.spawnCars(); this.nextCar = Math.max(16, 36 - this.distance * 0.003) * rand(0.85, 1.25); }
      this.nextHaz -= dz;
      if (this.nextHaz <= 0) { this.spawnHazards(); this.nextHaz = Math.max(S * 0.75, 62 - this.distance * 0.004) * rand(0.85, 1.3); }
      this.nextRamp -= dz;
      if (this.nextRamp <= 0) { this.spawnRamp(); this.nextRamp = this.demo ? rand(180, 300) : rand(300, 520); }
      this.wrongWay(dt);
      if (this.demo) this.autopilot(dt);
    }

    // ---------------------------------------------------------------- obstacles
    for (const o of this.obstacles) {
      o.z += dz - o.v * dt;
      if (o.changer && o.blink === undefined && o.z > -80 && o.z < -25) {
        const opts = [o.lane - 1, o.lane + 1].filter((l) => l >= -1 && l <= 1);
        o.target = pick(opts);
        o.blink = 1.1;
      }
      if (o.blink !== undefined && o.blink > 0) {
        o.blink -= dt;
        if (o.blink <= 0 && o.target !== undefined) {
          const near = this.lanesNear(o.z, 16, o);
          const blocked = this.obstacles.some((p) => p !== o && p.kind !== "ramp" && laneOf(p.x) === o.target && Math.abs(p.z - o.z) < 14 + p.hl);
          near.add(o.target);
          if (blocked || near.size > 2) { o.target = undefined; o.changer = false; }
          else { o.fromX = o.x; o.moveT = 0; }
        }
      }
      if (o.moveT !== undefined && o.target !== undefined && o.fromX !== undefined) {
        o.moveT = Math.min(1, o.moveT + dt / 0.9);
        const u = o.moveT * o.moveT * (3 - 2 * o.moveT);
        const nx = o.fromX + (o.target * LANE - o.fromX) * u;
        o.obj.rotation.y = -(nx - o.x) / Math.max(dt, 1e-3) * 0.02;
        o.x = nx;
        if (o.moveT >= 1) { o.lane = o.target; o.target = undefined; o.moveT = undefined; o.changer = false; o.obj.rotation.y = 0; }
      }
      o.obj.position.x = o.x;
      o.obj.position.z = o.z;
      if (o.kind === "car" || o.kind === "wrong") for (const w of o.wheels) w.rotation.x -= (Math.abs(o.v) / 0.48) * dt * Math.sign(o.v || 1);
      if (o.warn) {
        o.warn.position.x = o.x;
        const m = o.warn.material as THREE.MeshBasicMaterial;
        m.map!.offset.y = (m.map!.offset.y - dt * 2.2) % 1;
        m.opacity = (0.45 + 0.4 * Math.abs(Math.sin(t * 9))) * Math.min(1, Math.max(0, (-o.z - 8) / 30));
      }

      // near miss: a car slipping past close by
      if (!o.passed && (o.kind === "car" || o.kind === "wrong") && o.z - o.hl > CAR_BACK && this.phase === "playing") {
        o.passed = true;
        const gap = Math.abs(o.x - this.x) - o.hw - CAR_HW;
        // also a last-moment dodge: it went through the lane you left under 0.8 s ago
        const dodged = this.swerve && laneOf(o.x) === this.swerve.from && laneOf(o.x) !== this.lane && this.time - this.swerve.t < 0.8;
        if ((gap < 1.0 || dodged) && this.jumpY < o.top) {
          this.streak++;
          this.audio.pass();
          this.hooks.onNearMiss?.(this.streak);
        }
      }

      if (this.phase !== "playing" || o.spent || (o.kind === "ramp" && this.jumpY > 0.3)) continue;
      const hitX = Math.abs(o.x - this.x) < CAR_HW + o.hw;
      const hitZ = o.z - o.hl < CAR_BACK && o.z + o.hl > CAR_FRONT;
      if (!hitX || !hitZ) continue;
      if (o.kind === "ramp") {
        this.jumpV = RAMP_V;
        this.jumpY = Math.max(this.jumpY, 0.1);
        this.audio.ramp();
        for (let i = 0; i < 30; i++) this.spark(this.x + rand(-1, 1), 0.3, CAR_BACK, rand(-3, 3), rand(1, 4), rand(2, 8), rand(0.2, 0.5));
        o.spent = true;
        continue;
      }
      if (this.jumpY >= o.top - 0.05) continue;
      if (o.kind === "cone") { this.knockCones(o); o.spent = true; continue; }
      this.crash(o);
    }
    // wrong-way trucks plough through anything in their lane
    for (const w of this.obstacles) {
      if (w.kind !== "wrong" || w.z > 0) continue;
      for (const o of this.obstacles) {
        if (o === w || o.spent || o.kind === "wrong" || o.kind === "ramp") continue;
        if (Math.abs(o.x - w.x) < o.hw + w.hw && Math.abs(o.z - w.z) < o.hl + w.hl) {
          this.explode((o.x + w.x) / 2, (o.z + w.z) / 2, o.kind === "car");
          if (o.kind === "car") this.audio.crash();
          o.z = KILL_Z + 100;
          w.z = KILL_Z + 100;
        }
      }
    }
    this.obstacles = this.obstacles.filter((o) => {
      if (o.z - o.hl < KILL_Z) return true;
      this.removeOb(o);
      return false;
    });

    // flying cones / debris
    for (const f of this.flyers) {
      f.life -= dt;
      f.vy -= GRAVITY * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt + dz;
      if (f.y < 0) { f.y = 0; f.vy *= -0.35; f.vx *= 0.7; f.vz *= 0.7; f.wx *= 0.6; f.wz *= 0.6; }
      f.obj.position.set(f.x, f.y, f.z);
      f.obj.rotation.x += f.wx * dt; f.obj.rotation.y += f.wy * dt; f.obj.rotation.z += f.wz * dt;
    }
    this.flyers = this.flyers.filter((f) => {
      if (f.life > 0 && f.z < KILL_Z) return true;
      this.scene.remove(f.obj);
      return false;
    });

    // islands
    this.nextIsland -= dz;
    if (this.nextIsland <= 0 && this.islands.length) { this.spawnIsland(-330); this.nextIsland = rand(40, 75); }
    this.islands = this.islands.filter((isl) => {
      isl.position.z += dz;
      if (isl.position.z < KILL_Z + 40) return true;
      this.scene.remove(isl);
      return false;
    });

    // ---------------------------------------------------------------- lights
    const G = this.glows;
    G.begin();
    const lampA = night;
    if (lampA > 0.01) {
      this.bridge.lights(this.offset, (x, y, z) => {
        G.add(x, y, z, 1, 0.82, 0.55, lampA, 1.4);
        G.add(x, y - 0.2, z, 1, 0.7, 0.4, lampA * 0.25, 6);
      });
      // necklace lights along the main cables
      for (const g of this.bridge.spans) {
        const z0 = g.position.z;
        for (let s = 4; s < SPAN; s += 7) {
          const z = z0 - s;
          if (z > KILL_Z || z < -330) continue;
          for (const side of [-1, 1]) G.add(side * TOWER_X, cableY(s) + 0.9, z, 1, 0.92, 0.75, lampA * 0.85, 0.7);
        }
      }
    }
    // tower beacons blink all day
    const beacon = 0.5 + 0.5 * Math.sin(t * 3);
    for (const g of this.bridge.spans) for (const side of [-1, 1]) G.add(side * TOWER_X, TOWER_TOP + 2.2, g.position.z, 1, 0.12, 0.08, beacon * (0.5 + night), 2.2);

    const dayA = 0.45 + 0.75 * night;
    for (const o of this.obstacles) {
      if (o.kind !== "car" && o.kind !== "wrong") continue;
      const back = o.kind === "wrong" ? o.z - o.hl : o.z + o.hl;
      const front = o.kind === "wrong" ? o.z + o.hl : o.z - o.hl;
      const lx = o.hw - 0.3;
      if (o.kind === "car") {
        for (const s of [-1, 1]) {
          G.add(o.x + s * lx, 0.8, back + 0.05, 1, 0.08, 0.06, dayA, 0.55);
          if (night > 0.1) G.add(o.x + s * lx, 0.8, back + 0.3, 1, 0.05, 0.04, night * 0.35, 2.4);
        }
        if (o.blink !== undefined && (o.blink > 0 || o.moveT !== undefined) && o.target !== undefined && Math.sin(t * 18) > 0) {
          const s = Math.sign(o.target * LANE - (o.fromX ?? o.x)) || 1;
          G.add(o.x + s * (o.hw + 0.05), 0.85, back, 1, 0.65, 0.08, 1.2, 0.9);
          G.add(o.x + s * (o.hw + 0.05), 0.85, front, 1, 0.65, 0.08, 1.0, 0.7);
        }
      } else {
        // head-on: blazing headlights, flashing high beams
        const flash = Math.sin(t * 22) > 0 ? 1 : 0.55;
        for (const s of [-1, 1]) {
          G.add(o.x + s * lx, 0.9, front + 0.1, 1, 0.97, 0.85, 1.4 * flash, 1.0);
          G.add(o.x + s * lx, 0.9, front + 0.4, 1, 0.9, 0.7, 0.4 * flash, 6);
        }
      }
      if (o.siren) {
        const ph = Math.sin(t * 14) > 0;
        G.add(o.x - 0.35, o.top + 0.1, o.z, ph ? 1 : 0.1, 0.1, ph ? 0.1 : 1, 1.2, 1.1);
        G.add(o.x + 0.35, o.top + 0.1, o.z, ph ? 0.1 : 1, 0.1, ph ? 1 : 0.1, 1.2, 1.1);
      }
    }
    // own car: tail / brake lights, exhaust flame at speed, headlights at night
    if (this.phase !== "over") {
      const cx = this.car.position.x, cy = this.car.position.y;
      const br = this.brake > 0 ? 1.6 : 0.6 + 0.6 * night;
      for (const s of [-0.62, 0.62]) G.add(cx + s, cy + 0.62, CAR_BACK - 0.05, 1, 0.08, 0.06, br, 0.5);
      if (sp > 0.55) {
        const f = (sp - 0.55) * 2.2 * (0.6 + 0.4 * Math.random());
        G.add(cx, cy + 0.42, CAR_BACK + 0.25, 0.35, 0.55, 1, f, 0.55 + 0.3 * Math.random());
        G.add(cx, cy + 0.42, CAR_BACK + 0.55, 0.6, 0.35, 1, f * 0.5, 0.35);
      }
      if (night > 0.05) for (const s of [-0.6, 0.6]) G.add(cx + s, cy + 0.55, CAR_FRONT + 0.1, 1, 0.97, 0.9, night * 1.2, 0.7);
    }
    (this.beam.material as THREE.MeshBasicMaterial).opacity = this.phase === "over" ? 0 : night * 0.5;

    for (const f of this.flashes) {
      f.life -= dt;
      f.z += dz;
      const a = Math.max(0, f.life) * 2.4;
      G.add(f.x, 1.2, f.z, 1, 0.75, 0.45, a, f.size * (1.3 - f.life));
      G.add(f.x, 1.0, f.z, 1, 0.95, 0.8, a * 1.5, f.size * 0.35);
    }
    this.flashes = this.flashes.filter((f) => f.life > 0);

    // ---------------------------------------------------------------- particles
    const Sm = this.smoke;
    Sm.begin();
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      if (!p.smoke) p.vy -= 9.8 * dt;
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vz *= dr; if (p.smoke) p.vy *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt + dz;
      if (!p.smoke && p.y < 0.02) { p.y = 0.02; p.vy *= -0.4; }
      const k2 = p.life / p.max;
      if (p.smoke) Sm.add(p.x, p.y, p.z, p.r, p.g, p.b, p.a * Math.min(1, k2 * 2), p.size * (1 + (1 - k2) * p.grow));
      else G.add(p.x, p.y, p.z, p.r, p.g, p.b, Math.min(1, k2 * 1.8), p.size);
    }
    G.end();
    Sm.end();

    // speed lines
    const la = Math.max(0, sp - 0.55) * (0.7 + 0.5 * night) * (this.phase === "over" ? 0 : 1);
    this.lineSeeds.forEach((s, i) => {
      s.z += dz * 1.4;
      if (s.z > 8) this.seedLine(s);
      const len = 1.5 + sp * 4;
      const b = la * s.k * Math.min(1, (s.z + 90) / 30);
      this.linePos.set([s.x + this.x * 0.5, s.y, s.z, s.x + this.x * 0.5, s.y, s.z - len], i * 6);
      this.lineCol.set([b, b, b, 0, 0, 0], i * 6);
    });
    (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.lines.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // ---------------------------------------------------------------- camera
    const cam = this.camera;
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * this.shake;
    const back = (this.portrait ? 11.5 : 8.4) - sp * 0.9;
    const up = (this.portrait ? 5.4 : 3.5) + this.jumpY * 0.35;
    if (this.phase === "over") {
      // pull back and up to watch the wreck tumble
      const k3 = Math.min(1, this.crashT / 1.2);
      const ease = k3 * (2 - k3);
      cam.position.set(this.car.position.x * 0.5 + rand(-1, 1) * sh, up + 3.5 * ease + rand(-1, 1) * sh, back + 6 * ease);
      cam.lookAt(this.car.position.x * 0.7, 0.8 + this.car.position.y * 0.5, -6 + 4 * ease);
    } else {
      cam.position.set(this.x * 0.6 + rand(-1, 1) * sh, up + rand(-1, 1) * sh, back);
      cam.lookAt(this.x * 0.82, 0.9 + this.jumpY * 0.4, -14);
      cam.rotateZ(-(this.x - prevX) / Math.max(dt, 1e-3) * 0.004);
    }
    const fov = (this.portrait ? 70 : 58) + sp * 16;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, 3 * dt); cam.updateProjectionMatrix(); this.pointScale(); }
    this.sky.mesh.position.copy(cam.position);
    this.mountains.group.position.set(cam.position.x, 0, cam.position.z);

    // the shadow camera rides with the car
    const L = this.tod.lightDir;
    this.sun.position.set(this.x + L.x * 70, L.y * 70, -8 + L.z * 70);
    this.sun.target.position.set(this.x, 0, -8);

    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.05;
      this.hooks.onDistance(this.score(), Math.round(S * 6));
    }
  }
}
