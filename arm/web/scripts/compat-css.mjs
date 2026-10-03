// Generates src/app/compat.css: fallbacks for engines older than Tailwind v4's baseline — Chromium 99 system WebViews
// (Huawei / Honor, old Android). iOS 16.4+ and current Chromium never match these @supports blocks.
//   1. `color-mix(in oklab, X N%, transparent)` → rgb() with alpha (otherwise Tailwind falls back to the *opaque* colour,
//      e.g. `bg-foreground/[0.04]` turns solid black);
//   2. the `translate` / `scale` / `rotate` properties (Chromium 104+) → an equivalent `transform`;
//   3. dvh (Chromium 108+) → vh;
//   4. Tailwind's `filter: var(--tw-blur,) var(--tw-brightness,) …` chain, which Chromium 99 computes to `none`
//      (empty var() fallbacks) → the rule's own filter function written out.
// Reads the *built* CSS, so: `npx next build && node scripts/compat-css.mjs`, then build again. Re-run after adding
// translucent colour classes or translate/scale/rotate utilities.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "src/app/compat.css";

const cssFiles = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".css") && cssFiles.push(join(d, f))));
walk(".next/static");
if (!cssFiles.length) throw new Error("no built CSS: run `npx next build` first");
const built = cssFiles.map((f) => readFileSync(f, "utf8")).join("\n");

// ---- theme colours from globals.css: "--name: #hex | rgba(...)" in the light (:root / arc) and dark (terminal) blocks
const globals = readFileSync("src/app/globals.css", "utf8");
const block = (head) => {
  const i = globals.indexOf(head);
  return i < 0 ? "" : globals.slice(i, globals.indexOf("}", i));
};
const parseColour = (v) => {
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(" "), a: 1 };
  }
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (m) return { rgb: `${m[1]} ${m[2]} ${m[3]}`, a: m[4] ? Number(m[4]) : 1 };
  return null;
};
const themeVars = (src) => Object.fromEntries([...src.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, parseColour(v)]).filter(([, c]) => c));
const THEMES = { ':root,\n  [data-theme="arc"]': themeVars(block(':root,\n[data-theme="arc"]')), '[data-theme="terminal"]': themeVars(block('[data-theme="terminal"] {')) };

// Tailwind palette (--color-*) as emitted in the built CSS's hex fallback
const palette = {};
for (const [, k, v] of built.matchAll(/--color-([\w-]+):(#[0-9a-f]{3,8})\b/gi)) palette[k] ??= parseColour(v.length > 7 ? v.slice(0, 7) : v);

// ---- minimal CSS parser: [{ sel, decls }] with the enclosing at-rule preludes
function parse(css) {
  const out = [];
  const stack = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = css.indexOf(ch, i + 1) + 1 || css.length;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      i = css.indexOf("*/", i + 2) + 2 || css.length;
      start = i;
      continue;
    }
    if (ch === "{") {
      const head = css.slice(start, i).trim();
      if (head.startsWith("@") && !/^@(font-face|property|page)\b/.test(head) && !head.startsWith("@keyframes")) {
        stack.push(head);
        i++;
        start = i;
        continue;
      }
      // a rule (or keyframes / font-face — skipped): read to the matching brace
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      if (!head.startsWith("@")) out.push({ sel: head, body: css.slice(i + 1, j - 1), ctx: [...stack] });
      i = j;
      start = i;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i++;
      start = i;
      continue;
    }
    if (ch === ";" && css.slice(start, i).trim().startsWith("@")) {
      start = i + 1; // @layer a,b; / @import
    }
    i++;
  }
  return out;
}
const decls = (body) => {
  const res = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && !depth) {
      res.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) res.push(cur);
  return res
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(":");
      return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
    });
};

// color-mix(in <space>, <colour> N%, transparent) → rgb(... / a); null when a colour can't be resolved
function unmix(value) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("color-mix(", i);
    if (at < 0) return out + value.slice(i);
    let depth = 0;
    let j = at + "color-mix".length;
    do {
      if (value[j] === "(") depth++;
      else if (value[j] === ")") depth--;
      j++;
    } while (depth && j < value.length);
    const inner = value.slice(at + "color-mix(".length, j - 1);
    const m = inner.match(/^in [a-z]+,\s*(.+?)\s+([\d.]+)%,\s*transparent$/);
    if (!m) return null;
    const a = Number(m[2]) / 100;
    const col = m[1];
    let rep = null;
    const v = col.match(/^var\(--([\w-]+)\)$/);
    if (v && Object.values(THEMES).some((t) => t[v[1]])) {
      used.add(v[1]);
      rep = `rgb(var(--wc-${v[1]}) / calc(var(--wa-${v[1]}, 1) * ${a}))`;
    } else {
      const c = v ? (v[1].startsWith("color-") ? palette[v[1].slice(6)] : null) : parseColour(col);
      if (c) rep = `rgb(${c.rgb} / ${+(c.a * a).toFixed(4)})`;
    }
    if (!rep) return null;
    out += value.slice(i, at) + rep;
    i = j;
  }
}
const used = new Set();

