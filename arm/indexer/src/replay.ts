import { sql } from "./db.js";
import { scanner, scanShared } from "./scanner.js";

/**
 * Launch replay (10.2): the first hour of a new Arc USDC pool, swap by swap, with every wallet tagged by what it did
 * (dev = first trader, bundle = bought in the opening block, bot = first buy within 15 s, smart = scanner's smart
 * wallets, everyone else retail). Tags are inferred from behaviour, not identities.
 */

const DAYS = 7;
const WINDOW_SEC = 3600;
const BOT_SEC = 15;
const MAX_EVENTS = 1500;
const LIST = 24;
const MIN_BUYERS = 5;
const MIN_FILL_USDC = 1;
const LIST_TTL = 300_000;
const DETAIL_TTL = 120_000;

export type Role = "dev" | "bundle" | "bot" | "smart" | "retail";
export type ReplayLaunch = { pool: string; token: string; symbol: string; bornAt: number; buyers: number; swaps: number; volume: number };
export type ReplayEvent = { t: number; side: 1 | -1; usdc: number; px: number | null; role: Role; w: number };
export type RoleStat = { wallets: number; spent: number; received: number; value: number; pnl: number };
export type ReplayDetail = {
  pool: string; token: string; symbol: string; bornAt: number; window: number; truncated: boolean;
  p0: number; lastPx: number; peakPx: number; nowPx: number; buyers: number;
  events: ReplayEvent[];
  /** marked at the last price inside the window */
  roles: Record<Role, RoleStat>;
  /** the same wallets' whole history in this pool to date, holdings marked at the current price */
  rolesNow: Record<Role, RoleStat>;
  /** first retail buy: seconds after open, its rank among all buyers, entry price / opening price */
  firstRetail: { t: number; rank: number; x: number } | null;
  /** retail's volume-weighted entry price / opening price */
  retailAvgX: number | null;
  /** wallets that were in before the first retail buy */
  aheadOfRetail: number;
};
export type ReplayList = { status: "syncing"; progress: number } | { status: "ready"; launches: ReplayLaunch[] };

let listCache: { at: number; list: ReplayList } | null = null;
let listInflight: Promise<ReplayList> | null = null;
const detailCache = new Map<string, { at: number; d: ReplayDetail }>();

async function shared() {
  const st = await scanner();
  if (st.status !== "ready") return { st, sh: null };
  return { st, sh: scanShared() };
}

async function computeList(): Promise<ReplayList> {
  const { st, sh } = await shared();
  if (!sh) return st.status === "syncing" ? { status: "syncing", progress: st.progress } : { status: "ready", launches: [] };
  const [{ m }] = await sql<{ m: string | null }[]>`select max(block) as m from dex_swaps`;
  const head = Number(m ?? 0);
  const from = head - Math.round((DAYS * 86_400) / sh.bt);
  const win = Math.round(WINDOW_SEC / sh.bt);
  const fresh = [...sh.born].filter(([, b]) => b >= from);
  if (!fresh.length) return { status: "ready", launches: [] };
  const rows = await sql<{ pool: string; token: string; symbol: string; b0: string; n: number; buyers: number; vol: number }[]>`
    select s.pool, p.token, p.symbol, w.b0, count(*)::int as n,
           count(distinct s.trader) filter (where s.side = 1)::int as buyers,
           (sum(s.usdc) / 1e6)::float8 as vol
    from unnest(${fresh.map(([p]) => p)}::text[], ${fresh.map(([, b]) => String(b))}::bigint[]) as w(pool, b0)
    join dex_swaps s on s.pool = w.pool and s.block between w.b0 and w.b0 + ${win}
    join dex_pools p on p.address = w.pool and p.usdc
    group by s.pool, p.token, p.symbol, w.b0
    having count(distinct s.trader) filter (where s.side = 1) >= ${MIN_BUYERS}
    order by buyers desc, vol desc
    limit ${LIST * 2}`;
  const launches = rows
    .filter((r) => !sh.NOT_MEME.test(r.symbol))
    .slice(0, LIST)
    .map((r) => ({ pool: r.pool, token: r.token, symbol: r.symbol, bornAt: sh.tsOf(Number(r.b0)), buyers: r.buyers, swaps: r.n, volume: r.vol }));
  return { status: "ready", launches };
}

export function replayList(): Promise<ReplayList> {
  if (listCache && Date.now() - listCache.at < LIST_TTL) return Promise.resolve(listCache.list);
  listInflight ??= computeList()
    .then((list) => { if (list.status === "ready") listCache = { at: Date.now(), list }; return list; })
    .catch((e) => { console.warn("[replay]", (e as Error).message); if (listCache) return listCache.list; throw e; })
    .finally(() => (listInflight = null));
  return listInflight;
}

const emptyStat = (): RoleStat => ({ wallets: 0, spent: 0, received: 0, value: 0, pnl: 0 });

