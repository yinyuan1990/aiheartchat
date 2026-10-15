import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { WebSocket } from "ws";
import { sql } from "./db.js";

/**
 * 10.14 Arm AI (desktop app for other people's Cursor): every user keeps their own wallet in the app; the server never
 * sees a private key. The app makes an API key locally and links its sha256 to the wallet with a personal_sign; Cursor
 * calls /api/ai/v1 with that key, and when BlockRun quotes a price the server asks the user's app (over the WebSocket
 * at /api/ai/signer) to sign it. The app checks the payee / asset / amount / its own caps before signing.
 */

export type AiUser = { id: string; address: string; lang: string };
/** languages of the messages the proxy writes into Cursor for Arm AI users (the app's own UI has its own files) */
export const AI_LANGS = ["zh", "en"];
const langOf = (v: unknown) => (AI_LANGS.includes(String(v)) ? String(v) : "zh");
type Reply = { t?: string; id?: string; payment?: string; reason?: string; lang?: string; authorization?: Record<string, string>; signature?: string };
type Pending = { want: string; resolve: (m: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Signer = { ws: WebSocket; pending: Map<string, Pending>; since: number };

const SIGN_TIMEOUT_MS = 30_000;
const LINK_MAX_AGE_MS = 10 * 60_000;
const signers = new Map<string, Signer>();
const keyCache = new Map<string, { user: AiUser | null; at: number }>();

let ready: Promise<void> | null = null;
export const ensureAiUsers = () => (ready ??= (async () => {
  await sql`create table if not exists ai_users (
    id bigserial primary key, address text not null unique, key_hash text not null unique,
    created_at timestamptz not null default now(), seen_at timestamptz)`;
  await sql`alter table ai_users add column if not exists lang text not null default 'zh'`;
  await sql`alter table if exists ai_proxy_calls add column if not exists user_id bigint`;
  // the service fee (ai-fees.ts) counts calls from here on: users who joined before it started owe nothing for those
  await sql`alter table ai_users add column if not exists fee_since timestamptz not null default now()`;
  await sql`create table if not exists ai_fees (
    id bigserial primary key, user_id bigint not null, amount bigint not null, status text not null, tx text, nonce text, reason text,
    at timestamptz not null default now())`;
  // 心之音后台 → AI: whether the app shows its Binance / OKX top-up page (off until the operator turns it on)
  await sql`alter table ai_users add column if not exists show_exchanges boolean not null default false`;
})());

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
export const linkMessage = (address: string, hash: string, at: string) => `Arm AI\nLink API key ${hash}\nto wallet ${address}\nat ${at}`;

/** POST /api/ai/register {address, keyHash, at, signature}: the wallet signs that this key hash is its key */
export async function aiRegister(b: { address?: string; keyHash?: string; at?: string; signature?: string; lang?: string }) {
  if (!b.address || !isAddress(b.address)) return { status: 400, json: { error: "bad address" } };
  if (!b.keyHash || !/^[0-9a-f]{64}$/.test(b.keyHash)) return { status: 400, json: { error: "bad keyHash" } };
  const at = Date.parse(b.at ?? "");
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > LINK_MAX_AGE_MS) return { status: 400, json: { error: "stale or bad timestamp (check the PC clock)" } };
  const address = getAddress(b.address);
  const ok = await verifyMessage({ address, message: linkMessage(address, b.keyHash, b.at!), signature: (b.signature ?? "0x") as Hex }).catch(() => false);
  if (!ok) return { status: 401, json: { error: "signature does not match the wallet" } };
  await ensureAiUsers();
  const [taken] = await sql<{ address: string }[]>`select address from ai_users where key_hash = ${b.keyHash}`;
  if (taken && taken.address !== address.toLowerCase()) return { status: 409, json: { error: "key already linked to another wallet" } };
  const [u] = await sql<{ id: string }[]>`insert into ai_users (address, key_hash, lang) values (${address.toLowerCase()}, ${b.keyHash}, ${langOf(b.lang)})
    on conflict (address) do update set key_hash = excluded.key_hash, lang = excluded.lang returning id::text`;
  keyCache.clear();
  return { status: 200, json: { ok: true, id: u.id, address } };
}

/** the Arm AI user behind an API key (null = not a user key) */
export async function userByKey(key: string): Promise<AiUser | null> {
  if (key.length < 32 || key.length > 200) return null;
  const h = keyHash(key);
  const c = keyCache.get(h);
  if (c && Date.now() - c.at < 60_000) return c.user;
  await ensureAiUsers();
  const [u] = await sql<{ id: string; address: string; lang: string }[]>`select id::text, address, lang from ai_users where key_hash = ${h}`;
  const user = u ? { id: u.id, address: u.address, lang: langOf(u.lang) } : null;
  keyCache.set(h, { user, at: Date.now() });
  return user;
}

export const signerOnline = (u: AiUser) => signers.get(u.id)?.ws.readyState === WebSocket.OPEN;

/** /api/ai/signer upgrade: `Authorization: Bearer <key>` (or ?key= for clients that can't set headers) */
export async function signerAuth(req: IncomingMessage) {
  const h = req.headers.authorization?.replace(/^Bearer /, "") ?? new URL(req.url ?? "/", "http://x").searchParams.get("key") ?? "";
  return userByKey(h);
}

/** `lang`: the app's UI language (?lang= on the upgrade), kept for the messages written into Cursor */
export function attachSigner(ws: WebSocket, user: AiUser, lang?: string | null) {
  const old = signers.get(user.id);
  if (old && old.ws !== ws) old.ws.close(4000, "replaced by a newer Arm AI connection");
  const s: Signer = { ws, pending: new Map(), since: Date.now() };
  signers.set(user.id, s);
  if (lang && AI_LANGS.includes(lang)) user.lang = lang;
  void sql`update ai_users set seen_at = now(), lang = ${user.lang} where id = ${user.id}`.catch(() => {});
  ws.send(JSON.stringify({ t: "hello", address: user.address }));
  void sql<{ show_exchanges: boolean }[]>`select show_exchanges from ai_users where id = ${user.id}`
    .then(([r]) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "config", exchanges: !!r?.show_exchanges })))
    .catch(() => {});
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25_000);
  ws.on("message", (raw) => {
    let m: Reply;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.t === "lang") {
      // `user` is the cached object the chat requests get from userByKey, so this takes effect at once
      if (m.lang && AI_LANGS.includes(m.lang) && m.lang !== user.lang) {
        user.lang = m.lang;
        void sql`update ai_users set lang = ${user.lang} where id = ${user.id}`.catch(() => {});
      }
      return;
    }
    const p = m.id ? s.pending.get(m.id) : undefined;
    if (!p) return;
    s.pending.delete(m.id!);
    clearTimeout(p.timer);
    if (m.t === p.want) p.resolve(m);
    else p.reject(new Error(m.reason || "Arm AI refused to sign"));
  });
  ws.on("close", () => {
    clearInterval(ping);
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Arm AI disconnected while signing"));
    }
    if (signers.get(user.id) === s) signers.delete(user.id);
  });
}

