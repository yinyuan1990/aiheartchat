/**
 * EVM token markets for the wallet's 交易 tab (Ethereum / BNB Chain / Base / Arbitrum / Polygon). Verified 10.3 from
 * the server: GeckoTerminal for per-chain lists, candles and trades (tight budget, see `gt`), DexScreener for token
 * details, prices and search (≈300/min, no key), KyberSwap for
 * swap routes (the wallet signs the built transaction locally). Every upstream answer is cached; a failing upstream
 * serves the last good copy.
 */

const GT = "https://api.geckoterminal.com/api/v2";
const DS = "https://api.dexscreener.com";
const KYBER = "https://aggregator-api.kyberswap.com";
const KYBER_CLIENT = process.env.KYBER_CLIENT_ID ?? "arm-wallet";
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

type ChainIds = { gt: string; ds: string; kyber: string };
const CHAINS: Record<string, ChainIds> = {
  eth: { gt: "eth", ds: "ethereum", kyber: "ethereum" },
  bsc: { gt: "bsc", ds: "bsc", kyber: "bsc" },
  base: { gt: "base", ds: "base", kyber: "base" },
  arb: { gt: "arbitrum", ds: "arbitrum", kyber: "arbitrum" },
  polygon: { gt: "polygon_pos", ds: "polygon", kyber: "polygon" },
};
export const isMarketChain = (k: string) => k in CHAINS;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddr = (s: string) => ADDR.test(s);

/** Quote-side assets (stables, wrapped natives, majors) never show up as coins in the lists. */
const NOT_A_COIN = /^(w?eth|weth\.e|wbnb|bnb|w?pol|wmatic|matic|usdc(\.e)?|usdbc|usdt0?|usd₮0?|dai|usde|susde|fdusd|usd1|busd|tusd|lusd|frax|pyusd|usds|w?btc|cbbtc|btcb|tbtc|steth|wsteth|weeth|reth|cbeth|ezeth)$/i;

