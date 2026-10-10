// Chicken Cross: a TypeScript port of Hunor Márton Borbély's "Crossy Road with three.js" CodePen
// (https://codepen.io/HunorMarton/pen/JwWLJo, MIT, see public/hop/License-crossy-road.txt): the same box models,
// camera and lane types (grass, forest, car and truck roads). Changed: dt-driven instead of per-frame, traffic gets
// faster and denser the further you go, an eagle takes the chicken if it falls too far behind the scrolling view,
// swipe / tap controls, sound, squash, feathers and shake. Score = furthest lane reached.
import * as THREE from "three";
import { HopAudio, recordingAudio, renderLog, type AudioLog } from "./audio";

export type Phase = "ready" | "playing" | "over";
type Hooks = {
  onPhase: (p: Phase, score: number) => void;
  onRequestStart: () => void;
  onScore: (score: number) => void;
  /** 0 = safe, 1 = the eagle is about to strike */
  onDanger: (d: number) => void;
};
type Dir = "forward" | "backward" | "left" | "right";
type LaneType = "field" | "grass" | "forest" | "car" | "truck";

const Z = 2;
const TILE = 42 * Z;
const COLS = 13;
const BOARD = COLS * TILE;
/** seconds per hop; also the server's score bound (web hop: 1 + floor(s / 0.2) lanes) */
export const STEP = 0.2;
const CHICK = 15 * Z;
const WRAP = BOARD / 2 + 260;
const MAX_QUEUE = 2;
const EAGLE_REACH = 1.2; // tiles behind the scroll line
const colX = (c: number) => (c + 0.5) * TILE - BOARD / 2;

// ---------------------------------------------------------------- shared models (built once)

function texture(w: number, h: number, rects: [number, number, number, number][]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(0,0,0,0.6)";
  rects.forEach(([x, y, rw, rh]) => g.fillRect(x, y, rw, rh));
  return new THREE.CanvasTexture(c);
}

type Kit = ReturnType<typeof buildKit>;
function buildKit() {
  const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x * Z, y * Z, z * Z);
  const phong = (color: number, map?: THREE.Texture) => new THREE.MeshPhongMaterial({ color, flatShading: true, map });
  const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const carFront = texture(40, 80, [[0, 10, 30, 60]]);
  const carBack = texture(40, 80, [[10, 10, 30, 60]]);
  const carRight = texture(110, 40, [[10, 0, 50, 30], [70, 0, 30, 30]]);
  const carLeft = texture(110, 40, [[10, 10, 50, 30], [70, 10, 30, 30]]);
  const truckFront = texture(30, 30, [[15, 0, 10, 30]]);
  const truckRight = texture(25, 30, [[0, 15, 10, 10]]);
  const truckLeft = texture(25, 30, [[0, 5, 10, 10]]);
  const colors = [0xa52523, 0xbdb638, 0x78b14b, 0x3f7fd8, 0xef8a2b];
  return {
    wheel: box(12, 33, 12), wheelMat: lambert(0x333333),
    carBody: box(60, 30, 15), carBodyMats: colors.map((c) => phong(c)),
    cabin: box(33, 24, 12), cabinMats: [phong(0xcccccc, carBack), phong(0xcccccc, carFront), phong(0xcccccc, carRight), phong(0xcccccc, carLeft), phong(0xcccccc), phong(0xcccccc)],
    truckBase: box(100, 25, 5), truckBaseMat: lambert(0xb4c6fc),
    cargo: box(75, 35, 40), cargoMat: phong(0xb4c6fc),
    truckCabin: box(25, 30, 30), truckCabinMats: colors.map((c) => [phong(c), phong(c, truckFront), phong(c, truckRight), phong(c, truckLeft), phong(c), phong(c)]),
    trunk: box(15, 15, 20), trunkMat: phong(0x4d2926),
    crowns: [20, 45, 60].map((h) => ({ h, geo: box(30, 30, h) })), crownMat: lambert(0x7aa21d),
    roadPlane: new THREE.PlaneGeometry(BOARD, TILE), roadMid: new THREE.MeshPhongMaterial({ color: 0x454a59 }), roadSide: new THREE.MeshPhongMaterial({ color: 0x393d49 }),
    stripe: new THREE.PlaneGeometry(TILE * 0.35, 2.5 * Z), stripeMat: new THREE.MeshBasicMaterial({ color: 0x5d6274 }),
    grassBox: box(COLS * 42, 42, 3), grassMid: new THREE.MeshPhongMaterial({ color: 0xbaf455 }), grassAlt: new THREE.MeshPhongMaterial({ color: 0xaee84a }), grassSide: new THREE.MeshPhongMaterial({ color: 0x99c846 }),
    feather: box(4, 4, 1.5), featherMat: new THREE.MeshLambertMaterial({ color: 0xffffff }),
  };
}

