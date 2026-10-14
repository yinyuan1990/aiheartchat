/**
 * Arm AI: a wallet on this PC that pays BlockRun (x402, USDC on Base) for the AI models you use in Cursor.
 *   ArmAI.exe          local UI on 127.0.0.1 + keeps the signer connection to the server open
 *   ArmAI.exe --mcp    MCP server for Cursor (stdio), paid from the same wallet
 * The server (arm.yyheart.com/api/ai) never gets the private key: it forwards BlockRun's quote and this app signs it.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createPublicClient, erc20Abi, http } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import QRCode from "qrcode";
import zh from "../i18n/zh.json" with { type: "json" };
import en from "../i18n/en.json" with { type: "json" };
import { DIR, caps, file, history, ledger, loadSecret, readJson, saveCaps, saveSecret, writeJson } from "./store.mjs";
import { BASE_USDC, connect } from "./signer.mjs";
import { editors, installMcp, mcpStatus } from "./editors.mjs";
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

if (process.argv.includes("--mcp")) {
  // the MCP server from arm/ops/x402-mcp, pointed at this wallet and this app's data dir; stdout is the MCP channel
  process.env.X402_PRIVATE_KEY = pk;
  process.env.X402_DIR = file("mcp");
  process.env.X402_API ??= `${SERVER}/api`;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(file("mcp"), { recursive: true });
  const c = caps();
  writeJson("mcp/mcp-config.json", { ...readJson("mcp/mcp-config.json", {}), maxPerCall: c.maxPerCall, dailyCap: c.dailyCap });
  await import("../../../ops/x402-mcp/server.mjs");
} else {
  await runApp();
}

async function runApp() {
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
  if (!registered()) await register().catch((e) => console.log(`register failed / 登记失败: ${e.message}`));

  const link = connect({
    url: SIGNER_URL,
    key,
    lang,
    account,
    onStatus: async (s) => {
      // the server forgot us (or never knew): register again, then the reconnect loop picks it up
      if (s === "unregistered") {
        status = "unregistered";
        await register().catch(() => {});
        return;
      }
      status = s;
    },
    onSigned: (m, out) => console.log(`${new Date().toLocaleTimeString()} ${out.t === "signed" ? "signed / 已签" : "refused / 拒绝"} ${m.model} $${(Number(m.accepted?.amount ?? 0) / 1e6).toFixed(4)}${out.reason ? ` (${out.reason})` : ""}`),
  });

  // ---------------------------------------------------------------- chain + server reads for the UI
  const chain = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  let usdc = null;
  const refreshBalance = () => chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).then((b) => (usdc = Number(b)), () => {});
  void refreshBalance();
  setInterval(refreshBalance, 20_000);
  let found = editors.map((e) => ({ e, installs: e.detect() }));
  let modelsCache = null;
  const authed = (path, init = {}) => fetch(`${SERVER}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });

  // ---------------------------------------------------------------- local UI server
  const ui = readJson("ui.json", {});
  const nonce = randomBytes(16).toString("hex");
  const routes = {
    "GET /api/state": () => ({
      version: VERSION, address: account.address, usdc, status, lang: lang(), caps: caps(), today: ledger(), baseUrl: BASE_URL, key, examples: EXAMPLES,
      editors: found.map(({ e, installs }) => ({ id: e.id, name: e.name, installs, mcp: mcpStatus(e) })),
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
    "POST /api/mcp": (b) => {
      const e = editors.find((x) => x.id === b.editor);
      if (!e) return { error: "unknown editor" };
      try {
        return installMcp(e);
      } catch (err) {
        return { error: err.message };
      }
    },
    "POST /api/register": async () => {
      await register().catch((e) => console.log(`register failed / 登记失败: ${e.message}`));
      link.reconnect();
      return { status };
    },
    "POST /api/export": (b) => (b.confirm === true ? { privateKey: pk } : { error: "confirm" }),
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
      let server = [];
      try {
        server = (await (await authed("/api/ai/v1/stats?limit=60")).json()).calls ?? [];
      } catch {}
      return { local: history(60), server: server.map(({ shape, ...c }) => c) };
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
      // another Arm AI already running: just show its window
      const other = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text(), () => "");
      if (other.startsWith("arm-ai ") && ui.url) {
        open(ui.url);
        process.exit(0);
      }
      if (i >= 20) throw e;
      port++;
    }
  }
  const url = `http://127.0.0.1:${port}/?n=${nonce}`;
  writeJson("ui.json", { port, url });
  console.log(`Arm AI ${VERSION}  ${account.address}`);
  console.log(`界面 / UI: ${url}`);
  console.log("使用 Cursor 时请保持这个窗口打开；关掉窗口就停止签名。 / Keep this window open while you use Cursor; closing it stops signing.");
  console.log(`数据目录 / Data: ${DIR}`);
  if (!process.argv.includes("--no-open")) open(url);
}

function open(url) {
  if (process.platform === "win32") execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
  else execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}
