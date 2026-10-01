/**
 * Perp radar (10.2), Hyperliquid public info API only (no key, read-only):
 *  - market: every listed perp's funding / open interest / 24h move + an Arm-computed greed index;
 *  - whales: this month's most profitable large accounts on the public leaderboard, their open positions, liquidation prices and the
 *    position changes we see between polls.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const MARKET_TTL = 3_000;
const OI_KEEP_MS = 70 * 60_000;
const OI_SAMPLE_MS = 60_000;
const BOARD_TTL = 24 * 3600_000;
const BOARD_CHUNK = 2_000_000;
const BOARD_FILE = process.env.PERP_BOARD_FILE ?? join(tmpdir(), "arm-hl-whales-v2.json");
const MIN_MONTH_VLM = 10_000_000;
const WHALE_POLL_MS = 90_000;
const WHALES = 80;
const MIN_ACCOUNT = 1_000_000;
const EVENT_MIN_USD = 250_000;
const EVENTS_KEEP = 60;
const MIN_OI_FOR_INDEX = 1_000_000;
/** Hyperliquid funding = premium + a fixed 0.00125%/h interest leg (~10.95% APR); at that rate a market is neutral. */
const BASE_FUNDING_APR = 0.0000125 * 24 * 365;

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function hl<T>(body: unknown, timeout = 10_000): Promise<T> {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return (await r.json()) as T;
}

// -------------------------------------------------------------------------------- market

export type PerpCoin = {
  coin: string; mark: number; change: number; funding: number; fundingApr: number; oiUsd: number; volUsd: number;
  premium: number; maxLev: number; oiChg1h: number | null;
};
export type PerpMarket = {
  updatedAt: number; coins: PerpCoin[];
  greed: { value: number; fundingApr: number; breadth: number; oiUsd: number; volUsd: number };
};

let market: PerpMarket | null = null;
let marketInflight: Promise<PerpMarket> | null = null;
const oiHistory: { at: number; oi: Map<string, number> }[] = [];

async function loadMarket(): Promise<PerpMarket> {
  const [meta, ctxs] = await hl<[{ universe: Json[] }, Json[]]>({ type: "metaAndAssetCtxs" });
  const now = Date.now();
  const past = oiHistory.find((s) => now - s.at >= 55 * 60_000) ?? null;
  const coins: PerpCoin[] = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted === true) return;
    const mark = num(c.markPx), prev = num(c.prevDayPx), funding = num(c.funding);
    const oiUsd = num(c.openInterest) * mark;
    if (!mark || !oiUsd) return;
    const old = past?.oi.get(str(u.name));
    coins.push({
      coin: str(u.name), mark, change: prev ? mark / prev - 1 : 0, funding, fundingApr: funding * 24 * 365,
      oiUsd, volUsd: num(c.dayNtlVlm), premium: num(c.premium), maxLev: num(u.maxLeverage),
      oiChg1h: old ? oiUsd / old - 1 : null,
    });
  });
  if (!oiHistory.length || now - oiHistory[oiHistory.length - 1].at >= OI_SAMPLE_MS) {
    oiHistory.push({ at: now, oi: new Map(coins.map((c) => [c.coin, c.oiUsd])) });
    while (oiHistory.length && now - oiHistory[0].at > OI_KEEP_MS) oiHistory.shift();
  }
  coins.sort((a, b) => b.oiUsd - a.oiUsd);

  // greed: OI-weighted funding above the fixed interest leg (crowded longs pay more) + how many liquid coins are up on the day
  const liquid = coins.filter((c) => c.oiUsd >= MIN_OI_FOR_INDEX);
  const oiSum = liquid.reduce((s, c) => s + c.oiUsd, 0);
  const fundingApr = oiSum ? liquid.reduce((s, c) => s + c.fundingApr * c.oiUsd, 0) / oiSum : 0;
  const breadth = liquid.length ? liquid.filter((c) => c.change > 0).length / liquid.length : 0.5;
  const value = Math.round(Math.max(0, Math.min(100, 50 + 30 * Math.tanh((fundingApr - BASE_FUNDING_APR) / 0.2) + 20 * (breadth * 2 - 1))));
  return {
    updatedAt: now, coins,
    greed: { value, fundingApr, breadth, oiUsd: coins.reduce((s, c) => s + c.oiUsd, 0), volUsd: coins.reduce((s, c) => s + c.volUsd, 0) },
  };
}

