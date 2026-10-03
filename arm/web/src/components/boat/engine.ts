import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { BoatAudio } from "./audio";
import { createSky, createWater, ROCK_N, SKY, TRAIL_N, waveHeight } from "./water";

// Three-lane speedboat runner. The boat stays at z = 0 and steers in x; obstacles, scenery and the water pattern
// flow toward the camera (+z) at the current speed. Distance in metres is the score.

export type Phase = "ready" | "playing" | "over";
// distances reported to the UI are game metres: world units x METRE, so a whole run lands in the hundreds, not thousands
export const METRE = 0.25;
type Hooks = { onPhase: (p: Phase, distance: number) => void; onDistance: (m: number, kmh: number) => void; onRequestStart: () => void };

const LANE = 3;
const SPAWN_Z = -230;
const KILL_Z = 30;
const BOAT_HALF_W = 0.6;
const BOAT_FRONT = -1.7;
const BOAT_BACK = 1.3;
const JUMP_V = 9.5;
const GRAVITY = 24;
const BUOY_TOP = 1.3;

const speedAt = (d: number) => 20 + 26 * (1 - Math.exp(-d / 1800));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function spriteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.75)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildBoat() {
  const boat = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.62, BOAT_BACK);
  shape.lineTo(0.62, BOAT_BACK);
  shape.lineTo(0.62, -0.3);
  shape.quadraticCurveTo(0.56, -1.25, 0, BOAT_FRONT);
  shape.quadraticCurveTo(-0.56, -1.25, -0.62, -0.3);
  shape.closePath();
  const hullGeo = (depth: number) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 10 });
    g.rotateX(Math.PI / 2);
    return g;
  };
  const white = new THREE.MeshStandardMaterial({ color: "#f7f7f2", roughness: 0.35, metalness: 0.05 });
  const red = new THREE.MeshStandardMaterial({ color: "#e23b3b", roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: "#1d2733", roughness: 0.5 });

  const hull = new THREE.Mesh(hullGeo(0.42), white);
  hull.position.y = 0.48;
  const stripe = new THREE.Mesh(hullGeo(0.14), red);
  stripe.scale.set(1.03, 1, 1.01);
  stripe.position.y = 0.12;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 1.5), new THREE.MeshStandardMaterial({ color: "#c79a62", roughness: 0.8 }));
  deck.position.set(0, 0.52, 0.45);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.98, 0.34, 0.06),
    new THREE.MeshStandardMaterial({ color: "#7fd3ff", roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55 }),
  );
  glass.position.set(0, 0.7, -0.25);
  glass.rotation.x = -0.45;
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.24), dark);
  motor.position.set(0, 0.42, BOAT_BACK + 0.14);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.42, 10), new THREE.MeshStandardMaterial({ color: "#ffb020", roughness: 0.6 }));
  body.position.set(0, 0.78, 0.2);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), new THREE.MeshStandardMaterial({ color: "#f1c7a0", roughness: 0.7 }));
  head.position.set(0, 1.08, 0.2);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), red);
  cap.position.set(0, 1.1, 0.2);
  boat.add(hull, stripe, deck, glass, motor, body, head, cap);
  return boat;
}

const BOAT_SKINS = "abcdefghij";

function boatModelUrl() {
  const q = new URLSearchParams(window.location.search).get("boat") ?? "";
  return `/boat/boat-speed-${q.length === 1 && BOAT_SKINS.includes(q) ? q : "c"}.glb`;
}

const rockGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const s = 0.8 + 0.35 * Math.abs(Math.sin(v.x * 3.1 + v.y * 2.3) * Math.cos(v.z * 2.7));
    p.setXYZ(i, v.x * s, v.y * s * 0.9, v.z * s);
  }
  g.computeVertexNormals();
  return g;
})();

function buildBuoy() {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: "#ff3b30", roughness: 0.4 });
  const white = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.4 });
  const a = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.5, 16), red);
  a.position.y = 0.1;
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 0.45, 16), white);
  b.position.y = 0.55;
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 16), red);
  c.position.y = 1.1;
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: "#fff6a0" }));
  light.position.y = 1.5;
  g.add(a, b, c, light);
  return g;
}