function car(k: Kit) {
  const g = new THREE.Group();
  const main = new THREE.Mesh(k.carBody, k.carBodyMats[Math.floor(Math.random() * k.carBodyMats.length)]);
  main.position.z = 12 * Z;
  main.castShadow = main.receiveShadow = true;
  const cabin = new THREE.Mesh(k.cabin, k.cabinMats);
  cabin.position.set(6 * Z, 0, 25.5 * Z);
  cabin.castShadow = cabin.receiveShadow = true;
  g.add(main, cabin);
  for (const x of [-18, 18]) {
    const w = new THREE.Mesh(k.wheel, k.wheelMat);
    w.position.set(x * Z, 0, 6 * Z);
    g.add(w);
  }
  return g;
}

function truck(k: Kit) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(k.truckBase, k.truckBaseMat);
  base.position.z = 10 * Z;
  const cargo = new THREE.Mesh(k.cargo, k.cargoMat);
  cargo.position.set(15 * Z, 0, 30 * Z);
  cargo.castShadow = cargo.receiveShadow = true;
  const cabin = new THREE.Mesh(k.truckCabin, k.truckCabinMats[Math.floor(Math.random() * k.truckCabinMats.length)]);
  cabin.position.set(-40 * Z, 0, 20 * Z);
  cabin.castShadow = cabin.receiveShadow = true;
  g.add(base, cargo, cabin);
  for (const x of [-38, -10, 30]) {
    const w = new THREE.Mesh(k.wheel, k.wheelMat);
    w.position.set(x * Z, 0, 6 * Z);
    g.add(w);
  }
  return g;
}

function tree(k: Kit) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(k.trunk, k.trunkMat);
  trunk.position.z = 10 * Z;
  trunk.castShadow = trunk.receiveShadow = true;
  const c = k.crowns[Math.floor(Math.random() * k.crowns.length)];
  const crown = new THREE.Mesh(c.geo, k.crownMat);
  crown.position.z = (c.h / 2 + 20) * Z;
  crown.castShadow = true;
  g.add(trunk, crown);
  return g;
}

function chicken() {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, shadow = true) => {
    const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, flatShading: true }));
    m.position.set(x * Z, y * Z, z * Z);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    g.add(m);
    return m;
  };
  const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x * Z, y * Z, z * Z);
  add(box(CHICK / Z, CHICK / Z, 20), 0xffffff, 0, 0, 10);
  add(box(2, 4, 2), 0xf0619a, 0, 0, 21, false);
  add(box(4, 3, 2.5), 0xffa52b, 0, 8.5, 13, false); // beak
  add(box(2.2, 1, 2.2), 0xf0619a, 0, 8.2, 10, false); // wattle
  add(box(1.6, 1.6, 2.4), 0x111111, -7.6, 3, 15, false);
  add(box(1.6, 1.6, 2.4), 0x111111, 7.6, 3, 15, false);
  add(box(5, 8, 2), 0xf3f3f3, -8.5, -1, 9, false); // wings
  add(box(5, 8, 2), 0xf3f3f3, 8.5, -1, 9, false);
  return g;
}

function eagle() {
  const g = new THREE.Group();
  const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x * Z, y * Z, z * Z);
  const add = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, flatShading: true }));
    m.position.set(x * Z, y * Z, z * Z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(box(16, 30, 12), 0x6b4423, 0, 0, 0);
  add(box(13, 12, 11), 0xffffff, 0, -19, 2);
  add(box(5, 6, 4), 0xffc21a, 0, -27, 0);
  add(box(14, 10, 3), 0x5a381c, 0, 20, 0); // tail
  const wings = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.x = s * 8 * Z;
    const w = new THREE.Mesh(box(36, 18, 3), new THREE.MeshPhongMaterial({ color: 0x5a381c, flatShading: true }));
    w.position.x = s * 18 * Z;
    w.castShadow = true;
    pivot.add(w);
    g.add(pivot);
    return { pivot, s };
  });
  g.userData.flap = (t: number) => wings.forEach(({ pivot, s }) => { pivot.rotation.y = s * Math.sin(t * 18) * 0.6; });
  g.visible = false;
  return g;
}

