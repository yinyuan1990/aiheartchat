"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

/** Base URL: same-origin `/api` in production (nginx → indexer); override for local dev. */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export type TokenView = {
  address: string;
  /** Arm: the per-token CreatorFeeSplitter the lock pays; null for tokens without one */
  splitter?: string | null;
  /** share of the creator fees offered to promoters, bps (0 = referral off) */
  referralBps?: number;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { website: string; twitter: string; telegram: string; discord: string; farcaster: string };
  deployer: string;
  payout: string;
  pool: string;
  positionId: string;
  isToken0: boolean;
  launchBlock: number;
  launchTs: string;
  launchTx: string;
  restrictionsEndBlock: number;
  graduationThreshold: string; // usdc 6dp
  pairedUsdc: string;
  graduated: boolean;
  graduatedAt: string | null;
  creatorShareBps: number;
  price: number; // usd per token
  mcapUsd: number;
  feesUsdcTotal: string;
  feesCreatorUsdcTotal: string;
  lastDistributedAt: string | null;
  /** tax mode: creator-set at launch, immutable. 0/0 = standard token */
  buyTaxBps: number;
  sellTaxBps: number;
  taxMarketingWallet: string;
  taxTeamWallet: string;
  /** share of the tax to the marketing wallet; the rest goes to the team wallet */
  taxMarketingBps: number;
  taxUsdcTotal: string;
  /** owner moderation flags (indexer-side, display only) */
  hidden?: boolean;
  pinned?: boolean;
  /** LaunchFactory generation that launched the token → pick locker / router / quoter via `addrsFor` */
  factory?: string;
  /** stock generation: the tokenized stock the pool is quoted in ('' = USDC). graduationThreshold / pairedUsdc / price
   *  / mcap are already USD; the *Quote fields are the raw quote-asset figures. */
  quote?: string;
  quoteSymbol?: string;
  quoteDecimals?: number;
  quoteUsdcFee?: number;
  quotePool?: string;
  /** USDC (6dp) per whole quote unit, latest */
  quotePriceUsdc?: string;
  /** USDC (6dp) per whole quote unit at launch (TWAP the opening price was set with) */
  quotePriceUsdcLaunch?: string;
  pairedQuote?: string;
  graduationThresholdQuote?: string;
  poolQuote?: string;
  // list/detail extras
  volume24hUsdc?: string;
  trades24h?: number;
  /** volume over the requested `window` (list endpoint only) */
  volumeUsdc?: string;
  tradesWindow?: number;
  holders?: number;
  change24h?: number | null;
  /** hourly closes (USD) over the last 24h, oldest first — list endpoint only, for the card sparkline */
  spark?: number[];
  poolUsdc?: string;
  poolTokens?: string;
  liquidityUsd?: number;
  burnedTokens?: string;
  fdvUsd?: number;
  circulatingMcapUsd?: number;
  protectionActive?: boolean;
  currentBlock?: number;
};

export type Health = { ok: boolean; lastBlock: number | null; head: number | null; chainId: number };

