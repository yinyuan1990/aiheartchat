/**
 * Shared by the MCP server (server.mjs) and the local picker UI (ui.mjs): BlockRun chat models paid per call in USDC on
 * Base over x402 with the local wallet, through the Arm relay. Quotes are checked before signing (exact USDC on Base to
 * BlockRun's known payee, within the caps); nothing is added on top of BlockRun's price.
 *
 * Files in ~/.arm-x402-test/: key.json (wallet, never logged), mcp-config.json (default model + caps, written by the
 * UI), mcp-spend.json (today's spend), mcp-history.jsonl (one line per call). Env X402_* still works as a fallback.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPublicClient, erc20Abi, http, toHex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const API = (process.env.X402_API ?? "https://arm.yyheart.com/api").replace(/\/$/, "");
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** BlockRun's x402 payee on Base (same constant as arm/web/src/lib/wallet/x402.ts). Quotes to anyone else are refused. */
const BLOCKRUN_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const NETWORK = "eip155:8453";
const DIR = join(homedir(), ".arm-x402-test");
const KEY_FILE = process.env.X402_KEY_FILE ?? join(DIR, "key.json");
const CONFIG = join(DIR, "mcp-config.json");
const LEDGER = join(DIR, "mcp-spend.json");
const HISTORY = join(DIR, "mcp-history.jsonl");
export const FALLBACK_MODEL = "deepseek/deepseek-chat";

function loadAccount() {
  let pk = process.env.X402_PRIVATE_KEY;
  if (!pk && existsSync(KEY_FILE)) pk = JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey;
  if (!pk) return null;
  return privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
}
export const account = loadAccount();
export const keyFile = KEY_FILE;
const chain = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
export const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(Number(micro) < 10_000 ? 6 : 4)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------------------------------------------------------------- settings / ledger / history

/** default model + caps in USDC; the UI edits this file, the MCP server re-reads it on every call */
export function config() {
  let c = {};
  try {
    c = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {}
  return {
    defaultModel: typeof c.defaultModel === "string" && c.defaultModel ? c.defaultModel : process.env.X402_DEFAULT_MODEL || FALLBACK_MODEL,
    maxPerCall: Number(c.maxPerCall ?? process.env.X402_MAX_PER_CALL ?? 0.1),
    dailyCap: Number(c.dailyCap ?? process.env.X402_DAILY_CAP ?? 3),
  };
}
export function saveConfig(patch) {
  const c = { ...config(), ...patch };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 1));
  return c;
}

const today = () => new Date().toLocaleDateString("sv");
export function ledger() {
  try {
    const j = JSON.parse(readFileSync(LEDGER, "utf8"));
    return j.day === today() ? j : { day: today(), spent: 0, calls: 0 };
  } catch {
    return { day: today(), spent: 0, calls: 0 };
  }
}
function record(entry) {
  mkdirSync(DIR, { recursive: true });
  if (entry.cost) {
    const l = ledger();
    l.spent += entry.cost;
    l.calls += 1;
    writeFileSync(LEDGER, JSON.stringify(l));
  }
  appendFileSync(HISTORY, JSON.stringify(entry) + "\n");
}
export function history(limit = 50) {
  try {
    return readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function balance() {
  if (!account) return null;
  return Number(await chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }));
}

// ---------------------------------------------------------------- relay calls

async function call(path, body, payment) {
  const headers = { "content-type": "application/json" };
  if (payment) headers["x-payment-signature"] = payment;
  const once = async (p, b) => {
    const r = await fetch(`${API}${p}`, { method: b ? "POST" : "GET", headers, body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(90_000) });
    return { status: r.status, json: (await r.json().catch(() => null)) ?? {} };
  };
  let res = await once(path, body);
  // long answers are parked by the relay past nginx's 60s; each GET long-polls ~25s
  const relay = res.status === 202 ? res.json.relay : undefined;
  for (let i = 0; relay && res.status === 202 && res.json.relay && i < 40; i++) res = await once(`/x402/relay/${relay}`);
  return res;
}

