/**
 * Request testnet USDC from faucet.circle.com for an address on Arc Testnet via headless Edge.
 *   node ops/faucet.mjs 0xADDRESS [--show]
 * Logs network calls so we can learn the API; saves a screenshot to ops/.tmp/faucet.png.
 */
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;

const addr = process.argv[2];
if (!addr) throw new Error("address required");
const show = process.argv.includes("--show");
const OUT = resolve(import.meta.dirname, ".tmp");
mkdirSync(OUT, { recursive: true });

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
// reCAPTCHA v3 scores headless/automated browsers poorly; use a visible window with a persistent profile
// and hide the automation flag.
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: show ? false : "shell" === "never" ? true : false,
  userDataDir: resolve(OUT, "edge-profile"),
  args: ["--no-first-run", "--window-size=1200,900", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

page.on("request", (r) => {
  const u = r.url();
  if (/faucet|api|graphql/i.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(u) && r.method() !== "GET") {
    console.log("→", r.method(), u, (r.postData() ?? "").slice(0, 300));
  }
});
page.on("response", async (r) => {
  const u = r.url();
  if (/faucet|api|graphql/i.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(u) && r.request().method() !== "GET") {
    let body = "";
    try { body = (await r.text()).slice(0, 400); } catch {}
    console.log("←", r.status(), u, body);
  }
});

await page.goto("https://faucet.circle.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForSelector("input[name=address]", { timeout: 90000 });
// Look human for the v3 scorer: linger, move the mouse, scroll a bit.
await new Promise((r) => setTimeout(r, 4000));
for (let i = 0; i < 12; i++) {
  await page.mouse.move(200 + Math.random() * 700, 150 + Math.random() * 500, { steps: 8 });
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
}
await page.mouse.wheel({ deltaY: 300 });
await new Promise((r) => setTimeout(r, 800));
await page.mouse.wheel({ deltaY: -300 });
await new Promise((r) => setTimeout(r, 1500));

// Dump interactive elements so we can drive the form.
const controls = await page.evaluate(() =>
  [...document.querySelectorAll("button, input, select, [role=combobox], [role=button]")].map((e) => ({
    tag: e.tagName,
    type: e.getAttribute("type"),
    role: e.getAttribute("role"),
    text: (e.innerText || e.getAttribute("placeholder") || e.getAttribute("aria-label") || "").trim().slice(0, 60),
    id: e.id,
    name: e.getAttribute("name"),
  })),
);
console.log(JSON.stringify(controls, null, 0));
await page.screenshot({ path: `${OUT}/faucet-0.png` });

// Dismiss cookie banner so it cannot intercept clicks.
const accept = await page.$("#onetrust-accept-btn-handler");
if (accept) {
  await accept.click().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
}

// Network toggle: ensure Arc Testnet is selected.
const netBtn = await page.$('button[name=network]');
const netText = netBtn ? (await netBtn.evaluate((e) => e.innerText)).trim() : "";
console.log("network:", netText);
if (netBtn && !/arc/i.test(netText)) {
  await netBtn.click();
  await new Promise((r) => setTimeout(r, 800));
  const arc = await page.evaluateHandle(() => [...document.querySelectorAll('[role=option], li')].find((e) => /arc testnet/i.test(e.innerText)));
  if (arc && (await arc.evaluate((e) => !!e))) await arc.asElement().click();
  await new Promise((r) => setTimeout(r, 800));
}
await page.screenshot({ path: `${OUT}/faucet-1.png` });

// Address input (React-controlled: focus + type).
const input = await page.$("input[name=address]");
await input.click({ clickCount: 3 });
await page.keyboard.press("Backspace");
await input.type(addr, { delay: 15 });
await new Promise((r) => setTimeout(r, 500));
console.log("typed:", await input.evaluate((e) => e.value));
await page.screenshot({ path: `${OUT}/faucet-2.png` });

// Log every non-GET, non-telemetry request from here on.
page.removeAllListeners("request");
page.removeAllListeners("response");
page.on("response", async (r) => {
  const u = r.url();
  if (r.request().method() === "GET" || /google|datadog|onetrust|recaptcha/i.test(u)) return;
  let body = "";
  try { body = (await r.text()).slice(0, 600); } catch {}
  console.log("←", r.status(), r.request().method(), u, "\n   req:", (r.request().postData() ?? "").slice(0, 300), "\n   res:", body);
});

const submit = await page.$('button[type=submit]');
await submit.click();
await new Promise((r) => setTimeout(r, 12000));
const finalText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
console.log("---- page text ----\n" + finalText);
await page.screenshot({ path: `${OUT}/faucet-3.png` });
await browser.close();
