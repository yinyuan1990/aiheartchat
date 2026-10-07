import { mix, rgba, type Batch, type Rgba } from "./gfx";

/** Cartoon fruit enemies: thick dark outline, flat fill, a highlight, stalk and leaf. Each one splashes its own
 *  juice colour (particles, stains, rings, damage numbers). */
export const FRUITS = [
  "apple", "orange", "lemon", "grape", "strawberry", "kiwi", "banana", "cherry", "peach", "blueberry", "dragonfruit",
  "melon", "pineapple", "coconut", "golden",
] as const;
export type Fruit = (typeof FRUITS)[number];
export const SMALL_FRUITS: Fruit[] = ["apple", "orange", "lemon", "grape", "strawberry", "kiwi", "banana", "cherry", "peach", "blueberry", "dragonfruit"];
/** the tough ones: bigger burst, screen splash, a good chance of a weapon capsule */
export const BIG_FRUITS: Fruit[] = ["melon", "pineapple", "coconut"];

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
  banana: def(13, 70, 10, 1.2, "#ffd93b", "#fff6c9", "#ffe866"),
  cherry: def(12, 50, 5, 1, "#d6143a", "#ff6b7d", "#ff2a4d"),
  peach: def(13, 80, 10, 1.3, "#ff9f7a", "#ffd2a6", "#ffb48a"),
  blueberry: def(11, 40, 5, 0.9, "#3d5bd9", "#a8b8ff", "#6a7dff"),
  dragonfruit: def(14, 90, 10, 1.4, "#ff2f8e", "#fff4f8", "#ff5aa8", true),
  melon: def(23, 360, 30, 3, "#1f9a3c", "#ff5a72", "#ff3b5c", true),
  pineapple: def(20, 300, 25, 2.8, "#e8a51c", "#ffe57a", "#ffd23a"),
  coconut: def(19, 420, 30, 3.2, "#6b4226", "#fbfbf3", "#f4f1e6"),
  /** rare: always drops a weapon capsule */
  golden: def(13, 120, 30, 1.3, "#ffc81f", "#fff6b0", "#ffe14d"),
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

  /** a fat tube along an arc (banana): outline circles first, then the fill */
  const tube = (rad: number, a0: number, a1: number, cy: number, thick: (u: number) => number, c: Rgba, grow: number) => {
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = a0 + (a1 - a0) * u;
      const w = thick(u) + grow;
      ell(Math.cos(a) * rad, cy + Math.sin(a) * rad, w, w, 0, c, 10);
    }
  };
  /** a four-point sparkle (golden apple) */
  const sparkle = (cx: number, cy: number, s: number) => {
    const [mx, my] = P(cx, cy);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rot;
      const [tx, ty] = [mx + Math.cos(a) * s, my + Math.sin(a) * s];
      const [lx, ly] = [mx + Math.cos(a + Math.PI / 2) * s * 0.22, my + Math.sin(a + Math.PI / 2) * s * 0.22];
      const [rx, ry] = [mx + Math.cos(a - Math.PI / 2) * s * 0.22, my + Math.sin(a - Math.PI / 2) * s * 0.22];
      B.tri(tx, ty, lx, ly, rx, ry, [1, 1, 1, 0.95]);
    }
  };

  switch (f) {
    case "apple":
    case "golden": {
      seg(0, r * 0.6, r * 0.12, r * 1.2, 2.5 + O * 2, OL);
      ell(-r * 0.3, 0, r * 0.74 + O, r * 0.88 + O, 0, OL);
      ell(r * 0.3, 0, r * 0.74 + O, r * 0.88 + O, 0, OL);
      ell(-r * 0.3, 0, r * 0.74, r * 0.88, 0, fill(d.skin));
      ell(r * 0.3, 0, r * 0.74, r * 0.88, 0, fill(d.skin));
      seg(0, r * 0.6, r * 0.12, r * 1.2, 2.5, fill(STEM));
      leaf(r * 0.42, r * 1.02, r * 0.36, 0.45);
      shine(-r * 0.45, r * 0.32, r * 0.22, r * 0.13);
      if (f === "golden" && !white) { sparkle(r * 0.35, -r * 0.2, r * 0.42); sparkle(-r * 0.55, r * 0.55, r * 0.22); }
      break;
    }
    case "banana": {
      // a curved tube, thicker in the middle, dark tips
      const th = (u: number) => r * (0.2 + 0.26 * Math.sin(Math.PI * u));
      tube(r * 1.05, Math.PI * 1.15, Math.PI * 1.85, r * 0.75, th, OL, O);
      tube(r * 1.05, Math.PI * 1.15, Math.PI * 1.85, r * 0.75, th, fill(d.skin), 0);
      if (!white) {
        for (const a of [Math.PI * 1.15, Math.PI * 1.85]) ell(Math.cos(a) * r * 1.05, r * 0.75 + Math.sin(a) * r * 1.05, r * 0.13, r * 0.13, 0, rgba("#5a3a12"), 8);
        ell(0, r * 0.75 - r * 0.92, r * 0.5, r * 0.07, 0, HI, 10);
      }
      break;
    }
    case "cherry": {
      // two cherries on joined stems
      const balls: [number, number][] = [[-0.48, -0.3], [0.45, -0.42]];
      for (const [a, b] of balls) seg(a * r, b * r + r * 0.3, r * 0.1, r * 1.15, 2 + O * 2, OL);
      for (const [a, b] of balls) ell(a * r, b * r, r * 0.52 + O, r * 0.52 + O, 0, OL, 14);
      for (const [a, b] of balls) seg(a * r, b * r + r * 0.3, r * 0.1, r * 1.15, 2, fill(rgba("#3f8a2a")));
      for (const [a, b] of balls) ell(a * r, b * r, r * 0.52, r * 0.52, 0, fill(d.skin), 14);
      for (const [a, b] of balls) shine(a * r - r * 0.18, b * r + r * 0.18, r * 0.15, r * 0.09);
      leaf(r * 0.38, r * 1.1, r * 0.32, 0.3);
      break;
    }
    case "peach": {
      ell(0, 0, r + O, r * 0.95 + O, 0, OL, 22);
      ell(0, 0, r, r * 0.95, 0, fill(d.skin), 22);
      if (!white) {
        ell(r * 0.35, -r * 0.2, r * 0.45, r * 0.4, 0, rgba("#ff7a6a", 0.55), 14);
        seg(r * 0.05, r * 0.9, -r * 0.25, -r * 0.6, 1.6, rgba("#d9624a"));
      }
      leaf(r * 0.25, r * 1.0, r * 0.38, 0.5);
      shine(-r * 0.45, r * 0.35, r * 0.22, r * 0.13);
      break;
    }
    case "blueberry": {
      ell(0, 0, r + O, r + O, 0, OL, 20);
      ell(0, 0, r, r, 0, fill(d.skin), 20);
      if (!white) {
        for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + 0.3; ell(Math.cos(a) * r * 0.22, r * 0.55 + Math.sin(a) * r * 0.22, r * 0.12, r * 0.12, 0, rgba("#1d2a6b"), 6); }
        ell(-r * 0.4, -r * 0.1, r * 0.25, r * 0.4, 0.4, rgba("#8aa0ff", 0.35), 10);
      }
      shine(-r * 0.4, r * 0.3, r * 0.2, r * 0.12);
      break;
    }
    case "dragonfruit": {
      // pink oval with green-tipped scales
      const scales: [number, number, number][] = [[-1.05, 0.2, 2.6], [1.05, 0.15, 0.5], [-0.8, -0.65, 3.6], [0.8, -0.7, -0.6], [0, 1.15, 1.57], [-0.55, 0.95, 2.1], [0.55, 0.95, 1.0], [0, -1.12, -1.57]];
      for (const [a, b, ang] of scales) ell(a * r, b * r, r * 0.34 + O * 0.8, r * 0.16 + O * 0.8, ang, OL, 10);
      ell(0, 0, r * 0.9 + O, r * 1.05 + O, 0, OL, 22);
      for (const [a, b, ang] of scales) ell(a * r, b * r, r * 0.34, r * 0.16, ang, fill(LEAF), 10);
      ell(0, 0, r * 0.9, r * 1.05, 0, fill(d.skin), 22);
      shine(-r * 0.38, r * 0.4, r * 0.2, r * 0.12);
      break;
    }
    case "pineapple": {
      // crown of spiky leaves, a golden oval with a diamond crosshatch
      for (let i = -2; i <= 2; i++) ell(i * r * 0.18, r * 1.15, r * 0.14 + O * 0.8, r * 0.5 + O * 0.8, i * 0.32, OL, 10);
      ell(0, 0, r * 0.82 + O, r * 1.05 + O, 0, OL, 24);
      for (let i = -2; i <= 2; i++) ell(i * r * 0.18, r * 1.15, r * 0.14, r * 0.5, i * 0.32, fill(i % 2 ? LEAF : rgba("#2f9a3a")), 10);
      ell(0, 0, r * 0.82, r * 1.05, 0, fill(d.skin), 24);
      if (!white) {
        const hatch = rgba("#a8670f");
        for (const k of [-0.6, -0.2, 0.2, 0.6]) {
          seg(-r * 0.75, k * r - r * 0.4, r * 0.75, k * r + r * 0.4, 1.4, hatch);
          seg(-r * 0.75, k * r + r * 0.4, r * 0.75, k * r - r * 0.4, 1.4, hatch);
        }
      }
      shine(-r * 0.38, r * 0.45, r * 0.16, r * 0.24);
      break;
    }
    case "coconut": {
      ell(0, 0, r + O, r * 0.95 + O, 0, OL, 24);
      ell(0, 0, r, r * 0.95, 0, fill(d.skin), 24);
      if (!white) {
        for (let i = 0; i < 14; i++) { const a = i * 2.4, rr = r * (0.3 + (i % 5) * 0.13); seg(Math.cos(a) * rr, Math.sin(a) * rr, Math.cos(a) * rr + 3, Math.sin(a) * rr + 1, 1.2, rgba("#4a2c18")); }
        for (const [a, b] of [[-0.25, 0.35], [0.25, 0.35], [0, 0.05]]) ell(a * r, b * r, r * 0.12, r * 0.12, 0, rgba("#2a170c"), 8);
      }
      shine(-r * 0.45, r * 0.4, r * 0.2, r * 0.12);
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

/** One half of a sliced fruit (Fruit Ninja style): a half disc of skin with the cut face showing the flesh and seeds.
 *  side = which half (+1 / −1); rot turns the whole piece. alpha fades it out at the end of its flight. */
export function drawHalf(B: Batch, f: Fruit, x: number, y: number, rot: number, side: 1 | -1, alpha: number) {
  const d = FRUIT_DEFS[f];
  const r = d.r * (f === "banana" ? 0.8 : 1);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const P = (lx: number, ly: number): [number, number] => [x + lx * cs - ly * sn, y + lx * sn + ly * cs];
  const a = (c: Rgba): Rgba => [c[0], c[1], c[2], c[3] * alpha];
  const half = (rr: number, c: Rgba, segs = 14) => {
    const [mx, my] = P(0, 0);
    let prev = P(rr, 0);
    for (let i = 1; i <= segs; i++) {
      const t = (i / segs) * Math.PI;
      const q = P(Math.cos(t) * rr, Math.sin(t) * rr * side);
      B.tri(mx, my, prev[0], prev[1], q[0], q[1], c);
      prev = q;
    }
  };
  half(r + O, a(OL));
  half(r, a(d.skin));
  half(r * 0.8, a(d.flesh));
  // the flat cut edge, a little lighter
  const [ax, ay] = P(-r * 0.8, 0), [bx, by] = P(r * 0.8, 0);
  B.line(ax, ay, bx, by, 1.6, a(mix(d.flesh, [1, 1, 1, 1], 0.5)));
  if (d.seeds || f === "kiwi" || f === "dragonfruit") {
    const seed: Rgba = f === "strawberry" ? rgba("#ffe66b") : [0.08, 0.06, 0.05, 1];
    for (let i = 0; i < 5; i++) {
      const t = ((i + 0.5) / 5) * Math.PI;
      const [sx, sy] = P(Math.cos(t) * r * 0.5, Math.sin(t) * r * 0.5 * side);
      B.polyFill(sx, sy, 1.3, 6, 0, 1, 1.4, a(seed));
    }
  }
  if (f === "coconut") half(r * 0.55, a([0.98, 0.98, 0.95, 1]));
}