/** Expired entries are served at once while one background load refreshes them (the upstream budget is tight). */
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load()
      .then((v) => {
        cache.set(key, { at: Date.now(), v });
        if (cache.size > 20_000) for (const [k, e] of cache) if (Date.now() - e.at > 12 * 3_600_000) cache.delete(k);
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  if (hit) {
    p.catch(() => {});
    return hit.v as T;
  }
  return p;
}

/**
 * GeckoTerminal data comes from two doors with separate budgets:
 * - the public API, limited per IP (measured 10.3 from our server: a burst of 4, then one call per ~11 s);
 * - CoinGecko's /onchain API with CG_API_KEY (same paths and payloads). CG_PLAN=demo (free key: 100/min but only
 *   10k calls a month) is the overflow when the public budget is empty, capped per day by CG_DAILY (default 300);
 *   CG_PLAN=pro (paid) goes first.
 * Callers say how long they may queue (candles for an open page: long; token info: not at all); a 429 empties that
 * door's bucket.
 */
type Door = { name: string; base: string; headers: Record<string, string>; burst: number; refillMs: number; daily: number; tokens: number; at: number; day: string; used: number };
const door = (name: string, base: string, headers: Record<string, string>, burst: number, perMin: number, daily: number): Door => ({ name, base, headers, burst, refillMs: 60_000 / perMin, daily, tokens: burst, at: Date.now(), day: "", used: 0 });
const PUBLIC = door("public", GT, { accept: "application/json;version=20230302" }, 4, 5, Infinity);
const CG_KEY = process.env.CG_API_KEY?.trim();
const CG_PRO = process.env.CG_PLAN === "pro";
const KEYED = CG_KEY
  ? CG_PRO
    ? door("pro", "https://pro-api.coingecko.com/api/v3/onchain", { "x-cg-pro-api-key": CG_KEY }, 50, 250, Number(process.env.CG_DAILY) || 3_000)
    : door("demo", "https://api.coingecko.com/api/v3/onchain", { "x-cg-demo-api-key": CG_KEY }, 10, 90, Number(process.env.CG_DAILY) || 300)
  : null;
const DOORS = KEYED ? (CG_PRO ? [KEYED, PUBLIC] : [PUBLIC, KEYED]) : [PUBLIC];

function take(d: Door): boolean {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (d.day !== day) Object.assign(d, { day, used: 0 });
  d.tokens = Math.min(d.burst, d.tokens + (now - d.at) / d.refillMs);
  d.at = now;
  if (d.tokens < 1 || d.used >= d.daily) return false;
  d.tokens -= 1;
  d.used += 1;
  return true;
}
/** ms until `d` has a call to give (Infinity once its daily cap is spent) */
const waitOf = (d: Door) => (d.used >= d.daily ? Infinity : Math.ceil((1 - d.tokens) * d.refillMs) + 20);

/**
 * Keeps the five 热门 lists warm (the tab most people open first) without starving candles: one chain per minute,
 * only while the bucket has spare calls.
 */
export function startMarketWarmer() {
  const keys = Object.keys(CHAINS);
  let i = 0;
  setInterval(() => {
    PUBLIC.tokens = Math.min(PUBLIC.burst, PUBLIC.tokens + (Date.now() - PUBLIC.at) / PUBLIC.refillMs);
    PUBLIC.at = Date.now();
    if (PUBLIC.tokens < 2.5) return;
    void marketList(keys[i++ % keys.length], "hot").catch(() => {});
  }, 60_000).unref();
}

export const gtUsage = () => DOORS.map((d) => ({ door: d.name, usedToday: d.used, daily: d.daily === Infinity ? null : d.daily }));

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(12_000) });
  if (r.status === 404) throw Object.assign(new Error("not found"), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} ${r.status}`), { status: r.status });
  return (await r.json()) as T;
}
/** chart requests waiting for a slot; lists and extras step aside for them */
let chartsWaiting = 0;
async function gt<T>(path: string, maxWaitMs: number): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  const chart = maxWaitMs >= WAIT.chart;
  if (chart) chartsWaiting++;
  try {
    for (;;) {
      const d = chart || chartsWaiting === 0 ? DOORS.find(take) : undefined;
      if (d) {
        try {
          return await getJson<T>(`${d.base}${path}`, d.headers);
        } catch (e) {
          if ((e as { status?: number }).status !== 429) throw e;
          d.tokens = 0;
          continue;
        }
      }
      const wait = Math.max(250, Math.min(...DOORS.map(waitOf)));
      if (Date.now() + wait > deadline) throw Object.assign(new Error("geckoterminal busy"), { status: 503 });
      await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    if (chart) chartsWaiting--;
  }
}
/** how long a request may queue for GeckoTerminal */
const WAIT = { chart: 15_000, list: 8_000, extra: 0 };

/** After a restart nothing is cached: fetch each chain's hot list once, spread out so pages never start cold. */
export function warmMarkets() {
  Object.keys(CHAINS).forEach((chain, i) => setTimeout(() => void marketList(chain, "hot").catch(() => {}), 2_000 + i * 13_000));
}

const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// ---------- lists ----------

export type MarketRow = {
  address: string;
  pool: string;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  change1h: number | null;
  change24h: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  createdAt: number | null;
  dex: string | null;
};

type GtPool = {
  attributes: {
    address: string;
    name: string;
    base_token_price_usd?: string;
    pool_created_at?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    price_change_percentage?: Record<string, string | null>;
    volume_usd?: Record<string, string | null>;
  };
  relationships: { base_token: { data: { id: string } }; dex?: { data: { id: string } } };
};
type GtToken = { id: string; attributes: { address: string; name: string; symbol: string; image_url?: string | null; decimals?: number } };
type GtPools = { data: GtPool[]; included?: GtToken[] };

function rowsOf(j: GtPools): MarketRow[] {
  const toks = new Map((j.included ?? []).map((t) => [t.id, t.attributes]));
  const seen = new Set<string>();
  const out: MarketRow[] = [];
  for (const p of j.data) {
    const t = toks.get(p.relationships.base_token.data.id);
    if (!t || NOT_A_COIN.test(t.symbol)) continue;
    const addr = t.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    const a = p.attributes;
    out.push({
      address: addr,
      pool: a.address,
      name: t.name,
      symbol: t.symbol,
      image: t.image_url && t.image_url !== "missing.png" ? t.image_url : null,
      priceUsd: num(a.base_token_price_usd),
      change1h: num(a.price_change_percentage?.h1),
      change24h: num(a.price_change_percentage?.h24),
      mcapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      liquidityUsd: num(a.reserve_in_usd),
      volume24hUsd: num(a.volume_usd?.h24),
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
      dex: p.relationships.dex?.data.id ?? null,
    });
  }
  return out;
}

export type MarketTab = "hot" | "new" | "gainers";

export async function marketList(chain: string, tab: string): Promise<MarketRow[]> {
  const c = CHAINS[chain];
  const t: MarketTab = tab === "new" || tab === "gainers" ? tab : "hot";
  const inc = "include=base_token";
  if (t === "hot") return cached(`list:${chain}:hot`, 5 * 60_000, async () => rowsOf(await gt<GtPools>(`/networks/${c.gt}/trending_pools?${inc}&page=1`, WAIT.list)));
  if (t === "new")
    return cached(`list:${chain}:new`, 3 * 60_000, async () => {
      // brand-new pools are mostly rugs with a few dollars in them; keep the ones somebody actually trades
      const rows = rowsOf(await gt<GtPools>(`/networks/${c.gt}/new_pools?${inc}&page=1`, WAIT.list));
      const live = rows.filter((r) => (r.liquidityUsd ?? 0) >= 1_000 && (r.volume24hUsd ?? 0) >= 500);
      return live.length >= 5 ? live : rows;
    });
  return cached(`list:${chain}:gainers`, 6 * 60_000, async () => {
    const [vol, hot] = await Promise.all([gt<GtPools>(`/networks/${c.gt}/pools?${inc}&page=1&sort=h24_volume_usd_desc`, WAIT.list), marketList(chain, "hot").catch(() => [] as MarketRow[])]);
    const seen = new Set<string>();
    return [...rowsOf(vol), ...hot]
      .filter((r) => !seen.has(r.address) && seen.add(r.address) && (r.liquidityUsd ?? 0) >= 20_000 && (r.volume24hUsd ?? 0) >= 20_000 && r.change24h != null)
      .sort((a, b) => b.change24h! - a.change24h!)
      .slice(0, 30);
  });
}

// ---------- DexScreener: details, search, prices ----------

type DsPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; header?: string; websites?: { label?: string; url: string }[]; socials?: { type: string; url: string }[] };
};

/** The pair that prices `token`: the most liquid one where it is the base token. */
function bestPair(pairs: DsPair[], token: string): DsPair | null {
  const t = token.toLowerCase();
  const own = pairs.filter((p) => p.baseToken.address.toLowerCase() === t);
  return (own.length ? own : pairs).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

const dsTokens = (chain: string, addrs: string[]) => getJson<DsPair[]>(`${DS}/tokens/v1/${CHAINS[chain].ds}/${addrs.join(",")}`);

export type MarketToken = {
  address: string;
  name: string;
  symbol: string;
  image: string | null;
  header: string | null;
  priceUsd: number | null;
  priceNative: number | null;
  changes: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volume: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number; sells: number } | null;
  liquidityUsd: number | null;
  mcapUsd: number | null;
  fdvUsd: number | null;
  pool: string;
  dex: string;
  dexLabel: string | null;
  quote: { address: string; symbol: string };
  pairCreatedAt: number | null;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  description: string | null;
  holders: number | null;
  top10Pct: number | null;
};

type GtInfo = { data: { attributes: { description?: string | null; websites?: string[]; twitter_handle?: string | null; telegram_handle?: string | null; image_url?: string | null; holders?: { count?: number | null; distribution_percentage?: { top_10?: string | number | null } } | null } } };

/** GeckoTerminal's token info (description, holders) changes slowly and costs budget: hours of cache, best-effort. */
const tokenInfo = (chain: string, addr: string) => cached(`info:${chain}:${addr}`, 6 * 3_600_000, () => gt<GtInfo>(`/networks/${CHAINS[chain].gt}/tokens/${addr}/info`, WAIT.extra)).catch(() => null);

export async function marketToken(chain: string, address: string): Promise<MarketToken> {
  const addr = address.toLowerCase();
  return cached(`token:${chain}:${addr}`, 10_000, async () => {
    const [pairs, info] = await Promise.all([dsTokens(chain, [addr]), tokenInfo(chain, addr)]);
    const p = bestPair(pairs, addr);
    if (!p) throw Object.assign(new Error("not found"), { status: 404 });
    const own = p.baseToken.address.toLowerCase() === addr;
    const tok = own ? p.baseToken : p.quoteToken;
    const social = (type: string) => p.info?.socials?.find((s) => s.type === type)?.url ?? null;
    const gi = info?.data.attributes;
    const top10 = num(gi?.holders?.distribution_percentage?.top_10);
    return {
      address: addr,
      name: tok.name,
      symbol: tok.symbol,
      image: p.info?.imageUrl ?? (gi?.image_url && gi.image_url !== "missing.png" ? gi.image_url : null),
      header: p.info?.header ?? null,
      priceUsd: own ? num(p.priceUsd) : null,
      priceNative: own ? num(p.priceNative) : null,
      changes: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
      volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
      txns24h: p.txns?.h24 ?? null,
      liquidityUsd: num(p.liquidity?.usd),
      mcapUsd: num(p.marketCap) ?? num(p.fdv),
      fdvUsd: num(p.fdv),
      pool: p.pairAddress,
      dex: p.dexId,
      dexLabel: p.labels?.[0] ?? null,
      quote: own ? { address: p.quoteToken.address, symbol: p.quoteToken.symbol } : { address: p.baseToken.address, symbol: p.baseToken.symbol },
      pairCreatedAt: p.pairCreatedAt ?? null,
      socials: {
        twitter: social("twitter") ?? (gi?.twitter_handle ? `https://x.com/${gi.twitter_handle}` : null),
        telegram: social("telegram") ?? (gi?.telegram_handle ? `https://t.me/${gi.telegram_handle}` : null),
        website: p.info?.websites?.[0]?.url ?? gi?.websites?.[0] ?? null,
      },
      description: gi?.description?.trim() || null,
      holders: gi?.holders?.count ?? null,
      top10Pct: top10,
    };
  });
}

