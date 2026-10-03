import * as THREE from "three";

// Gerstner waves shared by the water shader and the CPU (boat / buoy bobbing). Pattern space is (x, z - offset):
// as the boat "moves" the pattern slides toward the camera while the mesh stays put.

type Wave = { dir: [number, number]; len: number; amp: number; steep: number };

export const WAVES: Wave[] = [
  { dir: [0.2, -1], len: 26, amp: 0.34, steep: 0.55 },
  { dir: [0.8, -0.6], len: 13, amp: 0.17, steep: 0.5 },
  { dir: [-0.6, -0.8], len: 7.5, amp: 0.085, steep: 0.6 },
  { dir: [0.3, 0.95], len: 3.8, amp: 0.035, steep: 0.6 },
];

const G = 9.8;
const norm = ([x, y]: [number, number]) => { const l = Math.hypot(x, y); return [x / l, y / l] as [number, number]; };
const PARAMS = WAVES.map((w) => {
  const k = (2 * Math.PI) / w.len;
  return { d: norm(w.dir), k, c: Math.sqrt(G / k), a: w.amp, q: w.steep / (k * WAVES.length) };
});

/** Surface height at world (x, z). */
export function waveHeight(x: number, z: number, offset: number, t: number) {
  let h = 0;
  const pz = z - offset;
  for (const w of PARAMS) h += w.a * Math.sin(w.k * (w.d[0] * x + w.d[1] * pz - w.c * t));
  return h;
}

export const TRAIL_N = 40;
export const ROCK_N = 16;

