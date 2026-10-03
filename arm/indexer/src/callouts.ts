import { createPrivateKey, sign } from "node:crypto";
import type { PendingQuery, Row as PgRow } from "postgres";
import { sql } from "./db.js";
import { solTokens } from "./solana.js";

/**
 * pump.fun callouts (喊单) for the wallet. pump's own undocumented web APIs, verified 10.3 from the server:
 * - POST /auth/login/token {address, signature, timestamp, authType:"non_custodial"} — signature = ed25519 over
 *   `Sign in to pump.fun: <timestamp>` by an empty wallet of ours (PUMP_AUTH_KEY in indexer.env, holds no funds);
 * - GET /callout/leaderboard?duration=weekly|monthly&limit= (login) — callers with their track record;
 * - GET /callout/list/{uuid|wallet}?sortBy=TIMESTAMP&sortOrder=DESC&limit= — a caller's callouts (no login needed).
 * There is no global "latest callouts" feed, so the feed is built by polling the ranked (and pinned) callers in turn.
 * Everything pump-callout-specific lives here.
 */

const FE = "https://frontend-api-v3.pump.fun";
const HEADERS = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36" };
const BOARD_EVERY_MS = 10 * 60_000;
/** pump's per-IP limiter (shared with pump.ts's coin pages) starts answering 429 at about one request a second */
const POLL_GAP_MS = 3_000;
const PROFILE_TTL_MS = 24 * 3_600_000;

// ---------- pump login ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc58 = (buf: Uint8Array) => {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
};
const dec58 = (s: string) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  const lead = [...s].findIndex((c) => c !== "1");
  return Buffer.concat([Buffer.alloc(lead < 0 ? s.length : lead), Buffer.from(h, "hex")]);
};

let token: { value: string; at: number } | null = null;

async function login(): Promise<string> {
  const secret = process.env.PUMP_AUTH_KEY;
  if (!secret) throw new Error("PUMP_AUTH_KEY not set");
  const raw = dec58(secret);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const address = enc58(raw.subarray(32, 64));
  const timestamp = Date.now();
  const signature = enc58(sign(null, Buffer.from(`Sign in to pump.fun: ${timestamp}`), key));
  const r = await fetch(`${FE}/auth/login/token`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ address, signature, timestamp, authType: "non_custodial" }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string };
  if (!r.ok || !j.access_token) throw new Error(`pump login ${r.status}`);
  token = { value: j.access_token, at: Date.now() };
  return j.access_token;
}

