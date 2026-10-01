import { client } from "./chain.js";
import { sql } from "./db.js";
import { DEX_START, dexProgress } from "./dex.js";

/**
 * Chain-scanner arena (10.1): every new USDC pool on Arc, read from the DEX tape, scored the way a scanner bot would,
 * and four paper strategies replayed on the real swaps. Every decision only uses swaps at or before its own block
 * (no look-ahead); "smart money" is learned from swaps before the replay window. Fills are the pool's real prices with
 * a flat cost per side for fee + slippage, so results are estimates and a real sniper would fill a little worse.
 */

const NOT_MEME = /^(w?usdc|usdt|eurc|usyc|dai|w?eth|w?btc|cirbtc|stusdc)$/i;
const TTL_MS = 60_000;
const SMART_TTL_MS = 3_600_000;
const DAYS = 7;
const START_EQUITY = 100;
const STAKE = 1;
const COST = 0.03; // per side: 1% pool fee + ~2% slippage on a thin pool
const TP = 2, SL = 0.5;
const HOLD_SEC = 6 * 3600;
const SNIPE_SEC = 15, CHECK_SEC = 300, SMART_SEC = 3600;
const RADAR_SEC = 86_400;
const FILTER = { buyers: 4, volume: 50, bundle: 3, top3: 0.8 };
const SMART_MIN = 1;
const MIN_FILL_USDC = 1; // dust swaps round to absurd prices

export type BotId = "sniper" | "filter" | "smart" | "random";
export type Reason = "thin" | "lowVol" | "bundle" | "devSold" | "whales" | "smart" | "pass";
export type ScanTrade = {
  pool: string; token: string; symbol: string; entryAt: number; exitAt: number | null;
  entryPx: number; exitPx: number; x: number; pnl: number; exit: "tp" | "sl" | "time" | "open";
};
export type ScanBot = {
  id: BotId; trades: number; open: number; wins: number; pnl: number; roi: number; equity: number;
  best: number; curve: [number, number][]; recent: ScanTrade[];
};
export type RadarItem = {
  pool: string; token: string; symbol: string; bornAt: number; buyers: number; swaps: number; volume: number;
  price: number; signalPx: number; peakX: number; nowX: number; score: number | null;
  verdict: "pending" | "buy" | "skip"; reasons: Reason[]; smart: number; bots: BotId[]; dead: boolean;
};
export type ScanState =
  | { status: "syncing"; progress: number }
  | {
      status: "ready"; updatedAt: number;
      rules: { stake: number; start: number; cost: number; tp: number; sl: number; holdHours: number; days: number; filter: typeof FILTER };
      stats: { scanned: number; passed: number; skipped: number; skippedDead: number; alive: number; smartWallets: number };
      bots: ScanBot[]; radar: RadarItem[];
    };

type Swap = { block: number; idx: number; trader: string; side: number; qty: number; usdc: number; px: number };
type Pool = { address: string; token: string; symbol: string; decimals: number };

// -------------------------------------------------------------------------------- block clock

let clock: { head: number; ts: number; bt: number; at: number } | null = null;
async function tick() {
  if (clock && Date.now() - clock.at < 600_000) return clock;
  const [h, s] = await Promise.all([client.getBlock(), client.getBlock({ blockNumber: DEX_START })]);
  clock = { head: Number(h.number), ts: Number(h.timestamp), bt: (Number(h.timestamp) - Number(s.timestamp)) / Number(h.number - DEX_START), at: Date.now() };
  return clock;
}
const tsOf = (b: number) => (clock!.ts - (clock!.head - b) * clock!.bt) * 1000;
const blocks = (sec: number) => Math.round(sec / clock!.bt);

// -------------------------------------------------------------------------------- inputs

const born = new Map<string, number>(); // pool -> first swap block
let bornThrough = 0;
async function refreshBorn() {
  const rows = bornThrough
    ? await sql<{ pool: string; b: string }[]>`select pool, min(block) as b from dex_swaps where block > ${bornThrough} group by pool`
    : await sql<{ pool: string; b: string }[]>`select pool, min(block) as b from dex_swaps group by pool`;
  for (const r of rows) if (!born.has(r.pool)) born.set(r.pool, Number(r.b));
  const [{ m }] = await sql<{ m: string | null }[]>`select max(block) as m from dex_swaps`;
  bornThrough = Number(m ?? 0);
}

