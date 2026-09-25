import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress, isAddress, parseEventLogs, type Address } from "viem";
import { sql } from "./db.js";
import { bindReferral, promoterStats, referralOf } from "./referral.js";
import { client, ADDR, ALL_LOCKERS, addrsFor, isLocker, keeperWallet } from "./chain.js";
import { deployments, config } from "./config.js";
import { factoryAbi, hubAbi, lockerAbi, erc20Abi, treasuryAbi } from "./abi.js";
import { keeperState } from "./keeper-log.js";
import { PINNED_X_ACCOUNTS, getSettings, saveSettings } from "./hotspots/settings.js";
import { PUBLIC_ORDER, aiCallsToday, aiStatus, generateOne, hasAiLogo, quotaLeft, radarState, refreshHotspots, type HotspotRow } from "./hotspots/service.js";
import { generateIdeas, generateLogo, monogramLogo, templateIdeas } from "./hotspots/ai.js";
import { tgStatus, tgSubscriptions, tgTestChannel } from "./telegram/bot.js";
import { buybackStatus, runBuyback } from "./buyback.js";
import { quoteAssets, stockSet } from "./config.js";
import { hasStock, quotePrice, quoteToUsdc } from "./quotes.js";

export const app = new Hono();
// paged list endpoints report the full row count in X-Total-Count; expose it so the browser can read it
app.use("*", cors({ origin: "*", exposeHeaders: ["x-total-count"] }));

const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const SUPPLY_TOKENS = 1_000_000_000;
const ZERO = "0x0000000000000000000000000000000000000000";
// Arc forbids transfers to address(0); burns go to the conventional dead address instead.
const DEAD = "0x000000000000000000000000000000000000dEaD";

function addr(a: string): Address {
  if (!isAddress(a)) throw new Error("bad address");
  return getAddress(a);
}

/** Shape a tokens row for the client (numerics as strings, add derived fields). */
function shapeToken(r: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const lastMcap6 = BigInt((r.last_mcap6 as string) ?? "0");
  // stock generation: graduation_threshold / paired_usdc are stored in the pool's quote units; the client gets USD
  // (converted at the quote's latest USDC price) plus the raw quote figures for "x.xx NVDA" displays
  const quote = ((r.quote as string) ?? "") || "";
  const qDec = Number(r.quote_decimals ?? 6);
  const qPx = quote ? quotePrice(quote) : 1_000_000n;
  const toUsd = (v: unknown) => (quote ? quoteToUsdc(BigInt((v as string) ?? "0"), qDec, qPx).toString() : ((v as string) ?? "0"));
  return {
    address: r.address,
    // Arm: the lock pays this per-token splitter; referralBps > 0 = the creator shares fees with promoters
    splitter: (r.splitter as string) || null,
    referralBps: Number(r.referral_bps ?? 0),
    name: r.name,
    symbol: r.symbol,
    logo: r.logo,
    description: r.description,
    socials: { website: r.website, twitter: r.twitter, telegram: r.telegram, discord: r.discord ?? "", farcaster: r.farcaster ?? "" },
    deployer: r.deployer,
    payout: r.payout,
    pool: r.pool,
    positionId: r.position_id,
    isToken0: r.is_token0,
    launchBlock: Number(r.launch_block),
    launchTs: r.launch_ts,
    launchTx: r.launch_tx,
    restrictionsEndBlock: Number(r.restrictions_end_block),
    graduationThreshold: toUsd(r.graduation_threshold),
    pairedUsdc: toUsd(r.paired_usdc),
    // quote asset the pool is priced in ('' / USDC for every USDC-generation token)
    quote,
    quoteSymbol: (r.quote_symbol as string) ?? "USDC",
    quoteDecimals: qDec,
    quoteUsdcFee: Number(r.quote_usdc_fee ?? 0),
    quotePool: (r.quote_pool as string) ?? "",
    quotePriceUsdc: quote ? qPx.toString() : "1000000",
    quotePriceUsdcLaunch: quote ? ((r.quote_price_usdc_launch as string) ?? undefined) : undefined,
    pairedQuote: quote ? ((r.paired_usdc as string) ?? "0") : undefined,
    graduationThresholdQuote: quote ? ((r.graduation_threshold as string) ?? "0") : undefined,
    graduated: r.graduated,
    graduatedAt: r.graduated_at,
    creatorShareBps: r.creator_share_bps,
    price: Number(r.last_price),
    mcapUsd: Number(lastMcap6) / 1e6,
    feesUsdcTotal: r.fees_usdc_total,
    feesCreatorUsdcTotal: r.fees_creator_usdc_total,
    lastDistributedAt: r.last_distributed_at,
    // tax mode (0/0 = standard token); immutable on the token contract
    buyTaxBps: Number(r.buy_tax_bps ?? 0),
    sellTaxBps: Number(r.sell_tax_bps ?? 0),
    taxMarketingWallet: (r.tax_marketing_wallet as string) ?? "",
    taxTeamWallet: (r.tax_team_wallet as string) ?? "",
    taxMarketingBps: Number(r.tax_marketing_bps ?? 0),
    taxUsdcTotal: (r.tax_usdc_total as string) ?? "0",
    hidden: Boolean(r.hidden),
    pinned: r.pinned_at != null,
    // factory generation that launched the token (its locker / router / quoter follow from it — see /api/config)
    factory: (r.factory as string | null) ?? ADDR.factory,
    ...extra,
  };
}

app.get("/api/health", async (c) => {
  const [{ v }] = await sql`select value as v from sync_state where key = 'last_block'`.catch(() => [{ v: null }]);
  const head = await client.getBlockNumber().catch(() => null);
  return c.json({ ok: true, lastBlock: v ? Number(v) : null, head: head ? Number(head) : null, chainId: deployments.chainId });
});

// ---------- Arm promoter referrals ----------
/** Bind the connected wallet to the promoter from `?ref=` (first touch wins; signed by the wallet). */
app.post("/api/referral/bind", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await bindReferral(body);
  return c.json(r, r.ok ? 200 : 400);
});
app.get("/api/referral/of/:wallet", async (c) => {
  const w = c.req.param("wallet");
  if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return c.json({ error: "bad address" }, 400);
  return c.json({ binding: await referralOf(w) });
});
app.get("/api/referral/stats/:wallet", async (c) => {
  const w = c.req.param("wallet");
  if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return c.json({ error: "bad address" }, 400);
  return c.json(await promoterStats(w));
});
/** Tokens that pay promoters (referralBps > 0), for the promote page. */
app.get("/api/referral/tokens", async (c) => {
  const rows = await sql`select address, name, symbol, logo, referral_bps, last_mcap6, splitter from tokens
    where referral_bps > 0 and splitter_active and not hidden order by last_mcap6 desc nulls last limit 100`;
  return c.json({ tokens: rows });
});

/** Site-wide switches the frontend reads on every load (owner edits them in /admin, saved on the settings row). */
app.get("/api/site", async (c) => {
  const s = await getSettings();
  const tg = tgStatus();
  return c.json({
    bugButton: s.bugButton, swapEnabled: s.swapEnabled, swapMaxUsd: s.swapMaxUsd,
    // Telegram buy bot: username for the "add to your group" deep link, public channel handle for the join link
    tgBot: tg.bot, tgChannel: tg.channel, tgEnabled: s.tgEnabled, tgChannelMinBuyUsd: s.tgChannelMinBuyUsd, tgLaunches: s.tgLaunches, tgPhotos: s.tgPhotos,
  });
});

app.get("/api/config", async (c) => {
  const [fee, thr, prot, maxHold, maxBuy, startMcap, total, maxTax] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: ADDR.factory, abi: factoryAbi, functionName: "creationFee" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "graduationThreshold" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "protectionBlocks" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxHoldBps" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxBuyBps" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "startMcapUsdc" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "totalLaunches" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxTaxBps" },
    ],
  });
  return c.json({
    chainId: deployments.chainId,
    addresses: deployments,
    params: {
      creationFee: fee.toString(), // 0 on Arm
      graduationThreshold: thr.toString(),
      protectionBlocks: Number(prot),
      maxHoldBps: maxHold,
      maxBuyBps: maxBuy,
      startMcapUsdc: startMcap.toString(),
      creatorShareBps: 7800,
      poolFee: 10000,
      totalLaunches: Number(total),
      maxTaxBps: Number(maxTax),
    },
    // stock generation (absent until ops/deploy-stock.sh has run): same economics expressed in the quote asset at launch
    stock: stockSet ? { factory: stockSet.launchFactory, locker: stockSet.feeLocker, oracle: stockSet.quoteOracle, deployBlock: stockSet.deployBlock, quotes: quoteAssets } : null,
  });
});

/** Whitelisted quote assets of the stock generation with their latest USDC prices (6dp per whole unit). */
app.get("/api/quotes", async (c) => {
  if (!hasStock()) return c.json({ quotes: [] });
  const rows = await sql<{ address: string; price_usdc: string; twap_usdc: string; enabled: boolean; updated_at: Date }[]>`select address, price_usdc, twap_usdc, enabled, updated_at from quote_prices`;
  const byAddr = new Map(rows.map((r) => [r.address.toLowerCase(), r]));
  const launches = await sql<{ quote: string; n: number; vol: string }[]>`
    select t.quote, count(*)::int as n, coalesce(sum(tr.usdc), 0)::text as vol
    from tokens t left join trades tr on tr.token = t.address and tr.ts > now() - interval '24 hours'
    where t.quote <> '' and not t.hidden group by t.quote`;
  const stats = new Map(launches.map((l) => [l.quote.toLowerCase(), l]));
  return c.json({
    quotes: quoteAssets.map((q) => {
      const r = byAddr.get(q.address.toLowerCase());
      const s = stats.get(q.address.toLowerCase());
      return {
        ...q,
        priceUsdc: r?.price_usdc ?? quotePrice(q.address).toString(),
        twapUsdc: r?.twap_usdc ?? "0",
        enabled: r?.enabled ?? true,
        updatedAt: r?.updated_at ?? null,
        launches: s?.n ?? 0,
        volume24hUsdc: s?.vol ?? "0",
      };
    }),
  });
});

/** Helper for the create form: the platform opening mcap and the (constant) creation fee. The opening price is
 *  fixed by the factory (fair launch) — the form cannot choose it. Token addresses are CREATE2 with the previous
 *  block hash in the salt, so they cannot be predicted ahead of the launch transaction. */