// ---- AI Meme Radar (v2)
export type HotspotPlatform = "x" | "weibo";
export type HotspotSourceType = "trend" | "key_account" | "community";
export type HotspotLang = "en" | "zh";
export type HotspotToken = { address: string; symbol: string; name: string; logo: string; deployer: string; mode: "standard" | "tax"; time: string };
export type Hotspot = {
  id: number; platform: HotspotPlatform; sourceType: HotspotSourceType; account: string | null; title: string; lang: HotspotLang; url: string | null;
  /** regional boards the topic appeared on (WW / US / JP …); posts carry WW */
  regions: string[]; signals: number; related: number; rising: boolean; keyAccount: boolean;
  metrics: Record<string, number | string>; context: string[]; category: MemeCategory | null;
  status: "pending" | "published" | "blocked" | "merged" | "expired" | "hidden"; firstSeen: string; lastSeen: string;
  /** token copy exists (pre-generated or produced by /prepare) */
  prepared: boolean; generatedAt: string | null;
  titleZh: string | null; titleEn: string | null;
  name: string | null; symbol: string | null; description: string | null; logo: string | null;
  nameZh: string | null; descriptionZh: string | null;
  launches: number; tokens: HotspotToken[];
};
export type MemeCategory = "animal" | "food" | "quote" | "abstract" | "scene" | "trend" | "nickname" | "none";
export type TaxDefaults = { buyTaxBps: number; sellTaxBps: number; marketingBps: number };
export type HotspotList = {
  enabled: boolean; sources: Record<HotspotPlatform, boolean>; accounts: string[];
  /** the boss's named accounts (subset of `accounts`), listed first in the filter drawer */
  pinnedAccounts?: string[];
  counts: { all: number; x: number; weibo: number }; signalsToday: number; updatedAt: string | null; total: number; nextOffset: number | null; windowHours: number;
  quota: { perAddress: number; perIp: number }; tax: TaxDefaults; items: Hotspot[];
};
export type HotspotDetail = Hotspot & { tax: TaxDefaults; relatedSignals: { title: string; region: string; sourceType: HotspotSourceType; url: string | null; lastSeen: string }[] };
export type HotspotQuota = { address: number; ip: number; perAddress: number; perIp: number };
export type HotspotClaim = {
  claimId: number;
  params: { name: string; symbol: string; logo: string; description: string; lang: HotspotLang; socials: { website: string; twitter: string; telegram: string; discord: string; farcaster: string }; mode: "standard" | "tax" } & TaxDefaults;
  quota: { address: number; ip: number };
};
export type HotspotSettings = {
  enabled: boolean; sources: Record<HotspotPlatform, boolean>; intervalMs: number;
  xRegions: string[]; xRegionsPerTick: number; xTrendIntervalMs: number; xAccounts: string[]; xAccountsIntervalMs: number;
  xBusyPostsPerDay: number; xBusyIntervalMs: number; xBusyReadPerDay: number;
  xBreakoutEnabled: boolean; xBreakoutIntervalMs: number; xBreakoutMinLikes: number; xBreakoutMinReposts: number; xBreakoutLang: string;
  xDailyPostCap: number; xDailyBudgetUsd: number;
  publicWindowHours: number; xPublicMax: number; weiboPublicMax: number; aiFilter: boolean; pregenTop: number; pregenLogos: boolean; aiDailyCap: number; aiPerIpHour: number; blacklist: string[];
  quotaPerAddress: number; quotaPerIp: number; tax: TaxDefaults;
  aiDraftDailyCap: number; aiDraftPerIpHour: number; aiDraftPerAddressDay: number;
  bugButton: boolean;
  swapEnabled: boolean; swapMaxUsd: number;
};
/** Site-wide switches (owner-edited in /admin): the floating bug-report button, the /tools swap and its USD cap. */
export type SiteFlags = {
  bugButton: boolean; swapEnabled: boolean; swapMaxUsd: number;
  /** Telegram buy bot: username (null = not configured on the server) / public channel handle */
  tgBot: string | null; tgChannel: string | null; tgEnabled: boolean; tgChannelMinBuyUsd: number; tgLaunches: boolean; tgPhotos: boolean;
};
export type AdminTelegram = {
  configured: boolean; bot: string | null; channel: string | null; channelSet: boolean; lastPoll: string | null; lastError: string | null;
  log: { ts: string; kind: "sent" | "cmd" | "error" | "info"; chat?: string; detail: string }[];
  subscriptions: { id: number; chatId: string; chatTitle: string; token: string; symbol: string | null; minBuyUsd: number; active: boolean; addedAt: string }[];
};
export type HotspotDaily = { day: string; fetched: number; blocked: number; merged: number; published: number; x_requests: number; x_posts: number; ai_calls: number };
export type AdminHotspots = {
  settings: HotspotSettings;
  ai: { copy: string; logo: string; x: boolean; weibo: boolean };
  state: {
    lastTick: string | null; lastError: string | null;
    last: { fetched: number; merged: number; blocked: number; published: number; aiBatches: number; ms: number };
    sources: Record<string, { ok: boolean; count: number; at: string }>;
    x: {
      day: string; requests: number; searches: number; posts: number; costUsd: number; nextRegion: string; breakoutError: string | null;
      paceUsd: number; busy: { handle: string; perDay: number }[]; lastRoundStop: string | null;
    };
  };
  aiToday: number;
  claims: { total: number; day: number; launched: number };
  gate: { blocked: number; published: number; pending: number };
  reasons: { reason: string | null; n: number }[];
  daily: HotspotDaily[];
  items: (Hotspot & { blockedReason: string | null; verdict: string | null; ideasBy: string | null; logoBy: string | null })[];
};
export type TokenWindow = "24h" | "7d" | "all";
export type Analytics = {
  latestDay: string;
  day: { volumeUsdc: string; trades: number; traders: number; launches: number; feesUsdc: string };
  allTime: { volumeUsdc: string; trades: number; traders: number; launches: number; graduated: number; feesUsdc: string; feesCreatorUsdc: string; creationFeesUsdc: string; buybackFundUsdc: string };
  daily: { day: string; launches: number; volumeUsdc: string; trades: number; feesUsdc: string }[];
  source: { factory: string; locker: string; treasury: string; chainId: number };
};