export function perpMarket(): Promise<PerpMarket> {
  if (market && Date.now() - market.updatedAt < MARKET_TTL) return Promise.resolve(market);
  marketInflight ??= loadMarket()
    .then((m) => (market = m))
    .catch((e) => { console.warn("[perp] market", (e as Error).message); if (market) return market; throw e; })
    .finally(() => (marketInflight = null));
  return marketInflight;
}

// -------------------------------------------------------------------------------- whales

export type WhalePosition = { coin: string; side: "long" | "short"; ntl: number; size: number; entry: number; liqPx: number | null; lev: number; upnl: number };
export type Whale = { address: string; name: string; accountValue: number; monthPnl: number; allPnl: number; positions: WhalePosition[] };
export type WhaleEvent = { at: number; address: string; name: string; coin: string; kind: "open" | "close" | "add" | "cut" | "flip"; side: "long" | "short"; ntl: number; px: number };
export type WhaleState =
  | { status: "loading" }
  | { status: "ready"; updatedAt: number; whales: Whale[]; events: WhaleEvent[]; mids: Record<string, number> };

let board: { at: number; rows: { address: string; name: string; accountValue: number; monthPnl: number; allPnl: number }[] } | null = null;
let whales: WhaleState = { status: "loading" };
const events: WhaleEvent[] = [];
let loop: Promise<void> | null = null;

/** The leaderboard is tens of MB and arrives at ~300 KB/s in Hong Kong: fetch it in the background, keep the whale list on disk. */
async function readBoardFile() {
  try {
    const b = JSON.parse(await readFile(BOARD_FILE, "utf8")) as NonNullable<typeof board>;
    if (Array.isArray(b.rows) && b.rows.length) board = b;
  } catch { /* first run */ }
}

let boardInflight: Promise<void> | null = null;
function refreshBoard() {
  boardInflight ??= fetchBoard()
    .then(async (rows) => {
      board = { at: Date.now(), rows };
      await writeFile(BOARD_FILE, JSON.stringify(board)).catch(() => {});
    })
    .catch((e) => console.warn("[perp] leaderboard", (e as Error).message))
    .finally(() => (boardInflight = null));
  return boardInflight;
}

async function loadBoard() {
  if (!board) await readBoardFile();
  if (!board || Date.now() - board.at >= BOARD_TTL) {
    const p = refreshBoard();
    if (!board) await p;
  }
  if (!board) throw new Error("leaderboard not loaded yet");
  return board.rows;
}

/** Long downloads from this host get cut, so the file comes in ranged chunks pinned to one ETag. */
async function download(url: string) {
  const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
  const len = Number(head.headers.get("content-length"));
  const etag = head.headers.get("etag") ?? "";
  if (!head.ok || !len) throw new Error(`leaderboard head ${head.status}`);
  const n = Math.ceil(len / BOARD_CHUNK);
  const parts: Buffer[] = new Array(n);
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(url, {
            headers: { range: `bytes=${i * BOARD_CHUNK}-${Math.min(len, (i + 1) * BOARD_CHUNK) - 1}`, ...(etag ? { "if-range": etag } : {}) },
            signal: AbortSignal.timeout(90_000),
          });
          if (r.status !== 206) throw new Error(`leaderboard chunk ${r.status}`); // 200 = file changed mid-download
          parts[i] = Buffer.from(await r.arrayBuffer());
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise((res) => setTimeout(res, 3_000));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return Buffer.concat(parts).toString("utf8");
}