function pickAccept(q) {
  const a = q.accepts?.find((x) => x.scheme === "exact" && x.network === NETWORK && same(x.asset, BASE_USDC));
  if (!a || !/^\d+$/.test(a.amount)) throw new Error("BlockRun quote has no USDC-on-Base option");
  if (!same(a.payTo, BLOCKRUN_PAY_TO)) throw new Error(`quote pays ${a.payTo}, not BlockRun's known payee: refused`);
  return a;
}

async function signPayment(q, a) {
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: account.address, to: BLOCKRUN_PAY_TO, value: BigInt(a.amount), validAfter: BigInt(now - 600), validBefore: BigInt(now + Math.min(a.maxTimeoutSeconds ?? 300, 900)), nonce: toHex(randomBytes(32)) };
  const signature = await account.signTypedData({
    domain: { name: a.extra?.name ?? "USD Coin", version: a.extra?.version ?? "2", chainId: base.id, verifyingContract: BASE_USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  const payload = {
    x402Version: q.x402Version ?? 2,
    resource: q.resource ?? { url: "https://blockrun.ai/api/v1/chat/completions", mimeType: "application/json" },
    accepted: a,
    payload: { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

const errText = (j, status) => {
  if (j.code === "PAYMENT_UNFUNDED") return "wallet has too little USDC on Base for this call";
  if (j.code?.startsWith?.("PAYMENT_")) return `payment refused by BlockRun (${j.code})`;
  const e = j.error;
  return (typeof e === "string" ? e : e?.message) || j.message || `HTTP ${status}`;
};

/** one completion (model omitted = the configured default); returns the answer and what it really cost / who served it */
export async function chat(model, messages, maxTokens, via = "mcp") {
  model = model || config().defaultModel;
  const caps = config();
  const body = { model, messages, max_tokens: maxTokens };
  let res = await call("/x402/chat", body);
  let cost = 0;
  if (res.status === 402) {
    if (!account) throw new Error(`no wallet key (set X402_PRIVATE_KEY or X402_KEY_FILE; looked at ${KEY_FILE})`);
    const a = pickAccept(res.json);
    cost = Number(a.amount);
    if (cost > caps.maxPerCall * 1e6) throw new Error(`quote ${usd(cost)} is over the per-call cap ${usd(caps.maxPerCall * 1e6)}; try a smaller max_tokens or raise the cap`);
    const l = ledger();
    if (l.spent + cost > caps.dailyCap * 1e6) throw new Error(`daily cap ${usd(caps.dailyCap * 1e6)} reached (spent ${usd(l.spent)} today)`);
    res = await call("/x402/chat", body, await signPayment(res.json, a));
    if (res.status === 402) throw new Error(errText(res.json, 402));
  }
  if (res.status !== 200) throw new Error(errText(res.json, res.status));
  const j = res.json;
  const r = {
    text: (j.choices?.[0]?.message?.content ?? "").split("</think>").pop().trim(),
    requested: model,
    served: j._served || j.model || model,
    usage: j.usage ?? null,
    cost,
    tx: j._payment?.transaction ?? null,
  };
  const last = messages[messages.length - 1]?.content ?? "";
  record({ at: new Date().toISOString(), via, requested: r.requested, served: r.served, inTok: r.usage?.prompt_tokens ?? null, outTok: r.usage?.completion_tokens ?? null, cost, tx: r.tx, prompt: last.slice(0, 80) });
  return r;
}

export const footer = (r) => {
  const u = r.usage ? ` · tokens in ${r.usage.prompt_tokens ?? "?"} / out ${r.usage.completion_tokens ?? "?"}` : "";
  const mismatch = !same(r.served, r.requested) ? `  ⚠ requested ${r.requested}` : "";
  return `— served by ${r.served}${mismatch}${u} · cost ${r.cost ? usd(r.cost) : "free"}${r.tx ? ` · tx https://basescan.org/tx/${r.tx}` : ""}`;
};

let modelsCache = null;
export async function models() {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.v;
  const r = await call("/x402/models");
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`model list failed (HTTP ${r.status})`);
  modelsCache = { at: Date.now(), v: r.json };
  return r.json;
}
