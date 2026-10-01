import { getAddress, type Address } from "viem";
import { client } from "./chain.js";
import { sql } from "./db.js";
import { DEX_START, dexProgress } from "./dex.js";

/**
 * Wallet trading card (10.1): PnL of one wallet across every USDC-paired token on Arc, read from the DEX tape.
 * Cost = USDC paid on buys, proceeds = USDC received on sells, the open position (bought − sold, never below zero)
 * is valued at the pool's latest swap price — transfers in/out are ignored, so moving coins between own wallets
 * neither books a loss nor a gain.
 */

const NOT_MEME = /^(w?usdc|usdt|eurc|usyc|dai|w?eth|w?btc|cirbtc|stusdc)$/i;
const CACHE_MS = 60_000;

export type CardToken = {
  address: string; symbol: string; spent: number; received: number; holding: number; pnl: number; pct: number;
  buys: number; sells: number; rank: number | null;
};
export type Persona = "newbie" | "printer" | "sniper" | "bagholder" | "flipper" | "diamond" | "hunter" | "degen";
export type Card = {
  address: string; updatedAt: string;
  tokens: number; trades: number; buys: number; sells: number;
  spent: number; received: number; holding: number; pnl: number; pct: number;
  wins: number; losses: number; winRate: number; avgHoldSec: number | null; firstTradeAt: string | null;
  best: CardToken | null; worst: CardToken | null; top: CardToken[]; persona: Persona;
};
export type CardState =
  | { status: "ready"; card: Card }
  | { status: "syncing"; progress: number }
  | { status: "error"; error: "contract" };

let clock: { head: number; ts: number; bt: number; at: number } | null = null;
async function blockTs(b: number): Promise<number> {
  if (!clock || Date.now() - clock.at > 3_600_000) {
    const [h, s] = await Promise.all([client.getBlock(), client.getBlock({ blockNumber: DEX_START })]);
    clock = { head: Number(h.number), ts: Number(h.timestamp), bt: (Number(h.timestamp) - Number(s.timestamp)) / Number(h.number - DEX_START), at: Date.now() };
  }
  return clock.ts - (clock.head - b) * clock.bt;
}

function persona(c: Omit<Card, "persona">): Persona {
  if (c.trades < 3) return "newbie";
  if (c.pct >= 1 && c.pnl > 0) return "printer";
  if (c.tokens >= 3 && c.winRate >= 0.6 && c.pnl > 0) return "sniper";
  if (c.pct <= -0.5) return "bagholder";
  if (c.avgHoldSec !== null && c.avgHoldSec < 3600 && c.sells >= 5) return "flipper";
  if (c.sells <= c.buys * 0.2 && c.tokens >= 2) return "diamond";
  if (c.tokens >= 15) return "hunter";
  return "degen";
}

type Row = {
  token: string; symbol: string; decimals: number; side: number; n: string; qty: string; usdc: string;
  first_b: string; last_b: string;
};