async function fetchBoard() {
  const json = JSON.parse(await download(HL_LEADERBOARD)) as { leaderboardRows?: Json[] };
  const perf = (row: Json, key: string) => (row.windowPerformances as [string, Json][] | undefined)?.find(([k]) => k === key)?.[1];
  // ranked by this month's profit among big, active accounts: sorting by size alone picks vaults and hedge books
  const rows = (json.leaderboardRows ?? [])
    .map((row) => ({
      address: str(row.ethAddress).toLowerCase(), name: str(row.displayName), accountValue: num(row.accountValue),
      monthPnl: num(perf(row, "month")?.pnl), allPnl: num(perf(row, "allTime")?.pnl), monthVlm: num(perf(row, "month")?.vlm),
    }))
    .filter((r) => r.address && r.accountValue >= MIN_ACCOUNT && r.monthVlm >= MIN_MONTH_VLM && r.monthPnl > 0)
    .sort((a, b) => b.monthPnl - a.monthPnl)
    .slice(0, WHALES)
    .map(({ monthVlm: _, ...r }) => r);
  if (!rows.length) throw new Error("leaderboard empty");
  return rows;
}

async function positionsOf(address: string): Promise<{ value: number; positions: WhalePosition[] }> {
  const st = await hl<{ marginSummary?: Json; assetPositions?: { position: Json }[] }>({ type: "clearinghouseState", user: address }, 15_000);
  const positions = (st.assetPositions ?? []).map(({ position: p }) => {
    const szi = num(p.szi);
    const lev = p.leverage as Json | undefined;
    const liq = num(p.liquidationPx);
    return {
      coin: str(p.coin), side: szi >= 0 ? "long" : "short", ntl: num(p.positionValue), size: Math.abs(szi),
      entry: num(p.entryPx), liqPx: liq > 0 ? liq : null, lev: num(lev?.value), upnl: num(p.unrealizedPnl),
    } as WhalePosition;
  }).filter((p) => p.size > 0);
  return { value: num(st.marginSummary?.accountValue), positions };
}

function diff(prev: Whale[], next: Whale[], mids: Record<string, number>) {
  const before = new Map(prev.map((w) => [w.address, new Map(w.positions.map((p) => [p.coin, p]))]));
  const at = Date.now();
  const push = (w: Whale, coin: string, kind: WhaleEvent["kind"], side: WhaleEvent["side"], ntl: number) => {
    if (ntl < EVENT_MIN_USD) return;
    events.unshift({ at, address: w.address, name: w.name, coin, kind, side, ntl, px: mids[coin] ?? 0 });
  };
  for (const w of next) {
    const old = before.get(w.address);
    if (!old) continue; // first time we see this whale: no baseline yet
    const now = new Map(w.positions.map((p) => [p.coin, p]));
    for (const [coin, p] of now) {
      const o = old.get(coin);
      if (!o) push(w, coin, "open", p.side, p.ntl);
      else if (o.side !== p.side) push(w, coin, "flip", p.side, p.ntl);
      else if (p.size > o.size * 1.2) push(w, coin, "add", p.side, (p.size - o.size) * (mids[coin] ?? p.entry));
      else if (p.size < o.size * 0.8) push(w, coin, "cut", p.side, (o.size - p.size) * (mids[coin] ?? p.entry));
    }
    for (const [coin, o] of old) if (!now.has(coin)) push(w, coin, "close", o.side, o.size * (mids[coin] ?? o.entry));
  }
  events.splice(EVENTS_KEEP);
}

async function pollWhales() {
  const rows = await loadBoard();
  const mids = Object.fromEntries(Object.entries(await hl<Record<string, string>>({ type: "allMids" })).map(([k, v]) => [k, num(v)]));
  const out: Whale[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    const batch = await Promise.all(rows.slice(i, i + 4).map(async (r) => {
      const st = await positionsOf(r.address).catch(() => null);
      return st ? { ...r, accountValue: st.value || r.accountValue, positions: st.positions } : null;
    }));
    out.push(...batch.filter((w): w is Whale => !!w));
  }
  if (!out.length) throw new Error("no whale positions");
  if (whales.status === "ready") diff(whales.whales, out, mids);
  whales = { status: "ready", updatedAt: Date.now(), whales: out, events: [...events], mids };
}

function startLoop() {
  loop ??= (async () => {
    for (;;) {
      await pollWhales().catch((e) => console.warn("[perp] whales", (e as Error).message));
      await new Promise((r) => setTimeout(r, WHALE_POLL_MS));
    }
  })();
}

/** First call starts the background poller; until its first round finishes the state is `loading`. */
export function perpWhales(): WhaleState {
  startLoop();
  return whales;
}
