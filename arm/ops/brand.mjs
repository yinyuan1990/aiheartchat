/**
 * Generate every brand asset from one source PNG (the swoosh-arrow mark on navy).
 *
 *   node ops/brand.mjs [web/brand-src/logo.png]
 *
 * Outputs (all under web/):
 *   src/app/icon.png          512×512  favicon (Next.js picks it up automatically)
 *   src/app/apple-icon.png    180×180  iOS home-screen icon
 *   public/brand/logo.png     512×512  mark with the navy background keyed to transparent (header / cards)
 *   public/brand/logo-navy.png 512×512 mark on navy, rounded corners (social avatars, docs)
 *   public/brand/og.png       1200×630 Open Graph / Twitter card
 *   public/brand/arcl.png     512×512  platform token logo (same mark on navy)
 *
 * Uses the `sharp` that ships with Next.js; no extra install.
 */
import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..", "web");
const require = createRequire(resolve(web, "package.json"));
const sharp = require("sharp");

const candidates = process.argv[2]
  ? [resolve(process.argv[2])]
  : ["png", "jpg", "jpeg", "webp"].map((ext) => resolve(web, "brand-src", `logo.${ext}`));
const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error(`source not found. Save the original as web/brand-src/logo.(png|jpg|webp) or pass a path.`);
  process.exit(1);
}
console.log("source:", src);
const NAVY = "#0b1020";
const out = (p) => resolve(web, p);
for (const d of ["src/app", "public/brand"]) mkdirSync(out(d), { recursive: true });

/** Key the flat navy background to transparent. The mark is bright (violet→cyan), the background is very dark,
 *  so luminance alone separates them; a soft ramp keeps the anti-aliased edges clean. Then trim the empty
 *  margins and re-center the mark so it fills `1 - 2*pad` of the square (the source has a lot of dead space). */
async function keyed(size, pad = 0.08) {
  const work = 1024;
  const { data, info } = await sharp(src).resize(work, work, { fit: "cover" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const LO = 42, HI = 90; // lum below LO → fully transparent, above HI → opaque
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const a = Math.max(0, Math.min(1, (lum - LO) / (HI - LO)));
    data[i + 3] = Math.round(data[i + 3] * a);
  }
  // The render has a floor reflection under the mark. Find the darkest row band in the lower half
  // (the gap between mark and reflection) and drop everything below it.
  const rowAlpha = new Array(work).fill(0);
  for (let y = 0; y < work; y++) for (let x = 0; x < work; x++) rowAlpha[y] += data[(y * work + x) * 4 + 3];
  let gapY = -1, best = Infinity;
  for (let y = Math.floor(work * 0.55); y < Math.floor(work * 0.95); y++) {
    if (rowAlpha[y] < best) { best = rowAlpha[y]; gapY = y; }
  }
  const hasReflection = gapY > 0 && rowAlpha.slice(gapY + 1).some((v) => v > work * 8);
  if (hasReflection && best < work * 2) {
    for (let y = gapY; y < work; y++) data.fill(0, y * work * 4, (y + 1) * work * 4);
  }
  const trimmed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().trim({ threshold: 8 }).toBuffer();
  const inner = Math.round(size * (1 - 2 * pad));
  const mark = await sharp(trimmed).resize(inner, inner, { fit: "inside" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, gravity: "centre" }])
    .png();
}

async function onNavy(size, radius) {
  const mark = await keyed(size, 0.12).then((s) => s.toBuffer());
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`);
  return sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: mark }, { input: mask, blend: "dest-in" }])
    .png();
}

async function og() {
  const W = 1200, H = 630, M = 360;
  const mark = await keyed(M, 0).then((s) => s.toBuffer());
  const text = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="520" y="290" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="96" font-weight="800" fill="#e5e7eb" letter-spacing="-2">Arc<tspan fill="#22d3ee">Launch</tspan></text>
    <text x="522" y="350" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="34" fill="#9ca3af">Launch tokens on Arc · settled in USDC</text>
    <text x="522" y="400" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="24" fill="#6b7280">Fair launch · LP locked forever · 75% of fees to creators</text>
  </svg>`);
  return sharp({ create: { width: W, height: H, channels: 4, background: NAVY } })
    .composite([{ input: mark, left: 110, top: (H - M) / 2 }, { input: text }])
    .png();
}

await (await keyed(512)).toFile(out("public/brand/logo.png"));
await (await onNavy(512, 96)).toFile(out("public/brand/logo-navy.png"));
await (await onNavy(512, 96)).toFile(out("public/brand/arcl.png"));
await (await onNavy(512, 0)).toFile(out("src/app/icon.png"));
await (await onNavy(180, 0)).toFile(out("src/app/apple-icon.png"));
await (await og()).toFile(out("public/brand/og.png"));

console.log("brand assets written:");
for (const p of ["src/app/icon.png", "src/app/apple-icon.png", "public/brand/logo.png", "public/brand/logo-navy.png", "public/brand/arcl.png", "public/brand/og.png"]) console.log("  web/" + p);