async function compute(wallet: string): Promise<Card> {
  const rows = await sql<Row[]>`
    select p.token, p.symbol, p.decimals, s.side, count(*) as n, sum(s.qty) as qty, sum(s.usdc) as usdc,
           min(s.block) as first_b, max(s.block) as last_b
    from dex_swaps s join dex_pools p on p.address = s.pool
    where s.trader = ${wallet}
    group by p.token, p.symbol, p.decimals, s.side`;
  // latest price per token across its pools
  const prices = new Map<string, number>();
  const px = await sql<{ token: string; last_px: number }[]>`
    select distinct on (token) token, last_px from dex_pools
    where usdc and token in ${sql([...new Set(rows.map((r) => r.token)), ""])} and last_px is not null
    order by token, last_block desc`;
  for (const r of px) prices.set(r.token, r.last_px);

  type Acc = { symbol: string; dec: number; spent: number; received: number; bought: number; sold: number; buys: number; sells: number; firstBuy: number; lastSell: number };
  const by = new Map<string, Acc>();
  for (const r of rows) {
    if (NOT_MEME.test(r.symbol)) continue;
    const a = by.get(r.token) ?? { symbol: r.symbol, dec: r.decimals, spent: 0, received: 0, bought: 0, sold: 0, buys: 0, sells: 0, firstBuy: 0, lastSell: 0 };
    const usd = Number(r.usdc) / 1e6, qty = Number(r.qty) / 10 ** r.decimals;
    if (r.side === 1) { a.spent += usd; a.bought += qty; a.buys += Number(r.n); a.firstBuy = Number(r.first_b); }
    else { a.received += usd; a.sold += qty; a.sells += Number(r.n); a.lastSell = Number(r.last_b); }
    by.set(r.token, a);
  }

  const list: (CardToken & { firstBuy: number; lastSell: number })[] = [];
  for (const [token, a] of by) {
    if (!a.buys) continue; // only coins actually bought here
    const holding = Math.max(0, a.bought - a.sold) * (prices.get(token) ?? 0);
    const pnl = a.received + holding - a.spent;
    list.push({ address: getAddress(token), symbol: a.symbol, spent: a.spent, received: a.received, holding, pnl, pct: a.spent > 0 ? pnl / a.spent : 0, buys: a.buys, sells: a.sells, rank: null, firstBuy: a.firstBuy, lastSell: a.lastSell });
  }
  const sum = (f: (t: CardToken) => number) => list.reduce((s, t) => s + f(t), 0);
  const spent = sum((t) => t.spent), pnl = sum((t) => t.pnl);
  const held = list.filter((t) => t.sells > 0 && t.lastSell > t.firstBuy);
  if (!clock) await blockTs(0).catch(() => 0);
  const bt = clock?.bt ?? 0.5;
  const firstBlock = list.reduce((m, t) => (m && m < t.firstBuy ? m : t.firstBuy), 0);
  const byPct = [...list].sort((x, y) => y.pct - x.pct);
  const best = byPct[0] && byPct[0].pnl > 0 ? byPct[0] : null;
  if (best) {
    // "#N buyer": distinct wallets that bought this coin before the wallet's first buy
    const [{ n }] = await sql<{ n: string }[]>`
      select count(distinct s.trader) as n from dex_swaps s join dex_pools p on p.address = s.pool
      where p.token = ${best.address.toLowerCase()} and s.side = 1 and s.block < ${best.firstBuy}`;
    best.rank = Number(n) + 1;
  }
  const strip = (t: (typeof list)[number] | null | undefined): CardToken | null => (t ? (({ firstBuy: _f, lastSell: _l, ...rest }) => rest)(t) : null);
  const wins = list.filter((t) => t.pnl > 0).length;
  const base = {
    address: getAddress(wallet), updatedAt: new Date().toISOString(),
    tokens: list.length, buys: sum((t) => t.buys), sells: sum((t) => t.sells), trades: sum((t) => t.buys + t.sells),
    spent, received: sum((t) => t.received), holding: sum((t) => t.holding), pnl, pct: spent > 0 ? pnl / spent : 0,
    wins, losses: list.length - wins, winRate: list.length ? wins / list.length : 0,
    avgHoldSec: held.length ? (held.reduce((s, t) => s + t.lastSell - t.firstBuy, 0) / held.length) * bt : null,
    firstTradeAt: firstBlock ? new Date((await blockTs(firstBlock)) * 1000).toISOString() : null,
    best: strip(best),
    worst: strip(byPct.length && byPct[byPct.length - 1].pnl < 0 ? byPct[byPct.length - 1] : null),
    top: [...list].sort((x, y) => Math.abs(y.pnl) - Math.abs(x.pnl)).slice(0, 8).map((t) => strip(t)!),
  };
  return { ...base, persona: persona(base) };
}

const cache = new Map<string, { at: number; state: CardState }>();
const isContract = new Map<string, boolean>();

export async function walletCard(address: string): Promise<CardState> {
  const wallet = address.toLowerCase();
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
  if (!isContract.has(wallet)) {
    const code = await client.getCode({ address: wallet as Address }).catch(() => undefined);
    isContract.set(wallet, !!code && code !== "0x");
  }
  if (isContract.get(wallet)) return { status: "error", error: "contract" };
  const sync = dexProgress();
  if (!sync.ready) return { status: "syncing", progress: sync.progress };
  const state: CardState = { status: "ready", card: await compute(wallet) };
  cache.set(wallet, { at: Date.now(), state });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return state;
}
