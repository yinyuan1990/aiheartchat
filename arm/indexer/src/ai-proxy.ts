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
  await sql`alter table ai_proxy_calls add column if not exists in_tok int, add column if not exists out_tok int, add column if not exists cached_tok int, add column if not exists body_model text, add column if not exists req_bytes int, add column if not exists ms int`;
  await sql`alter table ai_proxy_calls add column if not exists shape jsonb`;
})());

/** what a request is made of (sizes only, no content): why a Cursor agent turn is MBs */
function shapeOf(body: Record<string, unknown>) {
  const msgs = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown; tool_calls?: unknown }[]) : [];
  const by: Record<string, { n: number; chars: number }> = {};
  let images = 0, imageChars = 0, biggest = 0;
  for (const m of msgs) {
    let chars = 0;
    const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: string; image_url?: { url?: string } }[]) : null;
    if (typeof m.content === "string") chars += m.content.length;
    for (const p of parts ?? []) {
      if (p.type === "image_url") {
        images++;
        imageChars += p.image_url?.url?.length ?? 0;
      } else chars += (p.text ?? JSON.stringify(p)).length;
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    const k = m.role ?? "?";
    by[k] ??= { n: 0, chars: 0 };
    by[k].n++;
    by[k].chars += chars;
    biggest = Math.max(biggest, chars);
  }
  return { messages: msgs.length, by, images, imageChars, biggest, tools: Array.isArray(body.tools) ? body.tools.length : 0, toolsChars: body.tools ? JSON.stringify(body.tools).length : 0 };
}

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
  // the quote is driven by the input size (max_tokens barely moves it, measured 10.12), so Cursor's body goes as-is,
  // except that streams are asked to end with a usage chunk (standard OpenAI option) so the tokens can be logged
  const stream = body.stream === true;
  if (stream) body.stream_options = { ...((body.stream_options as object) ?? {}), include_usage: true };
  const payload = JSON.stringify(body);
  const t0 = Date.now();
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
  const [row] = await sql<{ id: string }[]>`insert into ai_proxy_calls (model, served, stream, cost, tx, status, req_bytes, shape) values (${body.model as string}, ${served}, ${stream}, ${r.ok ? cost : 0}, ${tx}, ${r.status}, ${payload.length}, ${sql.json(shapeOf(body))}) returning id::text`.catch(() => [] as { id: string }[]);
  const headers = new Headers({ "content-type": r.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json"), "cache-control": "no-cache" });
  // nginx must not buffer the SSE stream
  headers.set("x-accel-buffering", "no");
  if (served) headers.set("x-served-model", served);
  if (!r.body) return new Response(null, { status: r.status, headers });
  // pass the body through untouched while reading the usage / model out of a copy
  const [toClient, toLog] = r.body.tee();
  if (row) void logUsage(row.id, toLog, t0);
  else void toLog.cancel();
  return new Response(toClient, { status: r.status === 402 ? 402 : r.status, headers });
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
async function logUsage(id: string, s: ReadableStream<Uint8Array>, t0: number) {
  let text = "";
  try {
    const dec = new TextDecoder();
    for await (const c of s as unknown as AsyncIterable<Uint8Array>) {
      text += dec.decode(c, { stream: true });
      // keep only the tail: usage and the model name are in the last chunks / the top-level object
      if (text.length > 400_000) text = text.slice(-200_000);
    }
  } catch {
    // client went away: whatever arrived is still parsed
  }
  let usage: Usage | undefined, model: string | undefined;
  const take = (j: { usage?: Usage | null; model?: string }) => {
    if (j.usage) usage = j.usage;
    if (typeof j.model === "string") model = j.model;
  };
  try {
    take(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        take(JSON.parse(line.slice(5)));
      } catch {}
    }
  }
  await sql`update ai_proxy_calls set in_tok = ${usage?.prompt_tokens ?? null}, out_tok = ${usage?.completion_tokens ?? null}, cached_tok = ${usage?.prompt_tokens_details?.cached_tokens ?? null}, body_model = ${model ?? null}, ms = ${Date.now() - t0} where id = ${id}`.catch(() => {});
}

export async function aiProxyModels() {
  const r = await fetch(`${UPSTREAM}/models`, { signal: AbortSignal.timeout(12_000) });
  const j = (await r.json().catch(() => ({}))) as { data?: { id?: string; owned_by?: string; categories?: string[] }[] };
  const data = (j.data ?? []).filter((m) => m.id && m.categories?.includes("chat")).map((m) => ({ id: m.id, object: "model", owned_by: m.owned_by ?? m.id!.split("/")[0] }));
  return { object: "list", data };
}

export async function aiProxyStats(limit = 100) {
  await ensure();
  const rows = await sql`select at, model, coalesce(served, body_model) as served, stream, cost::float8 as cost, tx, status, in_tok, out_tok, cached_tok, req_bytes, ms, shape from ai_proxy_calls order by id desc limit ${Math.min(Math.max(limit, 1), 500)}`;
  const days = await sql`select to_char(at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as day, model, count(*)::int as calls, sum(cost)::float8 as cost, sum(in_tok)::int as in_tok, sum(out_tok)::int as out_tok
    from ai_proxy_calls where status = 200 and at > now() - interval '30 days' group by 1, 2 order by 1 desc, 4 desc`;
  return { address: aiProxyAddress(), spentToday: await spentToday(), dailyCap: DAILY_CAP, maxPerCall: MAX_PER_CALL, calls: rows, days };
}
