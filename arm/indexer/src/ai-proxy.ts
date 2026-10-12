import { randomBytes, timingSafeEqual } from "node:crypto";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql } from "./db.js";

/**
 * OpenAI-compatible endpoint for Cursor's "custom model" (10.12, operator only): Cursor's servers call
 * /api/ai/v1/chat/completions with `Authorization: Bearer AI_PROXY_KEY`; the body (tools, streaming, …) goes to
 * BlockRun as-is, and this server pays the x402 quote from its own small wallet (AI_PROXY_WALLET_KEY, USDC on Base).
 * Quotes are only paid to BlockRun's known payee, in USDC on Base, within AI_PROXY_MAX_PER_CALL / AI_PROXY_DAILY_CAP.
 * Off (404) unless both env vars are set. No markup: it costs what BlockRun quotes.
 */

const UPSTREAM = "https://blockrun.ai/api/v1";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BLOCKRUN_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const NETWORK = "eip155:8453";
const KEY = process.env.AI_PROXY_KEY ?? "";
const WALLET = process.env.AI_PROXY_WALLET_KEY ? privateKeyToAccount(process.env.AI_PROXY_WALLET_KEY as Hex) : null;
const MAX_PER_CALL = Math.round(Number(process.env.AI_PROXY_MAX_PER_CALL ?? 0.5) * 1e6);
const DAILY_CAP = Math.round(Number(process.env.AI_PROXY_DAILY_CAP ?? 5) * 1e6);
/** quotes assume the whole max_tokens reply, so an absent / huge one would be quoted (and paid) at the model maximum */
const MAX_TOKENS = 8192;
const MAX_BODY = 4_000_000;

export const aiProxyOn = () => KEY.length >= 32 && !!WALLET;
export const aiProxyAddress = () => WALLET?.address ?? null;