app.get("/api/launch-quote", async (c) => {
  const [startMcap, fee] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: ADDR.factory, abi: factoryAbi, functionName: "startMcapUsdc" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "creationFee" },
    ],
  });
  return c.json({ startMcapUsdc: startMcap.toString(), creationFee: fee.toString() });
});

// Public lists / feeds / stats leave out owner-hidden tokens (their detail page stays reachable so holders can exit).
const shown = sql`(select address from tokens where not hidden)`;

app.get("/api/stats", async (c) => {
  const [s] = await sql`select
      (select count(*) from tokens where not hidden) as tokens,
      (select count(*) from tokens where not hidden and launch_ts > now() - interval '24 hours') as launched_24h,
      (select count(*) from tokens where not hidden and graduated) as graduated,
      (select coalesce(sum(usdc),0) from trades where token in ${shown} and ts > now() - interval '24 hours') as volume_24h,
      (select coalesce(sum(usdc),0) from trades where token in ${shown}) as volume_total,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown}) as fees_total,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown} and ts > now() - interval '24 hours') as fees_24h,
      (select coalesce(sum(creation_fee_paid),0) from tokens where not hidden) as creation_fees_total,
      (select coalesce(sum(quote_protocol),0) from fee_events where token in ${shown}) as protocol_fees_total`;
  const treasuryUsdc = await client.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ADDR.treasury] }).catch(() => 0n);
  return c.json({
    tokens: Number(s.tokens),
    launched24h: Number(s.launched_24h),
    graduated: Number(s.graduated),
    volume24hUsdc: s.volume_24h,
    volumeTotalUsdc: s.volume_total,
    fees24hUsdc: s.fees_24h,
    feesTotalUsdc: s.fees_total,
    creationFeesTotalUsdc: s.creation_fees_total,
    protocolFeesTotalUsdc: s.protocol_fees_total,
    treasuryUsdc: treasuryUsdc.toString(),
  });
});

/** Public protocol analytics (pons-style): latest completed UTC day vs all time, plus a 30-day daily series.
 *  Everything is derived from indexed onchain events; the factory address is the verifiable source. */
app.get("/api/analytics", async (c) => {
  // "24h" = rolling last 24 hours (boss 9.14: the tab used to mean "yesterday UTC", which is empty right after a
  // redeploy / at the start of a day while "all time" already has numbers). latest_day only drives the chart highlight.
  const [d] = await sql`with day as (select (now() at time zone 'utc')::date - 1 as d), win as (select now() - interval '24 hours' as t0)
    select
      (select d from day) as latest_day,
      (select coalesce(sum(usdc),0) from trades, win where token in ${shown} and ts > win.t0) as day_volume,
      (select count(*) from trades, win where token in ${shown} and ts > win.t0) as day_trades,
      (select count(distinct sender) from trades, win where token in ${shown} and ts > win.t0) as day_traders,
      (select count(*) from tokens, win where not hidden and launch_ts > win.t0) as day_launches,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events, win where token in ${shown} and kind = 'fee' and ts > win.t0) as day_fees,
      (select coalesce(sum(usdc),0) from trades where token in ${shown}) as all_volume,
      (select count(*) from trades where token in ${shown}) as all_trades,
      (select count(distinct sender) from trades where token in ${shown}) as all_traders,
      (select count(*) from tokens where not hidden) as all_launches,
      (select count(*) from tokens where not hidden and graduated) as all_graduated,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown} and kind = 'fee') as all_fees,
      (select coalesce(sum(quote_creator),0) from fee_events where token in ${shown} and kind = 'fee') as all_fees_creator,
      (select coalesce(sum(creation_fee_paid),0) from tokens where not hidden) as all_creation_fees,
      (select coalesce(sum(usdc_to_buyback),0) from settlements) as all_to_buyback`;
  const daily = await sql`with days as (select generate_series(((now() at time zone 'utc')::date - 29), (now() at time zone 'utc')::date, '1 day')::date as d)
    select d,
      (select count(*) from tokens where not hidden and (launch_ts at time zone 'utc')::date = d) as launches,
      (select coalesce(sum(usdc),0) from trades where token in ${shown} and (ts at time zone 'utc')::date = d) as volume,
      (select count(*) from trades where token in ${shown} and (ts at time zone 'utc')::date = d) as trades,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown} and kind = 'fee' and (ts at time zone 'utc')::date = d) as fees
    from days order by d`;
  const dstr = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
  return c.json({
    latestDay: dstr(d.latest_day),
    day: { volumeUsdc: String(d.day_volume), trades: Number(d.day_trades), traders: Number(d.day_traders), launches: Number(d.day_launches), feesUsdc: String(d.day_fees) },
    allTime: {
      volumeUsdc: String(d.all_volume), trades: Number(d.all_trades), traders: Number(d.all_traders), launches: Number(d.all_launches), graduated: Number(d.all_graduated),
      feesUsdc: String(d.all_fees), feesCreatorUsdc: String(d.all_fees_creator), creationFeesUsdc: String(d.all_creation_fees), buybackFundUsdc: String(d.all_to_buyback),
    },
    daily: daily.map((r) => ({ day: dstr(r.d), launches: Number(r.launches), volumeUsdc: String(r.volume), trades: Number(r.trades), feesUsdc: String(r.fees) })),
    source: { factory: ADDR.factory, locker: ADDR.locker, treasury: ADDR.treasury, chainId: deployments.chainId },
  });
});

app.get("/api/tokens", async (c) => {
  const sort = c.req.query("sort") ?? "volume";
  const filter = c.req.query("filter") ?? "all";
  // volume window for the "volume" sort and the `volumeUsdc` field: 24h (default) / 7d / all
  const window = c.req.query("window") ?? "24h";
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const where = filter === "graduated" ? sql`where not t.hidden and t.graduated` : filter === "graduating" ? sql`where not t.hidden and not t.graduated` : sql`where not t.hidden`;
  const [{ n: total }] = await sql`select count(*)::int as n from tokens t ${where}`;
  c.header("x-total-count", String(total));
  const windowWhere = window === "all" ? sql`` : window === "7d" ? sql`where ts > now() - interval '7 days'` : sql`where ts > now() - interval '24 hours'`;
  const order =
    sort === "new" ? sql`t.launch_ts desc`
    : sort === "oldest" ? sql`t.launch_ts asc`
    : sort === "mcap" ? sql`t.last_mcap6 desc`
    : sort === "progress" ? sql`(t.paired_usdc::numeric / nullif(t.graduation_threshold,0)) desc nulls last, t.launch_ts desc`
    : sql`w.volume desc nulls last, t.launch_ts desc`;
  const rows = await sql`
    select t.*, coalesce(v.volume_24h,0) as volume_24h, coalesce(v.trades_24h,0) as trades_24h, coalesce(h.holders,0) as holders,
           coalesce(w.volume,0) as volume_window, coalesce(w.trades,0) as trades_window, p.price_24h_ago, sp.spark
    from tokens t
    left join (select token, sum(usdc) as volume_24h, count(*) as trades_24h from trades where ts > now() - interval '24 hours' group by token) v on v.token = t.address
    left join (select token, sum(usdc) as volume, count(*) as trades from trades ${windowWhere} group by token) w on w.token = t.address
    left join (select token, count(*) as holders from holders where balance > 0 group by token) h on h.token = t.address
    left join lateral (select price as price_24h_ago from trades where token = t.address and ts <= now() - interval '24 hours' order by ts desc limit 1) p on true
    left join lateral (
      select array_agg(close order by hb) as spark from (
        select date_trunc('hour', bucket_ts) as hb, (array_agg(close order by bucket_ts desc))[1] as close
        from candles where token = t.address and bucket_ts > now() - interval '24 hours' group by 1
      ) s
    ) sp on true
    ${where}
    order by (t.pinned_at is not null) desc, t.pinned_at desc nulls last, ${order}
    limit ${limit} offset ${offset}`;
  return c.json(rows.map((r) => shapeToken(r, {
    volume24hUsdc: r.volume_24h,
    trades24h: Number(r.trades_24h),
    volumeUsdc: r.volume_window,
    tradesWindow: Number(r.trades_window),
    holders: Number(r.holders),
    change24h: r.price_24h_ago ? ((Number(r.last_price) - Number(r.price_24h_ago)) / Number(r.price_24h_ago)) * 100 : null,
    // card sparkline: hourly closes over the last 24h (USD), oldest first; quiet tokens get a short / empty array
    spark: ((r.spark as number[] | null) ?? []).map(Number),
  })));
});

app.get("/api/tokens/:address", async (c) => {
  const a = addr(c.req.param("address"));
  const [t] = await sql`select t.*, coalesce(v.volume_24h,0) as volume_24h, coalesce(v.trades_24h,0) as trades_24h, coalesce(h.holders,0) as holders, p.price_24h_ago
    from tokens t
    left join (select token, sum(usdc) as volume_24h, count(*) as trades_24h from trades where token = ${a} and ts > now() - interval '24 hours' group by token) v on v.token = t.address
    left join (select token, count(*) as holders from holders where token = ${a} and balance > 0 group by token) h on h.token = t.address
    left join lateral (select price as price_24h_ago from trades where token = t.address and ts <= now() - interval '24 hours' order by ts desc limit 1) p on true
    where t.address = ${a}`;
  if (!t) return c.json({ error: "not found" }, 404);
  // the pool's quote side: USDC, or the stock the pool is quoted in (converted to USD below)
  const quoteAddr = ((t.quote as string) || ADDR.usdc) as Address;
  const [poolQuote, head, [bal]] = await Promise.all([
    client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: "balanceOf", args: [t.pool as Address] }).catch(() => null),
    client.getBlockNumber(),
    // token side of the pool + burned supply, both from the indexed Transfer ledger
    sql`select
      coalesce((select balance from holders where token = ${a} and address = ${t.pool}), 0) as pool_tokens,
      coalesce((select balance from holders where token = ${a} and address = ${DEAD}), 0) as burned`,
  ]);
  const poolQuoteRaw = poolQuote ?? BigInt(t.paired_usdc as string);
  const poolUsdcStr = t.quote ? quoteToUsdc(poolQuoteRaw, Number(t.quote_decimals), quotePrice(t.quote as string)).toString() : poolQuoteRaw.toString();
  const price = Number(t.last_price);
  const poolTokens = Number(bal.pool_tokens) / 1e18;
  const burned = Number(bal.burned) / 1e18;
  return c.json(shapeToken(t, {
    volume24hUsdc: t.volume_24h,
    trades24h: Number(t.trades_24h),
    holders: Number(t.holders),
    change24h: t.price_24h_ago ? ((Number(t.last_price) - Number(t.price_24h_ago)) / Number(t.price_24h_ago)) * 100 : null,
    poolUsdc: poolUsdcStr,
    poolQuote: t.quote ? poolQuoteRaw.toString() : undefined,
    poolTokens: bal.pool_tokens,
    // both sides of the locked position valued at the current price
    liquidityUsd: Number(poolUsdcStr) / 1e6 + poolTokens * price,
    burnedTokens: bal.burned,
    // fdv = price × full supply; mcap shown to users is burn-adjusted (price × circulating)
    fdvUsd: price * SUPPLY_TOKENS,
    circulatingMcapUsd: price * (SUPPLY_TOKENS - burned),
    protectionActive: Number(head) <= Number(t.restrictions_end_block),
    currentBlock: Number(head),
    supply: SUPPLY_TOKENS,
  }));
});