// ---------------------------------------------------------------- lanes

type Vehicle = { mesh: THREE.Group; len: number };
type Lane = { index: number; type: LaneType; mesh: THREE.Group; trees: Set<number>; vehicles: Vehicle[]; dir: 1 | -1; speed: number };

/** how hard the road is at a lane: 0 at the start, 1 from lane 200 on */
const hardness = (i: number) => Math.min(1, Math.max(0, i) / 200);

function pickType(index: number, prev: LaneType | undefined): LaneType {
  if (index <= 0) return "field";
  if (index <= 3) return index === 3 ? "car" : "grass";
  const h = hardness(index);
  const w: [LaneType, number][] = [["car", 0.36 + 0.06 * h], ["truck", 0.24 + 0.06 * h], ["forest", prev === "forest" ? 0 : 0.24 - 0.06 * h], ["grass", 0.16 - 0.06 * h]];
  let r = Math.random() * w.reduce((s, [, x]) => s + x, 0);
  for (const [t, x] of w) if ((r -= x) <= 0) return t;
  return "car";
}

function makeLane(k: Kit, index: number, prev: LaneType | undefined): Lane {
  const type = pickType(index, prev);
  const mesh = new THREE.Group();
  mesh.position.y = index * TILE;
  const lane: Lane = { index, type, mesh, trees: new Set(), vehicles: [], dir: Math.random() < 0.5 ? 1 : -1, speed: 0 };
  if (type === "car" || type === "truck") {
    for (const [mat, x] of [[k.roadMid, 0], [k.roadSide, -BOARD], [k.roadSide, BOARD]] as const) {
      const p = new THREE.Mesh(k.roadPlane, mat);
      p.position.x = x;
      p.receiveShadow = mat === k.roadMid;
      mesh.add(p);
    }
    if (prev === "car" || prev === "truck") {
      for (let c = 0; c < COLS; c += 2) {
        const s = new THREE.Mesh(k.stripe, k.stripeMat);
        s.position.set(colX(c), -TILE / 2, 0.5);
        mesh.add(s);
      }
    }
    const h = hardness(index);
    const n = type === "car" ? (h > 0.25 ? 4 : 3) : (h > 0.4 ? 3 : 2);
    const len = (type === "car" ? 60 : 105) * Z;
    const span = 2 * WRAP / n;
    const shift = Math.random() * span;
    for (let i = 0; i < n; i++) {
      const v = type === "car" ? car(k) : truck(k);
      // even slots with jitter, so there is always a gap of a few tiles to hop through
      v.position.x = -WRAP + ((i * span + shift + Math.random() * (span - len - 2.2 * TILE)) % (2 * WRAP));
      if (lane.dir > 0) v.rotation.z = Math.PI;
      mesh.add(v);
      lane.vehicles.push({ mesh: v, len });
    }
    const base = [125, 156, 187][Math.floor(Math.random() * 3)];
    lane.speed = base * (1 + 0.9 * h);
  } else {
    const ground = new THREE.Mesh(k.grassBox, index % 2 ? k.grassAlt : k.grassMid);
    ground.receiveShadow = true;
    ground.position.z = 1.5 * Z;
    const l = new THREE.Mesh(k.grassBox, k.grassSide);
    l.position.set(-BOARD, 0, 1.5 * Z);
    const r = new THREE.Mesh(k.grassBox, k.grassSide);
    r.position.set(BOARD, 0, 1.5 * Z);
    mesh.add(ground, l, r);
    const trees = type === "forest" ? 3 + Math.floor(Math.random() * 3) : index < 0 ? 6 : 0;
    while (lane.trees.size < trees) {
      const c = Math.floor(Math.random() * COLS);
      // the start column stays open on the first lanes
      if (index <= 4 && index >= -1 && c === Math.floor(COLS / 2)) continue;
      lane.trees.add(c);
    }
    for (const c of lane.trees) {
      const t = tree(k);
      t.position.x = colX(c);
      mesh.add(t);
    }
    // trees on the dark side strips frame the board
    for (const x of [-BOARD / 2 - TILE * 0.6, BOARD / 2 + TILE * 0.6]) {
      if (Math.random() < 0.55) continue;
      const t = tree(k);
      t.position.x = x + (Math.random() - 0.5) * TILE;
      mesh.add(t);
    }
  }
  return lane;
}

