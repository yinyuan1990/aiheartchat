/**
 * pump.fun data for the wallet's coin pages. These are pump's own (undocumented) web APIs, verified 10.3 from the
 * server; everything pump-specific lives here so a pump redesign only breaks this file. Short in-memory caches keep
 * us well under any rate limit and make repeated page opens instant.
 */

const FE = "https://frontend-api-v3.pump.fun";
const SWAP = "https://swap-api.pump.fun";
const SOLANA_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const HEADERS = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36" };
/** pump curve: 793.1M tokens are sold on the curve, the rest seeds the pool at graduation. */
const CURVE_TOKENS = 793_100_000n * 1_000_000n;

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s: string) => MINT.test(s);

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  try {
    const v = await load();
    cache.set(key, { at: Date.now(), v });
    if (cache.size > 20_000) for (const [k, e] of cache) if (Date.now() - e.at > 600_000) cache.delete(k);
    return v;
  } catch (e) {
    if (hit) return hit.v as T; // stale beats an error page while pump hiccups
    throw e;
  }
}

async function getJson<T>(url: string): Promise<T> {
  let r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  // pump's per-IP limiter answers 429 with a few-ms retryAfter; one short retry clears almost all of them
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 400));
    r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  }
  if (r.status === 404) throw Object.assign(new Error("not found"), { status: 404 });
  if (!r.ok) throw new Error(`pump ${r.status}`);
  return (await r.json()) as T;
}

export const solPrice = () => cached("sol-price", 30_000, async () => (await getJson<{ solPrice: number }>(`${FE}/sol-price`)).solPrice);

type RawCoin = {
  mint: string;
  name: string;
  symbol: string;
  description?: string | null;
  image_uri?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  creator: string;
  created_timestamp: number;
  complete: boolean;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  real_sol_reserves: number;
  real_token_reserves: number;
  total_supply: number;
  usd_market_cap?: number;
  market_cap_usd?: number;
  ath_market_cap?: number;
  ath_market_cap_timestamp?: number;
  reply_count?: number;
  last_trade_timestamp?: number;
  king_of_the_hill_timestamp?: number | null;
  raydium_pool?: string | null;
  pump_swap_pool?: string | null;
  pool_address?: string | null;
  bonding_curve?: string | null;
  token_program?: string | null;
  is_currently_live?: boolean;
  nsfw?: boolean;
  is_banned?: boolean;
  username?: string | null;
  profile_image?: string | null;
};

export type PumpCoinRow = { mint: string; name: string; symbol: string; image: string | null; mcapUsd: number; createdAt: number; lastTradeAt: number | null; progress: number; complete: boolean; replies: number; live: boolean };

const mcapOf = (c: RawCoin) => c.usd_market_cap ?? c.market_cap_usd ?? 0;
/** pump's `complete` lags (and `pool_address` is pre-filled for curve coins): having a PumpSwap / Raydium pool is what
 *  says the coin left the curve. */
const graduated = (c: RawCoin) => c.complete || !!c.pump_swap_pool || !!c.raydium_pool;
/** % of the curve sold; graduated coins are 100. */
function progressOf(c: RawCoin): number {
  if (graduated(c)) return 100;
  const left = BigInt(Math.max(0, Math.round(c.real_token_reserves ?? 0)));
  return Math.max(0, Math.min(100, Number(((CURVE_TOKENS - (left > CURVE_TOKENS ? CURVE_TOKENS : left)) * 10_000n) / CURVE_TOKENS) / 100));
}
const row = (c: RawCoin): PumpCoinRow => ({ mint: c.mint, name: c.name, symbol: c.symbol, image: c.image_uri ?? null, mcapUsd: mcapOf(c), createdAt: c.created_timestamp, lastTradeAt: c.last_trade_timestamp ?? null, progress: progressOf(c), complete: graduated(c), replies: c.reply_count ?? 0, live: !!c.is_currently_live });

const LISTS: Record<string, string> = {
  hot: "sort=last_trade_timestamp&order=DESC",
  new: "sort=created_timestamp&order=DESC",
  // pump's market_cap sort over complete=false is dominated by stale outliers; recently traded coins ranked by progress
  // is what "about to graduate" means on pump itself
  graduating: "sort=last_trade_timestamp&order=DESC&complete=false",
  graduated: "sort=last_trade_timestamp&order=DESC&complete=true",
  mcap: "sort=market_cap&order=DESC",
};