async function pumpGet<T>(path: string, auth = false): Promise<T> {
  let last = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const bearer = auth ? (token && Date.now() - token.at < 6 * 3_600_000 ? token.value : await login()) : null;
    const r = await fetch(`${FE}${path}`, { headers: bearer ? { ...HEADERS, authorization: `Bearer ${bearer}` } : HEADERS, signal: AbortSignal.timeout(12_000) });
    last = r.status;
    if (r.status === 401 && auth) {
      token = null;
      continue;
    }
    if (r.status === 429) {
      const after = Number(r.headers.get("retry-after"));
      await new Promise((res) => setTimeout(res, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 15_000) : 2_000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw Object.assign(new Error(`pump ${r.status}`), { status: r.status });
    return (await r.json()) as T;
  }
  throw new Error(`pump: gave up on ${path.split("?")[0]} (last HTTP ${last})`);
}

// ---------- storage ----------

export async function ensureCalloutTables() {
  await sql`create table if not exists pump_callers (
    uuid text primary key,
    wallet text not null,
    username text,
    avatar text,
    total integer,
    avg_multiple real,
    median_multiple real,
    pct2x real,
    avg_peak_ms bigint,
    rank_weekly integer,
    rank_monthly integer,
    pinned boolean not null default false,
    polled_at timestamptz,
    profile_at timestamptz,
    seen_at timestamptz not null default now()
  )`;
  await sql`create index if not exists pump_callers_wallet on pump_callers (wallet)`;
  await sql`create table if not exists pump_callouts (
    id text primary key,
    caller text not null,
    mint text not null,
    chain text,
    mcap_usd double precision,
    price_usd double precision,
    multiple real,
    max_multiple real,
    max_at timestamptz,
    thesis text,
    media text,
    created_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists pump_callouts_created on pump_callouts (created_at desc)`;
  await sql`create index if not exists pump_callouts_caller on pump_callouts (caller, created_at desc)`;
  await sql`create index if not exists pump_callouts_mint on pump_callouts (mint, created_at desc)`;
}

type BoardRow = {
  userId: string;
  user_uuid: string;
  primaryWallet?: string;
  totalCallouts?: number;
  avgMultiple?: number;
  medianMultiple?: number;
  pct2xOrMore?: number;
  averageTimeToPeak?: number;
};
type RawCallout = {
  calloutId: string;
  userId: string;
  coinMint: string;
  marketCap?: number;
  calloutPriceUsd?: number;
  multiple?: number;
  maxMultiplier?: number;
  maxMultiplierAt?: string;
  createdAt: number;
  thesis?: string;
  mediaUrl?: string | null;
  chain?: string | null;
};

async function refreshBoard() {
  for (const duration of ["weekly", "monthly"] as const) {
    const r = await pumpGet<{ callouts?: BoardRow[] }>(`/callout/leaderboard?duration=${duration}&limit=100`, true);
    const rows = (r.callouts ?? []).filter((x) => x.user_uuid && x.userId);
    const col = duration === "weekly" ? sql`rank_weekly` : sql`rank_monthly`;
    await sql`update pump_callers set ${col} = null where ${col} is not null`;
    for (const [i, x] of rows.entries()) {
      const stats = {
        uuid: x.user_uuid,
        wallet: x.primaryWallet ?? x.userId,
        total: x.totalCallouts ?? null,
        avg_multiple: x.avgMultiple ?? null,
        median_multiple: x.medianMultiple ?? null,
        pct2x: x.pct2xOrMore ?? null,
        avg_peak_ms: x.averageTimeToPeak != null ? Math.round(x.averageTimeToPeak) : null,
      };
      // the weekly board's stats are the fresher ones; the monthly pass only fills its rank (and new callers)
      if (duration === "weekly")
        await sql`insert into pump_callers ${sql({ ...stats, rank_weekly: i + 1 })}
          on conflict (uuid) do update set wallet = excluded.wallet, total = excluded.total, avg_multiple = excluded.avg_multiple,
            median_multiple = excluded.median_multiple, pct2x = excluded.pct2x, avg_peak_ms = excluded.avg_peak_ms, rank_weekly = excluded.rank_weekly, seen_at = now()`;
      else
        await sql`insert into pump_callers ${sql({ ...stats, rank_monthly: i + 1 })}
          on conflict (uuid) do update set rank_monthly = excluded.rank_monthly, seen_at = now()`;
    }
  }
}

type Listener = (c: CalloutView) => void;
const listeners: Listener[] = [];
/** New callouts as they are first seen (follow → push in 心之音 hooks in here). */
export const onCallout = (fn: Listener) => void listeners.push(fn);

async function pollOne() {
  const [c] = await sql<{ uuid: string; wallet: string; polled_at: Date | null; profile_at: Date | null }[]>`
    select uuid, wallet, polled_at, profile_at from pump_callers
    where pinned or rank_weekly is not null or rank_monthly is not null
    order by pinned desc, polled_at asc nulls first limit 1`;
  if (!c) return;
  await sql`update pump_callers set polled_at = now() where uuid = ${c.uuid}`;
  const first = c.polled_at == null;
  const r = await pumpGet<{ callouts?: RawCallout[] }>(`/callout/list/${c.uuid}?limit=20&sortBy=TIMESTAMP&sortOrder=DESC`);
  const fresh: string[] = [];
  for (const x of r.callouts ?? []) {
    if (!x.calloutId || !x.coinMint) continue;
    const row = {
      id: x.calloutId,
      caller: c.uuid,
      mint: x.coinMint,
      chain: x.chain ?? null,
      mcap_usd: x.marketCap ?? null,
      price_usd: x.calloutPriceUsd ?? null,
      multiple: x.multiple ?? null,
      max_multiple: x.maxMultiplier ?? null,
      max_at: x.maxMultiplierAt ? new Date(x.maxMultiplierAt) : null,
      thesis: x.thesis?.slice(0, 1000) ?? null,
      media: x.mediaUrl ?? null,
      created_at: new Date(x.createdAt),
    };
    const [ins] = await sql<{ inserted: boolean }[]>`insert into pump_callouts ${sql(row)}
      on conflict (id) do update set multiple = excluded.multiple, max_multiple = excluded.max_multiple, max_at = excluded.max_at, updated_at = now()
      returning (xmax = 0) as inserted`;
    // the first poll of a caller back-fills history: only callouts after that count as "new"
    if (ins?.inserted && !first && Date.now() - row.created_at.getTime() < 3_600_000) fresh.push(row.id);
  }
  if (!c.profile_at || Date.now() - c.profile_at.getTime() > PROFILE_TTL_MS) await refreshProfile(c.uuid, c.wallet).catch(() => {});
  if (fresh.length && listeners.length) for (const v of await viewsOf(sql`c.id in ${sql(fresh)}`, 20)) listeners.forEach((f) => f(v));
}

async function refreshProfile(uuid: string, wallet: string) {
  const p = await pumpGet<Record<string, unknown>>(`/users/${wallet}`).catch(() => ({}) as Record<string, unknown>);
  const name = typeof p.username === "string" && p.username ? p.username.slice(0, 40) : null;
  const avatar = typeof p.profile_image === "string" && /^https:\/\//.test(p.profile_image) ? p.profile_image : null;
  await sql`update pump_callers set username = coalesce(${name}, username), avatar = coalesce(${avatar}, avatar), profile_at = now() where uuid = ${uuid}`;
}

let started = false;
export function startCallouts() {
  if (started || !process.env.PUMP_AUTH_KEY) return;
  started = true;
  void (async () => {
    await ensureCalloutTables();
    let boardAt = 0;
    for (;;) {
      try {
        if (Date.now() - boardAt > BOARD_EVERY_MS) {
          boardAt = Date.now();
          await refreshBoard();
        }
        await pollOne();
      } catch (e) {
        console.warn("[callouts]", (e as Error).message);
        await new Promise((r) => setTimeout(r, 10_000));
      }
      await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    }
  })();
}

// ---------- reading ----------

export type CallerView = {
  id: string;
  wallet: string;
  name: string | null;
  avatar: string | null;
  total: number | null;
  avgMultiple: number | null;
  medianMultiple: number | null;
  pct2x: number | null;
  avgPeakMs: number | null;
  rankWeekly: number | null;
  rankMonthly: number | null;
  pinned: boolean;
};
export type CalloutView = {
  id: string;
  caller: Pick<CallerView, "id" | "wallet" | "name" | "avatar">;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  /** at the moment of the call */
  mcapUsd: number | null;
  priceUsd: number | null;
  /** latest price / call price */
  multiple: number | null;
  maxMultiple: number | null;
  maxAt: string | null;
  thesis: string | null;
  at: string;
};

type Row = {
  id: string;
  mint: string;
  mcap_usd: number | null;
  price_usd: number | null;
  multiple: number | null;
  max_multiple: number | null;
  max_at: Date | null;
  thesis: string | null;
  created_at: Date;
  uuid: string;
  wallet: string;
  username: string | null;
  avatar: string | null;
};

async function viewsOf(where: PendingQuery<PgRow[]>, limit: number, before?: Date): Promise<CalloutView[]> {
  const rows = await sql<Row[]>`
    select c.id, c.mint, c.mcap_usd, c.price_usd, c.multiple, c.max_multiple, c.max_at, c.thesis, c.created_at,
           k.uuid, k.wallet, k.username, k.avatar
    from pump_callouts c join pump_callers k on k.uuid = c.caller
    where ${where} and (c.chain is null or c.chain = 'solana') ${before ? sql`and c.created_at < ${before}` : sql``}
    order by c.created_at desc limit ${limit}`;
  const meta = rows.length ? await solTokens(rows.map((r) => r.mint)).catch(() => ({}) as Awaited<ReturnType<typeof solTokens>>) : {};
  return rows.map((r) => {
    const t = meta[r.mint];
    const live = t?.usdPrice != null && r.price_usd ? t.usdPrice / r.price_usd : null;
    return {
      id: r.id,
      caller: { id: r.uuid, wallet: r.wallet, name: r.username, avatar: r.avatar },
      mint: r.mint,
      symbol: t?.symbol ?? null,
      name: t?.name ?? null,
      image: t?.icon ?? null,
      mcapUsd: r.mcap_usd,
      priceUsd: r.price_usd,
      multiple: live ?? r.multiple,
      maxMultiple: r.max_multiple != null ? Math.max(r.max_multiple, live ?? 0) : live,
      maxAt: r.max_at?.toISOString() ?? null,
      thesis: r.thesis,
      at: r.created_at.toISOString(),
    };
  });
}

const feedCache = new Map<string, { at: number; v: CalloutView[] }>();
/** Newest callouts overall, of one caller, or on one coin. */
export async function calloutFeed(q: { caller?: string; mint?: string; before?: string; limit?: number }): Promise<CalloutView[]> {
  const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 60);
  const before = q.before ? new Date(q.before) : undefined;
  const key = JSON.stringify([q.caller ?? "", q.mint ?? "", q.before ?? "", limit]);
  const hit = feedCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.v;
  const where = q.caller ? sql`(k.uuid = ${q.caller} or k.wallet = ${q.caller})` : q.mint ? sql`c.mint = ${q.mint}` : sql`true`;
  const v = await viewsOf(where, limit, before && !Number.isNaN(before.getTime()) ? before : undefined);
  feedCache.set(key, { at: Date.now(), v });
  if (feedCache.size > 500) feedCache.clear();
  return v;
}