export async function replayDetail(pool: string): Promise<ReplayDetail | null> {
  const hit = detailCache.get(pool);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.d;
  const { sh } = await shared();
  const b0 = sh?.born.get(pool);
  if (!sh || b0 === undefined) return null;
  const [meta] = await sql<{ token: string; symbol: string; decimals: number; last_px: number | null }[]>`
    select token, symbol, decimals, last_px::float8 as last_px from dex_pools where address = ${pool} and usdc`;
  if (!meta) return null;
  const win = Math.round(WINDOW_SEC / sh.bt);
  const rows = await sql<{ block: string; trader: string; side: number; qty: string; usdc: string }[]>`
    select block, trader, side, qty, usdc from dex_swaps
    where pool = ${pool} and block between ${b0} and ${b0 + win}
    order by block, log_index limit ${MAX_EVENTS + 1}`;
  if (!rows.length) return null;
  const truncated = rows.length > MAX_EVENTS;
  const swaps = rows.slice(0, MAX_EVENTS).map((r) => {
    const qty = Number(r.qty) / 10 ** meta.decimals, usdc = Number(r.usdc) / 1e6;
    const raw = qty > 0 ? usdc / qty : 0;
    return { block: Number(r.block), trader: r.trader, side: r.side as 1 | -1, qty, usdc, px: usdc >= MIN_FILL_USDC && raw > 0 && Number.isFinite(raw) ? raw : null };
  });

  const dev = swaps[0].trader;
  const botBlocks = Math.round(BOT_SEC / sh.bt);
  const role = new Map<string, Role>();
  const index = new Map<string, number>();
  for (const s of swaps) {
    if (!index.has(s.trader)) index.set(s.trader, index.size);
    if (role.has(s.trader)) continue;
    if (s.trader === dev) role.set(s.trader, "dev");
    else if (s.side !== 1) continue; // first seen selling (tokens from elsewhere): tag on its first buy, else retail
    else if (s.block === b0) role.set(s.trader, "bundle");
    else if (sh.smart.has(s.trader)) role.set(s.trader, "smart");
    else if (s.block - b0 <= botBlocks) role.set(s.trader, "bot");
    else role.set(s.trader, "retail");
  }
  const roleOf = (w: string) => role.get(w) ?? "retail";

  const fills = swaps.filter((s) => s.px !== null);
  const p0 = fills[0]?.px ?? 0;
  const lastPx = fills.at(-1)?.px ?? 0;
  const peakPx = fills.reduce((m, s) => Math.max(m, s.px!), 0);

  const roles: Record<Role, RoleStat> = { dev: emptyStat(), bundle: emptyStat(), bot: emptyStat(), smart: emptyStat(), retail: emptyStat() };
  const held = new Map<string, number>();
  const buyers = new Set<string>();
  let firstRetail: ReplayDetail["firstRetail"] = null;
  let retailUsd = 0, retailQty = 0;
  for (const s of swaps) {
    const r = roles[roleOf(s.trader)];
    if (s.side === 1) {
      r.spent += s.usdc;
      held.set(s.trader, (held.get(s.trader) ?? 0) + s.qty);
      buyers.add(s.trader);
      if (roleOf(s.trader) === "retail") {
        retailUsd += s.usdc; retailQty += s.qty;
        if (!firstRetail && s.px !== null && p0) firstRetail = { t: (s.block - b0) * sh.bt, rank: buyers.size, x: s.px / p0 };
      }
    } else {
      r.received += s.usdc;
      held.set(s.trader, (held.get(s.trader) ?? 0) - s.qty);
    }
  }
  for (const w of index.keys()) roles[roleOf(w)].wallets++;
  for (const [w, q] of held) roles[roleOf(w)].value += Math.max(0, q) * lastPx;
  for (const r of Object.values(roles)) r.pnl = r.received + r.value - r.spent;

  const nowPx = meta.last_px ?? lastPx;
  const rolesNow: Record<Role, RoleStat> = { dev: emptyStat(), bundle: emptyStat(), bot: emptyStat(), smart: emptyStat(), retail: emptyStat() };
  const totals = await sql<{ trader: string; spent: number; received: number; net: string }[]>`
    select trader,
           (sum(case when side = 1 then usdc else 0 end) / 1e6)::float8 as spent,
           (sum(case when side = -1 then usdc else 0 end) / 1e6)::float8 as received,
           sum(case when side = 1 then qty else -qty end)::text as net
    from dex_swaps where pool = ${pool} and trader = any(${[...index.keys()]}) group by trader`;
  for (const r of totals) {
    const s = rolesNow[roleOf(r.trader)];
    s.wallets++; s.spent += r.spent; s.received += r.received;
    s.value += Math.max(0, Number(r.net) / 10 ** meta.decimals) * nowPx;
  }
  for (const r of Object.values(rolesNow)) r.pnl = r.received + r.value - r.spent;

  const firstRetailBlock = firstRetail ? b0 + Math.round(firstRetail.t / sh.bt) : Infinity;
  const ahead = new Set(swaps.filter((s) => s.side === 1 && s.block < firstRetailBlock && roleOf(s.trader) !== "retail").map((s) => s.trader));

  const d: ReplayDetail = {
    pool, token: meta.token, symbol: meta.symbol, bornAt: sh.tsOf(b0),
    window: truncated ? (swaps.at(-1)!.block - b0) * sh.bt : WINDOW_SEC, truncated,
    p0, lastPx, peakPx, nowPx, buyers: buyers.size,
    events: swaps.map((s) => ({ t: Math.round((s.block - b0) * sh.bt * 10) / 10, side: s.side, usdc: Math.round(s.usdc * 100) / 100, px: s.px, role: roleOf(s.trader), w: index.get(s.trader)! })),
    roles, rolesNow, firstRetail, retailAvgX: retailQty > 0 && p0 ? retailUsd / retailQty / p0 : null, aheadOfRetail: ahead.size,
  };
  detailCache.set(pool, { at: Date.now(), d });
  if (detailCache.size > 200) detailCache.delete(detailCache.keys().next().value!);
  return d;
}
