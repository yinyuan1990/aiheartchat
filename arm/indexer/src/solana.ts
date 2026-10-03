import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { sql } from "./db.js";

/**
 * Solana backend for the wallet: a JSON-RPC relay (public nodes are slow or blocked from mainland China, some refuse
 * Token-2022 scans, and a paid key must never ship in the App) plus cached Jupiter token info / quotes.
 * Upstreams: SOL_RPC_URLS (comma-separated, tried in order), JUP_BASE.
 */

const UPSTREAMS = (process.env.SOL_RPC_URLS ?? "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const JUP = (process.env.JUP_BASE ?? "https://lite-api.jup.ag").replace(/\/$/, "");

const METHODS = new Set([
  "getBalance",
  "getTokenAccountsByOwner",
  "getAccountInfo",
  "getMultipleAccounts",
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getBlockHeight",
  "getSlot",
  "getGenesisHash",
  "getFeeForMessage",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getMinimumBalanceForRentExemption",
  "getEpochInfo",
  "getHealth",
  "getVersion",
  "isBlockhashValid",
]);

// per-IP budget: a wallet polls a handful of calls every 15–20 s; a send loop re-broadcasts every 2 s
const WINDOW_MS = 60_000;
const PER_WINDOW = 400;
const hits = new Map<string, { at: number; n: number }>();
function allow(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > WINDOW_MS) {
    hits.set(ip, { at: now, n: 1 });
    if (hits.size > 20_000) for (const [k, v] of hits) if (now - v.at > WINDOW_MS) hits.delete(k);
    return true;
  }
  return ++h.n <= PER_WINDOW;
}

type RpcReq = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One JSON-RPC call; falls through to the next upstream on transport errors, 403/429 and 5xx. */
export async function solRelay(body: unknown, ip: string): Promise<{ status: number; json: unknown }> {
  const req = body as RpcReq;
  if (!req || typeof req !== "object" || Array.isArray(body)) return { status: 400, json: rpcError(null, -32600, "single requests only") };
  if (typeof req.method !== "string" || !METHODS.has(req.method)) return { status: 400, json: rpcError(req.id, -32601, `method not allowed: ${String(req.method)}`) };
  if (!allow(ip)) return { status: 429, json: rpcError(req.id, -32005, "rate limited") };
  const payload = JSON.stringify({ jsonrpc: "2.0", id: req.id ?? 1, method: req.method, params: Array.isArray(req.params) ? req.params : [] });
  let last = "no upstream";
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(req.method === "getTokenAccountsByOwner" ? 20_000 : 12_000) });
      if (r.status === 403 || r.status === 429 || r.status >= 500) {
        last = `${new URL(url).host} HTTP ${r.status}`;
        continue;
      }
      return { status: 200, json: await r.json() };
    } catch (e) {
      last = `${new URL(url).host} ${(e as Error).message}`;
    }
  }
  return { status: 502, json: rpcError(req.id, -32000, `all Solana nodes failed (${last})`) };
}

// ---------- token info / prices (Jupiter token API), cached per mint ----------

export type SolToken = { mint: string; name: string; symbol: string; icon: string | null; decimals: number; usdPrice: number | null; change24h: number | null; mcap: number | null; liquidity: number | null; verified: boolean; launchpad: string | null };

const TOKEN_TTL = 45_000;
const tokenCache = new Map<string, { at: number; t: SolToken | null }>();

type JupToken = { id: string; name: string; symbol: string; icon?: string; decimals: number; usdPrice?: number; mcap?: number; liquidity?: number; isVerified?: boolean; launchpad?: string; stats24h?: { priceChange?: number } };
const shapeJup = (j: JupToken): SolToken => ({
  mint: j.id,
  name: j.name,
  symbol: j.symbol,
  icon: j.icon ?? null,
  decimals: j.decimals,
  usdPrice: j.usdPrice ?? null,
  change24h: j.stats24h?.priceChange ?? null,
  mcap: j.mcap ?? null,
  liquidity: j.liquidity ?? null,
  verified: !!j.isVerified,
  launchpad: j.launchpad ?? null,
});

