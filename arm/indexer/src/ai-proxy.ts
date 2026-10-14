import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql } from "./db.js";
import { fromMessagesStream, oaiError, toMessages } from "./ai-claude.js";
import { ensureAiUsers, remoteSign, signerOnline, userByKey, type AiUser } from "./ai-users.js";

/**
 * OpenAI-compatible endpoint for Cursor's "custom model" (10.12, operator only): Cursor's servers call
 * /api/ai/v1/chat/completions with `Authorization: Bearer AI_PROXY_KEY`; the body (tools, streaming, …) goes to
 * BlockRun as-is, and this server pays the x402 quote from its own small wallet (AI_PROXY_WALLET_KEY, USDC on Base).
 * Quotes are only paid to BlockRun's known payee, in USDC on Base, within AI_PROXY_MAX_PER_CALL / AI_PROXY_DAILY_CAP.
 * The operator key is off unless both env vars are set. No markup: it costs what BlockRun quotes.
 * 10.14: Arm AI users (ai-users.ts) use their own keys; their quotes are signed by their own app, never by this server.
 */

const UPSTREAM = "https://blockrun.ai/api/v1";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BLOCKRUN_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const NETWORK = "eip155:8453";
const KEY = process.env.AI_PROXY_KEY ?? "";
const WALLET = process.env.AI_PROXY_WALLET_KEY ? privateKeyToAccount(process.env.AI_PROXY_WALLET_KEY as Hex) : null;
const MAX_PER_CALL = Math.round(Number(process.env.AI_PROXY_MAX_PER_CALL ?? 0.5) * 1e6);
const DAILY_CAP = Math.round(Number(process.env.AI_PROXY_DAILY_CAP ?? 5) * 1e6);
// Arm AI users: the app enforces each user's own caps; this is only the server's ceiling per call
const USER_MAX_PER_CALL = Math.round(Number(process.env.AI_USER_MAX_PER_CALL ?? 2) * 1e6);
const MAX_BODY = 4_000_000;
const MIN_MAX_TOKENS = Math.round(Number(process.env.AI_PROXY_MIN_MAX_TOKENS ?? 16384));
const KEEPALIVE_MS = Math.round(Number(process.env.AI_PROXY_KEEPALIVE_S ?? 10) * 1000);
const FAIL_TTL_MS = Math.round(Number(process.env.AI_PROXY_FAIL_TTL_S ?? 180) * 1000);
const CLAUDE_HINT = process.env.AI_PROXY_CLAUDE_HINT !== "0";
const CLAUDE_NATIVE = process.env.AI_PROXY_CLAUDE_NATIVE !== "0";
const HINT =
  "Note from the API proxy: a single reply is limited to about 16k output tokens and 500 seconds, and a reply that hits the limit is cut off mid tool call. Keep every tool call moderate: write or edit at most about 400 lines (about 15 KB) per tool call, and split bigger files into several calls (create the file, then append or edit the rest).";

export const aiProxyOn = () => KEY.length >= 32 && !!WALLET;
export const aiProxyAddress = () => WALLET?.address ?? null;

/** who is calling: the operator (server wallet pays) or an Arm AI user (their app signs) */
export type Who = { kind: "op" } | { kind: "user"; user: AiUser };
const whoId = (w: Who) => (w.kind === "op" ? "op" : `u${w.user.id}`);