// ---------------------------------------------------------------- engine

type Feather = { m: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; life: number };

export class HopEngine {
  readonly audio: HopAudio;
  zh = true;
  phase: Phase = "ready";
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private camBase = new THREE.Vector3();
  private camAt = new THREE.Vector2();
  private dirLight = new THREE.DirectionalLight(0xffffff, 1.9);
  private kit: Kit;
  private lanes = new Map<number, Lane>();
  private chick = chicken();
  private bird = eagle();
  private birdFrom = new THREE.Vector3();
  private birdTo = new THREE.Vector3();
  private lane = 0;
  private col = Math.floor(COLS / 2);
  private moves: Dir[] = [];
  private stepT = 0;
  private best = 0;
  private streak = 0;
  private scroll = 0;
  private scrolling = false;
  private dying = 0;
  private death: "car" | "eagle" | null = null;
  private deathDir = 1;
  private feathers: Feather[] = [];
  private shake = 0;
  private land = 0;
  private facing = 0;
  private raf = 0;
  private last = 0;
  private lastDanger = 0;
  /** game seconds (the capture's audio log runs on it) */
  private t = 0;
  private audioLog: AudioLog = [];
  private down: { x: number; y: number } | null = null;
  private params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  private local = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // local only: ?demo=1 plays itself; ?capture=1 also stops the clock so a script steps fixed 1/60 s frames
  // (window.__hop.step) and gets the run's sound rendered offline (__hop.audio) for promo videos
  private capture = this.local && this.params.get("capture") === "1";
  private demo = this.local && (this.params.get("demo") === "1" || this.capture);
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    const sound = new HopAudio();
    this.audio = this.capture ? recordingAudio(sound, this.audioLog, () => this.t) : sound;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: this.capture });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x2f6b3a);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";
    this.kit = buildKit();

    this.camera.rotation.set((50 * Math.PI) / 180, (20 * Math.PI) / 180, (10 * Math.PI) / 180);
    // the original sits 500 away; with the wider phone view the nearest lanes would cross the near plane
    const dist = 1600;
    this.camBase.y = -Math.tan(this.camera.rotation.x) * dist;
    this.camBase.x = Math.tan(this.camera.rotation.y) * Math.sqrt(dist ** 2 + this.camBase.y ** 2);
    this.camBase.z = dist;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 1.9));
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    const d = 560;
    Object.assign(this.dirLight.shadow.camera, { left: -d, right: d, top: d, bottom: -d, far: 1500 });
    this.scene.add(this.dirLight, this.dirLight.target);
    this.scene.add(this.chick, this.bird);

    this.reset();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    host.addEventListener("pointerdown", this.onDown);
    host.addEventListener("pointerup", this.onUp);
    window.addEventListener("keydown", this.onKey);
    if (!this.capture) this.raf = requestAnimationFrame(this.frame);
    if (this.local) {
      const info = () => ({ phase: this.phase, score: this.best, lane: this.lane, col: this.col, scroll: this.scroll / TILE, death: this.death });
      (window as unknown as { __hop: unknown }).__hop = this.capture
        ? {
            info,
            start: () => this.hooks.onRequestStart(),
            time: () => this.t,
            step: (n = 1) => {
              for (let i = 0; i < n; i++) { this.t += 1 / 60; this.update(1 / 60); }
              this.renderer.render(this.scene, this.camera);
            },
            audio: async (t0: number, secs: number) => {
              const wav = await renderLog(this.audioLog, t0, secs);
              let s = "";
              for (let i = 0; i < wav.length; i += 0x8000) s += String.fromCharCode(...wav.subarray(i, i + 0x8000));
              return btoa(s);
            },
          }
        : { info };
    }
  }

  start() {
    this.audio.unlock();
    this.reset();
    this.phase = "playing";
    this.audio.start();
    this.hooks.onPhase("playing", 0);
    this.hooks.onScore(0);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.host.removeEventListener("pointerdown", this.onDown);
    this.host.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKey);
    this.audio.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private reset() {
    for (const l of this.lanes.values()) this.scene.remove(l.mesh);
    this.lanes.clear();
    for (let i = -9; i <= 18; i++) this.addLane(i);
    this.lane = 0;
    this.col = Math.floor(COLS / 2);
    this.moves = [];
    this.stepT = 0;
    this.best = 0;
    this.streak = 0;
    this.scroll = 0;
    this.scrolling = false;
    this.dying = 0;
    this.death = null;
    this.facing = 0;
    for (const f of this.feathers) this.scene.remove(f.m);
    this.feathers = [];
    this.chick.position.set(colX(this.col), 0, 0);
    this.chick.scale.set(1, 1, 1);
    this.chick.rotation.set(0, 0, 0);
    this.bird.visible = false;
    this.camAt.set(this.chick.position.x, 0);
    this.danger(0);
  }

  private addLane(i: number) {
    const lane = makeLane(this.kit, i, this.lanes.get(i - 1)?.type);
    this.lanes.set(i, lane);
    this.scene.add(lane.mesh);
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    // narrow phones see about 8 columns; wide screens a bit more of the world at the original 1:1
    const s = Math.max(1, (TILE * 8.2) / w, (TILE * 11) / h);
    Object.assign(this.camera, { left: (-w * s) / 2, right: (w * s) / 2, top: (h * s) / 2, bottom: (-h * s) / 2 });
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- input

  private onKey = (e: KeyboardEvent) => {
    const map: Record<string, Dir> = { ArrowUp: "forward", w: "forward", W: "forward", " ": "forward", ArrowDown: "backward", s: "backward", S: "backward", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" };
    if (this.phase !== "playing") {
      if (e.key === "Enter" || e.key === " ") { this.hooks.onRequestStart(); e.preventDefault(); }
      return;
    }
    const dir = map[e.key];
    if (!dir) return;
    e.preventDefault();
    this.move(dir);
  };
  private onDown = (e: PointerEvent) => { this.audio.unlock(); this.down = { x: e.clientX, y: e.clientY }; };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || this.phase !== "playing") return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) < 24) return this.move("forward");
    this.move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy < 0 ? "forward" : "backward");
  };

  /** queue a hop if the target cell (after the queued hops) is free */
  move(dir: Dir) {
    if (this.phase !== "playing" || this.death || this.moves.length >= MAX_QUEUE) return;
    let lane = this.lane, col = this.col;
    for (const m of this.moves) [lane, col] = this.next(lane, col, m);
    const [nl, nc] = this.next(lane, col, dir);
    if (nc < 0 || nc >= COLS || nl < 0) return this.audio.bump();
    const target = this.lanes.get(nl);
    if (target?.trees.has(nc)) return this.audio.bump();
    this.moves.push(dir);
    if (this.moves.length === 1) this.stepT = 0;
    this.scrolling = true;
  }
  private next(lane: number, col: number, d: Dir): [number, number] {
    return d === "forward" ? [lane + 1, col] : d === "backward" ? [lane - 1, col] : d === "left" ? [lane, col - 1] : [lane, col + 1];
  }

  // ---------------------------------------------------------------- frame

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.t += dt;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number) {
    for (const lane of this.lanes.values()) {
      for (const v of lane.vehicles) {
        let x = v.mesh.position.x + lane.dir * lane.speed * dt;
        if (x > WRAP) x -= 2 * WRAP;
        else if (x < -WRAP) x += 2 * WRAP;
        v.mesh.position.x = x;
      }
    }
    const playing = this.phase === "playing";
    if (playing && this.demo && !this.death && this.moves.length === 0) this.autopilot();
    if (playing && !this.death) this.step(dt);
    if (playing && !this.death) this.checkHit();
    if (playing && !this.death && this.scrolling) {
      // the view keeps creeping forward; fall too far behind and the eagle comes
      const v = Math.min(0.95, 0.35 + this.best * 0.004) * TILE;
      this.scroll = Math.max(this.scroll + v * dt, this.chick.position.y - 2 * TILE);
      const behind = (this.scroll - this.chick.position.y) / TILE;
      this.danger(Math.max(0, Math.min(1, behind / EAGLE_REACH)));
      if (behind > EAGLE_REACH) this.kill("eagle");
    }
    if (this.death) this.dyingUpdate(dt);
    this.feathersUpdate(dt);
    this.cameraUpdate(dt);
  }

  /** tell the page only about visible changes (it re-renders on each call) */
  private danger(d: number) {
    const q = Math.round(d * 20) / 20;
    if (q === this.lastDanger) return;
    this.lastDanger = q;
    this.hooks.onDanger(q);
  }

  private step(dt: number) {
    if (this.land > 0) this.land = Math.max(0, this.land - dt * 6);
    const dir = this.moves[0];
    const sq = 1 - 0.18 * Math.sin(this.land * Math.PI);
    if (!dir) {
      this.chick.scale.set(1 / Math.sqrt(sq), 1 / Math.sqrt(sq), sq);
      return;
    }
    if (this.stepT === 0) this.audio.hop(this.streak);
    this.stepT += dt;
    const p = Math.min(1, this.stepT / STEP);
    const [nl, nc] = this.next(this.lane, this.col, dir);
    const x0 = colX(this.col), y0 = this.lane * TILE;
    this.chick.position.x = x0 + (colX(nc) - x0) * p;
    this.chick.position.y = y0 + (nl * TILE - y0) * p;
    this.chick.position.z = Math.sin(p * Math.PI) * 9 * Z;
    const face = { forward: 0, backward: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[dir];
    let diff = face - this.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.facing += diff * Math.min(1, dt * 22);
    this.chick.rotation.z = this.facing;
    const stretch = 1 + 0.15 * Math.sin(p * Math.PI);
    this.chick.scale.set(1 / Math.sqrt(stretch), 1 / Math.sqrt(stretch), stretch);
    if (p < 1) return;
    this.lane = nl;
    this.col = nc;
    this.moves.shift();
    this.stepT = 0;
    this.land = 1;
    this.chick.position.z = 0;
    if (dir === "forward" && this.lane > this.best) {
      this.best = this.lane;
      this.streak++;
      this.hooks.onScore(this.best);
      if (this.best % 25 === 0) this.audio.milestone();
      for (let i = this.best + 12; !this.lanes.has(i); i--) this.addLane(i);
      for (const [i, l] of this.lanes) if (i < this.best - 14) { this.scene.remove(l.mesh); this.lanes.delete(i); }
    } else if (dir !== "forward") this.streak = 0;
  }

  private checkHit() {
    const lane = this.lanes.get(Math.round(this.chick.position.y / TILE));
    if (!lane || !lane.vehicles.length || this.chick.position.z > 7 * Z) return;
    const cx = this.chick.position.x;
    for (const v of lane.vehicles) {
      if (Math.abs(cx - v.mesh.position.x) < CHICK / 2 + v.len / 2 - 3 * Z) {
        this.deathDir = lane.dir;
        this.kill("car");
        return;
      }
    }
  }

  private kill(how: "car" | "eagle") {
    this.death = how;
    this.dying = 0;
    this.moves = [];
    this.shake = how === "car" ? 1 : 0.4;
    this.danger(0);
    if (how === "car") {
      this.audio.splat();
      this.chick.position.z = 0;
      this.chick.scale.set(1.5, 1.5, 0.12);
      this.burstFeathers(16);
    } else {
      this.audio.eagle();
      this.chick.position.z = 0;
      // dives in from ahead of the view
      this.birdTo.set(this.chick.position.x, this.chick.position.y, 28 * Z);
      this.birdFrom.set(this.chick.position.x + 2 * TILE, this.chick.position.y + 6 * TILE, 520);
      this.bird.position.copy(this.birdFrom);
      this.bird.visible = true;
    }
  }

  private dyingUpdate(dt: number) {
    this.dying += dt;
    if (this.death === "car") this.chick.position.x += this.deathDir * 260 * Math.max(0, 0.15 - this.dying) * dt * 6;
    else {
      // the eagle dives onto the chicken (0.35 s), then carries it up and away
      const b = this.bird;
      (b.userData.flap as (t: number) => void)(this.dying);
      const to = this.birdTo;
      // the model's head points to -y; turn it along its flight
      const head = (dx: number, dy: number) => Math.atan2(dx, -dy);
      if (this.dying < 0.35) {
        const p = this.dying / 0.35;
        b.position.lerpVectors(this.birdFrom, to, p * p * (3 - 2 * p));
        b.rotation.z = head(to.x - this.birdFrom.x, to.y - this.birdFrom.y);
        if (this.dying + dt >= 0.35) this.burstFeathers(10);
      } else {
        const a = this.dying - 0.35;
        b.position.set(to.x - 300 * a, to.y + 700 * a, to.z + 900 * a * a + 120 * a);
        b.rotation.z = head(-300, 700);
        this.chick.position.set(b.position.x, b.position.y, b.position.z - 26 * Z);
        this.chick.rotation.z += dt * 4;
      }
    }
    if (this.dying > (this.death === "eagle" ? 1.4 : 1.0) && this.phase === "playing") {
      this.phase = "over";
      this.hooks.onPhase("over", this.best);
    }
  }

  private burstFeathers(n: number) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.kit.feather, this.kit.featherMat);
      m.position.copy(this.chick.position).add(new THREE.Vector3(0, 0, 14 * Z));
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 220;
      this.feathers.push({ m, v: new THREE.Vector3(Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 260), spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9), life: 1.4 + Math.random() * 0.6 });
    }
  }

  private feathersUpdate(dt: number) {
    this.feathers = this.feathers.filter((f) => {
      f.life -= dt;
      f.v.z -= 520 * dt;
      f.v.multiplyScalar(1 - dt * 1.6);
      f.m.position.addScaledVector(f.v, dt);
      if (f.m.position.z < 2) { f.m.position.z = 2; f.v.set(0, 0, 0); }
      f.m.rotation.x += f.spin.x * dt;
      f.m.rotation.y += f.spin.y * dt;
      if (f.life > 0) return true;
      this.scene.remove(f.m);
      return false;
    });
  }

  private cameraUpdate(dt: number) {
    const k = 1 - Math.exp(-dt * 7);
    const eagle = this.death === "eagle";
    const ty = eagle ? this.camAt.y : Math.max(this.chick.position.y, this.scroll);
    if (!eagle) this.camAt.x += (this.chick.position.x * 0.7 - this.camAt.x) * k;
    this.camAt.y += (ty - this.camAt.y) * k;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 14 * Z;
    this.camera.position.set(this.camBase.x + this.camAt.x + (Math.random() - 0.5) * s, this.camBase.y + this.camAt.y + (Math.random() - 0.5) * s, this.camBase.z);
    this.dirLight.position.set(this.camAt.x - 100, this.camAt.y - 100, 200);
    this.dirLight.target.position.set(this.camAt.x, this.camAt.y, 0);
  }

  // ---------------------------------------------------------------- autopilot (local ?demo=1)

  private safeAt(laneIdx: number, col: number, t0: number, t1: number) {
    const lane = this.lanes.get(laneIdx);
    if (!lane) return true;
    if (lane.trees.has(col)) return false;
    const x = colX(col);
    for (const v of lane.vehicles) {
      for (let t = t0; t <= t1; t += 0.05) {
        let vx = v.mesh.position.x + lane.dir * lane.speed * t;
        vx = ((vx + WRAP) % (2 * WRAP) + 2 * WRAP) % (2 * WRAP) - WRAP;
        if (Math.abs(x - vx) < CHICK / 2 + v.len / 2 + TILE * 0.15) return false;
      }
    }
    return true;
  }
  private autopilot() {
    const here = this.safeAt(this.lane, this.col, 0, STEP * 1.5);
    if (this.safeAt(this.lane + 1, this.col, STEP * 0.4, STEP * 2.2)) return this.move("forward");
    for (const d of [-1, 1]) {
      const c = this.col + d;
      if (c >= 0 && c < COLS && this.safeAt(this.lane, c, 0, STEP * 2) && this.safeAt(this.lane + 1, c, STEP * 1.2, STEP * 3.2)) return this.move(d < 0 ? "left" : "right");
    }
    if (!here) {
      if (this.lane > 0 && this.safeAt(this.lane - 1, this.col, STEP * 0.4, STEP * 2)) return this.move("backward");
      for (const d of [-1, 1]) if (this.col + d >= 0 && this.col + d < COLS && this.safeAt(this.lane, this.col + d, 0, STEP * 2)) return this.move(d < 0 ? "left" : "right");
    }
  }
}