export async function marketSearch(chain: string, q: string): Promise<MarketRow[]> {
  const term = q.trim().slice(0, 64);
  if (!term) return [];
  return cached(`search:${chain}:${term.toLowerCase()}`, 30_000, async () => {
    const ds = CHAINS[chain].ds;
    const pairs = isEvmAddr(term) ? await dsTokens(chain, [term]) : (await getJson<{ pairs: DsPair[] | null }>(`${DS}/latest/dex/search?q=${encodeURIComponent(term)}`)).pairs ?? [];
    const best = new Map<string, DsPair>();
    for (const p of pairs) {
      if (p.chainId !== ds || NOT_A_COIN.test(p.baseToken.symbol)) continue;
      const k = p.baseToken.address.toLowerCase();
      const cur = best.get(k);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(k, p);
    }
    return [...best.values()]
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
      .slice(0, 30)
      .map((p) => ({
        address: p.baseToken.address.toLowerCase(),
        pool: p.pairAddress,
        name: p.baseToken.name,
        symbol: p.baseToken.symbol,
        image: p.info?.imageUrl ?? null,
        priceUsd: num(p.priceUsd),
        change1h: num(p.priceChange?.h1),
        change24h: num(p.priceChange?.h24),
        mcapUsd: num(p.marketCap) ?? num(p.fdv),
        liquidityUsd: num(p.liquidity?.usd),
        volume24hUsd: num(p.volume?.h24),
        createdAt: p.pairCreatedAt ?? null,
        dex: p.dexId,
      }));
  });
}

