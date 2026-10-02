import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";
import { sql } from "./db.js";
import { scanner, scanShared } from "./scanner.js";
import { replayDetail, type ReplayDetail, type Role } from "./replay.js";

/**
 * Sell the Top (10.2): one real Arc launch a day, the same for everyone. You hold from the first retail buy of its
 * first hour and get one SELL. The server owns the clock: a round runs DUR_MS of real time mapped onto the hour as
 * t = entry + (T − entry)·u² (the first minutes get most of the time), trades are only handed out up to the current
 * game time, and the sell price is taken at the server's time of the request — knowing the client code doesn't help.
 * Free to play, no prizes: the first round per IP and day counts in the stats, rounds signed by a wallet go on the board.
 */

const HOUR = 3_600_000;
const DUR_MS = 45_000;
const LEAD_MS = 3_000;
const MIN_BUYERS = 15;
const MAX_ENTRY_SEC = 600;
const MIN_TOP = 1.5;
const MIN_AFTER = 30;
const MIN_AGE_DAYS = 3;
const MAX_TRIES = 30;
const MAX_ROUNDS_PER_IP = 40;
const PATH_POINTS = 400;
const BOARD = 20;
const SIGN_TTL = 5 * 60_000;

export const gameDay = (ms = Date.now()) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const nextDayAt = (ms = Date.now()) => Date.parse(`${gameDay(ms)}T00:00:00+08:00`) + 24 * HOUR;
export const signMessage = (wallet: string, day: string, ts: number) => `Arm · Sell the Top\nDay: ${day}\nWallet: ${getAddress(wallet)}\nTime: ${ts}`;

type GameEvent = { t: number; side: 1 | -1; usdc: number; x: number | null; role: Role };
type Round = {
  day: string; n: number; pool: string; d: ReplayDetail;
  entryT: number; T: number; pre: number; events: GameEvent[];
  peak: { x: number; t: number }; finalX: number; nowX: number;
};

const rel = (v: number) => Number(v.toPrecision(5));
const sig4 = (v: number) => Number(v.toPrecision(4));

/** Game time (seconds after the open) `ms` after the round's clock started. */
const clock = (r: Round, ms: number) => r.entryT + (r.T - r.entryT) * Math.min(1, Math.max(0, ms) / DUR_MS) ** 2;

/** Multiple of the entry price at game time `t`: the last priced trade at or before it. */
function xAt(r: Round, t: number) {
  let x = 1;
  for (const e of r.events) {
    if (e.t > t) break;
    if (e.x !== null && e.t >= r.entryT) x = e.x;
  }
  return x;
}

function build(day: string, n: number, pool: string, d: ReplayDetail): Round | null {
  const fr = d.firstRetail;
  if (!fr || !d.p0) return null;
  const entryPx = d.p0 * fr.x;
  const events = d.events.map((e) => ({ t: e.t, side: e.side, usdc: e.usdc, x: e.px === null ? null : rel(e.px / entryPx), role: e.role }));
  const pre = events.findIndex((e) => e.t > fr.t);
  if (pre < 0) return null;
  let peak = { x: 1, t: fr.t };
  for (const e of events.slice(pre)) if (e.x !== null && e.x > peak.x) peak = { x: e.x, t: e.t };
  const r: Round = { day, n, pool, d, entryT: fr.t, T: d.window, pre, events, peak, finalX: 1, nowX: rel(d.nowPx / entryPx) };
  r.finalX = xAt(r, r.T);
  return r;
}

const usable = (r: Round | null) => !!r && r.entryT <= MAX_ENTRY_SEC && r.events.length - r.pre >= MIN_AFTER && r.peak.x >= MIN_TOP;

