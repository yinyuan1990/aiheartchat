import * as THREE from "three";

/**
 * Immediate-mode 2D triangles for an orthographic camera: refilled every frame with begin(), shape calls …, end().
 * Each vertex carries an RGBA colour and a uv; uv = (-2, -2) is a solid fill, anything in [-1, 1]² is a soft dot
 * whose alpha falls off with the distance from the centre. One draw call per batch.
 */
export class Batch {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private uv: Float32Array;
  private n = 0;
  constructor(private cap: number, additive: boolean) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.uv = new Float32Array(cap * 2);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aUv", new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        vertexShader: /* glsl */ `
          attribute vec4 aColor;
          attribute vec2 aUv;
          varying vec4 vC;
          varying vec2 vUv;
          void main() {
            vC = aColor;
            vUv = aUv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying vec4 vC;
          varying vec2 vUv;
          void main() {
            float a = vC.a;
            if (vUv.x > -1.5) { float d = max(0.0, 1.0 - length(vUv)); a *= d * d; }
            gl_FragColor = vec4(vC.rgb, a);
          }`,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  begin() { this.n = 0; }
  end() {
    this.geo.setDrawRange(0, this.n);
    for (const k of ["position", "aColor", "aUv"]) {
      const a = this.geo.attributes[k] as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  private v(x: number, y: number, c: Rgba, u = -2, w = -2) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = 0;
    this.col[i * 4] = c[0]; this.col[i * 4 + 1] = c[1]; this.col[i * 4 + 2] = c[2]; this.col[i * 4 + 3] = c[3];
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = w;
  }

  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: Rgba) {
    if (this.n + 3 > this.cap) return;
    this.v(ax, ay, c); this.v(bx, by, c); this.v(cx, cy, c);
  }

  /** a segment `w` wide, colour fading from a to b along it */
  line(x1: number, y1: number, x2: number, y2: number, w: number, a: Rgba, b: Rgba = a) {
    if (this.n + 6 > this.cap) return;
    const dx = x2 - x1, dy = y2 - y1;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * w * 0.5, ny = (dx / l) * w * 0.5;
    this.v(x1 + nx, y1 + ny, a); this.v(x1 - nx, y1 - ny, a); this.v(x2 + nx, y2 + ny, b);
    this.v(x2 + nx, y2 + ny, b); this.v(x1 - nx, y1 - ny, a); this.v(x2 - nx, y2 - ny, b);
  }

  /** soft round glow of radius r */
  dot(x: number, y: number, r: number, c: Rgba) {
    if (this.n + 6 > this.cap) return;
    this.v(x - r, y - r, c, -1, -1); this.v(x + r, y - r, c, 1, -1); this.v(x + r, y + r, c, 1, 1);
    this.v(x - r, y - r, c, -1, -1); this.v(x + r, y + r, c, 1, 1); this.v(x - r, y + r, c, -1, 1);
  }

  /** stretched soft dot: an ellipse along (dx, dy) — bullet cores, streaks of light */
  streak(x: number, y: number, dx: number, dy: number, len: number, r: number, c: Rgba) {
    if (this.n + 6 > this.cap) return;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l, uy = dy / l;
    const ax = ux * len, ay = uy * len, bx = -uy * r, by = ux * r;
    this.v(x - ax - bx, y - ay - by, c, -1, -1); this.v(x + ax - bx, y + ay - by, c, 1, -1); this.v(x + ax + bx, y + ay + by, c, 1, 1);
    this.v(x - ax - bx, y - ay - by, c, -1, -1); this.v(x + ax + bx, y + ay + by, c, 1, 1); this.v(x - ax + bx, y - ay + by, c, -1, 1);
  }

  /** regular polygon: centre, radius, sides, rotation, then a squash (sx, sy) along the screen axes */
  polyOutline(x: number, y: number, r: number, sides: number, rot: number, sx: number, sy: number, w: number, c: Rgba) {
    const ri = r - w, steps = sides;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2 + Math.PI / sides + rot, a1 = ((i + 1) / steps) * Math.PI * 2 + Math.PI / sides + rot;
      const p = (rr: number, a: number): [number, number] => [x + Math.cos(a) * rr * sx, y + Math.sin(a) * rr * sy];
      const [ox0, oy0] = p(r, a0), [ox1, oy1] = p(r, a1), [ix0, iy0] = p(ri, a0), [ix1, iy1] = p(ri, a1);
      this.tri(ox0, oy0, ix0, iy0, ox1, oy1, c);
      this.tri(ox1, oy1, ix0, iy0, ix1, iy1, c);
    }
  }

  polyFill(x: number, y: number, r: number, sides: number, rot: number, sx: number, sy: number, c: Rgba) {
    let px0 = 0, py0 = 0;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides + rot;
      const qx = x + Math.cos(a) * r * sx, qy = y + Math.sin(a) * r * sy;
      if (i > 0) this.tri(x, y, px0, py0, qx, qy, c);
      px0 = qx; py0 = qy;
    }
  }

  /** thin circle outline (shockwave rings) */
  ring(x: number, y: number, r: number, w: number, c: Rgba, segs = 48) {
    this.polyOutline(x, y, r + w / 2, segs, 0, 1, 1, w, c);
  }
}

export type Rgba = [number, number, number, number];
export const rgba = (hex: string, a = 1): Rgba => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};
export const withA = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], a];
export const mix = (a: Rgba, b: Rgba, t: number): Rgba => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];

/** Neon grid floor. Up to 8 shockwaves push the lines outward as they pass. */
export function createGrid() {
  const waves = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));
  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    uniforms: { uWaves: { value: waves }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 uWaves[8];
      uniform float uTime;
      varying vec2 vP;
      float gridLine(vec2 p, float step, float w) {
        vec2 g = abs(fract(p / step + 0.5) - 0.5) * step;
        float d = min(g.x, g.y);
        return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.2, d);
      }
      void main() {
        vec2 p = vP;
        float bright = 0.0;
        for (int i = 0; i < 8; i++) {
          vec4 w = uWaves[i];
          if (w.w <= 0.0) continue;
          vec2 d = p - w.xy;
          float l = length(d) + 0.001;
          float k = exp(-pow((l - w.z) / 26.0, 2.0)) * w.w;
          p -= d / l * k * 22.0;
          bright += k;
        }
        float minor = gridLine(p + vec2(0.0, uTime * 6.0), 40.0, 0.6);
        float major = gridLine(p + vec2(0.0, uTime * 6.0), 160.0, 1.0);
        vec3 bg = vec3(0.016, 0.018, 0.04);
        vec3 lineC = mix(vec3(0.09, 0.11, 0.24), vec3(0.16, 0.18, 0.38), major);
        vec3 c = bg + lineC * max(minor * 0.7, major) * (1.0 + bright * 3.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, waves, uniforms: mat.uniforms };
}
