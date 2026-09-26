const path = require("path");
const sharp = require(path.join(__dirname, "../arm/web/node_modules/sharp"));

const W = 1920, H = 1080;
const mark = path.join(__dirname, "../arm/web/scripts/brand-src/mark-chrome.png");

(async () => {
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="0.7"><stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
      <radialGradient id="r" cx="0.72" cy="0.45" r="0.45"><stop offset="0" stop-color="#22d3ee" stop-opacity="0.35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/>
    <g font-family="Arial, Helvetica, sans-serif" fill="#fff">
      <text x="140" y="360" font-size="190" font-weight="700">Arm</text>
      <text x="146" y="450" font-size="50" font-weight="600">Free meme launches on Arc</text>
      <text x="146" y="520" font-size="38" fill-opacity="0.85">78% of trading fees to the creator · USDC-priced · LP locked forever</text>
      <text x="146" y="680" font-size="46" font-weight="700">arm.yyheart.com</text>
      <text x="146" y="750" font-size="34" fill-opacity="0.85">github.com/yinyuan1990/arn</text>
      <text x="146" y="810" font-size="34" fill-opacity="0.85">t.me/armlauch2  ·  x.com/yinyuan659</text>
    </g>
  </svg>`);
  // luminance-keyed cutout of the chrome mark (black background → transparent)
  const size = 620, span = 600;
  const crop = await sharp(mark).extract({ left: 520 - span / 2, top: 512 - span / 2, width: span, height: span }).resize(size, size).toBuffer();
  const { data, info } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.max(data[i], data[i + 1], data[i + 2]);
    data[i + 3] = Math.min(255, Math.max(0, (l - 18) * 3));
  }
  const cut = await sharp(data, { raw: info }).png().toBuffer();
  await sharp(bg).composite([{ input: cut, left: 1180, top: 200 }]).png().toFile(path.join(__dirname, "endcard.png"));
  console.log("endcard ok");
})();