export type Trade = { hash: string; time: string; side: "buy" | "sell"; usdc: string; tokens: string; price: number; mcapUsd: number; wallet: string; block: number };
export type Holder = { wallet: string; balance: string; pct: number; label?: string };
export type Candle = { time: number; open: number; high: number; low: number; close: number; volumeUsdc: string; trades: number };
export type Activity = { kind: "buy" | "sell" | "launch"; ts: string; wallet: string; tx: string; token: string; symbol: string; logo: string; usdc?: string };
export type Stats = {
  tokens: number; launched24h: number; graduated: number;
  volume24hUsdc: string; volumeTotalUsdc: string; fees24hUsdc: string; feesTotalUsdc: string;
  creationFeesTotalUsdc: string; protocolFeesTotalUsdc: string; treasuryUsdc: string;
};
export type Creator = {
  address: string; tokens: TokenView[];
  payouts: { time: string; hash: string; usdc: string; usdcFromToken: string; paid: boolean; kind: "fee" | "tax_marketing" | "tax_team"; token: string; symbol: string; logo: string }[];
  earnedUsdc: string; pendingEstimateUsdc: string; claimableUsdc: string;
  /** parked payouts per locker generation (only non-zero entries) */
  claimableByLocker?: { locker: string; usdc: string }[];
};
export type WalletView = {
  address: string; usdcBalance: string;
  holdings: { balance: string; valueUsd: number; token: TokenView }[];
  trades: { time: string; side: "buy" | "sell"; usdc: string; tokens: string; price: number; hash: string; token: string; symbol: string; logo: string }[];
};
/** One weekly Treasury settlement (v2.10: three plain USDC transfers, no on-chain buyback). */
export type Settlement = { hash: string; time: string; usdcToEco: string; usdcToBuyback: string; usdcToDev: string };
export type TreasuryView = {
  address: string; usdcBalance: string; fromCreationFees: string; fromTradeFees: string; ecoBps: number; buybackBps: number; devBps: number;
  intervalSec: number; lastExecutedAt: number; nextExecuteAt: number; pendingRevenueUsdc: string;
  feeRecipient: string; ecoFund: string; buybackFund: string; devFund: string;
  totalToEcoUsdc: string; totalToBuybackUsdc: string; totalToDevUsdc: string;
  settlements: Settlement[];
};
/** A burn the project performed by hand from the buyback multisig, recorded by the owner in /admin. */
export type ManualBurn = {
  id: number; hash: string; block: number; time: string; sender: string; token: string | null; symbol: string | null;
  tokensBurned: string; usdcSpent: string; note: string; addedBy: string; addedAt: string;
};
export type AdminBurns = { totals: { burned: string; usdcSpent: string; n: number }; items: ManualBurn[] };
/** Public "next burn" card (9.23): countdown + planned quantity at today's price + recorded history of the burned token. */
export type BurnView = {
  /** placement switches from /admin: home page strip (default off) / the burned token's own page (default on) */
  showHome: boolean; showToken: boolean;
  token: { address: string; symbol: string | null; name: string | null; logo: string | null; price: number } | null;
  intervalDays: number; nextAt: string | null;
  amount: string; amountUsd: number;
  /** on-chain total sent to the dead address = platform (recorded in /admin) + others (holders burning on their own) */
  totalBurned: string; totalBurnedUsd: number; platformBurned: string; platformBurnedUsd: number; otherBurned: string; otherBurnedUsd: number;
  burns: number;
  lastBurn: ManualBurn | null; history: ManualBurn[];
  /** raw owner settings (empty / 0 = derived from the last recorded burn) */
  config: { token: string; amount: number; intervalDays: number; nextAt: string };
};
export type Comment = { id: number; author: string; text: string; replyTo: number | null; time: string; likes: number; liked: boolean; isCreator: boolean };
export type ConfigView = {
  chainId: number;
  addresses: Record<string, string | number>;
  params: { creationFee: string; graduationThreshold: string; protectionBlocks: number; maxHoldBps: number; maxBuyBps: number; startMcapUsdc: string; creatorShareBps: number; poolFee: number; totalLaunches: number; maxTaxBps: number };
  stock: { factory: string; locker: string; oracle: string; deployBlock: number; quotes: QuoteAssetView[] } | null;
};