export async function pumpList(tab: string, offset = 0, q = ""): Promise<PumpCoinRow[]> {
  const off = Math.max(0, Math.min(500, offset | 0));
  if (q.trim()) {
    const term = q.trim().slice(0, 64);
    return cached(`search:${term}:${off}`, 30_000, async () => (await getJson<RawCoin[]>(`${FE}/coins/search-v2?searchTerm=${encodeURIComponent(term)}&limit=30&offset=${off}&includeNsfw=false`)).filter((c) => !c.is_banned).map(row));
  }
  const qs = LISTS[tab] ?? LISTS.hot;
  return cached(`list:${tab}:${off}`, 15_000, async () => {
    const page = async (o: number) => (await getJson<RawCoin[]>(`${FE}/coins?offset=${o}&limit=30&includeNsfw=false&${qs}`)).filter((c) => !c.is_banned && !c.nsfw);
    if (tab !== "graduating") return (await page(off)).map(row);
    const pages = await Promise.all([0, 30, 60].map((o) => page(off * 3 + o).catch(() => [] as RawCoin[])));
    const seen = new Set<string>();
    const rows = pages
      .flat()
      .filter((c) => !seen.has(c.mint) && seen.add(c.mint) && standardCurve(c))
      .map(row)
      .filter((r) => r.progress >= 25)
      .slice(0, 60);
    // pump's complete=false still returns already-migrated coins; "graduating" means closest to the end of the curve
    const left = rows.filter((r) => !r.complete);
    const migrated = await Promise.all(left.map((r) => (r.progress >= 95 ? onAmm(r.mint) : false)));
    return left.filter((_, i) => !migrated[i]).sort((a, b) => b.progress - a.progress);
  });
}

/**
 * Standard pump curve (30 SOL / 1.073B virtual): the SOL in the curve follows from the tokens sold. Some coins report
 * a high "sold" share with almost no SOL (another curve variant; Jupiter can't route them) — keep them out of
 * "即将毕业".
 */
function standardCurve(c: RawCoin): boolean {
  if (graduated(c)) return true;
  const V_SOL = 30e9;
  const V_TOK = 1_073e12;
  const sold = Number(CURVE_TOKENS) - (c.real_token_reserves ?? 0);
  if (sold <= 0) return true;
  const expected = (V_SOL * V_TOK) / (V_TOK - sold) - V_SOL;
  return (c.real_sol_reserves ?? 0) >= expected * 0.5;
}

/** Last trade went through an AMM (pump_amm / raydium) → the coin left the curve even if pump's flags say otherwise. */
const onAmm = (mint: string) =>
  cached(`amm:${mint}`, 60_000, async () => {
    const j = await getJson<{ trades: { program: string }[] }>(`${SWAP}/v2/coins/${mint}/trades?limit=1`).catch(() => null);
    const p = j?.trades[0]?.program;
    return !!p && p !== "pump";
  });

export type PumpCoin = PumpCoinRow & {
  description: string | null;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  creator: string;
  creatorName: string | null;
  creatorImage: string | null;
  athMcapUsd: number | null;
  athAt: number | null;
  kingAt: number | null;
  solInCurve: number;
  /** USD still to be bought before graduation (constant product, before fees); null once graduated */
  toGraduateUsd: number | null;
  priceUsd: number;
  pool: string | null;
  venue: "curve" | "pumpswap" | "raydium";
  tokenProgram: string;
  holders: { total: number; top10Pct: number | null; devPct: number | null; snipersPct: number | null } | null;
  solPrice: number;
};

