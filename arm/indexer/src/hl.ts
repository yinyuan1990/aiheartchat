/**
 * Wallet relays for 「AI 合约」 (wallet plan §5.8): Hyperliquid's info / exchange endpoints (api.hyperliquid.xyz is not reliably
 * reachable from mainland China). /api/hl/exchange forwards actions the wallet already signed (agent key or main wallet),
 * so the relay cannot change them. AI analysis and 托管 live in ./aibot/.
 */

const HL = "https://api.hyperliquid.xyz";
const INFO_TYPES = new Set([
  "meta", "metaAndAssetCtxs", "allMids", "l2Book", "candleSnapshot",
  "clearinghouseState", "openOrders", "frontendOpenOrders", "userFills", "userFillsByTime", "orderStatus",
  "maxBuilderFee", "extraAgents", "userRole", "userFees", "spotClearinghouseState", "fundingHistory", "userAbstraction", "historicalOrders",
]);
/** shared answers: market data only, never per-user state */
const INFO_TTL: Record<string, number> = { meta: 60_000, metaAndAssetCtxs: 2_000, allMids: 1_000, candleSnapshot: 15_000, fundingHistory: 60_000 };

type Reply = { status: number; json: unknown };
const cache = new Map<string, { at: number; v: Reply }>();

function limiter(perMin: number) {
  const hits = new Map<string, { at: number; n: number }>();
  return (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.at > 60_000) {
      hits.set(ip, { at: now, n: 1 });
      if (hits.size > 50_000) hits.clear();
      return true;
    }
    return ++h.n <= perMin;
  };
}
const infoLimit = limiter(300);
const exchangeLimit = limiter(60);

async function post(url: string, body: unknown): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 300) || `HTTP ${r.status}` };
  }
  return { status: r.status, json };
}