app.get("/api/tokens/:address/candles", async (c) => {
  const a = addr(c.req.param("address"));
  const interval = c.req.query("interval") ?? "1m";
  const secs = INTERVALS[interval] ?? 60;
  const limit = Math.min(Number(c.req.query("limit") ?? 300), 1000);
  // aggregate 1m candles into the requested bucket; open/close via first/last ordering
  const rows = await sql`
    with b as (
      select to_timestamp(floor(extract(epoch from bucket_ts) / ${secs}) * ${secs}) as bts, *
      from candles where token = ${a}
    ),
    agg as (
      select bts,
        (array_agg(open order by bucket_ts asc))[1] as open,
        max(high) as high, min(low) as low,
        (array_agg(close order by bucket_ts desc))[1] as close,
        sum(volume_usdc) as volume, sum(trades) as trades
      from b group by bts
    )
    select * from agg order by bts desc limit ${limit}`;
  return c.json(rows.reverse().map((r) => ({ time: Math.floor(new Date(r.bts).getTime() / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volumeUsdc: r.volume, trades: Number(r.trades) })));
});

app.get("/api/tokens/:address/trades", async (c) => {
  const a = addr(c.req.param("address"));
  const limit = Math.min(Number(c.req.query("limit") ?? 60), 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const [{ n: total }] = await sql`select count(*)::int as n from trades where token = ${a}`;
  c.header("x-total-count", String(total));
  const rows = await sql`select tx_hash, log_index, block_number, ts, side, usdc, tokens, price, mcap6, sender, recipient from trades where token = ${a} order by ts desc, log_index desc limit ${limit} offset ${offset}`;
  return c.json(rows.map((r) => ({ hash: r.tx_hash, time: r.ts, side: r.side, usdc: r.usdc, tokens: r.tokens, price: r.price, mcapUsd: Number(r.mcap6) / 1e6, wallet: r.recipient, block: Number(r.block_number) })));
});

app.get("/api/tokens/:address/holders", async (c) => {
  const a = addr(c.req.param("address"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  const [t] = await sql`select pool, deployer, payout from tokens where address = ${a}`;
  if (!t) return c.json({ error: "not found" }, 404);
  const rows = await sql`select address, balance from holders where token = ${a} and balance > 0 order by balance desc limit ${limit}`;
  const supply = config.SUPPLY;
  return c.json(rows.map((r) => {
    const bal = BigInt(r.balance);
    const label = r.address.toLowerCase() === t.pool.toLowerCase() ? "Pool (locked)"
      : r.address.toLowerCase() === t.deployer.toLowerCase() ? "Creator"
      : r.address.toLowerCase() === ADDR.treasury.toLowerCase() ? "Treasury"
      : r.address.toLowerCase() === DEAD.toLowerCase() ? "Burned"
      : isLocker(r.address) ? "FeeLocker" : undefined;
    return { wallet: r.address, balance: r.balance, pct: Number((bal * 1_000_000n) / supply) / 10_000, label };
  }));
});

app.get("/api/activity", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 40), 200);
  const trades = await sql`select tr.ts, tr.side, tr.usdc, tr.recipient as wallet, tr.tx_hash, t.address as token, t.symbol, t.logo
    from trades tr join tokens t on t.address = tr.token where not t.hidden order by tr.ts desc limit ${limit}`;
  const launches = await sql`select launch_ts as ts, deployer as wallet, launch_tx as tx_hash, address as token, symbol, logo from tokens where not hidden order by launch_ts desc limit ${limit}`;
  const items = [
    ...trades.map((r) => ({ kind: r.side, ts: r.ts, wallet: r.wallet, tx: r.tx_hash, token: r.token, symbol: r.symbol, logo: r.logo, usdc: r.usdc })),
    ...launches.map((r) => ({ kind: "launch", ts: r.ts, wallet: r.wallet, tx: r.tx_hash, token: r.token, symbol: r.symbol, logo: r.logo })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, limit);
  return c.json(items);
});

app.get("/api/creator/:address", async (c) => {
  const a = addr(c.req.param("address"));
  // tokens this wallet is involved in: deployer, fee payout, or one of the tax wallets
  const toks = await sql`select t.*, coalesce(v.volume_24h,0) as volume_24h from tokens t
    left join (select token, sum(usdc) as volume_24h from trades where ts > now() - interval '24 hours' group by token) v on v.token = t.address
    where t.deployer = ${a} or t.payout = ${a} or t.tax_marketing_wallet = ${a} or t.tax_team_wallet = ${a} order by t.launch_ts desc`;
  const payouts = await sql`select f.ts, f.tx_hash, f.quote_creator, f.usdc_from_token, f.creator_paid, f.kind, f.token, t.symbol, t.logo
    from fee_events f join tokens t on t.address = f.token where f.payout = ${a} and f.quote_creator > 0 order by f.ts desc limit 500`;
  // parked payouts can sit on any locker generation → sum them (the UI claims per locker)
  const claimableBy = await client.multicall({ allowFailure: true, contracts: ALL_LOCKERS.map((l) => ({ address: l, abi: lockerAbi, functionName: "claimable" as const, args: [a, ADDR.usdc] })) });
  const claimable = claimableBy.reduce((s, r) => s + ((r.status === "success" ? (r.result as bigint) : 0n)), 0n);
  const [sums] = await sql`select coalesce(sum(quote_creator),0) as earned from fee_events where payout = ${a} and creator_paid`;
  const [pend] = await sql`select coalesce(sum(volume_since_distribute),0) as vol from tokens where payout = ${a}`;
  return c.json({
    address: a,
    tokens: toks.map((r) => shapeToken(r, { volume24hUsdc: r.volume_24h })),
    payouts: payouts.map((p) => ({ time: p.ts, hash: p.tx_hash, usdc: p.quote_creator, usdcFromToken: p.usdc_from_token, paid: p.creator_paid, kind: p.kind, token: p.token, symbol: p.symbol, logo: p.logo })),
    earnedUsdc: sums.earned,
    pendingEstimateUsdc: ((BigInt(pend.vol) * 78n) / 10_000n).toString(), // 1% fee × 78%
    claimableUsdc: claimable.toString(),
    claimableByLocker: ALL_LOCKERS.map((l, i) => ({ locker: l, usdc: (claimableBy[i].status === "success" ? (claimableBy[i].result as bigint) : 0n).toString() })).filter((x) => x.usdc !== "0"),
  });
});

app.get("/api/treasury", async (c) => {
  const [s] = await sql`select coalesce(sum(creation_fee_paid),0) as creation from tokens`;
  const [f] = await sql`select coalesce(sum(quote_protocol),0) as proto from fee_events`;
  const [bal, nextAt, lastAt, pending, totalToEco, totalToBuyback, totalToDev, ecoFund, buybackFund, devFund] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "usdcBalance" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "nextExecuteAt" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "lastExecutedAt" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "pendingRevenue" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "totalToEco" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "totalToBuyback" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "totalToDev" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "ecoFund" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "buybackFund" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "devFund" },
    ],
  });
  const feeRecipient = null; // Arm: launching is free, no creation-fee recipient
  const settlements = await sql`select tx_hash, ts, usdc_to_eco, usdc_to_buyback, usdc_to_dev from settlements order by ts desc limit 500`;
  return c.json({
    address: ADDR.treasury,
    usdcBalance: bal.toString(),
    fromCreationFees: s.creation,
    fromTradeFees: f.proto,
    // immutable split of the protocol share (22% of the 1% pool fee) in parts of 22: 16 reserve / 5 buyback / 1 dev
    // → of the whole 1% fee: 78 creator / 16 reserve / 5 buyback fund / 1 dev
    ecoBps: 7272,
    buybackBps: 2273,
    devBps: 455,
    intervalSec: 7 * 86400,
    lastExecutedAt: Number(lastAt),
    nextExecuteAt: Number(nextAt),
    pendingRevenueUsdc: pending.toString(),
    feeRecipient,
    ecoFund,
    buybackFund,
    devFund,
    totalToEcoUsdc: totalToEco.toString(),
    totalToBuybackUsdc: totalToBuyback.toString(),
    totalToDevUsdc: totalToDev.toString(),
    settlements: settlements.map((b) => ({ hash: b.tx_hash, time: b.ts, usdcToEco: b.usdc_to_eco, usdcToBuyback: b.usdc_to_buyback, usdcToDev: b.usdc_to_dev })),
  });
});

app.get("/api/wallet/:address", async (c) => {
  const a = addr(c.req.param("address"));
  const holdings = await sql`select h.balance, t.* from holders h join tokens t on t.address = h.token where h.address = ${a} and h.balance > 0 order by h.balance desc`;
  const trades = await sql`select tr.ts, tr.side, tr.usdc, tr.tokens, tr.price, tr.tx_hash, t.address as token, t.symbol, t.logo from trades tr join tokens t on t.address = tr.token
    where tr.recipient = ${a} order by tr.ts desc limit 500`;
  const usdc = await client.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] }).catch(() => 0n);
  return c.json({
    address: a,
    usdcBalance: usdc.toString(),
    holdings: holdings.map((h) => ({ balance: h.balance, valueUsd: (Number(h.balance) / 1e18) * Number(h.last_price), token: shapeToken(h) })),
    trades: trades.map((r) => ({ time: r.ts, side: r.side, usdc: r.usdc, tokens: r.tokens, price: r.price, hash: r.tx_hash, token: r.token, symbol: r.symbol, logo: r.logo })),
  });
});