export function aiProxyAuth(h: string | undefined) {
  const got = Buffer.from(h?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(KEY);
  return aiProxyOn() && got.length === want.length && timingSafeEqual(got, want);
}

let ready: Promise<void> | null = null;
const ensure = () => (ready ??= (async () => {
  await sql`create table if not exists ai_proxy_calls (
    id bigserial primary key, at timestamptz not null default now(), model text not null, served text, stream boolean not null,
    cost bigint not null, tx text, status int not null)`;
})());

/** spend since 00:00 UTC+8 (micro-USDC) */
async function spentToday() {
  await ensure();
  const [r] = await sql<{ s: string | null }[]>`select sum(cost)::text as s from ai_proxy_calls where at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'`;
  return Number(r?.s ?? 0);
}

const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
const err = (status: number, message: string) => new Response(JSON.stringify({ error: { message, type: "ai_proxy_error" } }), { status, headers: { "content-type": "application/json" } });

async function sign(quote: Record<string, unknown>, a: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: WALLET!.address,
    to: BLOCKRUN_PAY_TO as Hex,
    value: BigInt(String(a.amount)),
    validAfter: BigInt(now - 600),
    validBefore: BigInt(now + Math.min(Number(a.maxTimeoutSeconds ?? 300), 900)),
    nonce: toHex(randomBytes(32)),
  };
  const extra = (a.extra ?? {}) as { name?: string; version?: string };
  const signature = await WALLET!.signTypedData({
    domain: { name: extra.name ?? "USD Coin", version: extra.version ?? "2", chainId: 8453, verifyingContract: BASE_USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  return Buffer.from(JSON.stringify({
    x402Version: quote.x402Version ?? 2,
    resource: quote.resource ?? { url: `${UPSTREAM}/chat/completions`, mimeType: "application/json" },
    accepted: a,
    payload: { signature, authorization: { ...auth, value: auth.value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } },
  })).toString("base64");
}

const decodeB64 = (v: string | null) => {
  try {
    return v ? (JSON.parse(Buffer.from(v, "base64").toString("utf8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** one chat completion: quote → check → pay → stream (or JSON) straight back to Cursor */
export async function aiProxyChat(raw: string): Promise<Response> {
  if (raw.length > MAX_BODY) return err(413, "request too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return err(400, "bad json");
  }
  if (typeof body.model !== "string" || !/^[\w.\-]+\/[\w.\-:+]+$/.test(body.model)) return err(400, "model must be a BlockRun id like deepseek/deepseek-chat");
  for (const k of ["max_tokens", "max_completion_tokens"] as const) {
    if (body[k] != null) body[k] = Math.min(Number(body[k]) || MAX_TOKENS, MAX_TOKENS);
  }
  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = MAX_TOKENS;
  const payload = JSON.stringify(body);
  const stream = body.stream === true;
  const post = (payment?: string) => fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(payment ? { "PAYMENT-SIGNATURE": payment, "X-PAYMENT": payment } : {}) },
    body: payload,
    signal: AbortSignal.timeout(600_000),
  });
  let r: Response;
  try {
    r = await post();
  } catch (e) {
    return err(502, `blockrun unreachable: ${(e as Error).message}`);
  }
  let cost = 0;
  if (r.status === 402) {
    const quote = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!quote.resource) quote.resource = decodeB64(r.headers.get("payment-required"))?.resource ?? null;
    const a = (quote.accepts as Record<string, unknown>[] | undefined)?.find((x) => x.scheme === "exact" && x.network === NETWORK && same(x.asset, BASE_USDC));
    if (!a || !/^\d+$/.test(String(a.amount))) return err(502, "BlockRun quote has no USDC-on-Base option");
    if (!same(a.payTo, BLOCKRUN_PAY_TO)) return err(502, "BlockRun quote pays an unknown address: refused");
    cost = Number(a.amount);
    if (cost > MAX_PER_CALL) return err(402, `quote $${(cost / 1e6).toFixed(4)} is over the per-call cap $${(MAX_PER_CALL / 1e6).toFixed(2)} (AI_PROXY_MAX_PER_CALL)`);
    if ((await spentToday()) + cost > DAILY_CAP) return err(402, `daily cap $${(DAILY_CAP / 1e6).toFixed(2)} reached (AI_PROXY_DAILY_CAP)`);
    try {
      r = await post(await sign(quote, a));
    } catch (e) {
      return err(502, `blockrun unreachable: ${(e as Error).message}`);
    }
  }
  const served = r.headers.get("x-served-model");
  const tx = (decodeB64(r.headers.get("payment-response"))?.transaction as string | undefined) ?? null;
  await ensure();
  await sql`insert into ai_proxy_calls (model, served, stream, cost, tx, status) values (${body.model}, ${served}, ${stream}, ${r.ok ? cost : 0}, ${tx}, ${r.status})`.catch(() => {});
  const headers = new Headers({ "content-type": r.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json"), "cache-control": "no-cache" });
  // nginx must not buffer the SSE stream
  headers.set("x-accel-buffering", "no");
  if (served) headers.set("x-served-model", served);
  return new Response(r.body, { status: r.status === 402 ? 402 : r.status, headers });
}

export async function aiProxyModels() {
  const r = await fetch(`${UPSTREAM}/models`, { signal: AbortSignal.timeout(12_000) });
  const j = (await r.json().catch(() => ({}))) as { data?: { id?: string; owned_by?: string; categories?: string[] }[] };
  const data = (j.data ?? []).filter((m) => m.id && m.categories?.includes("chat")).map((m) => ({ id: m.id, object: "model", owned_by: m.owned_by ?? m.id!.split("/")[0] }));
  return { object: "list", data };
}

export async function aiProxyStats() {
  await ensure();
  const rows = await sql`select at, model, served, stream, cost, tx, status from ai_proxy_calls order by id desc limit 30`;
  return { address: aiProxyAddress(), spentToday: await spentToday(), dailyCap: DAILY_CAP, maxPerCall: MAX_PER_CALL, calls: rows };
}