/** A whitelisted quote asset of the stock generation with its live USDC price (6dp per whole unit). */
export type QuoteAssetView = {
  symbol: string; address: string; decimals: number; usdcFee: number; usdcPool: string;
  priceUsdc?: string; twapUsdc?: string; enabled?: boolean; updatedAt?: string | null; launches?: number; volume24hUsdc?: string;
};

/** Tax helpers (bps → fraction). Buys: pool output is taxed, buyer receives output × (1 − buy). Sells: tax is
 *  charged on top, so selling N costs N × (1 + sell) and the max sellable is balance / (1 + sell). */
export const isTaxToken = (t: Pick<TokenView, "buyTaxBps" | "sellTaxBps">) => (t.buyTaxBps ?? 0) > 0 || (t.sellTaxBps ?? 0) > 0;
export const afterBuyTax = (out: bigint, buyTaxBps: number) => out - (out * BigInt(buyTaxBps)) / 10_000n;
export const sellTaxOn = (amount: bigint, sellTaxBps: number) => (amount * BigInt(sellTaxBps)) / 10_000n;
export const maxSellable = (balance: bigint, sellTaxBps: number) => (balance * 10_000n) / (10_000n + BigInt(sellTaxBps));
export type LaunchQuote = { startMcapUsdc: string; creationFee: string };