export async function solTokens(mints: string[]): Promise<Record<string, SolToken | null>> {
  const want = [...new Set(mints.filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))].slice(0, 100);
  const now = Date.now();
  const missing = want.filter((m) => !(now - (tokenCache.get(m)?.at ?? 0) < TOKEN_TTL));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const r = await fetch(`${JUP}/tokens/v2/search?query=${chunk.join(",")}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`jup ${r.status}`);
      const list = (await r.json()) as JupToken[];
      const got = new Map(list.map((j) => [j.id, shapeJup(j)]));
      for (const m of chunk) tokenCache.set(m, { at: now, t: got.get(m) ?? tokenCache.get(m)?.t ?? null });
    } catch {
      // keep serving stale entries when Jupiter hiccups
    }
  }
  if (tokenCache.size > 50_000) for (const [k, v] of tokenCache) if (now - v.at > 10 * TOKEN_TTL) tokenCache.delete(k);
  return Object.fromEntries(want.map((m) => [m, tokenCache.get(m)?.t ?? null]));
}

// ---------- coin comments (Solana-signed) ----------

/** Must match the wallet's `solCommentMessage`. */
export const solCommentMessage = (mint: string, text: string, ts: number, replyTo: number | null) => `Arm comment\nmint: ${mint}\nreply: ${replyTo ?? "-"}\nts: ${ts}\n${text}`;

function verifySol(author: string, message: string, signature: string): boolean {
  try {
    const pk = base58.decode(author);
    const sig = base58.decode(signature);
    return pk.length === 32 && sig.length === 64 && ed25519.verify(sig, new TextEncoder().encode(message), pk);
  } catch {
    return false;
  }
}

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function solComments(mint: string) {
  const rows = await sql`select id, author, text, reply_to, ts from sol_comments where mint = ${mint} order by ts desc limit 300`;
  return rows.map((r) => ({ id: Number(r.id), author: r.author as string, text: r.text as string, replyTo: r.reply_to ? Number(r.reply_to) : null, time: r.ts }));
}

export async function addSolComment(mint: string, body: { author?: string; text?: string; replyTo?: number | null; ts?: number; signature?: string }): Promise<{ status: number; json: unknown }> {
  const text = (body.text ?? "").trim();
  if (!SOL_ADDR.test(mint)) return { status: 400, json: { error: "bad mint" } };
  if (!text || text.length > 280) return { status: 400, json: { error: "text 1–280 chars" } };
  if (!body.author || !SOL_ADDR.test(body.author) || !body.signature || typeof body.ts !== "number") return { status: 400, json: { error: "bad request" } };
  if (Math.abs(Date.now() - body.ts) > 5 * 60_000) return { status: 400, json: { error: "stale timestamp" } };
  const replyTo = body.replyTo ?? null;
  if (replyTo) {
    const [p] = await sql`select 1 from sol_comments where id = ${replyTo} and mint = ${mint}`;
    if (!p) return { status: 400, json: { error: "bad replyTo" } };
  }
  if (!verifySol(body.author, solCommentMessage(mint, text, body.ts, replyTo), body.signature)) return { status: 401, json: { error: "bad signature" } };
  const [recent] = await sql`select ts from sol_comments where author = ${body.author} order by ts desc limit 1`;
  if (recent && Date.now() - new Date(recent.ts).getTime() < 10_000) return { status: 429, json: { error: "slow down" } };
  const [row] = await sql`insert into sol_comments (mint, author, text, reply_to, signature) values (${mint}, ${body.author}, ${text}, ${replyTo}, ${body.signature}) returning id, ts`;
  return { status: 200, json: { id: Number(row.id), time: row.ts } };
}

// ---------- Jupiter swap (quote + transaction building; the wallet signs locally) ----------

const QUOTE_KEYS = ["inputMint", "outputMint", "amount", "slippageBps", "swapMode", "onlyDirectRoutes", "restrictIntermediateTokens", "maxAccounts"];

export async function jupQuote(q: Record<string, string | undefined>): Promise<{ status: number; json: unknown }> {
  const p = new URLSearchParams();
  for (const k of QUOTE_KEYS) if (q[k] != null) p.set(k, q[k]!);
  if (!p.has("restrictIntermediateTokens")) p.set("restrictIntermediateTokens", "true");
  const r = await fetch(`${JUP}/swap/v1/quote?${p}`, { signal: AbortSignal.timeout(10_000) });
  return { status: r.status, json: await r.json().catch(() => ({ error: `jup ${r.status}` })) };
}

export async function jupSwap(body: unknown): Promise<{ status: number; json: unknown }> {
  const b = body as { quoteResponse?: unknown; userPublicKey?: string; priorityLevel?: string };
  if (!b?.quoteResponse || typeof b.userPublicKey !== "string") return { status: 400, json: { error: "quoteResponse and userPublicKey required" } };
  const level = ["medium", "high", "veryHigh"].includes(b.priorityLevel ?? "") ? b.priorityLevel : "high";
  const r = await fetch(`${JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: b.quoteResponse,
      userPublicKey: b.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: level } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, json: await r.json().catch(() => ({ error: `jup ${r.status}` })) };
}
