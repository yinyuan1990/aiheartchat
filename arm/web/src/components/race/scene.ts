import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Scenery for the highway runner: a suspension bridge over the sea that runs from golden hour into night.
// Everything that repeats along the road is placed from one scroll offset (world units travelled), so it never
// needs spawning: z = wrap(i · gap + offset) and the pattern slides toward the camera (+z).

export const LANE = 3.6;
export const ROAD_HALF = 6.8;
export const NEAR_Z = 40;
export const ROAD_LEN = 420;
export const SPAN = 160;
export const SPANS = 3;
export const TOWER_X = 8.7;
export const TOWER_TOP = 41;
export const CABLE_LOW = 2.6;
export const WATER_Y = -5.5;

/** z of the i-th of n repeating things spaced `gap` apart; range [NEAR_Z - n·gap + lead, NEAR_Z + lead) */
export const wrapZ = (i: number, gap: number, n: number, offset: number, lead = 0) =>
  (((i * gap + offset) % (n * gap)) + n * gap) % (n * gap) + NEAR_Z - n * gap + lead;

/** Main cable height at s metres from a tower (0..SPAN). */
export const cableY = (s: number) => CABLE_LOW + (TOWER_TOP - CABLE_LOW) * (2 * s / SPAN - 1) ** 2;

// ------------------------------------------------------------------ time of day

const C = (h: string) => new THREE.Color(h);
// keyframes at tod = 0 (golden hour), 0.5 (dusk), 1 (night)
const KEYS = {
  zenith: [C("#2c5cb8"), C("#33287a"), C("#060a24")],
  horizon: [C("#ffb257"), C("#ff6a5c"), C("#2e2556")],
  glow: [C("#ff7a2a"), C("#ff3f6a"), C("#3c2a6e")],
  sun: [C("#ffe2b0"), C("#ff8a50"), C("#8ea2ff")],
  deep: [C("#0b3150"), C("#1d1a45"), C("#03061a")],
  shallow: [C("#2d8aa0"), C("#5a4a8a"), C("#0d1838")],
  hemiSky: [C("#ffe3c2"), C("#d9a0c8"), C("#4a5a9a")],
  hemiGround: [C("#4a5f78"), C("#3c3060"), C("#0a0c20")],
};
const lerp3 = (k: THREE.Color[], t: number, out: THREE.Color) => {
  const u = Math.min(1, Math.max(0, t)) * 2;
  const i = Math.min(1, Math.floor(u));
  return out.copy(k[i]).lerp(k[i + 1], u - i);
};

export class TimeOfDay {
  zenith = new THREE.Color();
  horizon = new THREE.Color();
  glow = new THREE.Color();
  sun = new THREE.Color();
  deep = new THREE.Color();
  shallow = new THREE.Color();
  hemiSky = new THREE.Color();
  hemiGround = new THREE.Color();
  sunDir = new THREE.Vector3();
  /** what lights the scene: the sun until it sets, then a cool moon high up */
  lightDir = new THREE.Vector3();
  sunI = 1;
  hemiI = 1;
  night = 0;
  t = -1;

  set(t: number) {
    if (Math.abs(t - this.t) < 1e-4) return false;
    this.t = t;
    for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) lerp3(KEYS[k], t, this[k]);
    // the sun sits ahead on the road and sinks below the horizon around tod 0.7
    const elev = 0.13 - 0.25 * t;
    this.sunDir.set(-0.09, elev, -1).normalize();
    this.night = THREE.MathUtils.smoothstep(t, 0.45, 0.8);
    const moon = new THREE.Vector3(0.45, 0.8, -0.6).normalize();
    this.lightDir.copy(this.sunDir).setY(Math.max(0.08, elev)).normalize().lerp(moon, this.night).normalize();
    this.sunI = THREE.MathUtils.lerp(2.6, 0.55, this.night) * (1 - 0.35 * THREE.MathUtils.smoothstep(t, 0.2, 0.55));
    this.hemiI = THREE.MathUtils.lerp(1.5, 0.7, t);
    return true;
  }
}