/** Candidate pools: old enough to be finished, busy first hour; tried in an order seeded by the day. */
async function pick(day: string): Promise<{ pool: string; round: Round } | null> {
  const st = await scanner();
  const sh = st.status === "ready" ? scanShared() : null;
  if (!sh) return null;
  const [{ m }] = await sql<{ m: string | null }[]>`select max(block) as m from dex_swaps`;
  const cutoff = Number(m ?? 0) - Math.round((MIN_AGE_DAYS * 86_400) / sh.bt);
  const win = Math.round(3600 / sh.bt);
  const used = new Set((await sql<{ pool: string }[]>`select pool from game_days`).map((r) => r.pool));
  const old = [...sh.born].filter(([p, b]) => b <= cutoff && !used.has(p));
  if (!old.length) return null;
  const rows = await sql<{ pool: string; symbol: string }[]>`
    select s.pool, p.symbol
    from unnest(${old.map(([p]) => p)}::text[], ${old.map(([, b]) => String(b))}::bigint[]) as w(pool, b0)
    join dex_swaps s on s.pool = w.pool and s.block between w.b0 and w.b0 + ${win}
    join dex_pools p on p.address = w.pool and p.usdc
    group by s.pool, p.symbol
    having count(distinct s.trader) filter (where s.side = 1) >= ${MIN_BUYERS}`;
  const seed = (p: string) => createHash("sha256").update(`${day}:${p}`).digest().readUInt32BE(0);
  const order = rows.filter((r) => !sh.NOT_MEME.test(r.symbol)).map((r) => r.pool).sort((a, b) => seed(a) - seed(b));
  for (const pool of order.slice(0, MAX_TRIES)) {
    const d = await replayDetail(pool);
    const round = d ? build(day, 0, pool, d) : null;
    if (usable(round)) return { pool, round: round! };
  }
  return null;
}

const rounds = new Map<string, Round>();
const pending = new Map<string, Promise<Round | null>>();

async function load(day: string): Promise<Round | null> {
  let [row] = await sql<{ pool: string; n: number }[]>`select pool, n from game_days where day = ${day}`;
  if (!row) {
    if (day !== gameDay()) return null;
    const got = await pick(day);
    if (!got) return null;
    await sql`insert into game_days (day, pool, n) select ${day}, ${got.pool}, coalesce(max(n), 0) + 1 from game_days on conflict (day) do nothing`;
    [row] = await sql<{ pool: string; n: number }[]>`select pool, n from game_days where day = ${day}`;
  }
  const d = await replayDetail(row.pool);
  return d ? build(day, row.n, row.pool, d) : null;
}

export function round(day = gameDay()): Promise<Round | null> {
  const hit = rounds.get(day);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(day);
  if (!p) {
    p = load(day)
      .then((r) => {
        if (r) rounds.set(day, r);
        for (const k of rounds.keys()) if (k < gameDay(Date.now() - 3 * 86_400_000)) rounds.delete(k);
        return r;
      })
      .finally(() => pending.delete(day));
    pending.set(day, p);
  }
  return p;
}

type Play = { id: string; pub: string; day: string; ip: string; wallet: string | null; counted: boolean; ranked: boolean; startAt: number; soldT: number | null; x: number | null };
const plays = new Map<string, Play>();

async function play(id: string): Promise<Play | null> {
  const hit = plays.get(id);
  if (hit) return hit;
  const [r] = await sql<{ id: string; pub: string; day: string; ip: string; wallet: string | null; counted: boolean; ranked: boolean; started_at: Date; sold_t: number | null; x: number | null }[]>`
    select id, pub, day, ip, wallet, counted, ranked, started_at, sold_t, x from game_plays where id = ${id}`;
  if (!r) return null;
  const p: Play = { id: r.id, pub: r.pub, day: r.day, ip: r.ip, wallet: r.wallet, counted: r.counted, ranked: r.ranked, startAt: r.started_at.getTime(), soldT: r.sold_t, x: r.x };
  plays.set(id, p);
  if (plays.size > 5000) plays.delete(plays.keys().next().value!);
  return p;
}

async function playByPub(pub: string) {
  const [r] = await sql<{ id: string }[]>`select id from game_plays where pub = ${pub}`;
  return r ? play(r.id) : null;
}