export type AdminToken = TokenView & {
  volume24hUsdc: string; holders: number; hidden: boolean; pinned: boolean;
  volumeSinceDistribute: string; creationFeePaid: string; initialBuyUsdc: string;
  unconvertedTokenFees: string; claimableUsdc: string;
};
export type AdminOverview = {
  totals: Record<"tokens" | "graduated" | "launched_24h" | "volume_total" | "volume_24h" | "trades_total" | "traders" | "holders" | "fees_total" | "fees_creator" | "fees_protocol" | "fees_from_token" | "payouts_parked" | "creation_fees" | "to_buyback" | "to_dev" | "to_eco" | "burned" | "comments", string>;
  daily: { day: string; launches: number; volume: string; trades: number; fees: string; creationFees: string }[];
  tokens: AdminToken[];
  feeEvents: { time: string; hash: string; token: string; symbol: string; quoteCreator: string; quoteProtocol: string; tokenConverted: string; usdcFromToken: string; creatorPaid: boolean; payout: string; kind: "fee" | "tax_marketing" | "tax_team" }[];
  owners: { factory: string | null; locker: string | null; treasury: string | null };
  params: {
    creationFee: string; graduationThreshold: string; protectionBlocks: number; maxHoldBps: number; maxBuyBps: number; startMcapUsdc: string; maxTaxBps: number; feeRecipient: string | null; lockerTreasury: string | null;
    treasury: { ecoFund: string; buybackFund: string; devFund: string; nextExecuteAt: number; pendingRevenueUsdc: string; usdcBalance: string };
  };
  keeper: { enabled: boolean; address: string | null; balance: string | null; intervalMs: number; feeThresholdUsdc: string; maxAgeMs: number; lastTick: string | null; entries: { ts: string; action: string; token?: string; detail: string; hash?: string; ok: boolean }[] };
  sync: { lastBlock: number | null; head: number | null; startBlock: number; rpc: string };
  addresses: Record<string, string | number>;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

/** Server-paged lists: the indexer puts the full row count in X-Total-Count. */
export type Paged<T> = { items: T[]; total: number };
async function getPaged<T>(path: string): Promise<Paged<T>> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  const items = (await res.json()) as T[];
  return { items, total: Number(res.headers.get("x-total-count") ?? items.length) };
}

/** USDC raw (6dp) string → number of dollars. */
export const usd = (raw?: string | null) => (raw ? Number(raw) / 1e6 : 0);
/** token raw (18dp) string → whole tokens. */
export const tok = (raw?: string | null) => (raw ? Number(raw) / 1e18 : 0);

export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: () => get<Stats>("/stats"), refetchInterval: 10_000 });

// ---------- Arm promoter referrals ----------
export type ReferralBinding = { referrer: string; boundAt: string } | null;
export type PromoterStats = {
  wallet: string; invited: number; referredVolumeUsdc: string; referredTrades: number; paidUsdc: string; pendingEstimateUsdc: string;
  tokens: { token: string; symbol: string; logo: string; referral_bps: number; volume: string; paid: string }[];
  payouts: { amount: string; volume: string; token: string; symbol: string; tx_hash: string; ts: string }[];
};
export type ReferralToken = { address: string; name: string; symbol: string; logo: string; referral_bps: number; last_mcap6: string | null; splitter: string };
export const useReferralOf = (wallet?: string) =>
  useQuery({ queryKey: ["referralOf", wallet], queryFn: () => get<{ binding: ReferralBinding }>(`/referral/of/${wallet}`).then((r) => r.binding), enabled: !!wallet, staleTime: 60_000 });
export const usePromoterStats = (wallet?: string) =>
  useQuery({ queryKey: ["promoter", wallet], queryFn: () => get<PromoterStats>(`/referral/stats/${wallet}`), enabled: !!wallet, refetchInterval: 30_000 });
export const useReferralTokens = () =>
  useQuery({ queryKey: ["referralTokens"], queryFn: () => get<{ tokens: ReferralToken[] }>("/referral/tokens").then((r) => r.tokens), refetchInterval: 60_000 });
export const postReferralBind = (body: { wallet: string; referrer: string; ts: number; sig: string }) =>
  post<{ ok: boolean; referrer?: string; bound?: boolean; error?: string }>("/referral/bind", body);
export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => get<ConfigView>("/config"), staleTime: 60_000 });
/** Stock generation: whitelisted quote assets + live USDC prices (empty list when the stock factory is not deployed). */
export const useQuotes = () => useQuery({ queryKey: ["quotes"], queryFn: () => get<{ quotes: QuoteAssetView[] }>("/quotes").then((r) => r.quotes), staleTime: 15_000, refetchInterval: 15_000 });
export const useSite = () => useQuery({ queryKey: ["site"], queryFn: () => get<SiteFlags>("/site"), staleTime: 60_000, refetchInterval: 60_000, retry: 1 });
export const useBurn = () => useQuery({ queryKey: ["burn"], queryFn: () => get<BurnView>("/burn"), staleTime: 30_000, refetchInterval: 30_000, retry: 1 });
export const useTokens = (sort: string, filter: string, window: TokenWindow = "24h", limit = 100) =>
  useQuery({ queryKey: ["tokens", sort, filter, window, limit], queryFn: () => get<TokenView[]>(`/tokens?sort=${sort}&filter=${filter}&window=${window}&limit=${limit}`), refetchInterval: 8_000 });
