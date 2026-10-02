// Vertical end card for the Sell the Top promo: node game-endcard.cjs <out.png>
const path = require("path");
const sharp = require(path.join(__dirname, "../arm/web/node_modules/sharp"));

const W = 1080, H = 1920;
const mark = path.join(__dirname, "../arm/web/scripts/brand-src/mark-chrome.png");
const out = process.argv[2] || path.join(__dirname, "build/game/endcard.png");

(async () => {
  const sq = Array.from({ length: 10 }, (_, i) =>
    `<rect x="${140 + i * 82}" y="1090" width="66" height="66" rx="12" fill="${i < 8 ? "#3ddc97" : "#2a2a2a"}"/>`).join("");
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="a" cx="0.85" cy="0.05" r="0.7"><stop offset="0" stop-color="#3ddc97" stop-opacity="0.28"/><stop offset="1" stop-color="#3ddc97" stop-opacity="0"/></radialGradient>
      <radialGradient id="b" cx="0.05" cy="0.95" r="0.6"><stop offset="0" stop-color="#f5c451" stop-opacity="0.16"/><stop offset="1" stop-color="#f5c451" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="#050505"/><rect width="100%" height="100%" fill="url(#a)"/><rect width="100%" height="100%" fill="url(#b)"/>
    <g font-family="Arial, Helvetica, sans-serif" fill="#fff">
      <text x="140" y="760" font-size="64" fill="#8a8a8a" letter-spacing="6">DAILY · FREE</text>
      <text x="134" y="900" font-size="150" font-weight="700">Sell the Top</text>
      <text x="140" y="1010" font-size="46" fill-opacity="0.85">One real Arc launch a day. One tap.</text>
      ${sq}
      <text x="140" y="1300" font-size="40" fill-opacity="0.75">No token · no gas · no prizes</text>
      <text x="140" y="1500" font-size="70" font-weight="700">arm.yyheart.com/game</text>
      <text x="140" y="1580" font-size="38" fill-opacity="0.7">Real Arc mainnet data</text>
    </g>
  </svg>`);
  // luminance-keyed cutout of the chrome mark (black background → transparent)
  const size = 380, span = 600;
  const crop = await sharp(mark).extract({ left: 520 - span / 2, top: 512 - span / 2, width: span, height: span }).resize(size, size).toBuffer();
  const { data, info } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.max(data[i], data[i + 1], data[i + 2]);
    data[i + 3] = Math.min(255, Math.max(0, (l - 18) * 3));
  }
  const cut = await sharp(data, { raw: info }).png().toBuffer();
  await sharp(bg).composite([{ input: cut, left: 110, top: 240 }]).png().toFile(out);
  console.log("endcard ok");
})();
