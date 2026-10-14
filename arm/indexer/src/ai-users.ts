import { createHash, randomBytes } from "node:crypto";
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
type Pending = { resolve: (payment: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
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
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25_000);
  ws.on("message", (raw) => {
    let m: { t?: string; id?: string; payment?: string; reason?: string; lang?: string };
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
    if (m.t === "signed" && typeof m.payment === "string") p.resolve(m.payment);
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
export function remoteSign(user: AiUser, accepted: Record<string, unknown>, resource: unknown, info: { model: string; bytes: number }): Promise<string> {
  const s = signers.get(user.id);
  if (!s || s.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("offline"));
  const id = randomBytes(8).toString("hex");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error("Arm AI did not answer in time"));
    }, SIGN_TIMEOUT_MS);
    s.pending.set(id, {
      timer,
      reject,
      resolve: (payment) => {
        try {
          const p = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as { payload?: { authorization?: { from?: string; to?: string; value?: string } } };
          const a = p.payload?.authorization;
          if (a?.from?.toLowerCase() !== user.address || a?.to?.toLowerCase() !== String(accepted.payTo).toLowerCase() || a?.value !== String(accepted.amount)) throw new Error("payment does not match the quote");
          resolve(payment);
        } catch (e) {
          reject(e as Error);
        }
      },
    });
    s.ws.send(JSON.stringify({ t: "sign", id, accepted, resource, model: info.model, bytes: info.bytes }));
  });
}