// ---------------------------------------------------------------- logo upload

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";
const MAX_UPLOAD = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------- domains (multi-domain redundancy, boss 9.9)
// The site is reachable on several domains at once so a registrar takedown never takes the product offline. Uploads
// are therefore stored as HOST-RELATIVE paths (/api/uploads/x.png) and the frontend renders them against whatever host
// the user is on; only the immutable on-chain logo string is absolutised (by the browser, at launch time).
const PUBLIC_DOMAINS = (process.env.PUBLIC_DOMAINS ?? "arm.yyheart.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const SERVER_IP = (process.env.SERVER_IP ?? "").trim();
type DomainStatus = { host: string; ok: boolean; ips: string[]; error?: string; checkedAt: string };
let domainCache: { at: number; list: DomainStatus[] } | null = null;

/** DNS-probe every public domain (cached 5 min): "ok" = resolves to this server (or to anything when SERVER_IP is unset). */
async function probeDomains(): Promise<DomainStatus[]> {
  if (domainCache && Date.now() - domainCache.at < 5 * 60_000) return domainCache.list;
  const { Resolver } = await import("node:dns/promises");
  const r = new Resolver();
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  const list = await Promise.all(PUBLIC_DOMAINS.map(async (host): Promise<DomainStatus> => {
    try {
      const ips = await r.resolve4(host);
      const ok = ips.length > 0 && (!SERVER_IP || ips.includes(SERVER_IP));
      return { host, ok, ips, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { host, ok: false, ips: [], error: (e as Error & { code?: string }).code ?? (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }));
  domainCache = { at: Date.now(), list };
  return list;
}

app.get("/api/domains", async (c) => c.json({ primary: PUBLIC_DOMAINS[0] ?? null, domains: await probeDomains() }));

// ---- Uniswap Token Lists (https://github.com/Uniswap/token-lists) — served at https://<domain>/tokenlist.json via nginx.
// Every visible token with an http(s) logo; users import the URL once in Uniswap / Rabby / OKX and all Arm tokens show
// with name + logo instead of "unknown token". Schema limits: name ≤ 40 chars from a restricted charset, symbol ≤ 20.
const LIST_NAME_RE = /[^ \w.'+\-%/À-ÖØ-öø-ÿ:&[\]()]/g;
let tokenListCache: { at: number; body: string } | null = null;
app.get("/api/tokenlist.json", async (c) => {
  if (!tokenListCache || Date.now() - tokenListCache.at > 60_000) {
    const base = process.env.PUBLIC_BASE_URL || `https://${PUBLIC_DOMAINS[0]}`;
    const rows = await sql<{ address: string; name: string; symbol: string; logo: string; launch_ts: Date }[]>`
      select address, name, symbol, logo, launch_ts from tokens where not hidden order by launch_ts asc`;
    const tokens = rows.flatMap((r) => {
      const name = (r.name.replace(LIST_NAME_RE, "").trim() || r.symbol).slice(0, 40);
      const symbol = r.symbol.replace(/[^a-zA-Z0-9+\-%/$.]/g, "").slice(0, 20);
      if (!name || !symbol) return [];
      const logo = r.logo.startsWith("/") ? base + r.logo : r.logo;
      // no `extensions`: the schema caps extension strings at 42 chars, too short for any of our URLs
      return [{
        chainId: deployments.chainId, address: r.address, name, symbol, decimals: 18,
        ...(/^https?:\/\//.test(logo) && !logo.endsWith(".svg") ? { logoURI: logo } : {}),
      }];
    });
    const ts = rows.length ? rows[rows.length - 1].launch_ts : new Date();
    const body = JSON.stringify({
      name: "Arm",
      timestamp: new Date(ts).toISOString(),
      // token lists are versioned; adding tokens = minor bump, so minor tracks the count
      version: { major: 1, minor: tokens.length, patch: 0 },
      keywords: ["arm", "arc", "meme", "launchpad"],
      logoURI: `${base}/brand/mark.png`,
      tokens,
    }, null, 1);
    tokenListCache = { at: Date.now(), body };
  }
  return c.body(tokenListCache.body, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" });
});

function sniffImage(buf: Uint8Array): string | null {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
}

app.post("/api/upload", async (c) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "max 1 MB" }, 413);
  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = sniffImage(buf);
  if (!ext) return c.json({ error: "png/jpg/gif/webp only" }, 415);
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(`${UPLOAD_DIR}/${name}`, buf);
  // host-relative on purpose (see "domains" above)
  return c.json({ url: `/api/uploads/${name}`, name, size: buf.length });
});

app.get("/api/uploads/:name", async (c) => {
  const { readFile } = await import("node:fs/promises");
  const name = c.req.param("name");
  // svg is only ever written by the hotspot monogram generator, never accepted from users
  if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp|svg)$/.test(name)) return c.json({ error: "not found" }, 404);
  try {
    const data = await readFile(`${UPLOAD_DIR}/${name}`);
    const type = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[name.split(".")[1]]!;
    return new Response(data, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

// ---------------------------------------------------------------- comments (off-chain, wallet-signed)

export const commentMessage = (token: string, text: string, ts: number, replyTo?: number | null) =>
  `Arm comment\ntoken: ${token.toLowerCase()}\nreplyTo: ${replyTo ?? "-"}\nts: ${ts}\n\n${text}`;
export const likeMessage = (commentId: number, ts: number) => `Arm like\ncomment: ${commentId}\nts: ${ts}`;

async function verifySig(author: string, message: string, signature: string) {
  const { verifyMessage } = await import("viem");
  return verifyMessage({ address: getAddress(author), message, signature: signature as `0x${string}` });
}

app.get("/api/tokens/:address/comments", async (c) => {
  const a = addr(c.req.param("address"));
  const viewer = c.req.query("viewer");
  const [t] = await sql`select deployer, payout from tokens where address = ${a}`;
  if (!t) return c.json({ error: "not found" }, 404);
  const rows = await sql`
    select cm.id, cm.author, cm.text, cm.reply_to, cm.ts,
           (select count(*) from comment_likes l where l.comment_id = cm.id) as likes,
           ${viewer && isAddress(viewer) ? sql`exists(select 1 from comment_likes l where l.comment_id = cm.id and l.author = ${getAddress(viewer)})` : sql`false`} as liked
    from comments cm where cm.token = ${a} order by cm.ts asc limit 500`;
  return c.json(rows.map((r) => ({
    id: Number(r.id), author: r.author, text: r.text, replyTo: r.reply_to ? Number(r.reply_to) : null, time: r.ts,
    likes: Number(r.likes), liked: !!r.liked,
    isCreator: r.author.toLowerCase() === t.deployer.toLowerCase() || r.author.toLowerCase() === t.payout.toLowerCase(),
  })));
});

app.post("/api/tokens/:address/comments", async (c) => {
  const a = addr(c.req.param("address"));
  const body = await c.req.json<{ author: string; text: string; replyTo?: number | null; ts: number; signature: string }>();
  const text = (body.text ?? "").trim();
  if (!text || text.length > 280) return c.json({ error: "text 1–280 chars" }, 400);
  if (!isAddress(body.author)) return c.json({ error: "bad author" }, 400);
  if (Math.abs(Date.now() - body.ts) > 5 * 60_000) return c.json({ error: "stale timestamp" }, 400);
  const [t] = await sql`select 1 from tokens where address = ${a}`;
  if (!t) return c.json({ error: "not found" }, 404);
  if (body.replyTo) {
    const [p] = await sql`select 1 from comments where id = ${body.replyTo} and token = ${a}`;
    if (!p) return c.json({ error: "bad replyTo" }, 400);
  }
  const ok = await verifySig(body.author, commentMessage(a, text, body.ts, body.replyTo ?? null), body.signature).catch(() => false);
  if (!ok) return c.json({ error: "bad signature" }, 401);
  const author = getAddress(body.author);
  const [recent] = await sql`select ts from comments where author = ${author} order by ts desc limit 1`;
  if (recent && Date.now() - new Date(recent.ts).getTime() < 10_000) return c.json({ error: "slow down" }, 429);
  const [row] = await sql`insert into comments (token, author, text, reply_to, signature) values (${a}, ${author}, ${text}, ${body.replyTo ?? null}, ${body.signature}) returning id, ts`;
  return c.json({ id: Number(row.id), time: row.ts });
});

app.post("/api/comments/:id/like", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ author: string; ts: number; signature: string }>();
  if (!isAddress(body.author) || !Number.isFinite(id)) return c.json({ error: "bad request" }, 400);
  if (Math.abs(Date.now() - body.ts) > 5 * 60_000) return c.json({ error: "stale timestamp" }, 400);
  const ok = await verifySig(body.author, likeMessage(id, body.ts), body.signature).catch(() => false);
  if (!ok) return c.json({ error: "bad signature" }, 401);
  const author = getAddress(body.author);
  const [existing] = await sql`select 1 from comment_likes where comment_id = ${id} and author = ${author}`;
  if (existing) await sql`delete from comment_likes where comment_id = ${id} and author = ${author}`;
  else await sql`insert into comment_likes (comment_id, author) values (${id}, ${author})`;
  const [{ n }] = await sql`select count(*) as n from comment_likes where comment_id = ${id}`;
  return c.json({ liked: !existing, likes: Number(n) });
});

// ---------------------------------------------------------------- AI Meme Radar (v2)
// Public: the published hotspot pool (X + Weibo), newest-and-hottest first, no scores. A user picks one → the
// frontend asks /prepare (one AI copy generation per hotspot, cached), edits name / symbol / description, reserves a
// claim (quota by wallet + IP) and sends the normal factory.launch() from their wallet — the server never holds keys.

const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  (c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "").trim();

function shapeHotspot(h: HotspotRow, launches: { n: number; tokens: unknown[] }) {
  const ideas = h.ideas ?? null;
  return {
    id: Number(h.id), platform: h.platform, sourceType: h.source_type, account: h.account ?? null,
    title: h.title, lang: h.lang ?? "en", url: h.url, regions: h.regions ?? [], signals: h.signals, related: h.related, rising: h.rising, keyAccount: h.key_account,
    metrics: h.metrics, context: h.context ?? [], category: h.category ?? null, status: h.status,
    firstSeen: h.first_seen, lastSeen: h.last_seen,
    // token copy: null until /prepare (or the daily pre-generation) ran for this hotspot
    prepared: !!ideas, generatedAt: h.generated_at,
    titleZh: ideas?.titleZh ?? (h.lang === "zh" ? h.title : null), titleEn: ideas?.titleEn ?? (h.lang !== "zh" ? h.title : null),
    name: ideas?.name ?? null, symbol: ideas?.symbol ?? null, description: ideas?.description ?? null, logo: h.logo,
    nameZh: ideas?.nameZh ?? null, descriptionZh: ideas?.descriptionZh ?? null,
    launches: launches.n, tokens: launches.tokens,
  };
}

async function launchesFor(ids: number[]) {
  if (ids.length === 0) return new Map<number, { n: number; tokens: unknown[] }>();
  const rows = await sql`select c.hotspot_id, c.address, c.mode, c.ts, t.address as token, t.symbol, t.logo, t.name, t.launch_ts
    from hotspot_claims c join tokens t on t.address = c.token where c.hotspot_id in ${sql(ids)} order by c.ts desc`;
  const m = new Map<number, { n: number; tokens: unknown[] }>();
  for (const r of rows) {
    const e = m.get(Number(r.hotspot_id)) ?? { n: 0, tokens: [] };
    e.n++;
    if (e.tokens.length < 3) e.tokens.push({ address: r.token, symbol: r.symbol, name: r.name, logo: r.logo, deployer: r.address, mode: r.mode, time: r.launch_ts });
    m.set(Number(r.hotspot_id), e);
  }
  return m;
}

const PLATFORMS = ["x", "weibo"] as const;
const platformFilter = (p: string | undefined) => (p && (PLATFORMS as readonly string[]).includes(p) ? sql`and platform = ${p}` : sql``);

/** First page of each plain tab is cached 60 s (spec §9) — the list only changes once per 10-minute tick anyway. */
const listCache = new Map<string, { at: number; body: unknown }>();

app.get("/api/hotspots", async (c) => {
  const s = await getSettings();
  const platform = c.req.query("platform") ?? c.req.query("source") ?? "all";
  const account = (c.req.query("account") ?? "").replace(/^@/, "").toLowerCase();
  const tags = (c.req.query("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const offset = Math.max(0, Math.min(5000, Number(c.req.query("offset") ?? 0) || 0));
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 30) || 30));
  const plain = !account && tags.length === 0 && offset === 0 && limit === 30;
  const cacheKey = `${platform}`;
  if (plain) {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 60_000) return c.json(hit.body);
  }
  // `shown` = inside the per-platform pool cap (X 30 / Weibo 50); an explicit account filter shows the whole account
  const where = sql`where status = 'published' ${platformFilter(platform)}
    ${account ? sql`and account = ${account}` : sql`and shown`}
    ${tags.length ? sql`and category in ${sql(tags)}` : sql``}`;
  const [rows, [tot], [counts], [today], [{ v: lastTick }]] = await Promise.all([
    sql<HotspotRow[]>`select * from hotspots ${where} ${PUBLIC_ORDER} limit ${limit} offset ${offset}`,
    sql`select count(*)::int as n from hotspots ${where}`,
    sql`select count(*)::int as all_n, count(*) filter (where platform = 'x')::int as x, count(*) filter (where platform = 'weibo')::int as weibo from hotspots where status = 'published' and shown`,
    sql`select count(*)::int as n from hotspot_signals where first_seen >= date_trunc('day', now() at time zone 'utc')`,
    sql`select updated_at as v from settings where key = 'x_state'`.then((r) => (r.length ? r : [{ v: null }])),
  ]);
  const l = await launchesFor(rows.map((r) => Number(r.id)));
  const ai = aiStatus();
  const body = {
    enabled: s.enabled,
    sources: { x: s.sources.x && ai.x, weibo: s.sources.weibo },
    accounts: s.xAccounts,
    // the original celebrities + the boss's named accounts — the filter drawer lists them first
    pinnedAccounts: PINNED_X_ACCOUNTS.filter((a) => s.xAccounts.includes(a)),
    counts: { all: Number(counts.all_n), x: Number(counts.x), weibo: Number(counts.weibo) },
    signalsToday: Number(today.n),
    updatedAt: radarState.lastTick ?? (lastTick ? new Date(lastTick as string).toISOString() : null),
    total: Number(tot.n),
    nextOffset: offset + rows.length < Number(tot.n) ? offset + rows.length : null,
    windowHours: s.publicWindowHours,
    quota: { perAddress: s.quotaPerAddress, perIp: s.quotaPerIp },
    tax: s.tax,
    items: rows.map((h) => shapeHotspot(h, l.get(Number(h.id)) ?? { n: 0, tokens: [] })),
  };
  if (plain) listCache.set(cacheKey, { at: Date.now(), body });
  return c.json(body);
});

/** "12 new signals" banner: how many published hotspots appeared after `after` (ISO) in this tab. */
app.get("/api/hotspots/new", async (c) => {
  const after = new Date(c.req.query("after") ?? "");
  if (Number.isNaN(after.getTime())) return c.json({ error: "after required" }, 400);
  const platform = c.req.query("platform") ?? "all";
  const [{ n }] = await sql`select count(*)::int as n from hotspots where status = 'published' and shown and first_seen > ${after} ${platformFilter(platform)}`;
  return c.json({ count: Number(n) });
});

app.get("/api/hotspots/quota", async (c) => {
  const a = c.req.query("address");
  if (!a || !isAddress(a)) return c.json({ error: "address required" }, 400);
  return c.json(await quotaLeft(getAddress(a), clientIp(c)));
});

/** Public pipeline stats (spec §11 acceptance numbers), no auth: nothing here is secret. */
app.get("/api/hotspots/stats", async (c) => {
  const s = await getSettings();
  const [pool] = await sql`select
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'published' and platform = 'x')::int as published_x,
      count(*) filter (where status = 'published' and platform = 'weibo')::int as published_weibo,
      count(*) filter (where status = 'published' and last_seen > now() - interval '24 hours')::int as fresh,
      count(*) filter (where status = 'blocked' and last_seen > now() - interval '24 hours')::int as blocked_24h,
      count(*) filter (where status = 'pending')::int as pending
    from hotspots`;
  const [sig] = await sql`select count(*)::int as day, count(*) filter (where platform = 'x')::int as day_x from hotspot_signals where first_seen > now() - interval '24 hours'`;
  const daily = await sql`select * from hotspot_daily where day > current_date - 7 order by day desc`;
  return c.json({ pool, signals24h: { all: Number(sig.day), x: Number(sig.day_x) }, x: radarState.x, last: radarState.last, lastTick: radarState.lastTick, daily, settings: { intervalMs: s.intervalMs, xRegionsPerTick: s.xRegionsPerTick, publicWindowHours: s.publicWindowHours } });
});

const visible = (h: HotspotRow | undefined) => !!h && (h.status === "published" || h.status === "expired");

app.get("/api/hotspots/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const [h] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
  if (!visible(h)) return c.json({ error: "not found" }, 404);
  const s = await getSettings();
  const l = await launchesFor([id]);
  const related = await sql`select title, region, source_type, url, last_seen from hotspot_signals where hotspot_id = ${id} and norm_key <> ${h.norm_key} order by last_seen desc limit 12`;
  return c.json({ ...shapeHotspot(h, l.get(id) ?? { n: 0, tokens: [] }), tax: s.tax, relatedSignals: related.map((r) => ({ title: r.title, region: r.region, sourceType: r.source_type, url: r.url, lastSeen: r.last_seen })) });
});

/**
 * AI on click (spec §8): the first visitor who opens Launch on a hotspot triggers ONE copy generation; everyone
 * after that gets the cached copy. Rate-limited per IP and by the daily AI cap; the template fallback still answers
 * when the cap is hit, so the launch never blocks.
 */
const prepareHits = new Map<string, number[]>();
app.post("/api/hotspots/:id/prepare", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const [h] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
  if (!visible(h)) return c.json({ error: "not found" }, 404);
  const s = await getSettings();
  if (!h.ideas) {
    const ip = clientIp(c) || "?";
    const now = Date.now();
    const hits = (prepareHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= s.aiPerIpHour) return c.json({ error: `too many AI requests from this network (${s.aiPerIpHour}/hour)` }, 429);
    hits.push(now);
    prepareHits.set(ip, hits);
    const capped = (await aiCallsToday()) >= s.aiDailyCap;
    if (capped) {
      // budget used up: deterministic template copy, still editable by the launcher
      const ideas = templateIdeas({ title: h.title, source: h.platform, context: h.context ?? [], lang: h.lang, account: h.account ?? undefined });
      await sql`update hotspots set ideas = ${sql.json(ideas as never)}, generated_at = now() where id = ${id}`;
    } else await generateOne(h);
  }
  const [fresh] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
  const l = await launchesFor([id]);
  return c.json({ ...shapeHotspot(fresh, l.get(id) ?? { n: 0, tokens: [] }), tax: s.tax });
});

/** Logo on demand (spec §8): rendered when the launcher asks for it on the launch page, or they upload their own. */
app.post("/api/hotspots/:id/logo", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const [h] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
  if (!visible(h)) return c.json({ error: "not found" }, 404);
  if (hasAiLogo(h)) return c.json({ logo: h.logo, by: h.ideas?.logoBy ?? null, cached: true });
  const ip = clientIp(c) || "?";
  const now = Date.now();
  const hits = (prepareHits.get(`logo:${ip}`) ?? []).filter((t) => now - t < 3_600_000);
  const s = await getSettings();
  if (hits.length >= s.aiPerIpHour) return c.json({ error: `too many AI requests from this network (${s.aiPerIpHour}/hour)` }, 429);
  hits.push(now);
  prepareHits.set(`logo:${ip}`, hits);
  const row = await generateOne(h, { withLogo: true });
  if (!row?.logo) return c.json({ error: "logo generation failed" }, 502);
  return c.json({ logo: row.logo, by: row.ideas?.logoBy ?? null, cached: false });
});