/**
 * ask the user's Arm AI to pay this quote; resolves to the base64 x402 payment. The app rebuilds and checks
 * everything itself (payee, asset, network, amount vs its caps); the server only re-checks who signed what.
 */
export async function remoteSign(user: AiUser, accepted: Record<string, unknown>, resource: unknown, info: { model: string; bytes: number }): Promise<string> {
  const m = await ask(user, "signed", { t: "sign", accepted, resource, model: info.model, bytes: info.bytes });
  const p = JSON.parse(Buffer.from(String(m.payment), "base64").toString("utf8")) as { payload?: { authorization?: { from?: string; to?: string; value?: string } } };
  const a = p.payload?.authorization;
  if (a?.from?.toLowerCase() !== user.address || a?.to?.toLowerCase() !== String(accepted.payTo).toLowerCase() || a?.value !== String(accepted.amount)) throw new Error("payment does not match the quote");
  return String(m.payment);
}

/** ask the user's Arm AI to sign the service fee it owes (ai-fees.ts checks and submits what comes back) */
export async function remoteFee(user: AiUser, fee: { to: string; amount: number; bps: number; owed: number }) {
  const m = await ask(user, "feeSigned", { t: "fee", ...fee });
  if (!m.authorization || typeof m.signature !== "string") throw new Error("bad fee reply");
  return { authorization: m.authorization, signature: m.signature };
}

// ---------------------------------------------------------------- 心之音后台 → AI (houduan calls these with AI_ADMIN_TOKEN)

const ADMIN_TOKEN = process.env.AI_ADMIN_TOKEN ?? "";
/** off (always false) unless AI_ADMIN_TOKEN is set to at least 32 characters */
export const aiAdminOk = (h: string | undefined) => {
  const got = Buffer.from(h?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(ADMIN_TOKEN);
  return ADMIN_TOKEN.length >= 32 && got.length === want.length && timingSafeEqual(got, want);
};

/** GET /api/ai/admin/users?q=&page=&size= : newest first; q matches part of the address */
export async function aiAdminUsers(q: string, page: number, size: number) {
  await ensureAiUsers();
  size = Math.min(100, Math.max(1, Math.floor(size) || 20));
  page = Math.max(1, Math.floor(page) || 1);
  const term = q.trim().toLowerCase();
  const where = term ? sql`where address like ${`%${term.replace(/[%_\\]/g, "")}%`}` : sql``;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ai_users ${where}`;
  const rows = await sql<{ id: string; address: string; created_at: Date; seen_at: Date | null; show_exchanges: boolean }[]>`
    select id::text, address, created_at, seen_at, show_exchanges from ai_users ${where} order by id desc limit ${size} offset ${(page - 1) * size}`;
  const list = rows.map((r) => ({
    id: r.id,
    address: getAddress(r.address),
    createdAt: r.created_at,
    seenAt: r.seen_at,
    online: signers.get(r.id)?.ws.readyState === WebSocket.OPEN,
    exchanges: r.show_exchanges,
  }));
  return { list, total: n, page, size };
}

/** POST /api/ai/admin/users/:id/exchanges {show}: saved, and pushed at once to the user's app if it is open */
export async function aiAdminSetExchanges(id: string, show: boolean) {
  if (!/^\d+$/.test(id)) return null;
  await ensureAiUsers();
  const [r] = await sql<{ id: string }[]>`update ai_users set show_exchanges = ${show} where id = ${id} returning id::text`;
  if (!r) return null;
  const s = signers.get(r.id);
  const pushed = s?.ws.readyState === WebSocket.OPEN;
  if (pushed) s!.ws.send(JSON.stringify({ t: "config", exchanges: show }));
  return { id: r.id, exchanges: show, pushed };
}

/** send one request over the user's signer link; resolves with the app's reply of type `want` */
function ask(user: AiUser, want: string, msg: Record<string, unknown>): Promise<Reply> {
  const s = signers.get(user.id);
  if (!s || s.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("offline"));
  const id = randomBytes(8).toString("hex");
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error("Arm AI did not answer in time"));
    }, SIGN_TIMEOUT_MS);
    s.pending.set(id, { want, timer, reject, resolve });
    s.ws.send(JSON.stringify({ ...msg, id }));
  });
}