async function dayStats(day: string) {
  const [s] = await sql<{ n: number; avg: number | null }[]>`
    select count(*)::int as n, avg(x)::float8 as avg from game_plays where day = ${day} and counted and x is not null`;
  return { players: s.n, avgX: s.avg === null || day === gameDay() ? null : sig4(s.avg) };
}

export async function gameToday() {
  const day = gameDay();
  const r = await round(day);
  if (!r) {
    const st = await scanner();
    return st.status === "syncing" ? { status: "syncing" as const, progress: st.progress } : { status: "none" as const };
  }
  const prev = await round(gameDay(Date.now() - 86_400_000));
  return {
    status: "ready" as const, day, n: r.n, nextAt: nextDayAt(), durMs: DUR_MS, ...(await dayStats(day)),
    entry: { t: r.entryT, rank: r.d.firstRetail!.rank, ahead: r.d.aheadOfRetail },
    yesterday: prev ? { n: prev.n, symbol: prev.d.symbol, token: prev.d.token, peakX: prev.peak.x, ...(await dayStats(prev.day)) } : null,
  };
}

function meta(r: Round, p: Play) {
  return {
    id: p.id, day: r.day, n: r.n, startAt: p.startAt, serverNow: Date.now(), durMs: DUR_MS, T: r.T,
    entry: { t: r.entryT, rank: r.d.firstRetail!.rank, ahead: r.d.aheadOfRetail, xOpen: rel(r.d.firstRetail!.x) },
    pre: r.events.slice(0, r.pre), counted: p.counted, ranked: p.ranked, sold: p.x !== null,
  };
}

