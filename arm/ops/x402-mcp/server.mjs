#!/usr/bin/env node
/**
 * 心之音 Web3「AI 模型」for Cursor (MCP, stdio, text only). BlockRun's chat models, paid per call in USDC on Base over
 * x402 with YOUR OWN wallet: the request goes through the Arm relay (arm.yyheart.com/api/x402/chat, reachable from
 * mainland China); a paid model answers 402 with a quote, this server checks it (exact USDC on Base to BlockRun's
 * payee, within the caps below), signs an EIP-3009 authorization locally and retries. No fee is added: what you pay
 * is BlockRun's quote. Every answer reports which model BlockRun says actually served it, tokens, cost and the tx.
 *
 * Key: X402_PRIVATE_KEY, or X402_KEY_FILE (JSON with privateKey; default ~/.arm-x402-test/key.json). Never logged.
 * Caps: X402_MAX_PER_CALL (USDC, default 0.10), X402_DAILY_CAP (USDC per local day, default 3); spend ledger in
 * ~/.arm-x402-test/mcp-spend.json. X402_API overrides the relay base (default https://arm.yyheart.com/api).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createPublicClient, erc20Abi, http, toHex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = (process.env.X402_API ?? "https://arm.yyheart.com/api").replace(/\/$/, "");
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** BlockRun's x402 payee on Base (same constant as arm/web/src/lib/wallet/x402.ts). Quotes to anyone else are refused. */
const BLOCKRUN_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const NETWORK = "eip155:8453";
const MAX_PER_CALL = Math.round(Number(process.env.X402_MAX_PER_CALL ?? 0.1) * 1e6);
const DAILY_CAP = Math.round(Number(process.env.X402_DAILY_CAP ?? 3) * 1e6);
const KEY_FILE = process.env.X402_KEY_FILE ?? join(homedir(), ".arm-x402-test", "key.json");
const LEDGER = join(homedir(), ".arm-x402-test", "mcp-spend.json");

function loadAccount() {
  let pk = process.env.X402_PRIVATE_KEY;
  if (!pk && existsSync(KEY_FILE)) pk = JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey;
  if (!pk) return null;
  return privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
}
const account = loadAccount();
const chain = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(micro < 10_000 ? 6 : 4)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const today = () => new Date().toLocaleDateString("sv");
function ledger() {
  try {
    const j = JSON.parse(readFileSync(LEDGER, "utf8"));
    return j.day === today() ? j : { day: today(), spent: 0, calls: 0 };
  } catch {
    return { day: today(), spent: 0, calls: 0 };
  }
}
function record(micro) {
  const l = ledger();
  l.spent += micro;
  l.calls += 1;
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l));
}

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

/** one completion; returns the answer and what it really cost / who served it */
async function chat(model, messages, maxTokens) {
  const body = { model, messages, max_tokens: maxTokens };
  let res = await call("/x402/chat", body);
  let cost = 0;
  if (res.status === 402) {
    if (!account) throw new Error(`no wallet key (set X402_PRIVATE_KEY or X402_KEY_FILE; looked at ${KEY_FILE})`);
    const a = pickAccept(res.json);
    cost = Number(a.amount);
    if (cost > MAX_PER_CALL) throw new Error(`quote ${usd(cost)} is over the per-call cap ${usd(MAX_PER_CALL)} (X402_MAX_PER_CALL); try a smaller max_tokens`);
    const l = ledger();
    if (l.spent + cost > DAILY_CAP) throw new Error(`daily cap ${usd(DAILY_CAP)} reached (spent ${usd(l.spent)} today; X402_DAILY_CAP)`);
    res = await call("/x402/chat", body, await signPayment(res.json, a));
    if (res.status === 402) throw new Error(errText(res.json, 402));
    if (res.status === 200) record(cost);
  }
  if (res.status !== 200) throw new Error(errText(res.json, res.status));
  const j = res.json;
  return {
    text: (j.choices?.[0]?.message?.content ?? "").split("</think>").pop().trim(),
    requested: model,
    served: j._served || j.model || model,
    usage: j.usage ?? null,
    cost,
    tx: j._payment?.transaction ?? null,
  };
}