let smart: { set: Set<string>; before: number; at: number } = { set: new Set(), before: 0, at: 0 };
/** Wallets that made money across >= 5 coins before `before` (realized only: USDC out minus USDC in per coin). */
async function refreshSmart(before: number) {
  if (Date.now() - smart.at < SMART_TTL_MS && smart.set.size) return;
  const rows = await sql<{ trader: string }[]>`
    select trader from (
      select s.trader, p.token,
             sum(case when s.side = -1 then s.usdc else 0 end) - sum(case when s.side = 1 then s.usdc else 0 end) as pnl
      from dex_swaps s join dex_pools p on p.address = s.pool
      where p.usdc and s.block < ${before}
      group by s.trader, p.token
    ) t
    group by trader
    having count(*) >= 5 and sum(pnl) >= 100000000 and avg(case when pnl > 0 then 1.0 else 0 end) >= 0.4`;
  smart = { set: new Set(rows.map((r) => r.trader)), before, at: Date.now() };
}

async function load(from: number) {
  const ids = [...born].filter(([, b]) => b >= from).map(([p]) => p);
  if (!ids.length) return { pools: [] as Pool[], swaps: new Map<string, Swap[]>() };
  const meta = await sql<{ address: string; token: string; symbol: string; decimals: number }[]>`
    select address, token, symbol, decimals from dex_pools where usdc and address = any(${ids})`;
  const pools = meta.filter((p) => !NOT_MEME.test(p.symbol));
  const rows = await sql<{ block: string; log_index: number; pool: string; trader: string; side: number; qty: string; usdc: string }[]>`
    select block, log_index, pool, trader, side, qty, usdc from dex_swaps
    where pool = any(${pools.map((p) => p.address)}) order by block, log_index`;
  const dec = new Map(pools.map((p) => [p.address, p.decimals]));
  const swaps = new Map<string, Swap[]>();
  for (const r of rows) {
    const qty = Number(r.qty) / 10 ** (dec.get(r.pool) ?? 18), usdc = Number(r.usdc) / 1e6;
    const raw = qty > 0 ? usdc / qty : 0;
    const px = usdc >= MIN_FILL_USDC && raw > 0 && Number.isFinite(raw) ? raw : NaN;
    const list = swaps.get(r.pool) ?? [];
    list.push({ block: Number(r.block), idx: r.log_index, trader: r.trader, side: r.side, qty, usdc, px });
    swaps.set(r.pool, list);
  }
  return { pools, swaps };
}

// -------------------------------------------------------------------------------- per-pool replay

type Feats = { buyers: number; swaps: number; volume: number; bundle: number; devSold: boolean; top3: number; smart: number; px: number };