// Palm trees: Quaternius CC0 models (public/boat/palm-*.glb), normalised to 1 m tall with the base at y = 0.
// Islands built before they arrive fall back to the procedural palms below.
let palmProtos: THREE.Object3D[] = [];
let palmLoad: Promise<void> | null = null;
export function loadPalms() {
  if (palmLoad) return palmLoad;
  const loader = new GLTFLoader();
  palmLoad = Promise.all(
    ["a", "b", "c"].map(
      (k) =>
        new Promise<THREE.Object3D | null>((res) => {
          loader.load(
            `/boat/palm-${k}.glb`,
            (gltf) => {
              const m = gltf.scene;
              const box = new THREE.Box3().setFromObject(m);
              const size = box.getSize(new THREE.Vector3());
              const wrap = new THREE.Group();
              m.scale.setScalar(1 / Math.max(size.y, 1e-6));
              m.position.set(-(box.min.x + box.max.x) / 2 / size.y, -box.min.y / size.y, -(box.min.z + box.max.z) / 2 / size.y);
              wrap.add(m);
              res(wrap);
            },
            undefined,
            () => res(null),
          );
        }),
    ),
  ).then((list) => { palmProtos = list.filter((p): p is THREE.Object3D => !!p); });
  return palmLoad;
}

export function buildIsland() {
  const g = new THREE.Group();
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(rand(3, 6), rand(6, 9), 1.4, 9), new THREE.MeshStandardMaterial({ color: "#f1d9a0", roughness: 1, flatShading: true }));
  sand.position.y = -0.2;
  const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(2.5, 4.5), 0), new THREE.MeshStandardMaterial({ color: "#4caf50", roughness: 1, flatShading: true }));
  hill.scale.y = rand(0.5, 0.9);
  hill.position.y = 0.6;
  g.add(sand, hill);
  const palms = 1 + Math.floor(Math.random() * 3);
  if (palmProtos.length) {
    for (let i = 0; i < palms; i++) {
      const p = palmProtos[Math.floor(Math.random() * palmProtos.length)].clone();
      const h = rand(5.5, 8.5);
      p.scale.setScalar(h);
      p.position.set(rand(-2.5, 2.5), 0.3, rand(-2.5, 2.5));
      p.rotation.set(rand(-0.12, 0.12), rand(0, 6), rand(-0.12, 0.12));
      g.add(p);
    }
    return g;
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#8d6e4a", roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#2e9d4b", roughness: 1, flatShading: true, side: THREE.DoubleSide });
  for (let i = 0; i < palms; i++) {
    const p = new THREE.Group();
    const h = rand(3.5, 5.5);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, h, 6), trunkMat);
    trunk.position.y = h / 2;
    p.add(trunk);
    for (let j = 0; j < 6; j++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.6, 4, 1, true), leafMat);
      leaf.position.y = h;
      leaf.rotation.set(Math.PI / 2 + 0.5, (j / 6) * Math.PI * 2, 0, "YXZ");
      leaf.translateY(1.2);
      p.add(leaf);
    }
    p.position.set(rand(-2.5, 2.5), 0.4, rand(-2.5, 2.5));
    p.rotation.z = rand(-0.25, 0.25);
    g.add(p);
  }
  return g;
}

type Obstacle = { obj: THREE.Object3D; kind: "rock" | "buoy"; r: number; x: number; z: number; spin: number };
// artillery: a red target ring drifts in with the water; the shell lands on it after T seconds
type Shell = { x: number; z: number; t: number; T: number; ring: THREE.Mesh; beam: THREE.Mesh; body: THREE.Mesh };
type Splash = { x: number; z: number; life: number };