const footer = (r) => {
  const u = r.usage ? ` · tokens in ${r.usage.prompt_tokens ?? "?"} / out ${r.usage.completion_tokens ?? "?"}` : "";
  const mismatch = !same(r.served, r.requested) ? `  ⚠ requested ${r.requested}` : "";
  return `— served by ${r.served}${mismatch}${u} · cost ${r.cost ? usd(r.cost) : "free"}${r.tx ? ` · tx https://basescan.org/tx/${r.tx}` : ""}`;
};

let modelsCache = null;
async function models() {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.v;
  const r = await call("/x402/models");
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`model list failed (HTTP ${r.status})`);
  modelsCache = { at: Date.now(), v: r.json };
  return r.json;
}

const server = new McpServer({ name: "heartchat-x402", version: "0.1.0" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

server.tool(
  "list_models",
  "List the BlockRun chat models available through 心之音 (HeartChat) x402: id, USD price per 1M input/output tokens, context window. Use the id with `chat`.",
  { search: z.string().optional().describe("filter by id / name / owner, e.g. 'claude', 'deepseek', 'free'") },
  async ({ search }) => {
    try {
      let list = await models();
      if (search) {
        const s = search.toLowerCase();
        list = list.filter((m) => (s === "free" ? m.free : `${m.id} ${m.name} ${m.owner}`.toLowerCase().includes(s)));
      }
      const rows = list.map((m) => `${m.id} | ${m.free ? "free" : `$${m.input}/$${m.output} per 1M`} | ctx ${m.context ?? "?"}${m.reasoning ? " | reasoning" : ""}`);
      return ok(`${rows.length} models (paid per call in USDC on Base; the quote assumes the full max_tokens reply):\n${rows.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "chat",
  "Ask one BlockRun model (GPT, Claude, Gemini, DeepSeek, Qwen, Kimi, Grok, GLM…) a question, paid per call from the configured wallet in USDC on Base. Returns the answer plus the model BlockRun reports as having served it, token usage, cost and the payment tx.",
  {
    model: z.string().describe("model id from list_models, e.g. deepseek/deepseek-chat"),
    prompt: z.string().describe("the user message"),
    system: z.string().optional().describe("optional system prompt"),
    max_tokens: z.number().int().min(1).max(4096).optional().describe("reply length cap (default 1024); the price is quoted on this, so smaller is cheaper"),
  },
  async ({ model, prompt, system, max_tokens }) => {
    try {
      const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
      const r = await chat(model, messages, max_tokens ?? 1024);
      return ok(`${r.text}\n\n${footer(r)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "compare",
  "Send the same prompt to 2-4 BlockRun models in parallel and return each answer with the model that actually served it, tokens and cost. Useful to check whether a model is what it claims to be.",
  {
    models: z.array(z.string()).min(2).max(4).describe("model ids from list_models"),
    prompt: z.string(),
    max_tokens: z.number().int().min(1).max(4096).optional().describe("default 600"),
  },
  async ({ models: ids, prompt, max_tokens }) => {
    const out = await Promise.all(ids.map(async (m) => {
      try {
        const r = await chat(m, [{ role: "user", content: prompt }], max_tokens ?? 600);
        return `### ${m}\n${r.text}\n\n${footer(r)}`;
      } catch (e) {
        return `### ${m}\nError: ${e instanceof Error ? e.message : String(e)}`;
      }
    }));
    return ok(out.join("\n\n"));
  },
);

server.tool("wallet", "Show the paying wallet: address, USDC balance on Base, today's spend and the caps.", {}, async () => {
  try {
    if (!account) return ok(`No wallet key configured (X402_PRIVATE_KEY or X402_KEY_FILE; looked at ${KEY_FILE}). Free models still work.`);
    const bal = await chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const l = ledger();
    return ok(`address ${account.address} (Base)\nUSDC ${usd(Number(bal))}\ntoday ${usd(l.spent)} over ${l.calls} paid calls\ncaps: ${usd(MAX_PER_CALL)} per call, ${usd(DAILY_CAP)} per day\nTop up: send USDC on Base to the address above.`);
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