export async function gameStart(ip: string, body: { wallet?: string; ts?: number; sig?: string }) {
  const day = gameDay();
  const r = await round(day);
  if (!r) return { error: "no round today" as const };
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from game_plays where day = ${day} and ip = ${ip}`;
  if (n >= MAX_ROUNDS_PER_IP) return { error: "too many rounds today" as const };
  let wallet: string | null = null;
  if (body.wallet && body.sig && body.ts) {
    if (!isAddress(body.wallet) || Math.abs(Date.now() - body.ts) > SIGN_TTL) return { error: "bad signature" as const };
    const ok = await verifyMessage({ address: getAddress(body.wallet), message: signMessage(body.wallet, day, body.ts), signature: body.sig as `0x${string}` }).catch(() => false);
    if (!ok) return { error: "bad signature" as const };
    wallet = getAddress(body.wallet);
  }
  const id = randomBytes(12).toString("base64url");
  const pub = randomBytes(6).toString("base64url");
  const startAt = Date.now() + LEAD_MS;
  // the partial unique indexes decide the flags: the first round of an IP counts, the first counted one of a wallet ranks
  let counted = n === 0, ranked = counted && !!wallet;
  for (;;) {
    try {
      await sql`insert into game_plays (id, pub, day, ip, wallet, counted, ranked, started_at)
                values (${id}, ${pub}, ${day}, ${ip}, ${wallet}, ${counted}, ${ranked}, ${new Date(startAt)})`;
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "23505" || (!counted && !ranked)) throw e;
      if (ranked) ranked = false;
      else counted = false;
    }
  }
  const p: Play = { id, pub, day, ip, wallet, counted, ranked, startAt, soldT: null, x: null };
  plays.set(id, p);
  return meta(r, p);
}

export async function gameSession(id: string) {
  const p = await play(id);
  const r = p ? await round(p.day) : null;
  return p && r ? meta(r, p) : null;
}

/** Trades from index `from` up to the current game time (never ahead of it). */
export async function gameTick(id: string, from: number) {
  const p = await play(id);
  const r = p ? await round(p.day) : null;
  if (!p || !r) return null;
  const now = clock(r, Date.now() - p.startAt);
  const k = Math.max(r.pre, from);
  let end = k;
  while (end < r.events.length && r.events[end].t <= now) end++;
  return { now, done: now >= r.T, sold: p.x !== null, from: k, events: r.events.slice(k, end) };
}

export async function gameSell(id: string) {
  const p = await play(id);
  const r = p ? await round(p.day) : null;
  if (!p || !r) return null;
  if (p.x === null) {
    const t = clock(r, Date.now() - p.startAt);
    const x = xAt(r, t);
    const [row] = await sql<{ sold_t: number; x: number }[]>`
      update game_plays set sold_t = ${t}, x = ${x}, finished_at = now() where id = ${id} and x is null returning sold_t, x`;
    if (row) { p.soldT = row.sold_t; p.x = row.x; }
    else { const [s] = await sql<{ sold_t: number; x: number }[]>`select sold_t, x from game_plays where id = ${id}`; p.soldT = s.sold_t; p.x = s.x; }
  }
  return result(r, p, true);
}

/** Share of the hour's best exit captured: 0 at the entry price, 1 at the top; negative below the entry. */
const capture = (r: Round, x: number) => (x >= 1 ? (r.peak.x > 1 ? Math.min(1, (x - 1) / (r.peak.x - 1)) : 1) : x - 1);

function path(r: Round) {
  const pts: [number, number][] = [];
  for (const e of r.events) if (e.x !== null) pts.push([e.t, e.x]);
  const step = Math.max(1, Math.ceil(pts.length / PATH_POINTS));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1 || pts[i][1] === r.peak.x);
}

async function result(r: Round, p: Play, mine: boolean) {
  const x = p.x!;
  const [s] = await sql<{ n: number; below: number }[]>`
    select count(*)::int as n, count(*) filter (where x < ${x})::int as below
    from game_plays where day = ${r.day} and counted and x is not null and id <> ${p.id}`;
  // While the day is live, x / capture / timing would let anyone back out the top (and the coin name lets them look
  // the chart up): others only get persona-level data, and the player sees their chart but not which coin it was.
  const live = r.day === gameDay();
  const hide = live && !mine;
  const cap = capture(r, x);
  const roles = r.d.rolesNow;
  return {
    id: p.pub, day: r.day, n: r.n, live, up: x >= 1, held: p.soldT! >= r.T, T: r.T,
    x: hide ? null : x, soldT: hide ? null : p.soldT!, peak: hide ? null : r.peak, finalX: hide ? null : r.finalX,
    capture: hide ? Math.round(cap * 10) / 10 : cap,
    counted: p.counted, ranked: p.ranked, wallet: p.wallet,
    others: s.n, beat: s.n ? s.below / s.n : null,
    entry: { t: r.entryT, rank: r.d.firstRetail!.rank, ahead: r.d.aheadOfRetail, xOpen: rel(r.d.firstRetail!.x) },
    reveal: hide
      ? null
      : {
          path: path(r), insidersPnl: roles.dev.pnl + roles.bundle.pnl + roles.bot.pnl, retailPnl: roles.retail.pnl,
          coin: live ? null : { symbol: r.d.symbol, token: r.d.token, pool: r.pool, bornAt: r.d.bornAt, nowX: r.nowX },
        },
  };
}

export async function gamePlay(pub: string) {
  const p = await playByPub(pub);
  const r = p && p.x !== null ? await round(p.day) : null;
  return p && r ? result(r, p, false) : null;
}

export async function gameBoard(day = gameDay()) {
  const r = await round(day);
  const rows = await sql<{ id: string; wallet: string; x: number; sold_t: number }[]>`
    select pub as id, wallet, x, sold_t from game_plays
    where day = ${day} and ranked and x is not null order by x desc, sold_t asc limit ${BOARD}`;
  const live = day === gameDay();
  const top = rows.map((w) => {
    const cap = r ? capture(r, w.x) : 0;
    return live
      ? { id: w.id, wallet: w.wallet, up: w.x >= 1, capture: Math.round(cap * 10) / 10, x: null, soldT: null }
      : { id: w.id, wallet: w.wallet, up: w.x >= 1, capture: cap, x: w.x, soldT: w.sold_t };
  });
  return { day, n: r?.n ?? null, live, ...(await dayStats(day)), top };
}