const pct = (v) => (/^-?[\d.]+%$/.test(v) ? String(Number(v.slice(0, -1)) / 100) : v);
const TRANSFORM = "translate(var(--tw-translate-x, 0), var(--tw-translate-y, 0)) rotate(var(--wc-rotate, 0deg)) scale(var(--wc-scale-x, 1), var(--wc-scale-y, 1))";

const sections = { color: [], transform: [], dvh: [] };
const seen = new Set();
const wrap = (ctx, sel, body) => {
  const keep = ctx.filter((c) => !c.startsWith("@layer") && !c.startsWith("@supports"));
  return keep.reduceRight((inner, c) => `${c}{${inner}}`, `${sel}{${body}}`);
};
for (const { sel, body, ctx } of parse(built)) {
  const ds = decls(body);
  const colour = ds.filter(([, v]) => v.includes("color-mix(")).map(([k, v]) => [k, unmix(v)]).filter(([, v]) => v);
  if (colour.length) sections.color.push(wrap(ctx, sel, colour.map(([k, v]) => `${k}:${v}`).join(";")));
  const props = Object.fromEntries(ds);
  if (props.translate || props.scale || props.rotate) {
    const extra = [];
    if (props.rotate) extra.push(`--wc-rotate:${props.rotate}`);
    if (props.scale) {
      const [x, y = x] = props.scale.split(/\s+(?![^(]*\))/);
      const res = (s) => (s.startsWith("var(--tw-scale-") ? pct(props[s.slice(4, -1)] ?? "1") : pct(s));
      extra.push(`--wc-scale-x:${res(x)}`, `--wc-scale-y:${res(y)}`);
    }
    sections.transform.push(wrap(ctx, sel, [...extra, `transform:${TRANSFORM}`].join(";")));
  }
  for (const [prop, prefix] of [["filter", "--tw-"], ["backdrop-filter", "--tw-backdrop-"]]) {
    if (!props[prop]?.startsWith(`var(${prefix}`)) continue;
    const fns = ds.filter(([k]) => k.startsWith(prefix) && (prefix === "--tw-backdrop-" || !k.startsWith("--tw-backdrop-"))).map(([, v]) => v);
    if (fns.length) sections.transform.push(wrap(ctx, sel, prop === "filter" ? `filter:${fns.join(" ")}` : `-webkit-backdrop-filter:${fns.join(" ")};backdrop-filter:${fns.join(" ")}`));
  }
  const dvh = ds.filter(([, v]) => /\d(dvh|svh|lvh)\b/.test(v)).map(([k, v]) => [k, v.replace(/(\d)(dvh|svh|lvh)\b/g, "$1vh")]);
  if (dvh.length) sections.dvh.push(wrap(ctx, sel, dvh.map(([k, v]) => `${k}:${v}`).join(";")));
}
const uniq = (rules) => rules.filter((r) => !seen.has(r) && seen.add(r));

const themeVarRules = Object.entries(THEMES)
  .map(([sel, vars]) => `  ${sel} {\n${[...used].sort().filter((k) => vars[k]).map((k) => `    --wc-${k}: ${vars[k].rgb};${vars[k].a !== 1 ? ` --wa-${k}: ${vars[k].a};` : ""}`).join("\n")}\n  }`)
  .join("\n");
const color = uniq(sections.color);
const transform = uniq(sections.transform);
const dvh = uniq(sections.dvh);
const props = ["--wc-rotate", "--wc-scale-x", "--wc-scale-y"].map((p) => `@property ${p} { syntax: "*"; inherits: false; }`).join("\n");

writeFileSync(
  OUT,
  `/* Generated by scripts/compat-css.mjs — do not edit. Fallbacks for engines without color-mix() / translate / dvh
   (Chromium 99 system WebViews). Same layer as the utilities so hover / dark variants keep their usual precedence. */
${props}
@layer utilities {
@supports not (color: color-mix(in lab, red, red)) {
${themeVarRules}
${color.map((r) => "  " + r).join("\n")}
}
@supports not (translate: 0) {
${transform.map((r) => "  " + r).join("\n")}
}
@supports not (height: 100dvh) {
${dvh.map((r) => "  " + r).join("\n")}
}
}
`,
);
console.log(`${OUT}: ${color.length} colour, ${transform.length} transform, ${dvh.length} dvh rules from ${cssFiles.length} css files`);