/** what the proxy itself writes into Cursor; Arm AI users get it in the language picked in their app */
const TEXT = {
  zh: {
    repeat: "这一轮和 {ago} 秒前的请求完全相同，那次{why}。为了不重复付钱，{min} 分钟内同样的请求不再发给 BlockRun（这次没有付钱）。请让 Agent 换个做法继续，比如把大文件拆成几次写（每次几百行以内），或换更快的模型。",
    cut: "的回复在 max_tokens（{max}）处被截断（已付 {paid}）",
    empty: "等了 {s} 秒，BlockRun 没有给出有效回复（served={served}，已付 {paid}）",
    stalled: "BlockRun 等了 {s} 秒后没有给出有效回复就结束了（served={served}，{paid}）。BlockRun 连续 120 秒没有输出、或整段超过 500 秒会掐断；如果这一步在写大文件，请让 Agent 拆成几次写（每次几百行以内），或换更快的模型。",
    paid: "本次已付 {paid}",
    joined: "这次是同一轮的重发，接在上一次请求上，没有再付钱",
    overCap: "这一条 BlockRun 报价 {quote}，超过服务器单条上限 {cap}。请开一个新对话（历史太长报价就高）再试。（这次没有付钱）",
    offline: "没有连上你电脑上的 Arm AI：请先打开 Arm AI 程序（付款由它用你自己的钱包签名），然后在 Cursor 里重试。（这次没有付钱）",
    refused: "Arm AI 没有签这笔付款：{reason}。可以在 Arm AI 里调高上限或给钱包充值。（这次没有付钱）",
  },
  en: {
    repeat: "This turn is identical to a request {ago} s ago, which {why}. To avoid paying twice, the same request is not sent to BlockRun again for {min} minutes (nothing was paid this time). Ask the agent to take another route, e.g. write big files in several smaller steps (a few hundred lines each), or switch to a faster model.",
    cut: "was cut at max_tokens ({max}) (paid {paid})",
    empty: "got no usable answer from BlockRun after {s} s (served={served}, paid {paid})",
    stalled: "BlockRun ended after {s} s without a usable answer (served={served}, {paid}). BlockRun cuts a reply after 120 s without output or 500 s in total; if this step writes a big file, ask the agent to write it in several smaller steps (a few hundred lines each), or switch to a faster model.",
    paid: "paid {paid}",
    joined: "this was a resend of the same turn, joined to the earlier request, not paid again",
    overCap: "BlockRun quotes {quote} for this call, over the server's per-call ceiling {cap}. Start a new chat (long histories cost more) and try again. (Nothing was paid.)",
    offline: "Arm AI on your PC is not connected. Open the Arm AI app (it signs every payment with your own wallet), then retry in Cursor. (Nothing was paid.)",
    refused: "Arm AI did not sign this payment: {reason}. You can raise the caps or top up the wallet in Arm AI. (Nothing was paid.)",
  },
};
type Say = (k: keyof typeof TEXT.zh, p?: Record<string, string | number>) => string;
const sayer = (who: Who): Say => {
  const lang = who.kind === "user" && who.user.lang === "en" ? "en" : "zh";
  return (k, p = {}) => TEXT[lang][k].replace(/\{(\w+)\}/g, (_, n: string) => String(p[n] ?? ""));
};
const tag = (who: Who) => (who.kind === "user" ? "[Arm AI]" : "[心之音代理]");
const money = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

export async function aiProxyWho(h: string | undefined): Promise<Who | null> {
  const key = h?.replace(/^Bearer /, "") ?? "";
  const got = Buffer.from(key);
  const want = Buffer.from(KEY);
  if (aiProxyOn() && got.length === want.length && timingSafeEqual(got, want)) return { kind: "op" };
  const user = await userByKey(key).catch(() => null);
  return user ? { kind: "user", user } : null;
}