/** Home grid: one page at a time, straight from the server. */
export const useTokensPage = (sort: string, filter: string, window: TokenWindow, page: number, pageSize: number) =>
  useQuery({
    queryKey: ["tokens", "page", sort, filter, window, page, pageSize],
    queryFn: () => getPaged<TokenView>(`/tokens?sort=${sort}&filter=${filter}&window=${window}&limit=${pageSize}&offset=${(page - 1) * pageSize}`),
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });
export const useAnalytics = () => useQuery({ queryKey: ["analytics"], queryFn: () => get<Analytics>("/analytics"), refetchInterval: 60_000 });
export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: () => get<Health>("/health"), refetchInterval: 15_000, retry: 1 });
// Right after a launch the indexer can lag the chain by a few seconds → keep retrying 404s for ~30s.
export const useToken = (address?: string) =>
  useQuery({ queryKey: ["token", address], queryFn: () => get<TokenView>(`/tokens/${address}`), enabled: !!address, refetchInterval: 5_000, retry: 15, retryDelay: 2_000 });
export const useCandles = (address?: string, interval = "1m") =>
  useQuery({ queryKey: ["candles", address, interval], queryFn: () => get<Candle[]>(`/tokens/${address}/candles?interval=${interval}&limit=500`), enabled: !!address, refetchInterval: 5_000 });
export const useTrades = (address?: string, page = 1, pageSize = 20) =>
  useQuery({
    queryKey: ["trades", address, page, pageSize],
    queryFn: () => getPaged<Trade>(`/tokens/${address}/trades?limit=${pageSize}&offset=${(page - 1) * pageSize}`),
    enabled: !!address,
    refetchInterval: 4_000,
    placeholderData: (prev) => prev,
  });
export const useHolders = (address?: string, limit = 200) =>
  useQuery({ queryKey: ["holders", address, limit], queryFn: () => get<Holder[]>(`/tokens/${address}/holders?limit=${limit}`), enabled: !!address, refetchInterval: 15_000 });
export const useActivity = () => useQuery({ queryKey: ["activity"], queryFn: () => get<Activity[]>("/activity?limit=40"), refetchInterval: 5_000 });
export const useCreator = (address?: string) =>
  useQuery({ queryKey: ["creator", address], queryFn: () => get<Creator>(`/creator/${address}`), enabled: !!address, refetchInterval: 10_000 });
export const useWallet = (address?: string) =>
  useQuery({ queryKey: ["wallet", address], queryFn: () => get<WalletView>(`/wallet/${address}`), enabled: !!address, refetchInterval: 10_000 });
