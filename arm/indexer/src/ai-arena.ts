// AI live-trading arena: our own NOFX bots (Docker on this host, 127.0.0.1 only) shown read-only on Arm.
// Positions / decisions / trades need the NOFX owner JWT, so they are fetched here and only a sanitized subset leaves
// the server (no prompts, no account ids, reasoning truncated).

const BASE = process.env.NOFX_URL ?? "http://127.0.0.1:8280/api";
const EMAIL = process.env.NOFX_EMAIL;
const PASSWORD = process.env.NOFX_PASSWORD;
const HL_INFO = "https://api.hyperliquid.xyz/info";
const TTL_MS = 30_000;
const CURVE_POINTS = 120;
const HISTORY = 48;
export const ARENA_COINS = ["BTC", "ETH", "SOL"];

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type ArenaAction = {
  action: string; symbol: string; leverage: number; confidence: number; reasoning: string;
  price: number; stopLoss: number; takeProfit: number; success: boolean;
};
export type ArenaTrader = {
  id: string;
  name: string;
  model: string;
  exchange: string;
  running: boolean;
  equity: number;
  pnl: number;
  pnlPct: number;
  scanMinutes: number;
  minConfidence: number;
  /** coins this bot trades; bots share one Hyperliquid account and are split by coin */
  coins: string[];
  curve: [number, number][];
  positions: { symbol: string; side: string; size: number; entry: number; mark: number; upnl: number; leverage: number; stopLoss: number; takeProfit: number }[];
  trades: { symbol: string; side: string; entry: number; exit: number; pnl: number; pnlPct: number; exitTime: number; hold: string }[];
  /** newest first; `thought` is only filled for the newest record */
  decisions: { time: string; cycle: number; actions: ArenaAction[]; thought: string }[];
};
export type ArenaState = { enabled: boolean; updatedAt: number; traders: ArenaTrader[] };

let token = "";
let cache: ArenaState | null = null;
let inflight: Promise<ArenaState> | null = null;

async function login() {
  const r = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  token = str(((await r.json()) as Json).token);
  if (!token) throw new Error("nofx login failed");
}