export function createSky(tod: TimeOfDay) {
  const uniforms = {
    uZenith: { value: tod.zenith }, uHorizon: { value: tod.horizon }, uGlow: { value: tod.glow },
    uSunDir: { value: tod.sunDir }, uSun: { value: tod.sun }, uNight: { value: 0 }, uTime: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uGlow, uSunDir, uSun;
      uniform float uNight, uTime;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
        // warm band along the horizon, strongest toward the sun
        vec2 a = normalize(d.xz + 1e-5), sa = normalize(uSunDir.xz);
        float toward = max(dot(a, sa), 0.0);
        col += uGlow * (0.25 + 0.75 * pow(toward, 5.0)) * exp(-abs(h) * 7.0) * (1.0 - 0.5 * uNight);
        // sun: a big soft disc with a halo; the lower half gets thin horizontal gaps as it sinks (retro look)
        float s = dot(d, uSunDir);
        float disc = smoothstep(0.9987, 0.9991, s);
        float below = clamp((uSunDir.y - h) * 260.0, 0.0, 1.0);
        float gaps = step(0.42 + 0.3 * below, fract((uSunDir.y - h) * 140.0));
        vec3 sunCol = mix(vec3(1.0, 0.93, 0.6), vec3(1.0, 0.45, 0.55), clamp((uSunDir.y - h) * 45.0 + 0.5, 0.0, 1.0));
        col = mix(col, sunCol * 2.2, disc * mix(1.0, gaps, below) * (1.0 - uNight));
        col += uSun * (pow(max(s, 0.0), 300.0) * 0.9 + pow(max(s, 0.0), 14.0) * 0.28) * (1.0 - 0.8 * uNight);
        // stars
        vec3 p = d * 260.0;
        vec3 cell = floor(p);
        float r = hash(cell);
        float star = step(0.9965, r) * smoothstep(0.42, 0.0, length(fract(p) - 0.5));
        star *= 0.6 + 0.4 * sin(uTime * (2.0 + r * 5.0) + r * 40.0);
        col += vec3(0.9, 0.95, 1.0) * star * uNight * smoothstep(0.03, 0.25, h) * 1.4;
        if (h < 0.0) col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.08, h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(480, 48, 24), mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/** Two layers of hazy mountain silhouettes on the horizon; they follow the camera like the sky. */
export function createMountains() {
  const group = new THREE.Group();
  const layers: THREE.MeshBasicMaterial[] = [];
  const noise = (x: number, seed: number) =>
    Math.sin(x * 1.7 + seed) * 0.5 + Math.sin(x * 4.3 + seed * 2.1) * 0.25 + Math.sin(x * 9.1 + seed * 3.7) * 0.12;
  for (const [r, hMax, seed] of [[430, 46, 1.3], [380, 30, 4.1]] as const) {
    const pos: number[] = [];
    const N = 160;
    for (let i = 0; i < N; i++) {
      const a0 = -1.45 + (2.9 * i) / N, a1 = -1.45 + (2.9 * (i + 1)) / N;
      const h0 = Math.max(4, hMax * (0.55 + 0.5 * noise(a0 * 3, seed))), h1 = Math.max(4, hMax * (0.55 + 0.5 * noise(a1 * 3, seed)));
      const x0 = Math.sin(a0) * r, z0 = -Math.cos(a0) * r, x1 = Math.sin(a1) * r, z1 = -Math.cos(a1) * r;
      // bases sink well below the sea's far edge so no sky shows between water and mountains
      const b = WATER_Y - 40;
      pos.push(x0, b, z0, x1, b, z1, x1, h1, z1, x0, b, z0, x1, h1, z1, x0, h0, z0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.MeshBasicMaterial({ color: "#555", fog: false, side: THREE.DoubleSide, depthWrite: false });
    layers.push(m);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    group.add(mesh);
  }
  const update = (tod: TimeOfDay) => {
    layers[0].color.copy(tod.horizon).lerp(tod.zenith, 0.35).multiplyScalar(0.8);
    layers[1].color.copy(tod.horizon).lerp(tod.zenith, 0.6).multiplyScalar(0.55);
  };
  return { group, update };
}

// ------------------------------------------------------------------ road

export const ROAD_TILE = 24;

function roadTexture() {
  const W = 512, H = 1024;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const px = (m: number) => ((m + ROAD_HALF) / (2 * ROAD_HALF)) * W;
  const py = (m: number) => (m / ROAD_TILE) * H;
  g.fillStyle = "#3b3c44";
  g.fillRect(0, 0, W, H);
  // aggregate speckle
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // worn tyre tracks in each lane
  for (const l of [-1, 0, 1]) for (const s of [-0.95, 0.95]) {
    const grd = g.createLinearGradient(px(l * LANE + s - 0.5), 0, px(l * LANE + s + 0.5), 0);
    grd.addColorStop(0, "rgba(20,20,26,0)"); grd.addColorStop(0.5, "rgba(20,20,26,0.35)"); grd.addColorStop(1, "rgba(20,20,26,0)");
    g.fillStyle = grd;
    g.fillRect(px(l * LANE + s - 0.5), 0, px(1) - px(0), H);
  }
  // shoulders a shade lighter, red / white kerbs at the very edge
  g.fillStyle = "rgba(255,255,255,0.05)";
  g.fillRect(0, 0, px(-1.5 * LANE) - 0, H);
  g.fillRect(px(1.5 * LANE), 0, W - px(1.5 * LANE), H);
  for (let y = 0; y < ROAD_TILE; y += 2) {
    g.fillStyle = (y / 2) % 2 ? "#e8e8ea" : "#d23a35";
    g.fillRect(0, py(y), px(-ROAD_HALF + 0.45), py(2) + 1);
    g.fillRect(px(ROAD_HALF - 0.45), py(y), W, py(2) + 1);
  }
  // edge lines + dashed lane lines (6 m dash, 6 m gap)
  g.fillStyle = "#f4f1e6";
  for (const s of [-1, 1]) g.fillRect(px(s * 1.5 * LANE) - (s < 0 ? px(0.18) - px(0) : 0), 0, px(0.18) - px(0), H);
  for (const x of [-LANE / 2, LANE / 2]) for (let y = 0; y < ROAD_TILE; y += 12) g.fillRect(px(x - 0.08), py(y), px(0.16) - px(0), py(6));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_LEN / ROAD_TILE);
  return tex;
}

function concreteMat(color = "#b9b3ab") {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
}

/** Road deck, kerb walls, guard-rail posts, lamps, and the suspension spans. */
export function createBridge(renderer: THREE.WebGLRenderer) {
  const group = new THREE.Group();
  const tex = roadTexture();
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN).rotateX(-Math.PI / 2).translate(0, 0, NEAR_Z - ROAD_LEN / 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.6 }),
  );
  road.receiveShadow = true;
  group.add(road);

  // the deck runs out past the kerbs to the tower legs (a walkway carrying the lamps and hangers)
  const deck = new THREE.Mesh(new THREE.BoxGeometry((TOWER_X + 0.9) * 2, 1.8, ROAD_LEN).translate(0, -0.92, NEAR_Z - ROAD_LEN / 2), concreteMat("#a29c95"));
  deck.receiveShadow = true;
  const edgeGeo = new THREE.BoxGeometry(0.25, 0.9, ROAD_LEN);
  const edges = new THREE.Mesh(
    mergeGeometries([edgeGeo.clone().translate(-TOWER_X - 0.8, 0.45, NEAR_Z - ROAD_LEN / 2), edgeGeo.clone().translate(TOWER_X + 0.8, 0.45, NEAR_Z - ROAD_LEN / 2)]),
    new THREE.MeshStandardMaterial({ color: "#c2402f", roughness: 0.55, metalness: 0.2 }),
  );
  group.add(edges);
  const lip = new THREE.BoxGeometry(0.5, 0.55, ROAD_LEN);
  const kerbs = new THREE.Mesh(
    mergeGeometries([lip.clone().translate(-ROAD_HALF - 0.35, 0.27, NEAR_Z - ROAD_LEN / 2), lip.clone().translate(ROAD_HALF + 0.35, 0.27, NEAR_Z - ROAD_LEN / 2)]),
    concreteMat("#d8d2c8"),
  );
  kerbs.receiveShadow = true;
  // steel rail on top of the kerb
  const railGeo = new THREE.BoxGeometry(0.14, 0.32, ROAD_LEN);
  const rail = new THREE.Mesh(
    mergeGeometries([railGeo.clone().translate(-ROAD_HALF - 0.35, 1.0, NEAR_Z - ROAD_LEN / 2), railGeo.clone().translate(ROAD_HALF + 0.35, 1.0, NEAR_Z - ROAD_LEN / 2)]),
    new THREE.MeshStandardMaterial({ color: "#c9ccd2", roughness: 0.35, metalness: 0.8 }),
  );
  group.add(deck, kerbs, rail);

  // rail posts: every 4 m both sides
  const POST_GAP = 4, POSTS = Math.ceil(ROAD_LEN / POST_GAP);
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.6, 0.12), new THREE.MeshStandardMaterial({ color: "#9aa0a8", roughness: 0.4, metalness: 0.7 }), POSTS * 2);
  posts.frustumCulled = false;
  group.add(posts);

  // lamps: pole + arm reaching over the road, every 36 m, staggered sides
  const LAMP_GAP = 36, LAMPS = Math.ceil(ROAD_LEN / LAMP_GAP);
  const lampGeo = (side: number) => mergeGeometries([
    new THREE.CylinderGeometry(0.09, 0.14, 7.6, 8).translate(0, 3.8, 0),
    new THREE.BoxGeometry(2.0, 0.12, 0.14).translate(-side * 1.0, 7.5, 0),
    new THREE.BoxGeometry(0.7, 0.16, 0.34).translate(-side * 1.9, 7.42, 0),
  ]);
  const lampMat = new THREE.MeshStandardMaterial({ color: "#3a3d46", roughness: 0.5, metalness: 0.6 });
  const lamps = [-1, 1].map((side) => {
    const m = new THREE.InstancedMesh(lampGeo(side), lampMat, LAMPS);
    m.frustumCulled = false;
    m.castShadow = true;
    group.add(m);
    return m;
  });
  // pools of lamp light on the asphalt (additive decals), faded in at night
  const poolTex = radialTexture();
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: "#ffc98a", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(9, 12).rotateX(-Math.PI / 2), poolMat, LAMPS * 2);
  pools.frustumCulled = false;
  pools.renderOrder = 1;
  group.add(pools);

  // spans: a tower, two main cables sagging to the next tower, vertical hangers, and piers under the deck
  const towerMat = new THREE.MeshStandardMaterial({ color: "#c2402f", roughness: 0.55, metalness: 0.2 });
  const towerGeo = mergeGeometries([
    ...[-1, 1].map((s) => new THREE.BoxGeometry(1.5, TOWER_TOP - WATER_Y + 2, 2.4).translate(s * TOWER_X, (TOWER_TOP + WATER_Y) / 2, 0)),
    ...[-1, 1].map((s) => new THREE.BoxGeometry(2.2, 1.2, 3.2).translate(s * TOWER_X, TOWER_TOP + 1.2, 0)),
    new THREE.BoxGeometry(TOWER_X * 2, 1.6, 1.8).translate(0, 18, 0),
    new THREE.BoxGeometry(TOWER_X * 2, 1.6, 1.8).translate(0, 30, 0),
    new THREE.BoxGeometry(TOWER_X * 2, 2.0, 1.8).translate(0, TOWER_TOP - 1, 0),
    new THREE.BoxGeometry(TOWER_X * 2 + 3, 1.4, 4).translate(0, -1.9, 0),
  ]);
  const cablePts = (side: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) { const s = (i / 48) * SPAN; pts.push(new THREE.Vector3(side * TOWER_X, cableY(s) + 0.6, -s)); }
    return new THREE.CatmullRomCurve3(pts);
  };
  const cableGeo = mergeGeometries([-1, 1].map((s) => new THREE.TubeGeometry(cablePts(s), 64, 0.28, 6)));
  const hangerPos: number[] = [];
  for (const side of [-1, 1]) for (let s = 8; s < SPAN; s += 8) hangerPos.push(side * TOWER_X, 0, -s, side * TOWER_X, cableY(s) + 0.4, -s);
  const hangerGeo = new THREE.BufferGeometry();
  hangerGeo.setAttribute("position", new THREE.Float32BufferAttribute(hangerPos, 3));
  const pierGeo = mergeGeometries([0.25, 0.5, 0.75].map((f) => new THREE.CylinderGeometry(1.1, 1.4, -WATER_Y + 2, 10).translate(0, (WATER_Y - 2) / 2 - 0.5, -SPAN * f)));
  const spans = Array.from({ length: SPANS }, () => {
    const g = new THREE.Group();
    const tower = new THREE.Mesh(towerGeo, towerMat);
    tower.castShadow = true;
    const cable = new THREE.Mesh(cableGeo, towerMat);
    const hangers = new THREE.LineSegments(hangerGeo, new THREE.LineBasicMaterial({ color: "#7d2a22", transparent: true, opacity: 0.85 }));
    const piers = new THREE.Mesh(pierGeo, concreteMat("#7f7a76"));
    g.add(tower, cable, hangers, piers);
    group.add(g);
    return g;
  });

  const m4 = new THREE.Matrix4();
  /** offset = world units travelled; night 0..1 */
  const update = (offset: number, night: number) => {
    tex.offset.y = (offset / ROAD_TILE) % 1;
    for (let i = 0; i < POSTS; i++) {
      const z = wrapZ(i, POST_GAP, POSTS, offset);
      posts.setMatrixAt(i, m4.makeTranslation(-ROAD_HALF - 0.35, 0.82, z));
      posts.setMatrixAt(POSTS + i, m4.makeTranslation(ROAD_HALF + 0.35, 0.82, z));
    }
    posts.instanceMatrix.needsUpdate = true;
    lamps.forEach((m, k) => {
      const side = k ? 1 : -1;
      for (let i = 0; i < LAMPS; i++) {
        const z = wrapZ(i, LAMP_GAP, LAMPS, offset, k * LAMP_GAP / 2);
        m.setMatrixAt(i, m4.makeTranslation(side * (ROAD_HALF + 0.75), 0, z));
        pools.setMatrixAt(k * LAMPS + i, m4.makeTranslation(side * (ROAD_HALF - 2.4), 0.02, z));
      }
      m.instanceMatrix.needsUpdate = true;
    });
    pools.instanceMatrix.needsUpdate = true;
    poolMat.opacity = 0.55 * night;
    spans.forEach((g, i) => { g.position.z = wrapZ(i, SPAN, SPANS, offset, SPAN); });
  };
  /** lamp heads and tower beacons, for the glow layer */
  const lights = (offset: number, out: (x: number, y: number, z: number) => void) => {
    for (const k of [0, 1]) {
      const side = k ? 1 : -1;
      for (let i = 0; i < LAMPS; i++) out(side * (ROAD_HALF + 0.75 - 1.9), 7.3, wrapZ(i, LAMP_GAP, LAMPS, offset, k * LAMP_GAP / 2));
    }
  };
  return { group, update, lights, spans };
}