/**
 * Reserve a launch slot and hand back the exact launch params. The wallet then signs factory.launch() itself.
 * name / symbol / description / logo are all editable by the launcher (spec §8); anything not sent falls back to
 * the AI copy. No logo at all → deterministic monogram, so the launch never waits on an image model.
 */
const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,7}$/;
app.post("/api/hotspots/:id/claim", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ address: string; mode: "standard" | "tax"; buyTaxBps?: number; sellTaxBps?: number; lang?: "en" | "zh"; name?: string; symbol?: string; description?: string; logo?: string }>().catch(() => null);
  if (!Number.isFinite(id) || !body || !isAddress(body.address) || !["standard", "tax"].includes(body.mode)) return c.json({ error: "bad request" }, 400);
  const lang: "en" | "zh" = body.lang === "zh" ? "zh" : "en";
  const clean = (v: unknown, max: number) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const nameOverride = clean(body.name, 32);
  const symbolOverride = String(body.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const descOverride = clean(body.description, 400);
  const logoRaw = String(body.logo ?? "").trim();
  // our host-relative upload path, any http(s) image, or the create-page "emoji:🚀" form
  const logoOverride = /^\/api\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp|svg)$/.test(logoRaw) || /^https?:\/\/\S{1,300}$/.test(logoRaw) || /^emoji:.{1,8}$/.test(logoRaw) ? logoRaw : "";
  // the user may drag the tax sliders; clamp to the factory's hard cap (maxTaxBps is a contract constant)
  const maxTax = Number(await client.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: "maxTaxBps" }).catch(() => 1000));
  const bps = (v: unknown, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(maxTax, Math.max(0, n)) : d; };
  const s = await getSettings();
  if (!s.enabled) return c.json({ error: "hotspot launches are paused" }, 503);
  let [h] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
  if (!visible(h)) return c.json({ error: "not found" }, 404);
  if (!h.ideas) h = (await generateOne(h)) ?? h;
  const ideas = h.ideas ?? templateIdeas({ title: h.title, source: h.platform, context: h.context ?? [], lang: h.lang, account: h.account ?? undefined });
  const address = getAddress(body.address);
  const ip = clientIp(c);
  const q = await quotaLeft(address, ip, s);
  if (q.address <= 0) return c.json({ error: `daily limit reached for this wallet (${q.perAddress}/24h)` }, 429);
  if (ip && q.ip <= 0) return c.json({ error: `daily limit reached for this network (${q.perIp}/24h)` }, 429);
  const tax = body.mode === "tax"
    ? { buyTaxBps: bps(body.buyTaxBps, s.tax.buyTaxBps), sellTaxBps: bps(body.sellTaxBps, s.tax.sellTaxBps), marketingBps: s.tax.marketingBps }
    : { buyTaxBps: 0, sellTaxBps: 0, marketingBps: 0 };
  // on-chain copy in the language the launcher picked; falls back to English when no Chinese version exists
  const useZh = lang === "zh" && !!ideas.nameZh;
  const name = nameOverride || (useZh ? ideas.nameZh! : ideas.name);
  const symbol = SYMBOL_RE.test(symbolOverride) ? symbolOverride : ideas.symbol;
  const description = descOverride || (useZh ? (ideas.descriptionZh ?? ideas.description) : ideas.description);
  let logo = logoOverride || h.logo || "";
  if (!logo) {
    // no picture yet and none uploaded: instant monogram (the AI image is optional, see /logo)
    logo = await monogramLogo(symbol, `hot:${id}`);
    await sql`update hotspots set logo = coalesce(logo, ${logo}) where id = ${id}`;
  }
  const [row] = await sql`insert into hotspot_claims (hotspot_id, address, ip, mode, symbol, lang, name, logo)
    values (${id}, ${address}, ${ip}, ${body.mode}, ${symbol}, ${lang}, ${name}, ${logo}) returning id`;
  return c.json({
    claimId: Number(row.id),
    params: {
      name, symbol, logo, description,
      lang: useZh ? "zh" : "en",
      socials: { website: h.url ?? "", twitter: h.platform === "x" ? (h.url ?? "") : "", telegram: "", discord: "", farcaster: "" },
      mode: body.mode, ...tax,
    },
    quota: { address: q.address - 1, ip: ip ? q.ip - 1 : q.ip },
  });
});

