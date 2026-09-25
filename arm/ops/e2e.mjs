/**
 * Browser end-to-end test against the live site with a real (test) wallet.
 * A minimal EIP-1193 provider is injected into the page; signing happens in Node via viem.
 *
 *   node ops/e2e.mjs [https://arm.yyheart.com]
 * Screenshots → docs/screens/e2e-*.png ; summary → ops/.tmp/e2e-report.json
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const BASE = process.argv[2] ?? "https://arm.yyheart.com";
const OUT = resolve(import.meta.dirname, "../docs/screens");
mkdirSync(OUT, { recursive: true });
const wallet = JSON.parse(readFileSync(resolve(import.meta.dirname, ".tmp/e2e-wallet.json"), "utf8"));
const account = privateKeyToAccount(wallet.privateKey);
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const wc = createWalletClient({ account, chain: arcTestnet, transport: http() });
const USDC = "0x3600000000000000000000000000000000000000";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const report = { wallet: account.address, steps: [], txs: [] };
const log = (m, extra = {}) => { console.log("•", m); report.steps.push({ m, ...extra, t: new Date().toISOString() }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- wallet bridge (Node side)
async function handle(method, params = []) {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts": return [account.address];
    case "eth_chainId": return "0x" + arcTestnet.id.toString(16);
    case "net_version": return String(arcTestnet.id);
    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
    case "wallet_requestPermissions": return null;
    case "eth_sendTransaction": {
      const tx = params[0];
      const hash = await wc.sendTransaction({
        to: tx.to, data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      });
      report.txs.push(hash);
      console.log("   ↳ tx", hash);
      return hash;
    }
    case "personal_sign": return account.signMessage({ message: { raw: params[0] } });
    default: return pub.transport.request({ method, params });
  }
}

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run", "--hide-scrollbars", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => { if (m.type() === "error") console.log("   [console.error]", m.text().slice(0, 200)); });

await page.exposeFunction("__walletBridge", async (json) => {
  const { method, params } = JSON.parse(json);
  try { return JSON.stringify({ result: await handle(method, params) }); }
  catch (e) { return JSON.stringify({ error: { code: -32000, message: e.shortMessage ?? e.message } }); }
});
await page.evaluateOnNewDocument(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    _e2e: true,
    async request(args) {
      const r = JSON.parse(await window.__walletBridge(JSON.stringify(args)));
      if (r.error) { const err = new Error(r.error.message); err.code = r.error.code; throw err; }
      return r.result;
    },
    on(ev, fn) { (listeners[ev] ??= []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
});

const shot = (name) => page.screenshot({ path: `${OUT}/e2e-${name}.png` });
const clickByText = async (re, tag = "button") => {
  const els = await page.$$(tag);
  for (const el of els) {
    const txt = (await el.evaluate((e) => e.textContent ?? "")).trim();
    if (re.test(txt)) { await el.click(); return txt; }
  }
  throw new Error(`no ${tag} matching ${re}`);
};
const waitText = async (re, ms = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const body = await page.evaluate(() => document.body.innerText);
    if (re.test(body)) return true;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${re}`);
};

const usdcBal = async () => Number(formatUnits(await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] }), 6));

try {
  log(`wallet ${account.address} usdc=${await usdcBal()}`);

  // 1) home + connect
  await page.goto(`${BASE}/?theme=arc&lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await clickByText(/^connect( wallet)?$/i);
  await sleep(2500);
  // header shows the address as 0xAB…CDEF (4 + 4)
  await waitText(new RegExp(account.address.slice(0, 4) + ".*" + account.address.slice(-4), "i"), 20_000);
  log("connected", { shown: account.address.slice(0, 4) + "…" + account.address.slice(-4) });
  await shot("01-connected");

  // 2) create token
  await page.goto(`${BASE}/create?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  const sym = "E2E" + Math.floor(Math.random() * 900 + 100);
  await page.type("#name", `E2E Token ${sym}`);
  await page.type("#symbol", sym);
  await clickByText(/^next$/i);
  await sleep(400);
  await page.type("#desc", "Automated end-to-end launch from ops/e2e.mjs");
  await page.type("#x", "https://x.com/arm_");
  await clickByText(/^next$/i);
  await sleep(400);
  // opening mcap is platform-wide (fair launch) — the form only displays it
  await waitText(/fair launch/i, 10_000);
  await page.type("#buy", "1");
  await sleep(1200);
  await shot("02-create-form");
  await clickByText(/launch on arc/i);
  log("launch clicked; approving + launching…");
  await waitText(/Launched!|发射成功/i, 120_000);
  log("launched", { symbol: sym });
  await sleep(4000);
  await page.waitForFunction(() => location.pathname.startsWith("/token/"), { timeout: 30_000 });
  const tokenAddr = page.url().split("/token/")[1].split("?")[0];
  log("redirected to token page", { token: tokenAddr });
  await page.waitForSelector("input[type=number]", { timeout: 60_000 });
  await sleep(2500);
  await shot("03-token-page");

  // 2b) watchlist toggle (localStorage) + new header metrics
  await clickByText(/^watch$/i);
  await sleep(500);
  await waitText(/watching/i, 5_000);
  await waitText(/FDV/i, 5_000);
  await waitText(/liquidity/i, 5_000);
  log("watch toggled; FDV + liquidity shown");

  // 3) buy 1 USDC
  await page.type("input[type=number]", "1");
  await sleep(2500); // quote
  await clickByText(/review trade/i);
  await sleep(800);
  await shot("04-review-buy");
  await clickByText(/confirm buy/i);
  await waitText(/Buy .*Transaction confirmed|交易成功/i, 90_000);
  log("buy confirmed");
  await sleep(6000);

  // 4) sell 50%
  await clickByText(/^sell$/i);
  await sleep(1500);
  await clickByText(/^50%$/);
  await sleep(2500);
  await clickByText(/review trade/i);
  await sleep(800);
  await clickByText(/confirm sell/i);
  await waitText(/Sell .*Transaction confirmed|交易成功/i, 90_000);
  log("sell confirmed");
  await sleep(6000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(3000);
  await shot("05-after-trades");

  // 5) verify indexer picked the trades up
  const trades = await fetch(`${BASE}/api/tokens/${tokenAddr}/trades`).then((r) => r.json());
  log("indexer trades", { count: trades.length, sides: trades.map((t) => t.side) });
  if (trades.length < 3) throw new Error("expected initial buy + buy + sell in indexer");

  // 5b) wallet-signed comment + like
  await clickByText(/^thread$/i);
  await sleep(800);
  await page.type("textarea", `gm from e2e ${sym} 🚀`);
  await clickByText(/post a reply/i);
  await waitText(/gm from e2e/i, 30_000);
  log("comment posted (signed)");
  await sleep(1200);
  const likeBtn = (await page.$$("button")).find(async () => false); // placeholder to keep types simple
  void likeBtn;
  const hearts = await page.$$('button:has(svg.lucide-heart)');
  if (hearts.length) {
    await hearts[hearts.length - 1].click();
    await sleep(2500);
    log("like toggled (signed)");
  }
  const comments = await fetch(`${BASE}/api/tokens/${tokenAddr}/comments`).then((r) => r.json());
  if (!comments.length || !comments[0].isCreator) throw new Error("comment missing or not flagged as creator");
  log("indexer comments", { count: comments.length, likes: comments[0].likes });
  await shot("05b-thread");

  // 5c) logo upload API (1×1 PNG)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "logo.png");
  const up = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd }).then((r) => r.json());
  if (!up.url) throw new Error("upload failed: " + JSON.stringify(up));
  const served = await fetch(up.url);
  if (served.status !== 200 || served.headers.get("content-type") !== "image/png") throw new Error("uploaded logo not served");
  log("logo upload + serve ok", { url: up.url });

  // 5d) treasury settlements (v2.10: /burn is retired and redirects home; settlements are plain transfers)
  const tr = await fetch(`${BASE}/api/treasury`).then((r) => r.json());
  log("treasury", { settlements: tr.settlements.length, toBuyback: Number(tr.totalToBuybackUsdc) / 1e6, buybackFund: tr.buybackFund });

  // 6) creator page
  await page.goto(`${BASE}/creator?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  await waitText(new RegExp(sym), 20_000);
  await waitText(/payout address/i, 10_000);
  const creatorApi = await fetch(`${BASE}/api/creator/${account.address}`).then((r) => r.json());
  const mine = creatorApi.tokens.find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase());
  if (!mine || mine.payout.toLowerCase() !== account.address.toLowerCase()) throw new Error("creator API payout mismatch");
  await shot("06-creator");
  log("creator page shows the new token + payout row; API payout ok");

  // 6b) docs page renders with live config
  await page.goto(`${BASE}/docs?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  await waitText(/Integration/i, 15_000);
  await waitText(/TokenLaunched \(topic0\)/i, 15_000);
  await waitText(/Standard tokens/i, 15_000);
  await shot("06b-docs");
  log("docs page ok (integration + standard-token section)");

  // 6c) home watchlist tab lists the watched token
  await page.goto(`${BASE}/?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  await clickByText(/watchlist/i);
  await sleep(1500);
  await waitText(new RegExp(sym), 15_000);
  log("watchlist tab shows the token");

  // 7) portfolio
  await page.goto(`${BASE}/me?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  await waitText(new RegExp(sym), 20_000);
  await shot("07-portfolio");
  log("portfolio shows holding");

  // 8) home shows it in the grid + activity
  await page.goto(`${BASE}/?lang=en`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  await waitText(new RegExp(sym), 20_000);
  await shot("08-home-after");
  log(`home lists ${sym}`, { usdcLeft: await usdcBal() });

  report.ok = true;
  report.token = tokenAddr;
} catch (e) {
  report.ok = false;
  report.error = e.message;
  console.error("E2E FAILED:", e.message);
  await shot("99-failure").catch(() => {});
} finally {
  writeFileSync(resolve(import.meta.dirname, ".tmp/e2e-report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(report.ok ? "E2E_OK" : "E2E_FAILED");
}