export const useTreasury = () => useQuery({ queryKey: ["treasury"], queryFn: () => get<TreasuryView>("/treasury"), refetchInterval: 15_000 });
/** Radar list, "Load more" style: pages of 30, ordered by the server (new → multi-region → rising → key account → active). */
export type HotspotFilter = { platform: "all" | HotspotPlatform; accounts?: string[]; tags?: MemeCategory[] };
const hotspotQuery = (f: HotspotFilter, offset: number) => {
  const p = new URLSearchParams();
  if (f.platform !== "all") p.set("platform", f.platform);
  if (f.accounts?.length === 1) p.set("account", f.accounts[0]);
  if (f.tags?.length) p.set("tags", f.tags.join(","));
  if (offset) p.set("offset", String(offset));
  const q = p.toString();
  return `/hotspots${q ? `?${q}` : ""}`;
};
export const useHotspots = (f: HotspotFilter) =>
  useInfiniteQuery({
    queryKey: ["hotspots", f.platform, f.accounts?.join(",") ?? "", f.tags?.join(",") ?? ""],
    queryFn: ({ pageParam }) => get<HotspotList>(hotspotQuery(f, pageParam)),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
/** "N new signals" banner: how many published hotspots appeared since `after` (ISO) in this tab. */
export const useHotspotsNew = (platform: "all" | HotspotPlatform, after: string | null) =>
  useQuery({ queryKey: ["hotspots-new", platform, after], queryFn: () => get<{ count: number }>(`/hotspots/new?after=${encodeURIComponent(after!)}${platform !== "all" ? `&platform=${platform}` : ""}`), enabled: !!after, refetchInterval: 60_000 });
export const useHotspot = (id?: string) =>
  useQuery({ queryKey: ["hotspot", id], queryFn: () => get<HotspotDetail>(`/hotspots/${id}`), enabled: !!id, refetchInterval: 30_000 });
/** AI on click: generates the token copy for this hotspot once (cached server-side), returns the fresh detail. */
export const prepareHotspot = (id: number) => post<HotspotDetail>(`/hotspots/${id}/prepare`, {});
export const generateHotspotLogo = (id: number) => post<{ logo: string; by: string | null; cached: boolean }>(`/hotspots/${id}/logo`, {});
export const useHotspotQuota = (address?: string) =>
  useQuery({ queryKey: ["hotspot-quota", address], queryFn: () => get<HotspotQuota>(`/hotspots/quota?address=${address}`), enabled: !!address, refetchInterval: 30_000 });
export const useAdminHotspots = (enabled: boolean) =>
  useQuery({ queryKey: ["admin", "hotspots"], queryFn: () => get<AdminHotspots>("/admin/hotspots"), enabled, refetchInterval: 30_000 });
/** Multi-domain redundancy: every domain the site is served on, with a DNS liveness probe (indexer, cached 5 min). */
export type DomainStatus = { host: string; ok: boolean; ips: string[]; error?: string; checkedAt: string };
export const useDomains = () =>
  useQuery({ queryKey: ["domains"], queryFn: () => get<{ primary: string | null; domains: DomainStatus[] }>("/domains"), staleTime: 5 * 60_000, refetchInterval: 5 * 60_000 });
export const useAdminTelegram = (enabled: boolean) =>
  useQuery({ queryKey: ["admin", "telegram"], queryFn: () => get<AdminTelegram>("/admin/telegram"), enabled, refetchInterval: 30_000 });
export const useAdminBurns = (enabled: boolean) =>
  useQuery({ queryKey: ["admin", "burns"], queryFn: () => get<AdminBurns>("/admin/burns"), enabled, refetchInterval: 30_000 });
export const postAdminBurn = (body: { author: string; ts: number; signature: string; payload: unknown }) => post<{ ok: boolean; burnFound: boolean; item: ManualBurn }>("/admin/burns", body);
export const postAdminBurnAction = (id: number, body: { author: string; ts: number; signature: string; payload: unknown }) => post<{ ok: boolean }>(`/admin/burns/${id}`, body);
export const useAdminOverview = (enabled: boolean) =>
  useQuery({ queryKey: ["admin", "overview"], queryFn: () => get<AdminOverview>("/admin/overview"), enabled, refetchInterval: 15_000 });
export const fetchLaunchQuote = (account?: string) =>
  get<LaunchQuote>(`/launch-quote${account ? `?account=${account}` : ""}`);
export const useComments = (address?: string, viewer?: string) =>
  useQuery({ queryKey: ["comments", address, viewer], queryFn: () => get<Comment[]>(`/tokens/${address}/comments${viewer ? `?viewer=${viewer}` : ""}`), enabled: !!address, refetchInterval: 8_000 });

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status}`);
  return json as T;
}
export const postComment = (token: string, body: { author: string; text: string; replyTo: number | null; ts: number; signature: string }) =>
  post<{ id: number; time: string }>(`/tokens/${token}/comments`, body);
export const postLike = (id: number, body: { author: string; ts: number; signature: string }) => post<{ liked: boolean; likes: number }>(`/comments/${id}/like`, body);
export type TokenDraft = { name: string; symbol: string; description: string; logo: string; by: { copy: string; logo: string }; cached: boolean; left?: number };
/** Create page: name → AI-filled symbol / description / logo. Needs a wallet (≥ 1 USDC); `fresh` skips the 24 h per-name cache. */
export const aiTokenDraft = (name: string, address: string, fresh = false) => post<TokenDraft>("/ai/token-draft", { name, address, fresh });
export const useAiDraftQuota = (address?: string) =>
  useQuery({ queryKey: ["ai-draft-quota", address], queryFn: () => get<{ left: number; perDay: number }>(`/ai/token-draft/quota?address=${address}`), enabled: !!address, staleTime: 10_000 });
/** `name` / `symbol` / `description` / `logo` override the AI copy when the launcher edited them by hand. */
export const claimHotspot = (id: number, body: { address: string; mode: "standard" | "tax"; buyTaxBps?: number; sellTaxBps?: number; lang?: HotspotLang; name?: string; symbol?: string; description?: string; logo?: string }) => post<HotspotClaim>(`/hotspots/${id}/claim`, body);
export const reportHotspotLaunch = (claimId: number, body: { address: string; token: string; txHash: string }) => post<{ ok: boolean }>(`/hotspots/claims/${claimId}`, body);
/** Owner-signed admin calls; the message format must match the indexer's `hotspotAdminMessage`. */
export const hotspotAdminMessage = (action: string, ts: number, payload: unknown) => `Arm hotspots admin\naction: ${action}\nts: ${ts}\n\n${JSON.stringify(payload ?? {})}`;
export const postHotspotAdmin = <T,>(path: string, body: { author: string; ts: number; signature: string; payload: unknown }) => post<T>(`/admin/hotspots${path}`, body);
/** Owner-signed test post to the official Telegram channel; action = `telegram:test`. */
export const postAdminTelegramTest = (body: { author: string; ts: number; signature: string; payload: unknown }) => post<{ ok: boolean; error?: string }>(`/admin/telegram/test`, body);
/** Owner-signed token moderation (hide / show, pin / unpin on the public site); action = `token:<lowercase address>`. */
export type TokenFlags = { hidden?: boolean; pinned?: boolean };
export const postAdminToken = (address: string, body: { author: string; ts: number; signature: string; payload: TokenFlags }) => post<{ ok: true; hidden: boolean; pinned: boolean }>(`/admin/tokens/${address}`, body);
export async function uploadLogo(file: File): Promise<{ url: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status}`);
  return json as { url: string };
}

/** Must match indexer/src/api.ts */
export const commentMessage = (token: string, text: string, ts: number, replyTo?: number | null) =>
  `Arm comment\ntoken: ${token.toLowerCase()}\nreplyTo: ${replyTo ?? "-"}\nts: ${ts}\n\n${text}`;
export const likeMessage = (commentId: number, ts: number) => `Arm like\ncomment: ${commentId}\nts: ${ts}`;
export const ctoMessage = (token: string, newPayout: string, contact: string, reason: string, ts: number) =>
  `Arm CTO request\ntoken: ${token.toLowerCase()}\nnewPayout: ${newPayout.toLowerCase()}\ncontact: ${contact}\nts: ${ts}\n\n${reason}`;
export const ctoReviewMessage = (id: number, status: string, ts: number) => `Arm CTO review\nrequest: ${id}\nstatus: ${status}\nts: ${ts}`;

/** Progress toward graduation, 0–100. */
export const progressOf = (t: TokenView) => {
  const th = Number(t.graduationThreshold);
  if (!th) return 0;
  return Math.min(100, (Number(t.pairedUsdc) / th) * 100);
};