export async function hlInfo(body: unknown, ip: string): Promise<Reply> {
  const type = (body as { type?: unknown })?.type;
  if (typeof type !== "string" || !INFO_TYPES.has(type)) return { status: 400, json: { error: "info type not allowed" } };
  const ttl = INFO_TTL[type] ?? 0;
  const key = ttl ? JSON.stringify(body) : "";
  const hit = key ? cache.get(key) : undefined;
  // shared answers cost Hyperliquid nothing: only misses count (phones behind one carrier NAT share an IP)
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  if (!infoLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  try {
    const v = await post(`${HL}/info`, body);
    if (key && v.status === 200) {
      if (cache.size > 5_000) cache.clear();
      cache.set(key, { at: Date.now(), v });
    }
    return v;
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}

/** Latest mids for a few coins: one shared allMids fetch a second for everybody, a few bytes per phone (live chart tick) */
let mids: { at: number; v: Record<string, string> } | null = null;
let midsInflight: Promise<Record<string, string>> | null = null;
export async function hlMids(coins: string[]): Promise<Reply> {
  if (!mids || Date.now() - mids.at > 1_000) {
    midsInflight ??= post(`${HL}/info`, { type: "allMids" })
      .then((r) => {
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        mids = { at: Date.now(), v: r.json as Record<string, string> };
        return mids.v;
      })
      .finally(() => (midsInflight = null));
    try {
      await midsInflight;
    } catch (e) {
      if (!mids) return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
    }
  }
  const out: Record<string, number> = {};
  for (const c of coins.slice(0, 10)) if (mids!.v[c]) out[c] = Number(mids!.v[c]);
  return { status: 200, json: { at: mids!.at, mids: out } };
}

/**
 * What became of a 合约喊单 card (houduan perp-call): the caller's current position on the coin, or how it ended after
 * `since` (the card's time). One cached answer per caller+coin for everybody looking at the card.
 */
export type CallStatus =
  /** roe: percent of the margin, as Hyperliquid computes it */
  | { state: "open"; side: "long" | "short"; entry: number; mark: number; roe: number; liq: number | null; lev: number; at: number }
  | { state: "closed"; side: "long" | "short"; exit: number; reason: "tp" | "sl" | "liq" | "close"; closedAt: number; mark: number; at: number }
  | { state: "pending"; px: number; mark: number; at: number }
  | { state: "none"; mark: number; at: number };
/**
 * Hyperliquid budget: about half of its 1200-weight-a-minute IP limit for call cards. A position read costs 2, so with N
 * callers being watched each is re-read every N × 0.2 s (3 s minimum, 30 s maximum); a finished trade never changes.
 */
const activeCallers = new Map<string, number>();
const callTtl = () => {
  const now = Date.now();
  for (const [u, at] of activeCallers) if (now - at > 60_000) activeCallers.delete(u);
  return Math.min(30_000, Math.max(3_000, activeCallers.size * 200));
};
const callCache = new Map<string, { at: number; v: CallStatus }>();
const finished = new Map<string, CallStatus>();
type ChPos = { position: { coin: string; szi: string; entryPx: string; returnOnEquity: string; liquidationPx: string | null; leverage: { value: number } } };
const chCache = new Map<string, { at: number; v: Promise<{ assetPositions: ChPos[] }> }>();
const isCall = (user: string, coin: string, since: number) => /^0x[0-9a-fA-F]{40}$/.test(user) && /^[A-Za-z0-9]{1,16}$/.test(coin) && Number.isFinite(since) && since > 0;

async function hlGet<T>(body: unknown): Promise<T> {
  const r = await post(`${HL}/info`, body);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.json as T;
}

async function callStatus(user: string, coin: string, since: number, side?: "long" | "short"): Promise<CallStatus> {
  user = user.toLowerCase();
  const key = `${user}|${coin}|${since}`;
  const done = finished.get(key);
  if (done) return done;
  activeCallers.set(user, Date.now());
  const ttl = callTtl();
  const hit = callCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const mark = Number(mids?.v[coin] ?? 0);
  // one position read per caller however many of their cards are being watched
  let ch = chCache.get(user);
  if (!ch || Date.now() - ch.at >= ttl) {
    ch = { at: Date.now(), v: hlGet<{ assetPositions: ChPos[] }>({ type: "clearinghouseState", user }) };
    if (chCache.size > 20_000) chCache.clear();
    chCache.set(user, ch);
  }
  const p = (await ch.v).assetPositions.find((x) => x.position.coin === coin)?.position;
  const pSide = p && Number(p.szi) !== 0 ? (Number(p.szi) > 0 ? "long" : "short") : null;
  let v: CallStatus;
  if (p && pSide && (!side || pSide === side)) {
    v = { state: "open", side: pSide, entry: Number(p.entryPx), mark, roe: Number(p.returnOnEquity) * 100, liq: p.liquidationPx ? Number(p.liquidationPx) : null, lev: p.leverage.value, at: Date.now() };
  } else {
    type F = { coin: string; px: string; time: number; dir: string; oid: number; liquidation?: unknown };
    const fills = (await hlGet<F[]>({ type: "userFillsByTime", user, startTime: since - 60_000 })).filter((f) => f.coin === coin);
    const close = [...fills].reverse().find((f) => f.dir.startsWith("Close") || f.dir.includes(">"));
    if (close) {
      type H = { order: { oid: number; orderType: string } };
      const hist = await hlGet<H[]>({ type: "historicalOrders", user }).catch(() => [] as H[]);
      const ot = hist.find((h) => h.order.oid === close.oid)?.order.orderType ?? "";
      const reason = close.liquidation ? "liq" : /take profit/i.test(ot) ? "tp" : /stop/i.test(ot) ? "sl" : "close";
      v = { state: "closed", side: /Close Short|Short >/.test(close.dir) ? "short" : "long", exit: Number(close.px), reason, closedAt: close.time, mark, at: Date.now() };
      if (finished.size > 50_000) finished.clear();
      finished.set(key, v);
    } else {
      const orders = await hlGet<{ coin: string; limitPx: string; reduceOnly: boolean; isTrigger: boolean }[]>({ type: "frontendOpenOrders", user });
      const o = orders.find((x) => x.coin === coin && !x.reduceOnly && !x.isTrigger);
      v = o ? { state: "pending", px: Number(o.limitPx), mark, at: Date.now() } : { state: "none", mark, at: Date.now() };
    }
  }
  if (callCache.size > 20_000) callCache.clear();
  callCache.set(key, { at: Date.now(), v });
  return v;
}

export async function hlCallStatus(user: string, coin: string, since: number): Promise<Reply> {
  if (!isCall(user, coin, since)) return { status: 400, json: { error: "bad request" } };
  try {
    await hlMids([coin]);
    return { status: 200, json: await callStatus(user, coin, since) };
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}

/** Many cards at once (the 心之音 backend's 3-second tick for the chats people have open), plus the coins' mids. */
const batchLimit = limiter(40);
export async function hlCallStatusBatch(body: unknown, ip: string): Promise<Reply> {
  if (!batchLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length > 300) return { status: 400, json: { error: "bad request" } };
  const list = items
    .map((x) => x as { user?: unknown; coin?: unknown; since?: unknown; side?: unknown })
    .map((x) => ({ user: String(x.user ?? ""), coin: String(x.coin ?? ""), since: Number(x.since), side: x.side === "long" ? ("long" as const) : x.side === "short" ? ("short" as const) : undefined }))
    .filter((x) => isCall(x.user, x.coin, x.since));
  await hlMids([]).catch(() => null);
  const results: Record<string, CallStatus | { state: "error" }> = {};
  const queue = [...new Map(list.map((x) => [`${x.user.toLowerCase()}|${x.coin}|${x.since}`, x])).entries()];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [key, x] = job;
      results[key] = await callStatus(x.user, x.coin, x.since, x.side).catch(() => ({ state: "error" as const }));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const marks: Record<string, number> = {};
  for (const x of list) if (mids?.v[x.coin]) marks[x.coin] = Number(mids.v[x.coin]);
  return { status: 200, json: { results, marks } };
}

export async function hlExchange(body: unknown, ip: string): Promise<Reply> {
  const b = body as { action?: { type?: unknown }; nonce?: unknown; signature?: { r?: unknown; s?: unknown; v?: unknown } };
  if (!b?.action || typeof b.action.type !== "string" || typeof b.nonce !== "number" || typeof b.signature?.r !== "string") return { status: 400, json: { error: "bad request" } };
  if (!exchangeLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  try {
    return await post(`${HL}/exchange`, body);
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message.slice(0, 120) } };
  }
}