export async function pumpCoin(mint: string): Promise<PumpCoin> {
  return cached(`coin:${mint}`, 8_000, async () => {
    const [c, sp, hs, last] = await Promise.all([
      getJson<RawCoin>(`${FE}/coins-v2/${mint}`),
      solPrice(),
      getJson<{ totalHolders: number; top10HoldersPercent: number | null; devHoldingsPercent: number | null; snipersHoldingsPercent: number | null }>(`${FE}/coins/holder-stats/${mint}`).catch(() => null),
      getJson<{ trades: { program: string }[] }>(`${SWAP}/v2/coins/${mint}/trades?limit=1`).catch(() => null),
    ]);
    const r = row(c);
    // some migrated coins never get pump_swap_pool / complete set; their trades already run through the AMM
    const ammProgram = last?.trades[0]?.program;
    if (ammProgram) cache.set(`amm:${mint}`, { at: Date.now(), v: ammProgram !== "pump" });
    if (!r.complete && ammProgram && ammProgram !== "pump") Object.assign(r, { complete: true, progress: 100 });
    const supply = c.total_supply || 1e15;
    let toGraduateUsd: number | null = null;
    if (!r.complete && c.virtual_token_reserves > c.real_token_reserves) {
      // SOL that buys out the remaining curve: k / (vTok − realTok) − vSol
      const k = c.virtual_sol_reserves * c.virtual_token_reserves;
      const solNeeded = k / (c.virtual_token_reserves - c.real_token_reserves) - c.virtual_sol_reserves;
      toGraduateUsd = Math.max(0, (solNeeded / 1e9) * sp);
    }
    const pool = r.complete ? (c.pump_swap_pool ?? c.raydium_pool ?? c.pool_address ?? null) : (c.bonding_curve ?? null);
    return {
      ...r,
      description: c.description ?? null,
      socials: { twitter: c.twitter ?? null, telegram: c.telegram ?? null, website: c.website ?? null },
      creator: c.creator,
      creatorName: c.username ?? null,
      creatorImage: c.profile_image ?? null,
      athMcapUsd: c.ath_market_cap ?? null, // already USD (unlike market_cap, which is SOL)
      athAt: c.ath_market_cap_timestamp ?? null,
      kingAt: c.king_of_the_hill_timestamp ?? null,
      solInCurve: (c.real_sol_reserves ?? 0) / 1e9,
      toGraduateUsd,
      priceUsd: r.mcapUsd / (supply / 1e6),
      pool,
      venue: !r.complete ? "curve" : (c.raydium_pool && !c.pump_swap_pool) || /raydium/i.test(ammProgram ?? "") ? "raydium" : "pumpswap",
      tokenProgram: c.token_program ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      holders: hs ? { total: hs.totalHolders, top10Pct: hs.top10HoldersPercent, devPct: hs.devHoldingsPercent, snipersPct: hs.snipersHoldingsPercent } : null,
      solPrice: sp,
    };
  });
}

export type PumpTrade = { sig: string; at: number; side: "buy" | "sell"; trader: string; tokens: number; sol: number; usd: number; priceUsd: number; venue: string };

/** swap-api keeps the full history; the frontend-api feed only covers a recent window (empty for quiet coins).
 *  `user` narrows it to one wallet (my trades for the cost basis, the creator's for chart bubbles). */
export async function pumpTrades(mint: string, limit = 50, user?: string): Promise<PumpTrade[]> {
  const n = Math.max(1, Math.min(100, limit | 0));
  const who = user && isMint(user) ? user : "";
  return cached(`trades:${mint}:${n}:${who}`, who ? 10_000 : 4_000, async () => {
    type T = { tx: string; timestamp: string; type: "buy" | "sell"; userAddress: string; program: string; priceUsd: string; amountUsd: string; amountSol: string; baseAmount: string };
    const j = await getJson<{ trades: T[] }>(`${SWAP}/v2/coins/${mint}/trades?limit=${n}${who ? `&userAddress=${who}` : ""}`);
    return j.trades.map((t) => ({
      sig: t.tx,
      at: Date.parse(t.timestamp),
      side: t.type,
      trader: t.userAddress,
      tokens: Number(t.baseAmount),
      sol: Number(t.amountSol),
      usd: Number(t.amountUsd),
      priceUsd: Number(t.priceUsd),
      venue: t.program,
    }));
  });
}

export type PumpCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
const INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

export async function pumpCandles(mint: string, interval: string, limit = 300): Promise<PumpCandle[]> {
  const iv = INTERVALS.has(interval) ? interval : "5m";
  const n = Math.max(10, Math.min(1000, limit | 0));
  return cached(`candles:${mint}:${iv}:${n}`, iv === "1m" ? 10_000 : 20_000, async () => {
    const coin = await pumpCoin(mint);
    type C = { timestamp: number; open: string; high: string; low: string; close: string; volume: string };
    const list = await getJson<C[]>(`${SWAP}/v2/coins/${mint}/candles?interval=${iv}&limit=${n}&currency=USD&createdTs=${coin.createdAt}`);
    return list.map((c) => ({ time: Math.floor(c.timestamp / 1000), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }));
  });
}

export type PumpHolder = { address: string; amount: number; pct: number; isDev: boolean; isSniper: boolean; isBundler: boolean; isPool: boolean };

export async function pumpHolders(mint: string): Promise<PumpHolder[]> {
  return cached(`holders:${mint}`, 30_000, async () => {
    const coin = await pumpCoin(mint);
    type H = { address: string; amount: number; isDev?: boolean; isSniper?: boolean; isBundler?: boolean };
    const j = await getJson<{ topHolders: H[] }>(`${FE}/coins/top-holders-v2/${mint}`);
    return j.topHolders.slice(0, 50).map((h) => ({
      address: h.address,
      amount: h.amount,
      pct: (h.amount / 1e9) * 100,
      isDev: !!h.isDev || h.address === coin.creator,
      isSniper: !!h.isSniper,
      isBundler: !!h.isBundler,
      isPool: h.address === coin.pool,
    }));
  });
}
