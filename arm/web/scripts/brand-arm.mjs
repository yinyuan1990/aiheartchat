// Arm brand assets, all composited from the chosen artwork scripts/brand-src/mark-chrome.png
// (1024×1024, chrome "A" + glowing dot on black). Renders every PNG / JPG the site uses.
//   node scripts/brand-arm.mjs
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const out = (rel) => join(WEB, rel);
const SRC = join(import.meta.dirname, "brand-src", "mark-chrome.png");

// bounding box of the artwork inside the 1024 source (measured: x 248–793, y 237–788)
const CX = 520, CY = 512;
/** square crop of the source centred on the mark; `span` = side length in source pixels (mark itself is ~550) */
const crop = (span) => sharp(SRC).extract({ left: Math.round(CX - span / 2), top: Math.round(CY - span / 2), width: span, height: span });

const roundMask = (size, r) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`);

/** mark on its black background, `size` px square; `radius` > 0 rounds the corners (transparent outside) */
async function tile(size, { span = 760, radius = 0 } = {}) {
  const img = crop(span).resize(size, size);
  if (!radius) return img.png().toBuffer();
  return img.composite([{ input: roundMask(size, radius), blend: "dest-in" }]).png().toBuffer();
}

/** mark with the black background keyed out (alpha from luminance) — for dark surfaces only */
async function cutout(size, span = 600) {
  const { data, info } = await crop(span).resize(size, size).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const a = Math.min(255, Math.max(0, (Math.max(r, g, b) - 14) * 1.6));
    const k = a ? 255 / Math.max(a, Math.max(r, g, b)) : 0;
    rgba[j] = Math.min(255, r * k); rgba[j + 1] = Math.min(255, g * k); rgba[j + 2] = Math.min(255, b * k); rgba[j + 3] = a;
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** mark on black fading into black at the edges, so it sits seamlessly on a black canvas */
async function feathered(size, span = 900) {
  const fade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><radialGradient id="f"><stop offset="0.62" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#f)"/></svg>`);
  return crop(span).resize(size, size).ensureAlpha().composite([{ input: fade, blend: "dest-in" }]).png().toBuffer();
}

const FONT = "Segoe UI, Arial, sans-serif";
const CJK = "Microsoft YaHei, PingFang SC, sans-serif";
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const log = (rel) => console.log("  ", rel);

async function save(rel, img, kind = "png") {
  await (kind === "jpg" ? img.jpeg({ quality: 90 }) : img.png()).toFile(out(rel));
  log(rel);
}

// square marks: favicon, apple icon, default token avatar / WalletConnect icon
await save("src/app/icon.png", sharp(await tile(512, { span: 700, radius: 112 })));
await save("src/app/apple-icon.png", sharp(await tile(180, { span: 700 })));
await save("public/brand/mark.png", sharp(await tile(512, { span: 700, radius: 112 })));
await save("public/brand/logo.png", sharp(await tile(512, { span: 700 })));
await save("public/brand/logo-navy.png", sharp(await tile(512, { span: 700 })));

// Telegram channel / bot avatar: TG crops to a circle, so keep the whole mark well inside it
await save("public/brand/tg-avatar.png", sharp(await tile(640, { span: 940 })));

// lock-up (sidebar): mark + "Arm", transparent background; 728×240 = 2× of the 364×120 the layout declares.
// Light theme: chrome on a black rounded tile (silver alone washes out on white). Dark theme: keyed-out chrome.
const word = (ink, x) => svg(728, 240, `<text x="${x}" y="178" font-family="${FONT}" font-weight="800" font-size="168" letter-spacing="-6" fill="${ink}">Arm</text>`);
await save("public/brand/logo-arm.png", sharp({ create: { width: 728, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await tile(200, { span: 700, radius: 46 }), left: 12, top: 20 }, { input: word("#111111", 248), left: 0, top: 0 }]));
await save("public/brand/logo-arm-dark.png", sharp({ create: { width: 728, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await cutout(224), left: 4, top: 8 }, { input: word("#f2f2f2", 248), left: 0, top: 0 }]));

// share card 1200×630 (X / Telegram / OG preview)
const shareText = svg(1200, 630, `
  <text x="400" y="250" font-family="${FONT}" font-weight="800" font-size="160" letter-spacing="-6" fill="#ffffff">Arm</text>
  <text x="92" y="410" font-family="${CJK}" font-weight="700" font-size="54" fill="#ffffff">免费发币 · 78% 手续费归创作者 · 推广分佣</text>
  <text x="92" y="478" font-family="${FONT}" font-weight="500" font-size="34" fill="#a6a6a6">Free launches · 78% of fees to creators · Referral rewards · USDC on Arc</text>
  <line x1="92" y1="540" x2="1108" y2="540" stroke="#333333" stroke-width="2"/>
  <text x="92" y="590" font-family="${FONT}" font-weight="600" font-size="28" letter-spacing="4" fill="#737373">BUILT ON ARC</text>
  <text x="1108" y="590" text-anchor="end" font-family="${FONT}" font-weight="600" font-size="30" fill="#f2f2f2">arm.yyheart.com</text>`);
const share = async () => sharp({ create: { width: 1200, height: 630, channels: 3, background: "#000000" } })
  .composite([{ input: await feathered(340, 820), left: 60, top: 20 }, { input: shareText, left: 0, top: 0 }]);
await save("public/brand/share.jpg", await share(), "jpg");
await save("public/brand/og.png", await share());

// home hero banner 1600×506
const heroText = svg(1600, 506, `
  <text x="96" y="200" font-family="${FONT}" font-weight="800" font-size="150" letter-spacing="-6" fill="#ffffff">Arm</text>
  <text x="100" y="298" font-family="${CJK}" font-weight="700" font-size="58" fill="#ffffff">免费发币，手续费 78% 归你</text>
  <text x="100" y="368" font-family="${CJK}" font-weight="400" font-size="36" fill="#a6a6a6">开启推广分佣，让别人帮你带量 · USDC 计价 · LP 永久锁定</text>
  <text x="100" y="440" font-family="${FONT}" font-weight="600" font-size="28" letter-spacing="4" fill="#737373">MEME LAUNCHPAD ON ARC</text>`);
await save("public/brand/hero.jpg", sharp({ create: { width: 1600, height: 506, channels: 3, background: "#000000" } })
  .composite([{ input: await sharp(await feathered(620, 860)).extract({ left: 0, top: 57, width: 620, height: 506 }).toBuffer(), left: 1020, top: 0 }, { input: heroText, left: 0, top: 0 }]), "jpg");

writeFileSync(out("public/brand/README.txt"), "Generated by scripts/brand-arm.mjs from scripts/brand-src/mark-chrome.png — edit the script, not the images.\n");
console.log("done");