/** The frontend reports the tx right after it confirms (the indexer also back-fills from TokenLaunched). */
app.post("/api/hotspots/claims/:claimId", async (c) => {
  const id = Number(c.req.param("claimId"));
  const body = await c.req.json<{ address: string; token: string; txHash: string }>().catch(() => null);
  if (!Number.isFinite(id) || !body || !isAddress(body.address) || !isAddress(body.token) || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) return c.json({ error: "bad request" }, 400);
  await sql`update hotspot_claims set token = ${getAddress(body.token)}, tx_hash = ${body.txHash} where id = ${id} and lower(address) = ${body.address.toLowerCase()} and token is null`;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- AI draft for the manual create page
// The creator types a name; we return symbol / description / hosted logo. Same AI module as hotspots, with the name
// kept verbatim. Cached per name for 24 h (identical names share one generation) and rate-limited per IP + per day.
// Gate (boss, 9.8): a connected wallet holding at least the creation fee in USDC, and N fresh generations per wallet
// per rolling 24 h (default 1, /admin-adjustable). Cache hits (same name generated recently) are free and uncounted.
app.get("/api/ai/token-draft/quota", async (c) => {
  const a = c.req.query("address");
  if (!a || !isAddress(a)) return c.json({ error: "address required" }, 400);
  const s = await getSettings();
  const [{ n }] = await sql`select count(*)::int as n from ai_drafts where lower(address) = ${a.toLowerCase()} and ts > now() - interval '24 hours'`;
  return c.json({ left: Math.max(0, s.aiDraftPerAddressDay - Number(n)), perDay: s.aiDraftPerAddressDay });
});

app.post("/api/ai/token-draft", async (c) => {
  const body = await c.req.json<{ name: string; address?: string; fresh?: boolean }>().catch(() => null);
  const name = String(body?.name ?? "").replace(/[$#<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  if (name.length < 2) return c.json({ error: "name too short" }, 400);
  if (!body?.address || !isAddress(body.address)) return c.json({ error: "connect a wallet to use the AI assistant" }, 401);
  const address = getAddress(body.address);
  const s = await getSettings();
  const key = name.toLowerCase();
  const ip = clientIp(c);
  if (!body.fresh) {
    const [hit] = await sql`select * from ai_drafts where name_key = ${key} and ts > now() - interval '24 hours' order by ts desc limit 1`;
    if (hit) return c.json({ name, symbol: hit.symbol, description: hit.description, logo: hit.logo, by: { copy: hit.by_copy, logo: hit.by_logo }, cached: true });
  }
  // wallet must hold ≥ the creation fee (1 USDC) — cheap proof that this is a launcher, not a scraper
  const [bal, fee] = await Promise.all([
    client.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => 0n),
    client.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: "creationFee" }).catch(() => 1_000_000n),
  ]);
  if (bal < fee) return c.json({ error: `wallet needs at least ${Number(fee) / 1e6} USDC to use the AI assistant` }, 402);
  const [{ n: perAddr }] = await sql`select count(*)::int as n from ai_drafts where lower(address) = ${address.toLowerCase()} and ts > now() - interval '24 hours'`;
  if (Number(perAddr) >= s.aiDraftPerAddressDay) return c.json({ error: `daily AI limit reached for this wallet (${s.aiDraftPerAddressDay}/24h)` }, 429);
  const [{ n: perIp }] = ip ? await sql`select count(*)::int as n from ai_drafts where ip = ${ip} and ts > now() - interval '1 hour'` : [{ n: 0 }];
  if (ip && Number(perIp) >= s.aiDraftPerIpHour) return c.json({ error: `too many AI drafts from this network (${s.aiDraftPerIpHour}/hour)` }, 429);
  const [{ n: today }] = await sql`select count(*)::int as n from ai_drafts where ts >= date_trunc('day', now() at time zone 'utc')`;
  if (Number(today) >= s.aiDraftDailyCap) return c.json({ error: "AI draft budget for today is used up — fill the fields manually" }, 429);
  const ideas = await generateIdeas({ title: name, source: "user", context: [] });
  const logo = await generateLogo(ideas, `draft:${key}:${Date.now()}`);
  await sql`insert into ai_drafts (name_key, name, symbol, description, logo, by_copy, by_logo, ip, address)
            values (${key}, ${name}, ${ideas.symbol}, ${ideas.description}, ${logo.url}, ${ideas.by}, ${logo.by}, ${ip}, ${address})`;
  return c.json({ name, symbol: ideas.symbol, description: ideas.description, logo: logo.url, by: { copy: ideas.by, logo: logo.by }, cached: false, left: Math.max(0, s.aiDraftPerAddressDay - Number(perAddr) - 1) });
});

// Owner-only administration: settings + per-hotspot moderation, authenticated by an EIP-191 signature from the
// on-chain factory owner (same pattern as the rest of the app: the server holds no secret).
export const hotspotAdminMessage = (action: string, ts: number, payload: string) => `Arm hotspots admin\naction: ${action}\nts: ${ts}\n\n${payload}`;

async function requireOwner(c: { req: { json: <T>() => Promise<T> } }, action: string) {
  const body = await c.req.json<{ author: string; ts: number; signature: string; payload: unknown }>().catch(() => null);
  if (!body || !isAddress(body.author) || Math.abs(Date.now() - body.ts) > 5 * 60_000) return { error: "bad request", status: 400 as const };
  const owner = await client.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: "owner" });
  if (owner.toLowerCase() !== body.author.toLowerCase()) return { error: "not owner", status: 403 as const };
  const payload = JSON.stringify(body.payload ?? {});
  const ok = await verifySig(body.author, hotspotAdminMessage(action, body.ts, payload), body.signature).catch(() => false);
  if (!ok) return { error: "bad signature", status: 401 as const };
  return { payload: body.payload as Record<string, unknown>, author: body.author };
}

app.get("/api/admin/hotspots", async (c) => {
  const s = await getSettings();
  // published first, then pending / blocked (with reason) so the owner can audit what the filters threw out
  const rows = await sql<HotspotRow[]>`select * from hotspots where last_seen > now() - interval '48 hours' and status <> 'merged'
    order by (status = 'published') desc, (status = 'blocked') asc, last_seen desc limit 400`;
  const l = await launchesFor(rows.map((r) => Number(r.id)));
  const [claims] = await sql`select count(*)::int as total, count(*) filter (where ts > now() - interval '24 hours')::int as day, count(token)::int as launched from hotspot_claims`;
  const [gate] = await sql`select count(*) filter (where status = 'blocked')::int as blocked, count(*) filter (where status = 'published')::int as published, count(*) filter (where status = 'pending')::int as pending
    from hotspots where last_seen > now() - interval '24 hours'`;
  const reasons = await sql`select blocked_reason as reason, count(*)::int as n from hotspots where status = 'blocked' and last_seen > now() - interval '24 hours' group by blocked_reason order by n desc`;
  const daily = await sql`select * from hotspot_daily where day > current_date - 7 order by day desc`;
  return c.json({
    settings: s,
    ai: aiStatus(),
    state: radarState,
    aiToday: await aiCallsToday(),
    claims,
    gate,
    reasons: reasons.map((r) => ({ reason: r.reason, n: Number(r.n) })),
    daily,
    items: rows.map((h) => ({ ...shapeHotspot(h, l.get(Number(h.id)) ?? { n: 0, tokens: [] }), blockedReason: h.blocked_reason, verdict: h.verdict, ideasBy: h.ideas?.by ?? null, logoBy: h.ideas?.logoBy ?? null })),
  });
});