const shapeCaller = (r: Record<string, unknown>): CallerView => ({
  id: String(r.uuid),
  wallet: String(r.wallet),
  name: (r.username as string) ?? null,
  avatar: (r.avatar as string) ?? null,
  total: (r.total as number) ?? null,
  avgMultiple: (r.avg_multiple as number) ?? null,
  medianMultiple: (r.median_multiple as number) ?? null,
  pct2x: (r.pct2x as number) ?? null,
  avgPeakMs: r.avg_peak_ms != null ? Number(r.avg_peak_ms) : null,
  rankWeekly: (r.rank_weekly as number) ?? null,
  rankMonthly: (r.rank_monthly as number) ?? null,
  pinned: !!r.pinned,
});

export async function calloutCallers(sort: string): Promise<CallerView[]> {
  const rows =
    sort === "monthly"
      ? await sql`select * from pump_callers where rank_monthly is not null or pinned order by pinned desc, rank_monthly asc nulls last limit 120`
      : await sql`select * from pump_callers where rank_weekly is not null or pinned order by pinned desc, rank_weekly asc nulls last limit 120`;
  return rows.map(shapeCaller);
}

export async function calloutCaller(id: string): Promise<CallerView | null> {
  const [r] = await sql`select * from pump_callers where uuid = ${id} or wallet = ${id} limit 1`;
  return r ? shapeCaller(r) : null;
}

/** Owner adds / removes a caller to follow even when they are off the leaderboards (by wallet or pump user uuid). */
export async function pinCaller(id: string, pinned: boolean) {
  if (!/^[0-9a-f-]{36}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) throw new Error("bad caller id");
  if (!pinned) {
    await sql`update pump_callers set pinned = false where uuid = ${id} or wallet = ${id}`;
    return;
  }
  const known = await calloutCaller(id);
  if (known) {
    await sql`update pump_callers set pinned = true where uuid = ${known.id}`;
    return;
  }
  // unknown caller: their list endpoint tells us the wallet (and that they exist at all)
  const r = await pumpGet<{ callouts?: RawCallout[] }>(`/callout/list/${id}?limit=1&sortBy=TIMESTAMP&sortOrder=DESC`);
  const wallet = r.callouts?.[0]?.userId ?? (id.length < 36 ? id : null);
  if (!wallet) throw new Error("no callouts for this caller");
  await sql`insert into pump_callers (uuid, wallet, pinned) values (${id}, ${wallet}, true) on conflict (uuid) do update set pinned = true`;
}