let ready: Promise<void> | null = null;
const ensure = () => (ready ??= (async () => {
  await sql`create table if not exists ai_proxy_calls (
    id bigserial primary key, at timestamptz not null default now(), model text not null, served text, stream boolean not null,
    cost bigint not null, tx text, status int not null)`;
  await sql`alter table ai_proxy_calls add column if not exists in_tok int, add column if not exists out_tok int, add column if not exists cached_tok int, add column if not exists body_model text, add column if not exists req_bytes int, add column if not exists ms int`;
  await sql`alter table ai_proxy_calls add column if not exists shape jsonb`;
  await ensureAiUsers();
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

/** spend since 00:00 UTC+8 (micro-USDC): the operator's (rows without a user) or one Arm AI user's */
async function spentToday(userId: string | null = null) {
  await ensure();
  const [r] = await sql<{ s: string | null }[]>`select sum(cost)::text as s from ai_proxy_calls where at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'
    and ${userId === null ? sql`user_id is null` : sql`user_id = ${userId}`}`;
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
export async function aiProxyChat(raw: string, who: Who = { kind: "op" }): Promise<Response> {
  if (raw.length > MAX_BODY) return err(413, "request too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return err(400, "bad json");
  }
  if (typeof body.model !== "string" || !/^[\w.\-]+\/[\w.\-:+]+$/.test(body.model)) return err(400, "model must be a BlockRun id like deepseek/deepseek-chat");
  // the quote is driven by the input size, so Cursor's body goes as-is, except that streams are asked to end with a
  // usage chunk (standard OpenAI option) so the tokens can be logged, and Claude gets more reply room (below)
  const stream = body.stream === true;
  if (stream) body.stream_options = { ...((body.stream_options as object) ?? {}), include_usage: true };
  // 10.12: Opus replies were cut at exactly 4096 tokens mid tool-call (writing a big file), and Cursor resent the same
  // turn over and over ($0.18 each). Raise the reply room; the quote only grows ~$0.008 per extra 4k tokens.
  const sentMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 0) || null;
  if (MIN_MAX_TOKENS > 0 && /^anthropic\//.test(body.model) && (sentMax ?? 0) < MIN_MAX_TOKENS) {
    delete body.max_completion_tokens;
    body.max_tokens = MIN_MAX_TOKENS;
  }
  if (CLAUDE_HINT && /^anthropic\//.test(body.model) && Array.isArray(body.tools) && body.tools.length) addHint(body);
  const model = body.model;
  const payload = JSON.stringify(body);
  const t0 = Date.now();
  const hash = sha(payload);
  // dedup / failure memory is per payer: identical bodies from two users are two different payments
  const slot = `${whoId(who)}:${hash}`;
  const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  // Claude streams go to /v1/messages so tool-call arguments stream as they are written (ai-claude.ts)
  const native = CLAUDE_NATIVE && stream && /^anthropic\//.test(model) ? JSON.stringify(toMessages(body)) : null;
  // per-message hashes: which part of a near-identical resend Cursor changed
  const shape = { ...shapeOf(body), sentMax, maxTokens: Number(body.max_tokens ?? 0) || null, hash: hash.slice(0, 16), h: msgs.map((m) => sha(JSON.stringify(m)).slice(0, 8)), ...(native ? { native: native.length } : {}) };
  const userId = who.kind === "user" ? who.user.id : null;
  const log = (served: string | null, cost: number, tx: string | null, status: number, extra = {}) => logRow(model, served, stream, cost, tx, status, payload.length, { ...shape, ...extra }, userId);

  const say = sayer(who);
  const fail = failures.get(slot);
  if (fail && Date.now() - fail.at < FAIL_TTL_MS) {
    await log("ai-proxy:repeat", 0, null, 200, { repeatOf: fail.id });
    const ago = Math.round((Date.now() - fail.at) / 1000);
    return canned(stream, `${tag(who)} ${say("repeat", { ago, why: fail.why, min: Math.round(FAIL_TTL_MS / 60000) })}`);
  }
  const running = flights.get(slot);
  if (running) {
    const head = await running.head;
    await log(head.served, 0, null, head.status, { joined: head.id });
    return reply(running, head, stream, t0, true, who);
  }
  let open!: (h: Head) => void;
  const flight: Flight = { head: new Promise<Head>((r) => (open = r)), chunks: [], done: false, wake: [] };
  flights.set(slot, flight);
  let up: { r: Response; cost: number };
  try {
    up = await upstream(model, native ?? payload, stream, !!native, who);
  } catch (e) {
    up = { r: err(502, `ai proxy: ${(e as Error).message}`), cost: 0 };
  }
  const { r } = up;
  const cost = r.ok ? up.cost : 0;
  const served = r.headers.get("x-served-model");
  const tx = (decodeB64(r.headers.get("payment-response"))?.transaction as string | undefined) ?? null;
  const id = await log(served, cost, tx, r.status);
  const head: Head = { id, status: r.status, type: r.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json"), served, cost };
  open(head);
  void pump(flight, r.body, () => {
    if (flights.get(slot) === flight) flights.delete(slot);
  }, (text, seen) => {
    if (id) void logUsage(id, text, t0);
    if (!cost) return;
    const why = seen.cut
      ? say("cut", { max: shape.maxTokens ?? "?", paid: money(cost) })
      : !seen.said || seen.failed
        ? say("empty", { s: Math.round((Date.now() - t0) / 1000), served: served ?? "?", paid: money(cost) })
        : null;
    if (!why) return;
    for (const [k, v] of failures) if (Date.now() - v.at > FAIL_TTL_MS) failures.delete(k);
    failures.set(slot, { at: Date.now(), id, why });
  });
  return reply(flight, head, stream, t0, false, who);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Head = { id: string | null; status: number; type: string; served: string | null; cost: number };
type Flight = { head: Promise<Head>; chunks: Uint8Array[]; done: boolean; wake: (() => void)[] };
/**
 * 10.14: identical bodies still waiting on BlockRun. A resend (Cursor gave up on a silent connection, or retried a
 * cut reply) joins the running answer from the first byte instead of paying again; the upstream is always read to
 * the end even if the first client is gone.
 */
const flights = new Map<string, Flight>();
/** identical bodies that were paid but gave no usable answer (nothing said, model "error", cut at max_tokens) */
const failures = new Map<string, { at: number; id: string | null; why: string }>();

async function logRow(model: string, served: string | null, stream: boolean, cost: number, tx: string | null, status: number, bytes: number, shape: object, userId: string | null) {
  await ensure();
  const [row] = await sql<{ id: string }[]>`insert into ai_proxy_calls (model, served, stream, cost, tx, status, req_bytes, shape, user_id) values (${model}, ${served}, ${stream}, ${cost}, ${tx}, ${status}, ${bytes}, ${sql.json(shape as Record<string, never>)}, ${userId}) returning id::text`.catch(() => [] as { id: string }[]);
  return row?.id ?? null;
}

/** quote → check → pay; `aiproxy/silent-<s>` is a free stand-in that stays silent for s seconds (keepalive tests) */
async function upstream(model: string, payload: string, stream: boolean, native: boolean, who: Who): Promise<{ r: Response; cost: number }> {
  const silent = /^aiproxy\/silent-(\d{1,3})$/.exec(model);
  if (silent) return { r: silentReply(Math.min(Number(silent[1]), 300), stream), cost: 0 };
  const res = await paid(native ? "messages" : "chat/completions", payload, native, who, stream, model);
  return native && !res.local ? { ...res, r: await openaiFromMessages(res.r) } : res;
}

/** the /v1/messages answer as Cursor expects it: OpenAI chunks, OpenAI-style errors */
async function openaiFromMessages(r: Response) {
  if (r.status === 402 && !r.headers.get("payment-response")) return r;
  const headers = new Headers(r.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (!r.ok) {
    headers.set("content-type", "application/json");
    return new Response(oaiError(await r.text()), { status: r.status, headers });
  }
  headers.set("content-type", "text/event-stream");
  return new Response(r.body ? r.body.pipeThrough(fromMessagesStream()) : null, { status: r.status, headers });
}

/** `local`: an answer written by the proxy itself (already OpenAI-shaped, nothing paid) */
async function paid(path: string, payload: string, native: boolean, who: Who, stream: boolean, model: string): Promise<{ r: Response; cost: number; local?: boolean }> {
  const post = (payment?: string) => fetch(`${UPSTREAM}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(native ? { "anthropic-version": "2023-06-01" } : {}), ...(payment ? { "PAYMENT-SIGNATURE": payment, "X-PAYMENT": payment } : {}) },
    body: payload,
    signal: AbortSignal.timeout(600_000),
  });
  let r: Response;
  try {
    r = await post();
  } catch (e) {
    return { r: err(502, `blockrun unreachable: ${(e as Error).message}`), cost: 0 };
  }
  if (r.status !== 402) return { r, cost: 0 };
  const quote = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  quote.resource ??= decodeB64(r.headers.get("payment-required"))?.resource ?? { url: `${UPSTREAM}/${path}`, mimeType: "application/json" };
  const a = (quote.accepts as Record<string, unknown>[] | undefined)?.find((x) => x.scheme === "exact" && x.network === NETWORK && same(x.asset, BASE_USDC));
  if (!a || !/^\d+$/.test(String(a.amount))) return { r: err(502, "BlockRun quote has no USDC-on-Base option"), cost: 0 };
  if (!same(a.payTo, BLOCKRUN_PAY_TO)) return { r: err(502, "BlockRun quote pays an unknown address: refused"), cost: 0 };
  const cost = Number(a.amount);
  if (who.kind === "user") {
    const say = sayer(who);
    const local = (text: string) => ({ r: canned(stream, `[Arm AI] ${text}`), cost: 0, local: true });
    if (cost > USER_MAX_PER_CALL) return local(say("overCap", { quote: money(cost), cap: money(USER_MAX_PER_CALL) }));
    if (!signerOnline(who.user)) return local(say("offline"));
    let payment: string;
    try {
      payment = await remoteSign(who.user, a, quote.resource, { model, bytes: payload.length });
    } catch (e) {
      return local(say("refused", { reason: (e as Error).message }));
    }
    try {
      return { r: await post(payment), cost };
    } catch (e) {
      return { r: err(502, `blockrun unreachable: ${(e as Error).message}`), cost: 0 };
    }
  }
  if (cost > MAX_PER_CALL) return { r: err(402, `quote $${(cost / 1e6).toFixed(4)} is over the per-call cap $${(MAX_PER_CALL / 1e6).toFixed(2)} (AI_PROXY_MAX_PER_CALL)`), cost: 0 };
  if ((await spentToday()) + cost > DAILY_CAP) return { r: err(402, `daily cap $${(DAILY_CAP / 1e6).toFixed(2)} reached (AI_PROXY_DAILY_CAP)`), cost: 0 };
  try {
    return { r: await post(await sign(quote, a)), cost };
  } catch (e) {
    return { r: err(502, `blockrun unreachable: ${(e as Error).message}`), cost: 0 };
  }
}

/** ask the agent up front to keep each tool call under the reply limits (a cut tool call makes Cursor resend the turn) */
function addHint(body: Record<string, unknown>) {
  const msgs = body.messages as { role?: string; content?: unknown }[] | undefined;
  if (!Array.isArray(msgs)) return;
  const sys = msgs[0]?.role === "system" ? msgs[0] : null;
  if (!sys) msgs.unshift({ role: "system", content: HINT });
  else if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${HINT}`;
  else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: HINT });
}

/** read the upstream body to the end into the flight (every client replays from it), scanning how it went */
async function pump(f: Flight, body: ReadableStream<Uint8Array> | null, finished: () => void, onEnd: (text: string, seen: { said: boolean; failed: boolean; cut: boolean }) => void) {
  const dec = new TextDecoder();
  const seen = { said: false, failed: false, cut: false };
  let text = "", tail = "";
  try {
    for await (const c of (body ?? []) as AsyncIterable<Uint8Array>) {
      f.chunks.push(c);
      for (const w of f.wake.splice(0)) w();
      const t = dec.decode(c, { stream: true });
      const s = tail + t;
      if (!seen.said && SAID.test(s)) seen.said = true;
      if (!seen.failed && FAILED.test(s)) seen.failed = true;
      if (!seen.cut && CUT.test(s)) seen.cut = true;
      tail = t.slice(-48);
      text += t;
      // keep only the tail: usage and the model name are in the last chunks / the top-level object
      if (text.length > 400_000) text = text.slice(-200_000);
    }
  } catch {
    // upstream broke off: whatever arrived is still served and parsed
  }
  f.done = true;
  for (const w of f.wake.splice(0)) w();
  finished();
  onEnd(text, seen);
}

function reply(f: Flight, head: Head, stream: boolean, t0: number, joined: boolean, who: Who) {
  const headers = new Headers({ "content-type": head.type, "cache-control": "no-cache" });
  // nginx must not buffer the SSE stream
  headers.set("x-accel-buffering", "no");
  if (head.served) headers.set("x-served-model", head.served);
  let i = 0;
  const src = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      while (i >= f.chunks.length && !f.done) await new Promise<void>((r) => f.wake.push(r));
      try {
        if (i < f.chunks.length) ctl.enqueue(f.chunks[i++]);
        else ctl.close();
      } catch {
        // client went away meanwhile
      }
    },
  });
  const out = stream && head.status === 200 ? watchStream(src, t0, head.served, head.cost, joined, who) : src;
  return new Response(out, { status: head.status, headers });
}

const enc = new TextEncoder();
const chunk = (delta: object, finish: string | null = null, model = "ai-proxy") =>
  `data: ${JSON.stringify({ id: "ai-proxy-notice", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const completion = (content: string, model = "ai-proxy") =>
  JSON.stringify({ id: "ai-proxy-notice", object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

/** a whole answer written by the proxy itself (nothing paid) */
function canned(stream: boolean, content: string) {
  if (!stream) return new Response(completion(content), { headers: { "content-type": "application/json" } });
  const body = chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

function silentReply(s: number, stream: boolean) {
  const content = `[心之音代理] 测试模型：静默 ${s} 秒后回这一句（没有调用 BlockRun，没有付钱）。`;
  const wait = () => new Promise((r) => setTimeout(r, s * 1000));
  const model = "aiproxy/silent";
  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      if (stream) ctl.enqueue(enc.encode(chunk({ role: "assistant", content: "" }, null, model)));
      await wait();
      if (stream) ctl.enqueue(enc.encode(chunk({ content }, null, model) + chunk({}, "stop", model) + "data: [DONE]\n\n"));
      else ctl.enqueue(enc.encode(completion(content, model)));
      ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": stream ? "text/event-stream" : "application/json", "x-served-model": model } });
}

const SAID = /"(?:content|reasoning_content)":\s*"[^"]|"tool_calls"/;
const DONE = /data: ?\[DONE\]/;
// e.g. {"model":"error", … "[Error: stream stalled: no token for 120s (bedrock)]"}
const FAILED = /"model":\s*"error"/;
const CUT = /"finish_reason":\s*"length"/;

/**
 * Long silences happen (Claude on /chat/completions holds each tool-call argument back until it is complete; see
 * ai-claude.ts), and Cursor may give up on a silent connection and resend the turn, so SSE comments keep it open.
 * After 120 s with no token BlockRun gives up ("stream stalled … (bedrock)", or an empty "stop"; still paid): say why
 * in the reply instead of leaving the agent hanging on nothing.
 */
function watchStream(src: ReadableStream<Uint8Array>, t0: number, served: string | null, cost: number, joined: boolean, who: Who) {
  const say = sayer(who);
  const dec = new TextDecoder();
  const reader = src.getReader();
  let said = false, failed = false, noticed = false, tail = "", last = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const notice = () => {
    noticed = true;
    const s = Math.round((Date.now() - t0) / 1000);
    const paid = joined ? say("joined") : say("paid", { paid: money(cost) });
    const content = `\n\n${tag(who)} ${say("stalled", { s, served: served ?? "?", paid })}`;
    return enc.encode(chunk({ content }));
  };
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      if (KEEPALIVE_MS <= 0) return;
      timer = setInterval(() => {
        if (Date.now() - last < KEEPALIVE_MS) return;
        last = Date.now();
        try {
          ctl.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          clearInterval(timer);
        }
      }, 1000);
    },
    async pull(ctl) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (e) {
        clearInterval(timer);
        ctl.error(e);
        return;
      }
      if (next.done) {
        clearInterval(timer);
        if ((!said || failed) && !noticed) ctl.enqueue(notice());
        ctl.close();
        return;
      }
      last = Date.now();
      const text = dec.decode(next.value, { stream: true });
      if (!said && SAID.test(tail + text)) said = true;
      if (!failed && FAILED.test(tail + text)) failed = true;
      tail = text.slice(-48);
      const k = (said && !failed) || noticed ? -1 : text.search(DONE);
      if (k < 0) return ctl.enqueue(next.value);
      ctl.enqueue(enc.encode(text.slice(0, k)));
      ctl.enqueue(notice());
      ctl.enqueue(enc.encode(text.slice(k)));
    },
    cancel(reason) {
      clearInterval(timer);
      return reader.cancel(reason);
    },
  });
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
async function logUsage(id: string, text: string, t0: number) {
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

/** the operator sees every row (user_id tells Arm AI users apart) and its own spend; an Arm AI user only their own */
export async function aiProxyStats(limit = 100, who: Who = { kind: "op" }) {
  await ensure();
  const n = Math.min(Math.max(limit, 1), 500);
  const uid = who.kind === "user" ? who.user.id : null;
  const mine = uid === null ? sql`true` : sql`user_id = ${uid}`;
  const rows = await sql`select at, model, coalesce(served, body_model) as served, stream, cost::float8 as cost, tx, status, in_tok, out_tok, cached_tok, req_bytes, ms, shape, user_id::text from ai_proxy_calls where ${mine} order by id desc limit ${n}`;
  const days = await sql`select to_char(at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as day, model, count(*)::int as calls, sum(cost)::float8 as cost, sum(in_tok)::int as in_tok, sum(out_tok)::int as out_tok
    from ai_proxy_calls where status = 200 and at > now() - interval '30 days' and ${mine} group by 1, 2 order by 1 desc, 4 desc`;
  if (who.kind === "user") return { address: who.user.address, online: signerOnline(who.user), spentToday: await spentToday(uid), maxPerCall: USER_MAX_PER_CALL, calls: rows, days };
  return { address: aiProxyAddress(), spentToday: await spentToday(), dailyCap: DAILY_CAP, maxPerCall: MAX_PER_CALL, calls: rows, days };
}