app.post("/api/admin/hotspots/settings", async (c) => {
  const r = await requireOwner(c, "settings");
  if ("error" in r) return c.json({ error: r.error }, r.status);
  listCache.clear();
  return c.json(await saveSettings(r.payload as never));
});

app.post("/api/admin/hotspots/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const r = await requireOwner(c, `hotspot:${id}`);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const action = String(r.payload?.action ?? "");
  if (action === "hide") await sql`update hotspots set status = 'hidden', blocked_reason = 'owner' where id = ${id}`;
  // "show" overrides both filter layers and pins the verdict so the next tick does not re-block it
  else if (action === "show") await sql`update hotspots set status = 'published', blocked_reason = null, verdict = 'SAFE' where id = ${id}`;
  else if (action === "regenerate") {
    const [h] = await sql<HotspotRow[]>`select * from hotspots where id = ${id}`;
    if (!h) return c.json({ error: "not found" }, 404);
    await generateOne(h, { force: true });
  } else return c.json({ error: "unknown action" }, 400);
  listCache.clear();
  return c.json({ ok: true });
});

app.post("/api/admin/hotspots/refresh", async (c) => {
  const r = await requireOwner(c, "refresh");
  if ("error" in r) return c.json({ error: r.error }, r.status);
  await refreshHotspots();
  listCache.clear();
  return c.json({ ok: true, state: radarState });
});

// ------------------------------------------------------------------ manual burns (v2.10)
// The buyback multisig buys back and burns by hand; the owner pastes the tx hash here. We only accept a hash whose
// receipt succeeded on this chain, then read the burn out of its Transfer logs (→ 0x…dEaD) for the record.

const shapeBurn = (b: Record<string, unknown>) => ({
  id: Number(b.id), hash: b.tx_hash, block: Number(b.block_number), time: b.ts, sender: b.sender, token: b.token, symbol: b.token_symbol,
  tokensBurned: String(b.tokens_burned), usdcSpent: String(b.usdc_spent), note: b.note, addedBy: b.added_by, addedAt: b.added_at,
});

// Owner moderation: hide / show and pin / unpin a token on the public site (lists, ticker, stats). Hidden tokens stay
// tradable via their own page and in the holder's "Me" / creator views — display flags only, nothing on-chain changes.
app.post("/api/admin/tokens/:address", async (c) => {
  const a = addr(c.req.param("address"));
  const r = await requireOwner(c, `token:${a.toLowerCase()}`);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const p = r.payload;
  const set = [
    ...("hidden" in p ? [sql`hidden = ${Boolean(p.hidden)}`] : []),
    ...("pinned" in p ? [sql`pinned_at = ${p.pinned ? sql`now()` : null}`] : []),
  ];
  if (set.length === 0) return c.json({ error: "nothing to change" }, 400);
  const rows = await sql`update tokens set ${set.reduce((acc, s) => sql`${acc}, ${s}`)} where address = ${a} returning hidden, pinned_at`;
  if (rows.length === 0) return c.json({ error: "unknown token" }, 404);
  return c.json({ ok: true, address: a, hidden: rows[0].hidden, pinned: rows[0].pinned_at != null });
});

// Telegram buy bot: status + group subscriptions (read-only) and an owner-signed test post to the official channel.
app.get("/api/admin/telegram", async (c) => c.json({ ...tgStatus(), subscriptions: await tgSubscriptions() }));

app.post("/api/admin/telegram/test", async (c) => {
  const r = await requireOwner(c, "telegram:test");
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const res = await tgTestChannel();
  return c.json(res, res.ok ? 200 : 502);
});

// Automatic buyback & burn (9.18): status for the /admin burns tab + owner-signed "run now". Settings are saved
// through the shared owner-signed settings endpoint (bb* keys).
app.get("/api/admin/buyback", async (c) => c.json(await buybackStatus()));

app.post("/api/admin/buyback/run", async (c) => {
  const r = await requireOwner(c, "buyback:run");
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const res = await runBuyback(true);
  return c.json(res, res.ok ? 200 : 400);
});

/**
 * Public "next burn" card (boss 9.23): countdown to the next scheduled burn of the project's token, the planned
 * quantity and what it is worth right now, plus the recorded history. Everything the card needs in one call; the two
 * placement switches (home page / the burned token's own page) are included so the frontend renders only where the
 * owner allows. Admin edits the burn* settings through the shared owner-signed settings endpoint.
 */
app.get("/api/burn", async (c) => {
  const s = await getSettings();
  const [last] = await sql`select * from manual_burns where token is not null order by ts desc limit 1`;
  const tokenAddr = s.burnToken || (last?.token as string | undefined) || null;
  if (!tokenAddr) {
    return c.json({ showHome: s.burnCardHome, showToken: s.burnCardToken, token: null, intervalDays: s.burnIntervalDays, nextAt: null, amount: "0", amountUsd: 0, totalBurned: "0", totalBurnedUsd: 0, platformBurned: "0", platformBurnedUsd: 0, otherBurned: "0", otherBurnedUsd: 0, burns: 0, lastBurn: null, history: [], config: burnConfig(s) });
  }
  const [tok] = await sql`select address, symbol, name, logo, last_price from tokens where lower(address) = ${tokenAddr.toLowerCase()}`;
  const [lastOfToken] = await sql`select * from manual_burns where lower(token) = ${tokenAddr.toLowerCase()} order by ts desc limit 1`;
  const history = await sql`select * from manual_burns where lower(token) = ${tokenAddr.toLowerCase()} order by ts desc limit 20`;
  const [tot] = await sql`select coalesce(sum(tokens_burned),0) as burned, count(*)::int as n from manual_burns where lower(token) = ${tokenAddr.toLowerCase()}`;
  // everything anyone ever sent to the dead address, from the indexed Transfer ledger (boss 9.23 16:00: holders burn
  // too, so the card shows the on-chain total split into "platform" = recorded in /admin and "others" = the rest)
  const [chain] = tok ? await sql`select coalesce((select balance from holders where token = ${tok.address} and address = ${DEAD}), 0) as burned` : [{ burned: "0" }];
  const price = tok ? Number(tok.last_price) : 0;
  const intervalMs = s.burnIntervalDays * 86_400_000;
  // anchor: the owner's date, else last burn + interval, else now + interval; roll forward past "now"
  let next = s.burnNextAt ? new Date(s.burnNextAt).getTime() : lastOfToken ? new Date(lastOfToken.ts as string).getTime() + intervalMs : Date.now() + intervalMs;
  while (next <= Date.now()) next += intervalMs;
  const amountRaw = s.burnAmount > 0 ? BigInt(Math.round(s.burnAmount * 1e6)) * 10n ** 12n : BigInt(String(lastOfToken?.tokens_burned ?? "0"));
  const platformRaw = BigInt(String(tot.burned));
  const chainRaw = BigInt(String(chain.burned));
  // total = on-chain dead balance (never less than what /admin recorded, in case the ledger lags a fresh burn)
  const totalRaw = chainRaw > platformRaw ? chainRaw : platformRaw;
  const otherRaw = totalRaw - platformRaw;
  const usd = (raw: bigint) => (Number(raw) / 1e18) * price;
  return c.json({
    showHome: s.burnCardHome,
    showToken: s.burnCardToken,
    token: tok ? { address: tok.address, symbol: tok.symbol, name: tok.name, logo: tok.logo, price } : { address: tokenAddr, symbol: (lastOfToken?.token_symbol as string) ?? null, name: null, logo: null, price: 0 },
    intervalDays: s.burnIntervalDays,
    nextAt: new Date(next).toISOString(),
    amount: amountRaw.toString(),
    amountUsd: usd(amountRaw),
    totalBurned: totalRaw.toString(),
    totalBurnedUsd: usd(totalRaw),
    platformBurned: platformRaw.toString(),
    platformBurnedUsd: usd(platformRaw),
    otherBurned: otherRaw.toString(),
    otherBurnedUsd: usd(otherRaw),
    burns: Number(tot.n),
    lastBurn: lastOfToken ? shapeBurn(lastOfToken) : null,
    history: history.map(shapeBurn),
    config: burnConfig(s),
  });
});
const burnConfig = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  token: s.burnToken, amount: s.burnAmount, intervalDays: s.burnIntervalDays, nextAt: s.burnNextAt,
});

app.get("/api/admin/burns", async (c) => {
  const rows = await sql`select * from manual_burns order by ts desc limit 500`;
  const [t] = await sql`select coalesce(sum(tokens_burned),0) as burned, coalesce(sum(usdc_spent),0) as spent, count(*)::int as n from manual_burns`;
  return c.json({ totals: { burned: String(t.burned), usdcSpent: String(t.spent), n: Number(t.n) }, items: rows.map(shapeBurn) });
});