const glslWaves = PARAMS.map(
  (w) => `gerstner(q, vec2(${w.d[0].toFixed(5)}, ${w.d[1].toFixed(5)}), ${w.k.toFixed(5)}, ${w.c.toFixed(5)}, ${w.a.toFixed(5)}, ${w.q.toFixed(5)}, disp, nrm);`,
).join("\n    ");

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uOffset;
  varying vec3 vWorld;
  varying vec2 vBase;
  varying vec3 vNormal;
  varying float vH;

  void gerstner(vec2 q, vec2 d, float k, float c, float a, float qs, inout vec3 disp, inout vec3 nrm) {
    float f = k * (dot(d, q) - c * uTime);
    float s = sin(f), co = cos(f);
    disp += vec3(qs * a * d.x * co, a * s, qs * a * d.y * co);
    float wa = k * a;
    nrm += vec3(-d.x * wa * co, -qs * wa * s, -d.y * wa * co);
  }

  void main() {
    vec3 p = position;
    vec2 q = vec2(p.x, p.z - uOffset);
    vec3 disp = vec3(0.0);
    vec3 nrm = vec3(0.0, 1.0, 0.0);
    ${glslWaves}
    float fade = 1.0 - smoothstep(110.0, 300.0, -p.z) * 0.85;
    disp *= fade;
    nrm = normalize(vec3(nrm.x * fade, mix(1.0, nrm.y, fade), nrm.z * fade));
    vec4 wp = modelMatrix * vec4(p + disp, 1.0);
    vWorld = wp.xyz;
    vBase = p.xz;
    vNormal = nrm;
    vH = disp.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uOffset;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uTrail[${TRAIL_N}];
  uniform int uTrailCount;
  uniform vec4 uRocks[${ROCK_N}];
  varying vec3 vWorld;
  varying vec2 vBase;
  varying vec3 vNormal;
  varying float vH;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  // Wake behind the boat. Trail samples are world space (x, z, age); the boat sits at z = 0 and the water flows
  // toward +z, so "behind" = metres aft of the stern. Returns (foam, aerated water, normal ripple).
  vec3 wake(vec2 b, vec2 q) {
    if (uTrailCount < 2) return vec3(0.0);
    float x, age, fadeIn = 1.0;
    float lead = uTrail[0].y - b.y;
    if (lead > 0.0) {
      // ahead of the newest sample = under the hull: extend the wake forward and fade it in there, hidden by the
      // boat, instead of starting on a hard line at the transom
      if (lead > 2.4) return vec3(0.0);
      x = uTrail[0].x;
      age = uTrail[0].z;
      fadeIn = 1.0 - smoothstep(0.0, 2.4, lead);
    } else {
      bool hit = false;
      for (int i = 0; i < ${TRAIL_N - 1}; i++) {
        if (i >= uTrailCount - 1) break;
        vec3 a = uTrail[i], c = uTrail[i + 1];
        if (b.y < a.y || b.y > c.y) continue;
        float k = (b.y - a.y) / max(c.y - a.y, 0.001);
        x = mix(a.x, c.x, k);
        age = mix(a.z, c.z, k);
        hit = true;
        break;
      }
      if (!hit) return vec3(0.0);
    }
    {
      float dx = b.x - x, d = abs(dx);
      float behind = max(b.y - uTrail[0].y, 0.0);
      float decay = exp(-age * 1.1) * fadeIn;

      // turbulent prop wash: streaky foam, stretched along the travel direction, breaking into patches as it ages
      // The camera sits low and close, so only about ±2 m of water is visible behind the stern: keep the wash
      // hull-width (±0.6) at the transom and let it open up slowly, otherwise it fills the whole near field.
      float w = 0.55 + behind * 0.12;
      float band = 1.0 - smoothstep(w * 0.35, w, d);
      vec2 tc = vec2(dx * 2.2, q.y * 0.5);
      float tex = noise(tc + vec2(5.3, 0.0)) * 0.5 + noise(tc * vec2(2.7, 3.2) + vec2(0.0, uTime * 0.3)) * 0.5;
      float th = 0.05 + age * 0.35 + behind * 0.05;
      float wash = band * smoothstep(th, th + 0.45, tex + 0.45 * exp(-behind * 0.5));
      // solid churn right behind the propeller
      float core = (1.0 - smoothstep(0.05, 0.4, d)) * exp(-behind * 0.7);

      // diverging arms: start at the hull sides, a hint of foam close in, further out only ripples that catch the light
      float armX = 0.6 + behind * 0.22;
      float armD = d - armX;
      float armFoam = (1.0 - smoothstep(0.0, 0.18 + behind * 0.05, abs(armD))) * exp(-behind * 0.6) * smoothstep(0.0, 0.6, behind) * smoothstep(0.35, 0.75, tex) * 0.5;
      float side = (dx < 0.0 ? -1.0 : 1.0) * smoothstep(0.0, 0.5, d);
      float ripple = side * sin(armD * 7.0 - behind * 1.5 + uTime * 2.5) * exp(-abs(armD) * 2.0) * (1.0 - smoothstep(0.0, 14.0, behind)) * 0.3
                   + sin(dx * 9.0 + q.y * 3.0 + uTime * 5.0) * band * exp(-behind * 0.3) * 0.1;

      float foam = max(max(wash, core), armFoam) * decay;
      return vec3(foam, band * decay, ripple * decay);
    }
  }

  float rockFoam(vec2 b, float n) {
    float foam = 0.0;
    for (int i = 0; i < ${ROCK_N}; i++) {
      vec4 r = uRocks[i];
      if (r.w < 0.5) continue;
      float d = length(b - r.xy) - r.z;
      foam = max(foam, (1.0 - smoothstep(0.0, 0.9, d)) * smoothstep(0.2, 0.75, n + 0.3 * sin(uTime * 3.0 + d * 6.0)));
    }
    return foam;
  }

  void main() {
    vec2 q = vec2(vBase.x, vBase.y - uOffset);
    vec3 N = vNormal;
    // small ripples on top of the big waves
    float t = uTime;
    N.x += 0.06 * (sin(q.x * 1.9 + t * 2.1) + sin(q.y * 2.7 + q.x * 0.6 - t * 1.6)) + 0.03 * sin(q.x * 5.3 - q.y * 4.1 + t * 3.3);
    N.z += 0.06 * (sin(q.y * 2.3 - t * 1.8) + sin(q.x * 1.4 + q.y * 3.1 + t * 1.2)) + 0.03 * sin(q.y * 6.1 + q.x * 3.7 - t * 2.9);
    vec3 wk = wake(vBase, q);
    N.x += wk.z;
    N.z += wk.z * 0.35;
    N = normalize(N);

    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.7 * pow(1.0 - ndv, 5.0);
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.6));

    float crest = clamp(vH * 1.6 + 0.45, 0.0, 1.0);
    vec3 body = mix(uDeep, uShallow, crest);
    // light scattered through thin crests facing the sun
    body += uShallow * 0.35 * pow(max(dot(V, -uSunDir) * 0.5 + 0.5, 0.0), 3.0) * crest;
    // aerated, milky water inside the wash even where there is no solid foam
    body = mix(body, vec3(0.5, 0.84, 0.9), wk.y * 0.45);

    float n = noise(q * 1.7 + vec2(0.0, t * 0.4)) * 0.65 + noise(q * 4.3 - vec2(t * 0.3, 0.0)) * 0.35;
    float foam = smoothstep(0.62, 0.95, vH * 1.3 + 0.35) * smoothstep(0.45, 0.8, n) * 0.7;
    foam = max(foam, wk.x);
    foam = max(foam, rockFoam(vBase, n));
    foam = clamp(foam, 0.0, 1.0);

    vec3 col = mix(body, sky, fres * (1.0 - foam * 0.8));
    float spec = pow(max(dot(R, uSunDir), 0.0), 180.0) * 3.0 + pow(max(dot(R, uSunDir), 0.0), 18.0) * 0.18;
    col += uSunColor * spec * (1.0 - foam);
    // foam is matte and slightly blue in its thin edges
    col = mix(col, mix(vec3(0.78, 0.92, 0.97), vec3(0.97, 0.99, 1.0), foam), foam);

    float dist = length(cameraPosition - vWorld);
    col = mix(col, uHorizon, smoothstep(110.0, 300.0, dist));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const SKY = { horizon: new THREE.Color("#a9dcee"), zenith: new THREE.Color("#2672c2"), sun: new THREE.Vector3(-0.35, 0.42, -1).normalize() };

export function createWater() {
  const geo = new THREE.PlaneGeometry(260, 360, 200, 300);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -140);
  const uniforms = {
    uTime: { value: 0 },
    uOffset: { value: 0 },
    uDeep: { value: new THREE.Color("#023a5c") },
    uShallow: { value: new THREE.Color("#10a2b4") },
    uHorizon: { value: SKY.horizon },
    uZenith: { value: SKY.zenith },
    uSunDir: { value: SKY.sun },
    uSunColor: { value: new THREE.Color("#fff3d6") },
    uTrail: { value: Array.from({ length: TRAIL_N }, () => new THREE.Vector3()) },
    uTrailCount: { value: 0 },
    uRocks: { value: Array.from({ length: ROCK_N }, () => new THREE.Vector4()) },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uHorizon: { value: SKY.horizon }, uZenith: { value: SKY.zenith }, uSunDir: { value: SKY.sun } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, uSunDir), 0.0);
        col += vec3(1.0, 0.95, 0.8) * (pow(s, 900.0) * 4.0 + pow(s, 24.0) * 0.25);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(480, 32, 16), mat);
  mesh.frustumCulled = false;
  return mesh;
}