/** What a scanner could see in the pool at block `at` (inclusive). */
function feats(s: Swap[], at: number): Feats {
  const b0 = s[0].block, dev = s[0].trader;
  const bought = new Map<string, number>();
  const first = new Set<string>();
  const sm = new Set<string>();
  let n = 0, volume = 0, devSold = false, px = NaN, total = 0;
  for (const w of s) {
    if (w.block > at) break;
    n++; volume += w.usdc;
    if (Number.isNaN(w.px)) continue; // dust: counted in volume only
    px = w.px;
    if (w.side === 1) {
      bought.set(w.trader, (bought.get(w.trader) ?? 0) + w.qty);
      total += w.qty;
      if (w.block === b0) first.add(w.trader);
      if (smart.set.has(w.trader)) sm.add(w.trader);
    } else if (w.trader === dev) devSold = true;
  }
  const top = [...bought.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return { buyers: bought.size, swaps: n, volume, bundle: first.size, devSold, top3: total > 0 ? top / total : 0, smart: sm.size, px };
}

function judge(f: Feats): { verdict: "buy" | "skip"; reasons: Reason[]; score: number } {
  const reasons: Reason[] = [];
  if (f.buyers < FILTER.buyers) reasons.push("thin");
  if (f.volume < FILTER.volume) reasons.push("lowVol");
  if (f.bundle >= FILTER.bundle) reasons.push("bundle");
  if (f.devSold) reasons.push("devSold");
  if (f.buyers >= FILTER.buyers && f.top3 >= FILTER.top3) reasons.push("whales");
  const verdict = reasons.length ? "skip" : "buy";
  if (f.smart) reasons.push("smart");
  if (verdict === "buy") reasons.push("pass");
  const score = Math.round(Math.max(0, Math.min(100,
    15 + Math.min(f.buyers, 20) * 2 + Math.min(Math.log10(f.volume + 1) * 10, 30) + f.smart * 8
    - (f.bundle >= FILTER.bundle ? 15 : 0) - (f.devSold ? 25 : 0) - (f.top3 >= FILTER.top3 && f.buyers >= FILTER.buyers ? 10 : 0))));
  return { verdict, reasons, score };
}

/** Last real fill price at or before `at` (NaN if the pool has only dust so far). */
const pxAt = (s: Swap[], at: number) => {
  let px = NaN;
  for (const w of s) { if (w.block > at) break; if (!Number.isNaN(w.px)) px = w.px; }
  return px;
};

/** Hold from `entry` (block) with TP / SL / time exit on the pool's own swaps; null when there is no price to buy at. */
function ride(p: Pool, s: Swap[], entry: number, head: number): ScanTrade | null {
  if (head < entry) return null;
  const pE = pxAt(s, entry);
  if (Number.isNaN(pE)) return null;
  const until = entry + blocks(HOLD_SEC);
  let exitPx = pE, exitBlock: number | null = null, exit: ScanTrade["exit"] = "open";
  for (const w of s) {
    if (w.block <= entry || Number.isNaN(w.px)) continue;
    if (w.block > until) break;
    exitPx = w.px;
    if (w.px >= pE * TP) { exit = "tp"; exitBlock = w.block; break; }
    if (w.px <= pE * SL) { exit = "sl"; exitBlock = w.block; break; }
  }
  if (exit === "open" && head > until) { exit = "time"; exitBlock = until; }
  const x = (exitPx * (1 - COST)) / (pE * (1 + COST));
  return {
    pool: p.address, token: p.token, symbol: p.symbol, entryAt: tsOf(entry), exitAt: exitBlock ? tsOf(exitBlock) : null,
    entryPx: pE, exitPx, x, pnl: STAKE * (x - 1), exit,
  };
}

const pick = (pool: string) => {
  let h = 2166136261;
  for (let i = 0; i < pool.length; i++) h = Math.imul(h ^ pool.charCodeAt(i), 16777619);
  return (h >>> 0) % 10 === 0;
};

// -------------------------------------------------------------------------------- assemble

function summarize(id: BotId, trades: ScanTrade[]): ScanBot {
  const ordered = [...trades].sort((a, b) => (a.exitAt ?? Infinity) - (b.exitAt ?? Infinity));
  const closed = ordered.filter((t) => t.exitAt !== null);
  let eq = START_EQUITY;
  const pts: [number, number][] = [];
  for (const t of closed) { eq += t.pnl; pts.push([t.exitAt!, eq]); }
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  pts.push([Date.now(), START_EQUITY + pnl]);
  const step = Math.max(1, Math.ceil(pts.length / 120));
  const curve = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  return {
    id, trades: trades.length, open: trades.length - closed.length, wins: trades.filter((t) => t.pnl > 0).length,
    pnl, roi: trades.length ? pnl / (trades.length * STAKE) : 0, equity: START_EQUITY + pnl,
    best: trades.reduce((m, t) => Math.max(m, t.x), 0), curve,
    recent: [...trades].sort((a, b) => b.entryAt - a.entryAt).slice(0, 8),
  };
}

async function compute(): Promise<ScanState> {
  const sync = dexProgress();
  if (!sync.ready) return { status: "syncing", progress: sync.progress };
  const c = await tick();
  await refreshBorn();
  const head = Math.min(c.head + Math.floor((Date.now() / 1000 - c.ts) / c.bt), bornThrough);
  const from = head - blocks(DAYS * 86_400);
  await refreshSmart(from);
  const { pools, swaps } = await load(from);

  const book: Record<BotId, ScanTrade[]> = { sniper: [], filter: [], smart: [], random: [] };
  const radar: RadarItem[] = [];
  const radarFrom = head - blocks(RADAR_SEC);
  let scanned = 0, passed = 0, skipped = 0, skippedDead = 0, alive = 0;

  for (const p of pools) {
    const s = swaps.get(p.address);
    if (!s?.length) continue;
    const b0 = s[0].block;
    const bots: BotId[] = [];
    const enter = (id: BotId, at: number) => {
      const t = ride(p, s, at, head);
      if (t) { book[id].push(t); bots.push(id); }
    };
    enter("sniper", b0 + blocks(SNIPE_SEC));

    const check = b0 + blocks(CHECK_SEC);
    const ready = head >= check;
    const f = feats(s, check);
    const j = ready ? judge(f) : null;
    if (j?.verdict === "buy") enter("filter", check);
    if (ready && pick(p.address)) enter("random", check);

    // first block inside the first hour at which SMART_MIN smart wallets have bought
    const seen = new Set<string>();
    for (const w of s) {
      if (w.block > b0 + blocks(SMART_SEC)) break;
      if (w.side === 1 && !Number.isNaN(w.px) && smart.set.has(w.trader)) seen.add(w.trader);
      if (seen.size >= SMART_MIN) { enter("smart", w.block + blocks(SNIPE_SEC)); break; }
    }

    if (b0 < radarFrom) continue;
    const now = feats(s, head);
    const fills = s.filter((w) => !Number.isNaN(w.px));
    const last = s[s.length - 1];
    const lastPx = fills.at(-1)?.px ?? 0;
    const peak = fills.reduce((m, w) => Math.max(m, w.px), 0);
    const signalPx = (ready ? f.px : NaN) || fills[0]?.px || 0;
    const dead = (head - last.block > blocks(3600) && head - b0 > blocks(3600)) || !fills.length || lastPx <= peak * 0.1;
    scanned++;
    if (j?.verdict === "buy") passed++;
    if (j?.verdict === "skip") { skipped++; if (dead) skippedDead++; }
    if (!dead) alive++;
    radar.push({
      pool: p.address, token: p.token, symbol: p.symbol, bornAt: tsOf(b0), buyers: now.buyers, swaps: now.swaps, volume: now.volume,
      price: lastPx, signalPx, peakX: signalPx ? peak / signalPx : 0, nowX: signalPx ? lastPx / signalPx : 0, score: j?.score ?? null,
      verdict: j?.verdict ?? "pending", reasons: j?.reasons ?? [], smart: now.smart, bots, dead,
    });
  }

  radar.sort((a, b) => b.bornAt - a.bornAt);
  const busy = radar.filter((r) => r.buyers >= 3);
  const shown = [...new Map([...radar.slice(0, 60), ...busy.slice(0, 40)].map((r) => [r.pool, r])).values()].sort((a, b) => b.bornAt - a.bornAt);
  const bots = (Object.keys(book) as BotId[]).map((id) => summarize(id, book[id])).sort((a, b) => b.pnl - a.pnl);
  return {
    status: "ready", updatedAt: Date.now(),
    rules: { stake: STAKE, start: START_EQUITY, cost: COST, tp: TP, sl: SL, holdHours: HOLD_SEC / 3600, days: DAYS, filter: FILTER },
    stats: { scanned, passed, skipped, skippedDead, alive, smartWallets: smart.set.size },
    bots, radar: shown,
  };
}

/** Block clock, pool birth blocks and smart wallets as of the last `scanner()` run (launch replay reuses them). */
export function scanShared() {
  if (!clock) return null;
  const c = clock;
  return { born, smart: smart.set, bt: c.bt, tsOf: (b: number) => (c.ts - (c.head - b) * c.bt) * 1000, NOT_MEME };
}

let cache: { at: number; state: ScanState } | null = null;
let inflight: Promise<ScanState> | null = null;

export function scanner(): Promise<ScanState> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.state);
  inflight ??= compute()
    .then((state) => { if (state.status === "ready") cache = { at: Date.now(), state }; return state; })
    .catch((e) => { console.warn("[scanner]", (e as Error).message); if (cache) return cache.state; throw e; })
    .finally(() => (inflight = null));
  return inflight;
}