app.post("/api/admin/burns", async (c) => {
  const r = await requireOwner(c, "burn:add");
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const hash = String(r.payload?.hash ?? "").trim();
  const note = String(r.payload?.note ?? "").slice(0, 500);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: "bad tx hash" }, 400);
  const [dup] = await sql`select id from manual_burns where lower(tx_hash) = ${hash.toLowerCase()}`;
  if (dup) return c.json({ error: "already recorded" }, 409);

  const rc = await client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
  if (!rc) return c.json({ error: "tx not found on this chain" }, 404);
  if (rc.status !== "success") return c.json({ error: "tx reverted" }, 400);
  const block = await client.getBlock({ blockNumber: rc.blockNumber });

  // burned = Transfer(*, dead) per token (largest wins); usdc spent = USDC the sender paid out in the same tx
  const xfers = parseEventLogs({ abi: erc20Abi, logs: rc.logs, strict: false }).filter((l) => l.eventName === "Transfer");
  const burnedBy = new Map<string, bigint>();
  let usdcSpent = 0n;
  for (const l of xfers) {
    const a = l.args as { from?: Address; to?: Address; value?: bigint };
    if (!a.to || !a.value) continue;
    if (a.to.toLowerCase() === DEAD.toLowerCase()) burnedBy.set(l.address.toLowerCase(), (burnedBy.get(l.address.toLowerCase()) ?? 0n) + a.value);
    if (l.address.toLowerCase() === ADDR.usdc.toLowerCase() && a.from?.toLowerCase() === rc.from.toLowerCase()) usdcSpent += a.value;
  }
  const [tokenLc, burned] = [...burnedBy.entries()].sort((x, y) => (y[1] > x[1] ? 1 : -1))[0] ?? [null, 0n];
  let symbol: string | null = null;
  if (tokenLc) {
    const [ours] = await sql`select symbol from tokens where lower(address) = ${tokenLc}`;
    symbol = (ours?.symbol as string) ?? (await client.readContract({ address: getAddress(tokenLc), abi: erc20Abi, functionName: "symbol" }).catch(() => null));
  }
  const [row] = await sql`insert into manual_burns (tx_hash, block_number, ts, sender, token, token_symbol, tokens_burned, usdc_spent, note, added_by)
    values (${hash}, ${Number(rc.blockNumber)}, ${new Date(Number(block.timestamp) * 1000)}, ${getAddress(rc.from)}, ${tokenLc ? getAddress(tokenLc) : null}, ${symbol}, ${burned.toString()}, ${usdcSpent.toString()}, ${note}, ${getAddress(r.author)})
    returning *`;
  return c.json({ ok: true, burnFound: !!tokenLc, item: shapeBurn(row) });
});

app.post("/api/admin/burns/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const r = await requireOwner(c, `burn:${id}`);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  if (String(r.payload?.action ?? "") !== "delete") return c.json({ error: "unknown action" }, 400);
  await sql`delete from manual_burns where id = ${id}`;
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ admin panel
// Everything here is derived from public chain data / the public index; the panel itself is gated in the
// frontend by the on-chain owner() and every action is a wallet-signed tx, so there is no server secret.

app.get("/api/admin/overview", async (c) => {
  // totals / daily / fee log follow the public rule (hidden tokens excluded, boss 9.16); the token table itself still
  // lists hidden tokens so they can be restored. Settlements are Treasury-level and cannot be attributed per token.
  const [totals] = await sql`select
      (select count(*) from tokens where not hidden) as tokens,
      (select count(*) from tokens where not hidden and graduated) as graduated,
      (select count(*) from tokens where not hidden and launch_ts > now() - interval '24 hours') as launched_24h,
      (select coalesce(sum(usdc),0) from trades where token in ${shown}) as volume_total,
      (select coalesce(sum(usdc),0) from trades where token in ${shown} and ts > now() - interval '24 hours') as volume_24h,
      (select count(*) from trades where token in ${shown}) as trades_total,
      (select count(distinct sender) from trades where token in ${shown}) as traders,
      (select count(distinct address) from holders where token in ${shown} and balance > 0) as holders,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown}) as fees_total,
      (select coalesce(sum(quote_creator),0) from fee_events where token in ${shown}) as fees_creator,
      (select coalesce(sum(quote_protocol),0) from fee_events where token in ${shown}) as fees_protocol,
      (select coalesce(sum(usdc_from_token),0) from fee_events where token in ${shown}) as fees_from_token,
      (select count(*) from fee_events where token in ${shown} and not creator_paid) as payouts_parked,
      (select coalesce(sum(creation_fee_paid),0) from tokens where not hidden) as creation_fees,
      (select coalesce(sum(usdc_to_buyback),0) from settlements) as to_buyback,
      (select coalesce(sum(usdc_to_dev),0) from settlements) as to_dev,
      (select coalesce(sum(usdc_to_eco),0) from settlements) as to_eco,
      (select coalesce(sum(tokens_burned),0) from manual_burns) as burned,
      (select count(*) from comments) as comments`;

  const daily = await sql`with days as (select generate_series((now() - interval '29 days')::date, now()::date, '1 day')::date as d)
    select d,
      (select count(*) from tokens where not hidden and launch_ts::date = d) as launches,
      (select coalesce(sum(usdc),0) from trades where token in ${shown} and ts::date = d) as volume,
      (select count(*) from trades where token in ${shown} and ts::date = d) as trades,
      (select coalesce(sum(quote_creator + quote_protocol),0) from fee_events where token in ${shown} and ts::date = d) as fees,
      (select coalesce(sum(creation_fee_paid),0) from tokens where not hidden and launch_ts::date = d) as creation_fees
    from days order by d`;

  const toks = await sql`select t.*, coalesce(v.volume_24h,0) as volume_24h, coalesce(h.holders,0) as holders from tokens t
    left join (select token, sum(usdc) as volume_24h from trades where ts > now() - interval '24 hours' group by token) v on v.token = t.address
    left join (select token, count(*) as holders from holders where balance > 0 group by token) h on h.token = t.address
    order by t.launch_ts desc limit 500`;

  // on-chain state per token: unconverted fee backlog, parked creator payout
  const calls = toks.flatMap((t) => [
    { address: addrsFor(t.factory).locker, abi: lockerAbi, functionName: "unconvertedTokenFees" as const, args: [t.address as Address] },
    { address: addrsFor(t.factory).locker, abi: lockerAbi, functionName: "claimable" as const, args: [t.payout as Address, ADDR.usdc] },
  ]);
  const chain = calls.length ? await client.multicall({ allowFailure: true, contracts: calls }) : [];
  const tokens = toks.map((t, i) => {
    const un = chain[i * 2]?.result as bigint | undefined;
    const cl = chain[i * 2 + 1]?.result as bigint | undefined;
    return {
      ...shapeToken(t, { volume24hUsdc: t.volume_24h, holders: Number(t.holders) }),
      volumeSinceDistribute: t.volume_since_distribute,
      creationFeePaid: t.creation_fee_paid,
      initialBuyUsdc: t.initial_buy_usdc,
      unconvertedTokenFees: (un ?? 0n).toString(),
      claimableUsdc: (cl ?? 0n).toString(),
    };
  });

  const feeEvents = await sql`select f.ts, f.tx_hash, f.token, t.symbol, f.quote_creator, f.quote_protocol, f.token_converted, f.usdc_from_token, f.creator_paid, f.payout, f.kind
    from fee_events f join tokens t on t.address = f.token where not t.hidden order by f.ts desc limit 300`;

  const [fOwner, lOwner, tOwner, lTreasury, fee, thr, prot, maxHold, maxBuy, startMcap, bbFund, ecoFund, nextAt, dvFund, tBal, maxTax, feeRcpt, pending] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: ADDR.factory, abi: factoryAbi, functionName: "owner" },
      { address: ADDR.locker, abi: lockerAbi, functionName: "owner" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "owner" },
      { address: ADDR.locker, abi: lockerAbi, functionName: "treasury" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "creationFee" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "graduationThreshold" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "protectionBlocks" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxHoldBps" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxBuyBps" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "startMcapUsdc" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "buybackFund" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "ecoFund" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "nextExecuteAt" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "devFund" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "usdcBalance" },
      { address: ADDR.factory, abi: factoryAbi, functionName: "maxTaxBps" },
      { address: ADDR.hub, abi: hubAbi, functionName: "keeper" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "pendingRevenue" },
    ],
  });
  const r = <T,>(x: { result?: unknown }) => x.result as T | undefined;

  const [{ v: lastBlock }] = await sql`select value as v from sync_state where key = 'last_block'`.catch(() => [{ v: null }]);
  const head = await client.getBlockNumber().catch(() => null);
  let keeperAddress: string | null = null;
  let keeperBalance: string | null = null;
  if (config.keeper.enabled && config.keeper.privateKey) {
    try {
      const { account } = keeperWallet();
      keeperAddress = account.address;
      keeperBalance = (await client.getBalance({ address: account.address })).toString();
    } catch {}
  }

  return c.json({
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v)])),
    daily: daily.map((d) => ({ day: d.d, launches: Number(d.launches), volume: String(d.volume), trades: Number(d.trades), fees: String(d.fees), creationFees: String(d.creation_fees) })),
    tokens,
    feeEvents: feeEvents.map((f) => ({ time: f.ts, hash: f.tx_hash, token: f.token, symbol: f.symbol, quoteCreator: f.quote_creator, quoteProtocol: f.quote_protocol, tokenConverted: f.token_converted, usdcFromToken: f.usdc_from_token, creatorPaid: f.creator_paid, payout: f.payout, kind: f.kind })),
    owners: { factory: r<string>(fOwner) ?? null, locker: r<string>(lOwner) ?? null, treasury: r<string>(tOwner) ?? null },
    params: {
      creationFee: (r<bigint>(fee) ?? 0n).toString(),
      graduationThreshold: (r<bigint>(thr) ?? 0n).toString(),
      protectionBlocks: Number(r<bigint>(prot) ?? 0n),
      maxHoldBps: Number(r<number>(maxHold) ?? 0),
      maxBuyBps: Number(r<number>(maxBuy) ?? 0),
      startMcapUsdc: (r<bigint>(startMcap) ?? 0n).toString(),
      maxTaxBps: Number(r<number>(maxTax) ?? 0),
      feeRecipient: null, // Arm: free launches
      referralHub: ADDR.hub,
      referralKeeper: r<string>(feeRcpt) ?? null,
      lockerTreasury: r<string>(lTreasury) ?? null,
      treasury: {
        ecoFund: r<string>(ecoFund) ?? ZERO,
        buybackFund: r<string>(bbFund) ?? ZERO,
        devFund: r<string>(dvFund) ?? ZERO,
        nextExecuteAt: Number(r<bigint>(nextAt) ?? 0n),
        pendingRevenueUsdc: (r<bigint>(pending) ?? 0n).toString(),
        usdcBalance: (r<bigint>(tBal) ?? 0n).toString(),
      },
    },
    keeper: { enabled: config.keeper.enabled, address: keeperAddress, balance: keeperBalance, intervalMs: config.keeper.intervalMs, feeThresholdUsdc: config.keeper.feeThresholdUsdc.toString(), maxAgeMs: config.keeper.maxAgeMs, ...keeperState() },
    sync: { lastBlock: lastBlock ? Number(lastBlock) : null, head: head ? Number(head) : null, startBlock: Number(config.startBlock), rpc: new URL(config.rpcUrl).origin }, // host only: keyed endpoints carry the API key in the path
    addresses: deployments,
  });
});

app.onError((err, c) => {
  console.error("[api]", err.message);
  return c.json({ error: err.message }, 400);
});
