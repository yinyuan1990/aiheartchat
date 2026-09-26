const path = require("path");
const sharp = require(path.join(__dirname, "../arm/web/node_modules/sharp"));

const mark = path.join(__dirname, "../arm/web/scripts/brand-src/mark-chrome.png");

// YouTube banner: full 2048×1152 shows on TV only; text/logo must sit inside the centred 1235×338 safe area
async function banner(W, out) {
  const s = W / 2048, H = Math.round(1152 * s);
  const safeW = 1235 * s, safeH = 338 * s, x0 = (W - safeW) / 2, y0 = (H - safeH) / 2;
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
      <radialGradient id="r" cx="0.62" cy="0.5" r="0.4"><stop offset="0" stop-color="#22d3ee" stop-opacity="0.35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/>
    <g font-family="Arial, Helvetica, sans-serif" fill="#fff">
      <text x="${x0 + 330 * s}" y="${y0 + 150 * s}" font-size="${128 * s}" font-weight="700">Arm</text>
      <text x="${x0 + 336 * s}" y="${y0 + 222 * s}" font-size="${46 * s}" font-weight="600">Free meme launches on Arc</text>
      <text x="${x0 + 336 * s}" y="${y0 + 282 * s}" font-size="${32 * s}" fill-opacity="0.85">78% of fees to creators · USDC-priced · arm.yyheart.com</text>
    </g>
  </svg>`);
  const size = Math.round(300 * s), span = 600;
  const crop = await sharp(mark).extract({ left: 520 - span / 2, top: 512 - span / 2, width: span, height: span }).resize(size, size).toBuffer();
  const { data, info } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.max(data[i], data[i + 1], data[i + 2]);
    data[i + 3] = Math.min(255, Math.max(0, (l - 18) * 3));
  }
  const cut = await sharp(data, { raw: info }).png().toBuffer();
  await sharp(bg).composite([{ input: cut, left: Math.round(x0 + 10 * s), top: Math.round(y0 + (safeH - size) / 2) }]).jpeg({ quality: 92 }).toFile(out);
}

(async () => {
  await banner(2048, path.join(__dirname, "youtube-banner-2048x1152.jpg"));
  await banner(1024, path.join(__dirname, "youtube-banner-1024x576.jpg"));
  console.log("banner ok");
})();