export type MarketPrice = { priceUsd: number | null; change24h: number | null; symbol: string; name: string; image: string | null };

/** Prices for the wallet's asset list (tokens bought through the 交易 tab), 30 per DexScreener call. */
export async function marketPrices(chain: string, addrs: string[]): Promise<Record<string, MarketPrice | null>> {
  const want = [...new Set(addrs.map((a) => a.toLowerCase()).filter(isEvmAddr))].slice(0, 60);
  const out: Record<string, MarketPrice | null> = {};
  for (let i = 0; i < want.length; i += 30) {
    const chunk = want.slice(i, i + 30);
    const pairs = await cached(`prices:${chain}:${chunk.join(",")}`, 30_000, () => dsTokens(chain, chunk)).catch(() => [] as DsPair[]);
    for (const a of chunk) {
      const p = bestPair(
        pairs.filter((x) => x.baseToken.address.toLowerCase() === a),
        a,
      );
      out[a] = p ? { priceUsd: num(p.priceUsd), change24h: num(p.priceChange?.h24), symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl ?? null } : null;
    }
  }
  return out;
}

// ---------- GeckoTerminal: candles, trades ----------

export type MarketCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
const FRAMES: Record<string, [string, number, number]> = {
  // interval → [timeframe, aggregate, cache ms]
  "1m": ["minute", 1, 20_000],
  "5m": ["minute", 5, 30_000],
  "15m": ["minute", 15, 60_000],
  "1h": ["hour", 1, 120_000],
  "4h": ["hour", 4, 300_000],
  "1d": ["day", 1, 600_000],
};

