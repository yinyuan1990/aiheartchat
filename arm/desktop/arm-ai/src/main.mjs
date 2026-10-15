/**
 * Arm AI: a wallet on this PC that pays BlockRun (x402, USDC on Base) for the AI models you use in Cursor.
 * Local UI on 127.0.0.1 + keeps the signer connection to the server open.
 * The server (arm.yyheart.com/api/ai) never gets the private key: it forwards BlockRun's quote and this app signs it.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import zh from "../i18n/zh.json" with { type: "json" };
import en from "../i18n/en.json" with { type: "json" };
import { DIR, caps, fees, file, history, ledger, loadSecret, readJson, saveCaps, saveSecret, writeJson } from "./store.mjs";
import { BASE_USDC, FEE_BPS, FEE_TO, connect, feeRoom, reconcileFees } from "./signer.mjs";
import { editors } from "./editors.mjs";
import { download, downloadState, openPage, run } from "./exchanges.mjs";
import { clineConfigure, clineHosts, clineInstall, clineJobs, clineStatus, openVscodePage } from "./cline.mjs";
import { page } from "./page.mjs";

const VERSION = "0.1.0";
const SERVER = (process.env.ARM_AI_SERVER ?? "https://arm.yyheart.com").replace(/\/$/, "");
const BASE_URL = `${SERVER}/api/ai/v1`;
const SIGNER_URL = `${SERVER.replace(/^http/, "ws")}/api/ai/signer`;
const EXAMPLES = ["anthropic/claude-opus-5.5", "openai/gpt-6.1-sol", "deepseek/deepseek-chat"];
const locales = { zh, en };

// ------------------------------------------------------------------ wallet + API key (both DPAPI-encrypted)
let pk = loadSecret("wallet.json");
if (!pk) {
  pk = generatePrivateKey();
  saveSecret("wallet.json", pk);
}
const account = privateKeyToAccount(pk);

await runApp();

async function runApp() {
  // already running with this wallet: only show its window. Checked first, so the running copy keeps its signer link.
  const ui = readJson("ui.json", {});
  if (ui.port && ui.url) {
    const other = await fetch(`http://127.0.0.1:${ui.port}/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text(), () => "");
    if (other === `arm-ai ${account.address}`) {
      if (!process.argv.includes("--no-open")) open(ui.url);
      process.exit(0);
    }
  }
  let key = loadSecret("apikey.json");
  if (!key) {
    key = `armai_${randomBytes(24).toString("hex")}`;
    saveSecret("apikey.json", key);
  }
  const settings = () => readJson("settings.json", {});
  const lang = () => settings().lang ?? "zh";
  let status = "registering";

  async function register() {
    status = "registering";
    const keyHash = createHash("sha256").update(key).digest("hex");
    const at = new Date().toISOString();
    const message = `Arm AI\nLink API key ${keyHash}\nto wallet ${account.address}\nat ${at}`;
    const signature = await account.signMessage({ message });
    const r = await fetch(`${SERVER}/api/ai/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address, keyHash, at, signature, lang: lang() }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    writeJson("registered.json", { address: account.address, keyHash, at });
  }
  const registered = () => {
    const r = readJson("registered.json", null);
    return r?.address === account.address && r.keyHash === createHash("sha256").update(key).digest("hex");
  };
  if (!registered()) await register().catch((e) => log(`register failed / 登记失败: ${e.message}`));

  const chain = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const link = connect({
    url: SIGNER_URL,
    key,
    lang,
    account,
    chain,
    onStatus: async (s) => {
      // the server forgot us (or never knew): register again, then the reconnect loop picks it up
      if (s === "unregistered") {
        status = "unregistered";
        await register().catch(() => {});
        return;
      }
      status = s;
    },
    onSigned: (m, out) => {
      const what = m.t === "fee" ? `fee ${FEE_BPS / 100}% to ${FEE_TO}` : m.model;
      const amount = m.t === "fee" ? (out.amount ?? 0) : Number(m.accepted?.amount ?? 0);
      log(`${out.t === "refuse" ? "refused / 拒绝" : "signed / 已签"} ${what} $${(amount / 1e6).toFixed(4)}${out.reason ? ` (${out.reason})` : ""}`);
    },
    // the operator decides per user whether the Binance / OKX top-up page is shown; kept for when the server is unreachable
    onConfig: (m) => {
      const exchanges = m.exchanges === true;
      if (settings().exchanges !== exchanges) writeJson("settings.json", { ...settings(), exchanges });
    },
  });
  const reconcile = () => void reconcileFees(chain, account.address).catch(() => {});
  reconcile();
  setInterval(reconcile, 120_000);

  // ---------------------------------------------------------------- chain + server reads for the UI
  let usdc = null;
  const refreshBalance = () => chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).then((b) => (usdc = Number(b)), () => {});
  void refreshBalance();
  setInterval(refreshBalance, 20_000);
  let found = editors.map((e) => ({ e, installs: e.detect() }));
  let modelsCache = null;
  const authed = (path, init = {}) => fetch(`${SERVER}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });

  // ---------------------------------------------------------------- local UI server
  const nonce = randomBytes(16).toString("hex");
  const routes = {
    "GET /api/state": () => ({
      version: VERSION, address: account.address, usdc, status, lang: lang(), caps: caps(), today: ledger(), baseUrl: BASE_URL, key, examples: EXAMPLES, dataDir: DIR, logFile: file("armai.log"), exchanges: settings().exchanges === true,
      fee: (({ signed, paid, pending }) => ({ bps: FEE_BPS, to: FEE_TO, signed, paid, pending: pending.reduce((s, p) => s + p.amount, 0), room: feeRoom() }))(fees()),
      editors: found.map(({ e, installs }) => ({ id: e.id, name: e.name, installs })),
    }),
    "POST /api/caps": (b) => {
      const per = Number(b.maxPerCall), day = Number(b.dailyCap);
      if (!(per > 0 && per <= 100 && day > 0 && day <= 10_000)) return { error: "bad caps" };
      return saveCaps({ maxPerCall: per, dailyCap: day });
    },
    "POST /api/lang": (b) => {
      if (!locales[b.lang] || b.lang === lang()) return { lang: lang() };
      writeJson("settings.json", { ...settings(), lang: b.lang });
      link.setLang(b.lang);
      return { lang: b.lang };
    },
    "POST /api/rescan": () => {
      found = editors.map((e) => ({ e, installs: e.detect() }));
      return { ok: true };
    },
    "POST /api/register": async () => {
      await register().catch((e) => log(`register failed / 登记失败: ${e.message}`));
      link.reconnect();
      return { status };
    },
    "GET /api/download": () => downloadState(),
    "POST /api/download": (b) => download(b.id, log),
    "POST /api/download/run": (b) => run(b.id),
    "POST /api/download/page": (b) => openPage(b.id),
    "GET /api/cline": () => ({ hosts: clineHosts().map(({ cli, extDir, ...h }) => h), status: clineStatus(BASE_URL, key), jobs: clineJobs() }),
    "POST /api/cline/install": (b) => clineInstall(b.exe, log),
    // any id is allowed: BlockRun's free models work but are listed as unavailable, so they are not in the list
    "POST /api/cline/config": async (b) => {
      const list = await routes["GET /api/models"]().catch(() => []);
      return clineConfigure({ baseUrl: BASE_URL, key, model: b.model, info: list.find((m) => m.id === b.model) }, log);
    },
    "POST /api/cline/vscode": () => openVscodePage(),
    "POST /api/export": (b) => (b.confirm === true ? { privateKey: pk } : { error: "confirm" }),
    // there is no console window to close any more: this is how the user stops signing
    "POST /api/quit": () => {
      log("quit from the UI / 从界面退出");
      setTimeout(() => process.exit(0), 300);
      return { ok: true };
    },
    "POST /api/test": async () => {
      try {
        const r = await authed("/api/ai/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "nvidia/llama-3.3-nemotron-super-49b-v1.5", max_tokens: 60, messages: [{ role: "user", content: "Reply with exactly: OK, Arm AI works." }] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j.error?.message ?? `HTTP ${r.status}` };
        const text = String(j.choices?.[0]?.message?.content ?? "").split("</think>").pop().trim();
        return { ok: true, answer: text.slice(0, 120) || "(empty)" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    "GET /api/log": async () => {
      let server = [], fee = null;
      try {
        const j = await (await authed("/api/ai/v1/stats?limit=60")).json();
        server = j.calls ?? [];
        fee = j.fee ?? null;
      } catch {}
      return { local: history(60), server: server.map(({ shape, ...c }) => c), fee };
    },
    "GET /api/models": async () => {
      if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.v;
      const j = await (await fetch(`${SERVER}/api/x402/models`, { signal: AbortSignal.timeout(20_000) })).json().catch(() => []);
      modelsCache = { at: Date.now(), v: Array.isArray(j) ? j : [] };
      return modelsCache.v;
    },
  };
  const srv = createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) return res.writeHead(403).end();
    const url = new URL(req.url, `http://${host}`);
    if (req.method === "GET" && url.pathname === "/ping") return res.writeHead(200, { "content-type": "text/plain" }).end(`arm-ai ${account.address}`);
    if (req.method === "GET" && url.pathname === "/") {
      if (url.searchParams.get("n") !== nonce) return res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Open Arm AI from the app window. / 请从 Arm AI 程序打开。");
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page({ nonce, locales }));
    }
    if (req.headers["x-arm-nonce"] !== nonce) return res.writeHead(403).end();
    if (req.method === "GET" && url.pathname === "/api/qr") {
      const svg = await QRCode.toString(account.address, { type: "svg", margin: 0 });
      return res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
    }
    const fn = routes[`${req.method} ${url.pathname}`];
    if (!fn) return res.writeHead(404).end();
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
    }
    try {
      const out = await fn(body);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
  });

  const listen = (port) => new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(port));
  });
  let port = Number(ui.port ?? 47403);
  for (let i = 0; ; i++) {
    try {
      await listen(port);
      break;
    } catch (e) {
      if (i >= 20) throw e;
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/?n=${nonce}`;
  writeJson("ui.json", { port, url });
  log(`Arm AI ${VERSION}  ${account.address}  data ${DIR}`);
  log(`UI ${url}`);
  if (!process.argv.includes("--no-open")) open(url);
}

/** the packaged app has no console window: everything worth knowing goes to %APPDATA%\ArmAI\armai.log (and stdout) */
function log(msg) {
  try {
    appendFileSync(file("armai.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
  console.log(msg);
}

/** the UI as its own app window (Edge / Chrome app mode, own profile so it is a separate window); browser tab as fallback */
function open(url) {
  if (process.platform !== "win32") return execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  const pf = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browser = [
    ...pf.map((p) => join(p, "Microsoft", "Edge", "Application", "msedge.exe")),
    ...pf.map((p) => join(p, "Google", "Chrome", "Application", "chrome.exe")),
  ].find((p) => existsSync(p));
  if (!browser) return execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
  spawn(browser, [`--app=${url}`, `--user-data-dir=${file("window")}`, "--window-size=1200,900", "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" }).unref();
}
