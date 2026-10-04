/**
 * Wallet relays for 「AI 合约」 (wallet plan §5.8): Hyperliquid's info / exchange endpoints (api.hyperliquid.xyz is not reliably
 * reachable from mainland China). /api/hl/exchange forwards actions the wallet already signed (agent key or main wallet),
 * so the relay cannot change them. AI analysis and 托管 live in ./aibot/.
 */

const HL = "https://api.hyperliquid.xyz";
const INFO_TYPES = new Set([
  "meta", "metaAndAssetCtxs", "allMids", "l2Book", "candleSnapshot",
  "clearinghouseState", "openOrders", "frontendOpenOrders", "userFills", "userFillsByTime", "orderStatus",
  "maxBuilderFee", "extraAgents", "userRole", "userFees", "spotClearinghouseState", "fundingHistory", "userAbstraction",
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
  if (!infoLimit(ip)) return { status: 429, json: { error: "rate limited" } };
  const ttl = INFO_TTL[type] ?? 0;
  const key = ttl ? JSON.stringify(body) : "";
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.v;
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