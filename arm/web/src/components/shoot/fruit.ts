import { rgba, type Batch, type Rgba } from "./gfx";

/** Cartoon fruit enemies: thick dark outline, flat fill, a highlight, stalk and leaf. Each one splashes its own
 *  juice colour (particles, stains, rings, damage numbers). */
export const FRUITS = ["apple", "orange", "lemon", "grape", "strawberry", "kiwi", "melon"] as const;
export type Fruit = (typeof FRUITS)[number];
export const SMALL_FRUITS: Fruit[] = ["apple", "orange", "lemon", "grape", "strawberry", "kiwi"];

export type FruitDef = {
  r: number; hp: number; pts: number; mass: number;
  skin: Rgba; flesh: Rgba; juice: Rgba; juiceHex: string;
  /** dark seeds that fly out of the burst */
  seeds: boolean;
};
const def = (r: number, hp: number, pts: number, mass: number, skin: string, flesh: string, juice: string, seeds = false): FruitDef =>
  ({ r, hp, pts, mass, skin: rgba(skin), flesh: rgba(flesh), juice: rgba(juice), juiceHex: juice, seeds });
export const FRUIT_DEFS: Record<Fruit, FruitDef> = {
  apple: def(13, 80, 10, 1.3, "#e8323a", "#fff1c4", "#ff4d5a"),
  orange: def(13, 80, 10, 1.3, "#ff8a1c", "#ffc04d", "#ffa62b"),
  lemon: def(12, 60, 5, 1, "#ffe03a", "#fff7a8", "#fff36b"),
  grape: def(12, 50, 5, 1, "#8f3dff", "#d9b3ff", "#b366ff"),
  strawberry: def(12, 70, 10, 1.2, "#ff2f55", "#ffd1dc", "#ff4f78", true),
  kiwi: def(12, 70, 10, 1.2, "#8a5a2a", "#7fd13a", "#9be23c", true),
  melon: def(23, 360, 30, 3, "#1f9a3c", "#ff5a72", "#ff3b5c", true),
};
export const isFruit = (k: string): k is Fruit => k in FRUIT_DEFS;

const OL: Rgba = [0.07, 0.04, 0.1, 1];
const HI: Rgba = [1, 1, 1, 0.75];
const LEAF = rgba("#4fcf4a");
const STEM = rgba("#6b3a1a");
const FLASH: Rgba = [0.95, 0.95, 0.95, 1];
const O = 2.6;

/** Draw one fruit centred at (x, y): rotated by rot, then squashed along the screen axes (sx, sy) like the other
 *  enemies. white = the hit flash (every fill turns white, the outline stays). */
