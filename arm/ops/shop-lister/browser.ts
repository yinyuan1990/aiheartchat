/**
 * 用登录过闲鱼的浏览器抓 (10.10): Chrome with the lister's own profile (%USERPROFILE%\.arm-shop-admin\browser-profile;
 * Chrome does not let automation drive the user's main profile, and its cookies are encrypted per app). Log in to
 * Xianyu once in that window; grabs then open the item page there and read the detail API answer the page itself gets.
 * A login page or slider stays on screen for the operator to deal with.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ImportError, type ItemDO } from "../../indexer/src/shop-import";

const PROFILE = join(homedir(), ".arm-shop-admin", "browser-profile");
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DETAIL = /mtop\.taobao\.idle\.(awesome|pc)\.detail/;
const WAIT_MS = 120_000;

let browser: Browser | null = null;

function chromePath() {
  const local = process.env.LOCALAPPDATA ?? "";
  const list = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(local, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  const hit = list.find((p) => existsSync(p));
  if (!hit) throw new Error("没找到 Chrome 或 Edge");
  return hit;
}

async function open() {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    userDataDir: PROFILE,
    defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,900"],
  });
  browser.on("disconnected", () => (browser = null));
  return browser;
}

/** open goofish.com in the lister's browser so the operator can log in (QR code) */
export async function openLogin() {
  const b = await open();
  const p = await b.newPage();
  await p.goto("https://www.goofish.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.bringToFront();
}

/** logged in = Taobao's login cookies are on goofish.com in this profile */
export async function loginState(): Promise<{ open: boolean; loggedIn: boolean; nick: string }> {
  if (!browser?.connected) return { open: false, loggedIn: false, nick: "" };
  const cookies = await browser.defaultBrowserContext().cookies();
  const mine = cookies.filter((c) => /goofish\.com$/.test(c.domain.replace(/^\./, "")));
  const raw = mine.find((c) => c.name === "tracknick")?.value ?? "";
  let nick = raw;
  try {
    nick = JSON.parse(`"${raw}"`);
  } catch {}
  return { open: true, loggedIn: mine.some((c) => c.name === "unb" || c.name === "cookie2") && !!raw, nick };
}

function watch(p: Page): Promise<ItemDO> {
  return new Promise((resolve) => {
    p.on("response", async (r) => {
      if (!DETAIL.test(r.url())) return;
      const t = await r.text().catch(() => "");
      try {
        const j = JSON.parse(t.replace(/^[^{]*\(/, "").replace(/\)\s*$/, "")) as { ret?: string[]; data?: { itemDO?: ItemDO } };
        if (j.ret?.[0]?.startsWith("SUCCESS") && j.data?.itemDO) resolve(j.data.itemDO);
      } catch {}
    });
  });
}

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/** the item's detail record, read inside the logged-in browser (mobile page first, then the PC page) */
export async function grabInBrowser(itemId: string): Promise<ItemDO> {
  const b = await open();
  const p = await b.newPage();
  await p.setUserAgent(MOBILE_UA);
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const got = watch(p);
  await p.goto(`https://h5.m.goofish.com/item?id=${itemId}&itemId=${itemId}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  let it = await Promise.race([got, sleep(15_000)]);
  if (!it) {
    // PC page with the desktop identity (that is where the login lives); a slider / login prompt waits for the operator
    await p.setUserAgent((await b.userAgent()).replace(/Headless/, ""));
    await p.setViewport(null);
    await p.bringToFront();
    await p.goto(`https://www.goofish.com/item?id=${itemId}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    it = await Promise.race([got, sleep(WAIT_MS)]);
  }
  if (!it) throw new ImportError("busy", "browser got no detail");
  console.log(`grabbed ${itemId} in the browser (${p.url().includes("h5.m.") ? "mobile" : "PC"} page)`);
  await p.close().catch(() => {});
  return it;
}