async function get<T>(path: string, auth = false, retry = true): Promise<T> {
  if (auth && !token) await login();
  const r = await fetch(`${BASE}${path}`, {
    headers: auth ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (auth && r.status === 401 && retry) {
    token = "";
    return get(path, auth, false);
  }
  if (!r.ok) throw new Error(`nofx ${path} ${r.status}`);
  return (await r.json()) as T;
}

function downsample(points: [number, number][]) {
  if (points.length <= CURVE_POINTS) return points;
  const step = (points.length - 1) / (CURVE_POINTS - 1);
  return Array.from({ length: CURVE_POINTS }, (_, i) => points[Math.round(i * step)]);
}

const shapeAction = (a: Json): ArenaAction => ({
  action: str(a.action),
  symbol: str(a.symbol),
  leverage: num(a.leverage),
  confidence: num(a.confidence),
  reasoning: clip(str(a.reasoning), 400),
  price: num(a.price),
  stopLoss: num(a.stop_loss),
  takeProfit: num(a.take_profit),
  success: a.success === true,
});

const coinOf = (symbol: string) => symbol.replace(/USDT?$/, "");

type ArenaTrade = ArenaTrader["trades"][number];
const shapeTrade = (x: Json): ArenaTrade => ({
  symbol: str(x.symbol),
  side: str(x.side),
  entry: num(x.entry_price),
  exit: num(x.exit_price),
  pnl: num(x.realized_pnl),
  pnlPct: num(x.pnl_pct),
  exitTime: num(x.exit_time),
  hold: str(x.hold_duration),
});

async function loadTrader(t: Json): Promise<ArenaTrader> {
  const id = str(t.trader_id);
  const q = `trader_id=${encodeURIComponent(id)}`;
  const [history, decisions, trades, config] = await Promise.all([
    get<Json[]>(`/equity-history?${q}`).catch(() => []),
    get<Json[]>(`/decisions/latest?${q}&limit=${HISTORY}`, true).catch(() => []),
    get<Json[]>(`/trades?${q}&limit=50`, true).catch(() => []),
    get<Json>(`/traders/${encodeURIComponent(id)}/config`, true).catch(() => ({}) as Json),
  ]);
  const strategy = str(config.strategy_id)
    ? await get<Json>(`/strategies/${encodeURIComponent(str(config.strategy_id))}`, true).catch(() => ({}) as Json)
    : ({} as Json);
  const sc = (typeof strategy.config === "string" ? JSON.parse(strategy.config) : strategy.config ?? {}) as Json;
  const ai = (sc.ai_config ?? {}) as Json;
  const staticCoins = (((ai.coin_source ?? {}) as Json).static_coins as string[] | undefined) ?? [];
  const coins = staticCoins.length ? staticCoins.map(coinOf) : ARENA_COINS;
  const own = (symbol: string) => coins.includes(coinOf(symbol));
  const curve = downsample(
    (history ?? []).map((p) => [Date.parse(`${str(p.timestamp).replace(" ", "T")}Z`), num(p.total_equity)] as [number, number]),
  );
  const records = decisions ?? [];
  const latest = records[0];
  // stop / target of an open position = the most recent open action on that symbol
  const openPlan = (symbol: string) => {
    for (const d of records)
      for (const a of (d.decisions as Json[]) ?? [])
        if (str(a.symbol) === symbol && str(a.action).startsWith("open_")) return a;
    return undefined;
  };
  return {
    id,
    name: str(t.trader_name),
    model: str(t.ai_model),
    exchange: str(t.exchange),
    running: t.is_running === true,
    equity: num(t.total_equity),
    pnl: num(t.total_pnl),
    pnlPct: num(t.total_pnl_pct),
    scanMinutes: num(config.scan_interval_minutes) || 15,
    minConfidence: num(((ai.risk_control ?? {}) as Json).min_confidence) || 75,
    coins,
    curve,
    positions: ((latest?.positions as Json[]) ?? []).filter((p) => own(str(p.symbol))).map((p) => {
      const plan = openPlan(str(p.symbol));
      return {
        symbol: str(p.symbol),
        side: str(p.side),
        size: Math.abs(num(p.position_amt)),
        entry: num(p.entry_price),
        mark: num(p.mark_price),
        upnl: num(p.unrealized_profit),
        leverage: num(p.leverage),
        stopLoss: num(plan?.stop_loss),
        takeProfit: num(plan?.take_profit),
      };
    }),
    trades: (trades ?? []).map(shapeTrade),
    decisions: records.map((d, i) => ({
      time: str(d.timestamp),
      cycle: num(d.cycle_number),
      actions: ((d.decisions as Json[]) ?? []).filter((a) => own(str(a.symbol))).map(shapeAction),
      thought: i === 0 ? clip(str(d.cot_trace).trim(), 1500) : "",
    })),
  };
}

/**
 * Bots on the same account see every position and NOFX files each synced fill under whichever bot synced it first,
 * so trades are pooled and re-assigned by coin, and PnL / equity are per bot: its own realized + unrealized on its
 * share of the starting balance.
 */
function splitByCoin(traders: ArenaTrader[], initial: number[]) {
  const pool = new Map<string, ArenaTrade>();
  for (const tr of traders) for (const x of tr.trades) pool.set(`${x.symbol}|${x.exitTime}|${x.entry}`, x);
  const all = [...pool.values()].sort((a, b) => b.exitTime - a.exitTime);
  traders.forEach((tr, i) => {
    tr.trades = all.filter((x) => tr.coins.includes(coinOf(x.symbol)));
    if (traders.length < 2) return;
    const base = initial[i] / traders.length;
    tr.pnl = tr.trades.reduce((s, x) => s + x.pnl, 0) + tr.positions.reduce((s, p) => s + p.upnl, 0);
    tr.pnlPct = base > 0 ? (tr.pnl / base) * 100 : 0;
    tr.equity = base + tr.pnl;
  });
  for (const tr of traders) tr.trades = tr.trades.slice(0, 12);
}

async function refresh(): Promise<ArenaState> {
  const comp = await get<{ traders?: Json[] }>("/competition");
  const list = comp.traders ?? [];
  const traders = await Promise.all(list.map(loadTrader));
  splitByCoin(traders, list.map((t) => num(t.total_equity) - num(t.total_pnl)));
  traders.sort((a, b) => b.pnlPct - a.pnlPct);
  return { enabled: true, updatedAt: Date.now(), traders };
}

export async function aiArena(): Promise<ArenaState> {
  if (!EMAIL || !PASSWORD) return { enabled: false, updatedAt: Date.now(), traders: [] };
  if (cache && Date.now() - cache.updatedAt < TTL_MS) return cache;
  inflight ??= refresh()
    .then((s) => (cache = s))
    .catch((e) => {
      console.error("[ai-arena]", e instanceof Error ? e.message : e);
      return (cache = { enabled: true, traders: [], ...cache, updatedAt: Date.now() });
    })
    .finally(() => (inflight = null));
  return inflight;
}

// ---------------------------------------------------------------- live market (Hyperliquid public info API)

type Kline = [number, number, number, number, number, number];
/** `candles` = 5m over 12h for fast bots, `candlesH` = 1h over 7d for bots that think every few hours */
export type ArenaMarket = { updatedAt: number; coins: { coin: string; mid: number; candles: Kline[]; candlesH: Kline[] }[] };

const MIDS_TTL = 1_500;
const SERIES = [
  { key: "5m", interval: "5m", span: 12 * 3600_000, ttl: 10_000 },
  { key: "1h", interval: "1h", span: 7 * 24 * 3600_000, ttl: 60_000 },
] as const;
let mids: { at: number; data: Record<string, number> } = { at: 0, data: {} };
const candles = new Map<string, { at: number; data: Kline[] }>();
let marketInflight: Promise<ArenaMarket> | null = null;

async function hl<T>(body: unknown): Promise<T> {
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return (await r.json()) as T;
}

async function loadMarket(): Promise<ArenaMarket> {
  const now = Date.now();
  if (now - mids.at > MIDS_TTL) {
    const all = await hl<Record<string, string>>({ type: "allMids" }).catch(() => null);
    if (all) mids = { at: now, data: Object.fromEntries(ARENA_COINS.map((c) => [c, num(all[c])])) };
  }
  await Promise.all(
    ARENA_COINS.flatMap((coin) =>
      SERIES.map(async (s) => {
        const key = `${coin}:${s.key}`;
        const c = candles.get(key);
        if (c && now - c.at < s.ttl) return;
        const rows = await hl<Json[]>({ type: "candleSnapshot", req: { coin, interval: s.interval, startTime: now - s.span, endTime: now } }).catch(() => null);
        if (rows) candles.set(key, { at: now, data: rows.map((k) => [num(k.t), num(k.o), num(k.h), num(k.l), num(k.c), num(k.v)]) });
      }),
    ),
  );
  return {
    updatedAt: mids.at,
    coins: ARENA_COINS.map((coin) => ({
      coin,
      mid: mids.data[coin] ?? 0,
      candles: candles.get(`${coin}:5m`)?.data ?? [],
      candlesH: candles.get(`${coin}:1h`)?.data ?? [],
    })),
  };
}

export function aiMarket(): Promise<ArenaMarket> {
  marketInflight ??= loadMarket().finally(() => (marketInflight = null));
  return marketInflight;
}