export function drawFruit(B: Batch, f: Fruit, x: number, y: number, rot: number, sx: number, sy: number, white: boolean) {
  const d = FRUIT_DEFS[f];
  const r = d.r;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const P = (lx: number, ly: number): [number, number] => [x + (lx * cs - ly * sn) * sx, y + (lx * sn + ly * cs) * sy];
  const ell = (cx: number, cy: number, rx: number, ry: number, a: number, c: Rgba, segs = 18) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    const [mx, my] = P(cx, cy);
    let [px, py] = P(cx + rx * ca, cy + rx * sa);
    for (let i = 1; i <= segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      const lx = Math.cos(t) * rx, ly = Math.sin(t) * ry;
      const [qx, qy] = P(cx + lx * ca - ly * sa, cy + lx * sa + ly * ca);
      B.tri(mx, my, px, py, qx, qy, c);
      px = qx; py = qy;
    }
  };
  const seg = (x1: number, y1: number, x2: number, y2: number, w: number, c: Rgba) => {
    const [ax, ay] = P(x1, y1), [bx, by] = P(x2, y2);
    B.line(ax, ay, bx, by, w * Math.max(sx, sy), c);
  };
  const fill = (c: Rgba) => (white ? FLASH : c);
  const leaf = (cx: number, cy: number, len: number, a: number) => {
    ell(cx, cy, len + O * 0.8, len * 0.42 + O * 0.8, a, OL, 12);
    ell(cx, cy, len, len * 0.42, a, fill(LEAF), 12);
  };
  const shine = (cx: number, cy: number, rx: number, ry: number) => { if (!white) ell(cx, cy, rx, ry, 0.6, HI, 10); };

  switch (f) {
    case "apple": {
      seg(0, r * 0.6, r * 0.12, r * 1.2, 2.5 + O * 2, OL);
      ell(-r * 0.3, 0, r * 0.74 + O, r * 0.88 + O, 0, OL);
      ell(r * 0.3, 0, r * 0.74 + O, r * 0.88 + O, 0, OL);
      ell(-r * 0.3, 0, r * 0.74, r * 0.88, 0, fill(d.skin));
      ell(r * 0.3, 0, r * 0.74, r * 0.88, 0, fill(d.skin));
      seg(0, r * 0.6, r * 0.12, r * 1.2, 2.5, fill(STEM));
      leaf(r * 0.42, r * 1.02, r * 0.36, 0.45);
      shine(-r * 0.45, r * 0.32, r * 0.22, r * 0.13);
      break;
    }
    case "orange": {
      ell(0, 0, r + O, r + O, 0, OL, 22);
      ell(0, 0, r, r, 0, fill(d.skin), 22);
      if (!white) for (const [a, b] of [[0.4, -0.3], [-0.2, -0.5], [0.55, 0.25], [-0.5, 0.05], [0.1, 0.1]]) ell(a * r, b * r, 1.1, 1.1, 0, [0.85, 0.42, 0.05, 1], 6);
      leaf(r * 0.3, r * 1.0, r * 0.34, 0.35);
      shine(-r * 0.42, r * 0.38, r * 0.24, r * 0.14);
      break;
    }
    case "lemon": {
      for (const s of [-1, 1]) ell(s * r * 1.12, 0, r * 0.24 + O, r * 0.17 + O, 0, OL, 10);
      ell(0, 0, r * 1.15 + O, r * 0.85 + O, 0, OL, 22);
      for (const s of [-1, 1]) ell(s * r * 1.12, 0, r * 0.24, r * 0.17, 0, fill(d.skin), 10);
      ell(0, 0, r * 1.15, r * 0.85, 0, fill(d.skin), 22);
      shine(-r * 0.45, r * 0.3, r * 0.3, r * 0.12);
      break;
    }
    case "grape": {
      const berries: [number, number][] = [[-0.5, 0.42], [0, 0.5], [0.5, 0.42], [-0.26, -0.02], [0.26, -0.02], [0, -0.46]];
      const br = r * 0.38;
      seg(0, r * 0.7, r * 0.18, r * 1.25, 2.4 + O * 2, OL);
      for (const [a, b] of berries) ell(a * r, b * r, br + O, br + O, 0, OL, 12);
      seg(0, r * 0.7, r * 0.18, r * 1.25, 2.4, fill(STEM));
      for (const [a, b] of berries) ell(a * r, b * r, br, br, 0, fill(d.skin), 12);
      if (!white) for (const [a, b] of berries) ell(a * r - br * 0.35, b * r + br * 0.35, br * 0.3, br * 0.2, 0.6, HI, 8);
      leaf(-r * 0.35, r * 1.0, r * 0.32, 2.6);
      break;
    }
    case "strawberry": {
      // rounded top, pointed bottom
      const body = (grow: number, c: Rgba) => {
        const n = 26;
        const [mx, my] = P(0, -r * 0.05);
        let prev: [number, number] | null = null;
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2;
          const s = Math.sin(t);
          const w = s < 0 ? 1 + s * 0.55 : 1;
          const q = P(Math.cos(t) * (r * w + grow), s * (r * (s < 0 ? 1.18 : 0.9) + grow));
          if (prev) B.tri(mx, my, prev[0], prev[1], q[0], q[1], c);
          prev = q;
        }
      };
      body(O, OL);
      body(0, fill(d.skin));
      if (!white) for (const [a, b] of [[-0.45, 0.3], [0.1, 0.42], [0.5, 0.2], [-0.2, -0.1], [0.3, -0.25], [-0.05, -0.55], [-0.55, -0.2]]) ell(a * r, b * r, 1.1, 1.6, 0, rgba("#ffe66b"), 6);
      for (let i = 0; i < 5; i++) leaf((i - 2) * r * 0.22, r * 0.86, r * 0.3, Math.PI / 2 + (i - 2) * 0.55);
      shine(-r * 0.45, r * 0.38, r * 0.2, r * 0.12);
      break;
    }
    case "kiwi": {
      // cut in half: brown rim, green flesh, pale core, a ring of seeds
      ell(0, 0, r + O, r + O, 0, OL, 22);
      ell(0, 0, r, r, 0, fill(d.skin), 22);
      ell(0, 0, r * 0.82, r * 0.82, 0, fill(d.flesh), 22);
      ell(0, 0, r * 0.28, r * 0.28, 0, fill(rgba("#f6f2c6")), 12);
      if (!white) for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; ell(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, r * 0.12, r * 0.05, a, [0.08, 0.06, 0.05, 1], 6); }
      shine(-r * 0.4, r * 0.42, r * 0.18, r * 0.09);
      break;
    }
    case "melon": {
      ell(0, 0, r * 1.08 + O, r + O, 0, OL, 26);
      ell(0, 0, r * 1.08, r, 0, fill(d.skin), 26);
      if (!white) for (const k of [-0.68, -0.34, 0, 0.34, 0.68]) ell(k * r * 1.08, 0, r * 0.1, r * Math.sqrt(1 - k * k) * 0.95, 0, rgba("#0d5a24"), 12);
      seg(0, r * 0.95, r * 0.08, r * 1.2, 3 + O * 2, OL);
      seg(0, r * 0.95, r * 0.08, r * 1.2, 3, fill(STEM));
      shine(-r * 0.5, r * 0.45, r * 0.3, r * 0.16);
      break;
    }
  }
}