export async function marketCandles(chain: string, pool: string, interval: string, token?: string): Promise<MarketCandle[]> {
  const [tf, agg, ttl] = FRAMES[interval] ?? FRAMES["5m"];
  const tok = token && isEvmAddr(token) ? token.toLowerCase() : "base";
  return cached(`candles:${chain}:${pool.toLowerCase()}:${interval}:${tok}`, ttl, async () => {
    const j = await gt<{ data: { attributes: { ohlcv_list: number[][] } } }>(`/networks/${CHAINS[chain].gt}/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=300&currency=usd&token=${tok}`, WAIT.chart);
    return j.data.attributes.ohlcv_list.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })).sort((a, b) => a.time - b.time);
  });
}

export type MarketTrade = { hash: string; at: number; side: "buy" | "sell"; trader: string; tokens: number; usd: number; priceUsd: number };

export async function marketTrades(chain: string, pool: string, token: string): Promise<MarketTrade[]> {
  const t = token.toLowerCase();
  return cached(`trades:${chain}:${pool.toLowerCase()}:${t}`, 45_000, async () => {
    type A = { kind: string; tx_hash: string; tx_from_address: string; block_timestamp: string; from_token_amount: string; to_token_amount: string; from_token_address: string; to_token_address: string; volume_in_usd: string; price_from_in_usd: string; price_to_in_usd: string };
    const j = await gt<{ data: { attributes: A }[] }>(`/networks/${CHAINS[chain].gt}/pools/${pool}/trades`, WAIT.list);
    return j.data.slice(0, 100).map(({ attributes: a }) => {
      const buy = a.to_token_address.toLowerCase() === t;
      return {
        hash: a.tx_hash,
        at: Date.parse(a.block_timestamp),
        side: buy ? "buy" : "sell",
        trader: a.tx_from_address,
        tokens: Number(buy ? a.to_token_amount : a.from_token_amount),
        usd: Number(a.volume_in_usd),
        priceUsd: Number(buy ? a.price_to_in_usd : a.price_from_in_usd),
      } as MarketTrade;
    });
  });
}

// ---------- KyberSwap (route + build; no fee) ----------

const QUOTE_KEYS = ["tokenIn", "tokenOut", "amountIn"];

export async function kyberQuote(chain: string, q: Record<string, string | undefined>): Promise<{ status: number; json: unknown }> {
  const p = new URLSearchParams();
  for (const k of QUOTE_KEYS) {
    const v = q[k];
    if (!v || (k === "amountIn" ? !/^\d{1,78}$/.test(v) : !isEvmAddr(v))) return { status: 400, json: { error: `bad ${k}` } };
    p.set(k, v);
  }
  p.set("gasInclude", "true");
  const r = await fetch(`${KYBER}/${CHAINS[chain].kyber}/api/v1/routes?${p}`, { headers: { "x-client-id": KYBER_CLIENT }, signal: AbortSignal.timeout(10_000) });
  return { status: r.status, json: await r.json().catch(() => ({ error: `kyber ${r.status}` })) };
}

export async function kyberBuild(chain: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const b = body as { routeSummary?: unknown; sender?: string; slippageBps?: number };
  if (!b?.routeSummary || typeof b.sender !== "string" || !isEvmAddr(b.sender)) return { status: 400, json: { error: "routeSummary and sender required" } };
  const slip = Math.max(1, Math.min(5_000, Math.round(Number(b.slippageBps) || 100)));
  const r = await fetch(`${KYBER}/${CHAINS[chain].kyber}/api/v1/route/build`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-client-id": KYBER_CLIENT },
    body: JSON.stringify({ routeSummary: b.routeSummary, sender: b.sender, recipient: b.sender, slippageTolerance: slip, deadline: Math.floor(Date.now() / 1000) + 1200, source: KYBER_CLIENT }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, json: await r.json().catch(() => ({ error: `kyber ${r.status}` })) };
}
