/**
 * Screenshot every route in both themes at desktop + mobile viewports.
 * Usage: node scripts/shots.mjs [baseUrl]   (default http://localhost:3210)
 * Output: ../docs/screens/<route>-<theme>-<device>.png
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args.splice(onlyIdx, 2)[1] : null; // e.g. --only explore
const BASE = args[0] ?? "http://localhost:3210";
const OUT = resolve(import.meta.dirname, "../../docs/screens");
mkdirSync(OUT, { recursive: true });

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find(existsSync);
if (!EDGE) throw new Error("No Edge/Chrome binary found");

const ROUTES = [
  ["explore", "/"],
  ["token", "/token/__FIRST__"],
  ["create", "/create"],
  ["creator", "/creator"],
  ["burn", "/burn"],
  ["rank", "/rank"],
];
const THEMES = ["arc", "terminal"];
const DEVICES = {
  desktop: { width: 1440, height: 1000, deviceScaleFactor: 1, isMobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run", "--hide-scrollbars"] });
const page = await browser.newPage();

// Resolve first token address from mock module output on the explore page.
await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
const firstToken = await page.$eval('a[href^="/token/"]', (a) => a.getAttribute("href").split("/").pop());

for (const [name, path] of ROUTES) {
  if (ONLY && name !== ONLY) continue;
  const url = path.replace("__FIRST__", firstToken);
  for (const theme of THEMES) {
    for (const [device, vp] of Object.entries(DEVICES)) {
      await page.setViewport(vp);
      await page.goto(`${BASE}${url}?theme=${theme}`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 600));
      const file = `${OUT}/${name}-${theme}-${device}.png`;
      await page.screenshot({ path: file, fullPage: device === "desktop" });
      console.log("saved", file);

      // Extra state: Explore → Pulse view (desktop only)
      if (name === "explore" && device === "desktop") {
        const triggers = await page.$$('button[data-slot="tabs-trigger"]');
        for (const h of triggers) {
          const txt = await h.evaluate((b) => b.textContent?.trim());
          if (txt === "Pulse") {
            await h.click(); // real pointer events: Radix tabs activate on pointerdown
            await new Promise((r) => setTimeout(r, 600));
            await page.evaluate(() => document.querySelector('[data-slot="scroll-area"]')?.scrollIntoView({ block: "start" }));
            await new Promise((r) => setTimeout(r, 300));
            const f2 = `${OUT}/explore-pulse-${theme}-desktop.png`;
            await page.screenshot({ path: f2, fullPage: false });
            console.log("saved", f2);
            break;
          }
        }
      }
    }
  }
}

await browser.close();