const ARTILLERY_FROM = 600; // world units (= 150 game metres) before the first shell
const SALVO_FROM = 1500; // two shells at once from here on (375 game metres)
const SHELL_H = 46;
const ringGeo = new THREE.RingGeometry(1.15, 1.6, 40);
const beamGeo = new THREE.CylinderGeometry(0.25, 0.7, 40, 12, 1, true).translate(0, 20, 0);
const shellGeo = new THREE.SphereGeometry(0.38, 12, 10);
const shellMat = new THREE.MeshStandardMaterial({ color: "#1a1a1f", roughness: 0.6, metalness: 0.4 });
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number };

const MAX_PARTICLES = 700;

export class BoatEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1000);
  private water = createWater();
  private sky = createSky();
  private boat = buildBoat();
  private obstacles: Obstacle[] = [];
  private shells: Shell[] = [];
  private splashes: Splash[] = [];
  private shellTimer = 0;
  private markers: THREE.Object3D[] = [];
  private islands: THREE.Object3D[] = [];
  private trail: { x: number; z: number; age: number }[] = [];
  private particles: Particle[] = [];
  private points: THREE.Points;
  private pGeo = new THREE.BufferGeometry();
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pAlpha = new Float32Array(MAX_PARTICLES);
  private pSize = new Float32Array(MAX_PARTICLES);

  private phase: Phase = "ready";
  private time = 0;
  private distance = 0;
  private speed = 0;
  private lane = 0;
  private x = 0;
  private vx = 0;
  private nextRow = 0;
  private nextIsland = 0;
  private trailTimer = 0;
  private crashT = 0;
  private shake = 0;
  private jumpY = 0;
  private jumpV = 0;
  readonly audio = new BoatAudio();
  private hudT = 0;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private disposed = false;
  // promo recording only: localhost?demo=1 drives the boat itself (window.__boatAuto = false hands control back)
  private demo = window.location.hostname === "localhost" && new URLSearchParams(window.location.search).get("demo") === "1";
  private autoT = 0;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";

    this.scene.add(this.sky, this.water.mesh, this.boat);
    this.scene.add(new THREE.HemisphereLight("#d8f3ff", "#2a6f86", 1.6));
    const sun = new THREE.DirectionalLight("#fff1d6", 2.4);
    sun.position.copy(SKY.sun).multiplyScalar(50);
    this.scene.add(sun);

    this.pGeo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute("alpha", new THREE.BufferAttribute(this.pAlpha, 1));
    this.pGeo.setAttribute("size", new THREE.BufferAttribute(this.pSize, 1));
    this.points = new THREE.Points(
      this.pGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTex: { value: spriteTexture() }, uScale: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float alpha;
          attribute float size;
          uniform float uScale;
          varying float vA;
          void main() {
            vA = alpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * uScale / -mv.z;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uTex;
          varying float vA;
          void main() {
            vec4 t = texture2D(uTex, gl_PointCoord);
            gl_FragColor = vec4(vec3(1.0), t.a * vA);
          }
        `,
      }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    for (const side of [-1, 1]) {
      for (let i = 0; i < 22; i++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshStandardMaterial({ color: "#ffcf3a", roughness: 0.4 }));
        m.position.set(side * (LANE * 1.5 + 0.9), 0, KILL_Z - i * 12);
        this.markers.push(m);
        this.scene.add(m);
      }
    }
    for (let z = 20; z > SPAWN_Z - 60; z -= 45) this.spawnIsland(z);
    this.nextIsland = 45;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.bindInput();
    this.loadBoatModel();
    void loadPalms().then(() => {
      // islands placed before the models arrived: rebuild them in place with the real palms
      if (this.disposed || !palmProtos.length) return;
      this.islands = this.islands.map((old) => {
        this.scene.remove(old);
        const isl = buildIsland();
        isl.position.copy(old.position);
        isl.rotation.y = old.rotation.y;
        this.scene.add(isl);
        return isl;
      });
    });
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  start() {
    this.audio.unlock();
    if (this.phase === "playing") return;
    this.jumpY = 0;
    this.jumpV = 0;
    for (const o of this.obstacles) this.scene.remove(o.obj);
    this.obstacles = [];
    for (const s of this.shells) this.removeShell(s);
    this.shells = [];
    this.splashes = [];
    this.shellTimer = 3;
    // local testing only: ?d=800 starts the run at 800 m so the later stages can be reached quickly
    this.distance = window.location.hostname === "localhost" ? Number(new URLSearchParams(window.location.search).get("d")) || 0 : 0;
    this.speed = 6;
    this.lane = 0;
    this.x = 0;
    this.vx = 0;
    this.nextRow = 70;
    this.crashT = 0;
    this.trail = [];
    this.boat.position.set(0, 0, 0);
    this.boat.rotation.set(0, 0, 0);
    this.phase = "playing";
    this.hooks.onPhase("playing", 0);
  }

  steer(dir: -1 | 1) {
    if (this.phase === "ready") return this.hooks.onRequestStart();
    if (this.phase !== "playing") return;
    const next = Math.max(-1, Math.min(1, this.lane + dir));
    if (next === this.lane) return;
    this.audio.unlock();
    this.lane = next;
    this.audio.whoosh();
    if (this.jumpY < 0.3) this.burst(this.x - dir * 0.6, 0.3, 0.6, 14, dir * -2.5);
  }

  jump() {
    if (this.phase === "ready") return this.hooks.onRequestStart();
    if (this.phase !== "playing" || this.jumpY > 0.01 || this.jumpV > 0) return;
    this.audio.unlock();
    this.jumpV = JUMP_V;
    this.audio.whoosh();
    this.burst(this.x, 0.3, BOAT_BACK, 22);
  }

  private loadBoatModel() {
    new GLTFLoader().load(boatModelUrl(), (gltf) => {
      if (this.disposed) return;
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const s = (BOAT_BACK - BOAT_FRONT) / Math.max(size.x, size.z);
      model.scale.setScalar(s);
      if (size.x > size.z) model.rotation.y = Math.PI / 2;
      else model.rotation.y = Math.PI;
      model.position.set(0, -box.min.y * s - 0.12, (BOAT_FRONT + BOAT_BACK) / 2);
      for (const old of [...this.boat.children]) {
        this.boat.remove(old);
        old.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material | undefined)?.dispose();
        });
      }
      this.boat.add(model);
    });
  }

  dispose() {
    this.disposed = true;
    this.audio.dispose();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
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
      if (moved || e.buttons === 0 && e.pointerType === "mouse") return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) { moved = true; this.steer(dx < 0 ? -1 : 1); }
      else if (dy < -28 && -dy > Math.abs(dx)) { moved = true; this.jump(); }
    });
    el.addEventListener("pointerup", (e) => {
      if (moved) return;
      if (this.phase !== "playing") return;
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
    this.camera.updateProjectionMatrix();
    this.pointScale();
  }

  private pointScale() {
    const h = this.renderer.domElement.height;
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private spawnRow(z: number) {
    const twoChance = Math.min(0.6, 0.12 + this.distance / 4000);
    const lanes = [-1, 0, 1].sort(() => Math.random() - 0.5).slice(0, Math.random() < twoChance ? 2 : 1);
    for (const l of lanes) {
      const rock = Math.random() < 0.65;
      let obj: THREE.Object3D, r: number;
      if (rock) {
        r = rand(1.0, 1.45);
        obj = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.07, 0.15, rand(0.2, 0.3)), roughness: 0.95, flatShading: true }));
        obj.scale.setScalar(r);
        obj.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      } else {
        r = 0.7;
        obj = buildBuoy();
      }
      const x = l * LANE + rand(-0.35, 0.35);
      obj.position.set(x, 0, z);
      this.scene.add(obj);
      this.obstacles.push({ obj, kind: rock ? "rock" : "buoy", r, x, z, spin: rand(-0.4, 0.4) });
    }
  }

  private spawnIsland(z: number) {
    const isl = buildIsland();
    const side = Math.random() < 0.5 ? -1 : 1;
    isl.position.set(side * rand(15, 44), 0, z);
    isl.rotation.y = rand(0, 6);
    this.islands.push(isl);
    this.scene.add(isl);
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ x, y, z, vx, vy, vz, life, max: life, size });
  }

  private burst(x: number, y: number, z: number, n: number, push = 0) {
    for (let i = 0; i < n; i++) this.emit(x, y, z, push + rand(-2, 2), rand(2, 5), rand(-1, 3), rand(0.4, 0.9), rand(0.18, 0.34));
  }

  private crash(x: number, z: number) {
    this.phase = "over";
    this.crashT = 0;
    this.shake = 0.6;
    this.audio.crash();
    for (let i = 0; i < 90; i++) this.emit(x + rand(-0.8, 0.8), rand(0.2, 1.2), z + rand(-0.5, 1), rand(-5, 5), rand(3, 9), rand(-2, 5), rand(0.6, 1.4), rand(0.3, 0.7));
    const d = Math.floor(this.distance * METRE);
    setTimeout(() => { if (!this.disposed) this.hooks.onPhase("over", d); }, 900);
  }

  /** Fire a shell at a lane. It lands in T seconds exactly where that lane will be, so staying put is fatal. */
  private fireShell(lane: number, T: number) {
    const x = lane * LANE;
    const z = -this.speed * T;
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: "#ff2d2d", transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, z);
    // a red column of light marks the impact point so it reads from 70 m away; it collapses as the shell arrives
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: "#ff3030", transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.position.set(x, 0, z);
    const body = new THREE.Mesh(shellGeo, shellMat);
    body.visible = false;
    this.scene.add(ring, beam, body);
    this.shells.push({ x, z, t: 0, T, ring, beam, body });
    this.audio.whistle(T);
  }

  private removeShell(s: Shell) {
    this.scene.remove(s.ring, s.beam, s.body);
    (s.ring.material as THREE.Material).dispose();
    (s.beam.material as THREE.Material).dispose();
  }

  private detonate(s: Shell) {
    this.removeShell(s);
    this.audio.boom();
    this.shake = Math.max(this.shake, 0.45);
    // water column
    for (let i = 0; i < 80; i++) this.emit(s.x + rand(-0.7, 0.7), 0.2, s.z + rand(-0.7, 0.7), rand(-4, 4), rand(5, 15), rand(-4, 4), rand(0.7, 1.4), rand(0.35, 0.85));
    this.splashes.push({ x: s.x, z: s.z, life: 1.5 });
    if (this.phase === "playing" && Math.abs(s.x - this.x) < 1.7 && s.z > BOAT_FRONT - 0.8 && s.z < BOAT_BACK + 0.8 && this.jumpY < 1.4) this.crash(s.x, s.z);
  }

  /** Nearest danger in a lane, as metres until the bow reaches it (shells: seconds to impact × speed). */
  private threat(lane: number) {
    let d = Infinity, jumpable = true;
    const lx = lane * LANE;
    for (const o of this.obstacles) {
      if (Math.abs(o.x - lx) > BOAT_HALF_W + o.r * 0.75 + 0.4) continue;
      if (o.z - o.r * 0.6 > BOAT_BACK + 0.5) continue;
      const a = Math.max(0, BOAT_FRONT - (o.z + o.r * 0.6));
      if (a < d) { d = a; jumpable = o.kind === "buoy" || o.r * 0.65 < 1.6; }
    }
    for (const s of this.shells) {
      if (Math.abs(s.x - lx) > 1.9) continue;
      const a = Math.max(0, s.T - s.t) * this.speed;
      if (a < d) { d = a; jumpable = false; }
    }
    return { d, jumpable };
  }

  private autopilot(dt: number) {
    if ((window as unknown as { __boatAuto?: boolean }).__boatAuto === false) return;
    this.autoT -= dt;
    const cur = this.threat(this.lane);
    if (cur.d > this.speed * 0.9 + 6) return;
    if (this.autoT <= 0) {
      const opts = [this.lane - 1, this.lane + 1].filter((l) => l >= -1 && l <= 1).map((l) => ({ l, t: this.threat(l) }));
      opts.sort((a, b) => b.t.d - a.t.d);
      const best = opts[0];
      if (best && best.t.d > cur.d + 4 && best.t.d > 5) {
        this.steer(best.l > this.lane ? 1 : -1);
        this.autoT = 0.16;
        return;
      }
    }
    if (cur.jumpable && cur.d < this.speed * 0.3 + 1) this.jump();
  }

  /** Difficulty stages: rocks / buoys from the start, denser rows with distance, artillery after ARTILLERY_FROM
   *  (shorter warning + shorter gaps as you go), two-lane salvos after SALVO_FROM. */
  private artillery(dt: number) {
    if (this.distance < ARTILLERY_FROM) return;
    this.shellTimer -= dt;
    if (this.shellTimer > 0) return;
    const prog = Math.min(1, (this.distance - ARTILLERY_FROM) / 2400);
    const T = 1.9 - 0.7 * prog;
    const lane = Math.random() < 0.65 ? this.lane : [-1, 0, 1][Math.floor(Math.random() * 3)];
    this.fireShell(lane, T);
    if (this.distance > SALVO_FROM && Math.random() < 0.3 + 0.4 * prog) {
      const others = [-1, 0, 1].filter((l) => l !== lane);
      this.fireShell(others[Math.floor(Math.random() * 2)], T + 0.3);
    }
    this.shellTimer = rand(0.8, 1.2) * (6 - 3.6 * prog);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number) {
    const t = this.time;
    const playing = this.phase === "playing";
    const target = playing ? speedAt(this.distance) : this.phase === "ready" ? 7 : 0;
    const rate = this.phase === "over" ? 4 : playing && this.speed < target ? 1.6 : 3;
    this.speed += (target - this.speed) * Math.min(1, rate * dt);
    const dz = this.speed * dt;
    if (playing) this.distance += dz;
    const offset = this.water.uniforms.uOffset.value + dz;
    this.water.uniforms.uOffset.value = offset;
    this.water.uniforms.uTime.value = t;

    // steering: critically damped spring toward the lane centre
    const tx = this.lane * LANE;
    const k = 140, c = 2 * Math.sqrt(k);
    this.vx += ((tx - this.x) * k - this.vx * c) * dt;
    this.x += this.vx * dt;

    // boat on the waves
    const b = this.boat;
    const hF = waveHeight(this.x, BOAT_FRONT, offset, t), hB = waveHeight(this.x, BOAT_BACK, offset, t);
    const hL = waveHeight(this.x - 0.6, 0, offset, t), hR = waveHeight(this.x + 0.6, 0, offset, t);
    const sp = this.speed / 46;
    if (this.phase === "over") {
      this.crashT += dt;
      const k2 = Math.min(1, this.crashT / 0.7);
      b.rotation.z += (1.25 * Math.sign(this.vx || 1) - b.rotation.z) * Math.min(1, 5 * dt);
      b.rotation.x += (-0.5 - b.rotation.x) * Math.min(1, 4 * dt);
      b.position.y = (hF + hB) / 2 - 0.55 * k2 + Math.sin(this.crashT * 9) * 0.05 * (1 - k2);
    } else {
      if (this.jumpY > 0 || this.jumpV > 0) {
        this.jumpV -= GRAVITY * dt;
        this.jumpY += this.jumpV * dt;
        if (this.jumpY <= 0) {
          this.jumpY = 0;
          this.jumpV = 0;
          this.shake = 0.25;
          this.audio.splash();
          for (let i = 0; i < 40; i++) this.emit(this.x + rand(-0.8, 0.8), 0.2, rand(BOAT_FRONT, BOAT_BACK), rand(-4, 4), rand(2, 5), rand(-1, 3), rand(0.4, 0.9), rand(0.2, 0.45));
        }
      }
      b.position.y = (hF + hB) / 2 + 0.05 + sp * 0.12 + Math.sin(t * 13) * 0.015 * sp + this.jumpY;
      b.rotation.x = Math.atan2(hF - hB, BOAT_BACK - BOAT_FRONT) * 0.8 + sp * 0.07 + (this.jumpY > 0 ? 0.12 + this.jumpV * 0.025 : 0);
      b.rotation.z = Math.atan2(hL - hR, 1.2) * 0.6 - this.vx * 0.045;
      b.rotation.y = -this.vx * 0.02;
    }
    b.position.x = this.x;

    // wake trail: newest sample at the stern, older ones drift toward the camera
    this.trailTimer -= dt;
    for (const p of this.trail) { p.z += dz; p.age += dt; }
    const air = this.jumpY > 0.25;
    this.audio.update(sp, this.phase !== "over", air);
    if (this.speed > 2 && this.trailTimer <= 0 && this.phase !== "over" && !air) {
      this.trail.unshift({ x: this.x, z: BOAT_BACK - 0.2, age: 0 });
      this.trailTimer = 0.045;
    }
    this.trail = this.trail.filter((p) => p.z < KILL_Z + 10).slice(0, TRAIL_N);
    const tu = this.water.uniforms.uTrail.value;
    this.trail.forEach((p, i) => tu[i].set(p.x, p.z, p.age));
    this.water.uniforms.uTrailCount.value = this.trail.length;

    // spray from the stern corners and the bow
    if (this.phase !== "over" && this.speed > 4 && !air) {
      // rooster tail: a plume of droplets thrown up behind the propeller. Particles drift with the water, so
      // plenty of sideways / upward scatter is what keeps them from lining up into two solid ribbons.
      if (Math.random() < 0.4 + sp * 0.8) {
        this.emit(this.x + rand(-0.25, 0.25), b.position.y + 0.1, BOAT_BACK, rand(-1.8, 1.8) + this.vx * 0.3, rand(1.5, 4.5) * sp + 0.6, rand(0, 3), rand(0.35, 0.65), rand(0.18, 0.42));
      }
      // bow sheets: water peeling off both sides of the hull in a fan
      if (sp > 0.2 && Math.random() < 0.3 + sp * 1.2) {
        const s = Math.random() < 0.5 ? -1 : 1;
        this.emit(this.x + s * 0.5, b.position.y + 0.05, BOAT_FRONT + rand(0.3, 1.6), s * rand(1.5, 5) * sp + this.vx * 0.3, rand(0.8, 3) * sp + 0.3, rand(-1, 2), rand(0.3, 0.55), rand(0.1, 0.3));
      }
    }

    // obstacles
    if (playing) {
      this.nextRow -= dz;
      if (this.nextRow <= 0) {
        this.spawnRow(SPAWN_Z);
        this.nextRow = Math.max(this.speed * 0.6, 34 - this.distance * 0.004);
      }
    }
    const rocks = this.water.uniforms.uRocks.value;
    let ri = 0;
    for (const o of this.obstacles) {
      o.z += dz;
      const y = waveHeight(o.x, o.z, offset, t);
      o.obj.position.z = o.z;
      if (o.kind === "buoy") {
        o.obj.position.y = y - 0.15;
        o.obj.rotation.z = Math.sin(t * 2 + o.x) * 0.12;
        o.obj.rotation.x = Math.cos(t * 1.7 + o.z) * 0.1;
      } else {
        o.obj.position.y = -0.35 * o.r;
        o.obj.rotation.y += o.spin * dt * 0.1;
      }
      if (ri < ROCK_N && o.z > -150 && o.z < KILL_Z) rocks[ri++].set(o.x, o.z, o.r * (o.kind === "rock" ? 0.95 : 0.7), 1);
      const top = o.kind === "rock" ? o.r * 0.65 : BUOY_TOP;
      if (this.phase === "playing" && this.jumpY < top - 0.1 && Math.abs(o.x - this.x) < BOAT_HALF_W + o.r * 0.75 && o.z + o.r * 0.6 > BOAT_FRONT && o.z - o.r * 0.6 < BOAT_BACK) this.crash(o.x, o.z);
    }

    // artillery: rings drift with the water, shells fall on them, impacts leave an expanding foam ring
    if (playing) this.artillery(dt);
    if (playing && this.demo) this.autopilot(dt);
    for (const s of this.shells) {
      s.t += dt;
      s.z += dz;
      const u = Math.min(1, s.t / s.T);
      const wy = waveHeight(s.x, s.z, offset, t);
      // the ring grows with distance so it stays readable on screen, and settles to true size as it arrives
      const far = Math.max(1, -s.z / 16);
      s.ring.position.set(s.x, wy + 0.1, s.z);
      s.ring.scale.setScalar(far * (1.35 - 0.35 * u) * (1 + 0.08 * Math.sin(t * 16)));
      (s.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * Math.abs(Math.sin(t * (6 + 10 * u)));
      s.beam.position.set(s.x, wy, s.z);
      s.beam.scale.set(far, 1 - u * 0.85, far);
      (s.beam.material as THREE.MeshBasicMaterial).opacity = 0.2 * (1 - u * 0.5);
      // comes in from high up ahead, slightly off to the side, on a parabola
      s.body.visible = u > 0.04;
      s.body.position.set(s.x + (1 - u) * 2.5, SHELL_H * (1 - u * u) + 0.4, s.z - (1 - u) * 14);
      if (u > 0.35 && Math.random() < 0.7) this.emit(s.body.position.x, s.body.position.y, s.body.position.z, rand(-0.4, 0.4), rand(0.2, 0.8), rand(-0.4, 0.4), 0.35, 0.3);
      if (u >= 1) this.detonate(s);
    }
    this.shells = this.shells.filter((s) => s.t < s.T);
    for (const sp2 of this.splashes) {
      sp2.life -= dt;
      sp2.z += dz;
      if (ri < ROCK_N && sp2.life > 0) rocks[ri++].set(sp2.x, sp2.z, 1.2 + (1.5 - sp2.life) * 1.6, 1);
    }
    this.splashes = this.splashes.filter((sp2) => sp2.life > 0);
    for (; ri < ROCK_N; ri++) rocks[ri].w = 0;
    this.obstacles = this.obstacles.filter((o) => {
      if (o.z < KILL_Z) return true;
      this.scene.remove(o.obj);
      return false;
    });

    // scenery
    for (const m of this.markers) {
      m.position.z += dz;
      if (m.position.z > KILL_Z) m.position.z -= 22 * 12;
      m.position.y = waveHeight(m.position.x, m.position.z, offset, t) + 0.05;
    }
    this.nextIsland -= dz;
    if (this.nextIsland <= 0) { this.spawnIsland(SPAWN_Z - 40); this.nextIsland = rand(30, 60); }
    this.islands = this.islands.filter((isl) => {
      isl.position.z += dz;
      if (isl.position.z < KILL_Z + 20) return true;
      this.scene.remove(isl);
      return false;
    });

    // particles
    let n = 0;
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.vy -= 9.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += (p.vz * dt) + dz;
      if (p.y < -0.2) p.life = Math.min(p.life, 0.05);
      this.pPos[n * 3] = p.x; this.pPos[n * 3 + 1] = p.y; this.pPos[n * 3 + 2] = p.z;
      this.pAlpha[n] = Math.min(1, p.life / p.max * 1.6) * 0.6;
      this.pSize[n] = p.size * (2.2 - p.life / p.max * 1.2);
      n++;
    }
    this.pGeo.setDrawRange(0, n);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.size as THREE.BufferAttribute).needsUpdate = true;

    // camera
    const cam = this.camera;
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * this.shake;
    cam.position.set(this.x * 0.55 + rand(-1, 1) * sh, 4.3 + b.position.y * 0.3 + rand(-1, 1) * sh, 8.8 - sp * 0.8);
    cam.lookAt(this.x * 0.8, 0.7, -14);
    const fov = 58 + sp * 14;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, 3 * dt); cam.updateProjectionMatrix(); this.pointScale(); }
    this.sky.position.copy(cam.position);

    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.05;
      this.hooks.onDistance(Math.floor(this.distance * METRE), Math.round(this.speed * 3.6));
    }
  }
}