export function radialTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ glows + particles

/**
 * One Points draw call for many soft round sprites, sized in world units. Filled from scratch every frame:
 * begin(), add() …, end(). `additive` for lights / sparks, normal blending for smoke and dust.
 */
export class Sprites {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private n = 0;
  constructor(private cap: number, additive: boolean) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(
      this.geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: { uScale: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute vec4 aColor;
          attribute float aSize;
          uniform float uScale;
          varying vec4 vC;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            float d = -mv.z;
            vC = aColor;
            vC.a *= 1.0 - smoothstep(220.0, 330.0, d);
            gl_PointSize = clamp(aSize * uScale / max(d, 0.1), 0.0, 900.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: additive
          ? /* glsl */ `
          varying vec4 vC;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float a = max(0.0, 1.0 - d);
            gl_FragColor = vec4(vC.rgb * (a * a * 0.8 + pow(a, 8.0) * 1.6) * vC.a, 1.0);
          }`
          : /* glsl */ `
          varying vec4 vC;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(1.0, 0.15, d));
          }`,
      }),
    );
    this.points.frustumCulled = false;
  }
  setScale(s: number) { (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = s; }
  begin() { this.n = 0; }
  add(x: number, y: number, z: number, r: number, g: number, b: number, a: number, size: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.size[i] = size;
  }
  end() {
    this.geo.setDrawRange(0, this.n);
    for (const k of ["position", "aColor", "aSize"]) (this.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}
