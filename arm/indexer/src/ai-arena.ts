// AI live-trading arena: our own NOFX bots (Docker on this host, 127.0.0.1 only) shown read-only on Arm.
// Positions / decisions / trades need the NOFX owner JWT, so they are fetched here and only a sanitized subset leaves
// the server (no prompts, no account ids, reasoning truncated).

const BASE = process.env.NOFX_URL ?? "http://127.0.0.1:8280/api";
const EMAIL = process.env.NOFX_EMAIL;
const PASSWORD = process.env.NOFX_PASSWORD;
const TTL_MS = 60_000;
const CURVE_POINTS = 120;

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type ArenaTrader = {
  id: string;
  name: string;
  model: string;
  exchange: string;
  running: boolean;
  equity: number;
  pnl: number;
  pnlPct: number;
  curve: [number, number][];
  positions: { symbol: string; side: string; size: number; entry: number; mark: number; upnl: number; leverage: number }[];
  trades: { symbol: string; side: string; entry: number; exit: number; pnl: number; pnlPct: number; exitTime: number; hold: string }[];
  decisions: { time: string; cycle: number; actions: { action: string; symbol: string; leverage: number; confidence: number; reasoning: string }[]; thought: string }[];
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

async function loadTrader(t: Json): Promise<ArenaTrader> {
  const id = str(t.trader_id);
  const q = `trader_id=${encodeURIComponent(id)}`;
  const [history, decisions, trades] = await Promise.all([
    get<Json[]>(`/equity-history?${q}`).catch(() => []),
    get<Json[]>(`/decisions/latest?${q}&limit=6`, true).catch(() => []),
    get<Json[]>(`/trades?${q}&limit=12`, true).catch(() => []),
  ]);
  const curve = downsample(
    (history ?? []).map((p) => [Date.parse(`${str(p.timestamp).replace(" ", "T")}Z`), num(p.total_equity)] as [number, number]),
  );
  const latest = (decisions ?? [])[0];
  return {
    id,
    name: str(t.trader_name),
    model: str(t.ai_model),
    exchange: str(t.exchange),
    running: t.is_running === true,
    equity: num(t.total_equity),
    pnl: num(t.total_pnl),
    pnlPct: num(t.total_pnl_pct),
    curve,
    positions: ((latest?.positions as Json[]) ?? []).map((p) => ({
      symbol: str(p.symbol),
      side: str(p.side),
      size: Math.abs(num(p.position_amt)),
      entry: num(p.entry_price),
      mark: num(p.mark_price),
      upnl: num(p.unrealized_profit),
      leverage: num(p.leverage),
    })),
    trades: (trades ?? []).map((x) => ({
      symbol: str(x.symbol),
      side: str(x.side),
      entry: num(x.entry_price),
      exit: num(x.exit_price),
      pnl: num(x.realized_pnl),
      pnlPct: num(x.pnl_pct),
      exitTime: num(x.exit_time),
      hold: str(x.hold_duration),
    })),
    decisions: (decisions ?? []).map((d) => ({
      time: str(d.timestamp),
      cycle: num(d.cycle_number),
      actions: ((d.decisions as Json[]) ?? []).map((a) => ({
        action: str(a.action),
        symbol: str(a.symbol),
        leverage: num(a.leverage),
        confidence: num(a.confidence),
        reasoning: clip(str(a.reasoning), 400),
      })),
      thought: clip(str(d.cot_trace).trim(), 900),
    })),
  };
}

async function refresh(): Promise<ArenaState> {
  const comp = await get<{ traders?: Json[] }>("/competition");
  const traders = await Promise.all((comp.traders ?? []).map(loadTrader));
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
