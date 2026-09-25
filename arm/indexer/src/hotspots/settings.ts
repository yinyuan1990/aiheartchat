import { sql } from "../db.js";

/**
 * Runtime knobs for the AI Meme Radar. Stored as one JSON row in `settings`; the owner edits them from /admin.
 *
 * Radar v2 (boss spec, 9.10 night): cheap X usage — rotate official regional trend boards, read followed accounts in
 * grouped searches with since_id, one hourly "breakout" search, hard daily caps — local rules + one cached batched AI
 * safety call for filtering, local dedupe, and AI copy only when a user clicks Launch (plus a small pre-generated top).
 */
export type HotspotSettings = {
  enabled: boolean;
  /** public platforms the crawler pulls from */
  sources: { x: boolean; weibo: boolean };
  /** crawl cadence — every tick pulls `xRegionsPerTick` regional boards + Weibo, then filters / merges / publishes */
  intervalMs: number;

  // ---- X trends (GET /2/trends/by/woeid, $0.01 per request, 50 trends each)
  /** rotation order of regions; codes map to WOEIDs in sources.ts */
  xRegions: string[];
  /** boards per trend fetch: 1 = basic, 2 = event mode (doubles the trend spend) */
  xRegionsPerTick: number;
  /** how often boards are fetched (boss 9.11: $1/day total → hourly, 24 req ≈ $0.24/day; the 10-min tick was $1.44) */
  xTrendIntervalMs: number;

  // ---- X followed accounts (one `from:` recent search per account, since_id per account, billed per RETURNED post $0.005)
  xAccounts: string[];
  /** normal accounts are polled every round; a round with no new posts costs nothing */
  xAccountsIntervalMs: number;
  /** an account averaging at least this many posts / day is "prolific" and gets sampled instead of read in full (0 = off) */
  xBusyPostsPerDay: number;
  /** prolific accounts are sampled this often … */
  xBusyIntervalMs: number;
  /** … with a recent-posts window sized so that about this many of their posts are read per day in total
   *  (window = interval × target / observed rate; a 100-post/day feed → ~7-minute windows) */
  xBusyReadPerDay: number;

  // ---- X breakout posts (hourly recent search for suddenly viral media posts)
  xBreakoutEnabled: boolean;
  xBreakoutIntervalMs: number;
  xBreakoutMinLikes: number;
  xBreakoutMinReposts: number;
  xBreakoutLang: string;

  // ---- X hard caps (our own accounting matches the X console to the post; ALSO set a cap in the X developer console)
  /** new posts read per UTC day across accounts + breakout */
  xDailyPostCap: number;
  /** estimated spend per UTC day after which every X call is skipped until midnight UTC; account / breakout reads are
   *  also paced along the day (skipped while spend is ahead of `budget × hour/24 + 15 %`) so the evening is not empty */
  xDailyBudgetUsd: number;

  // ---- public pool
  /** hotspots not seen for this long leave the public list (status → expired) */
  publicWindowHours: number;
  /** most X items kept in the public pool (the rest, in PUBLIC_ORDER, are parked as expired each tick) — boss 9.11: 30 */
  xPublicMax: number;
  /** most Weibo items kept in the public pool */
  weiboPublicMax: number;
  /** second-layer AI safety classification (batched, cached forever); off = local rules only */
  aiFilter: boolean;
  /** how many of the top public hotspots get token copy pre-generated (the rest is generated on click) */
  pregenTop: number;
  /** background painter: render the AI logo for every shown hotspot that has copy (Pollinations, free; one at a time) */
  pregenLogos: boolean;
  /** total AI copy generations per UTC day (pre-generated + on-click) */
  aiDailyCap: number;
  /** on-click generations per IP per hour */
  aiPerIpHour: number;
  /** topics containing any of these words are blocked locally (lower-cased substring match) */
  blacklist: string[];

  // ---- launches
  quotaPerAddress: number;
  quotaPerIp: number;
  tax: { buyTaxBps: number; sellTaxBps: number; marketingBps: number };
  // ---- create-page AI drafts
  aiDraftDailyCap: number;
  aiDraftPerIpHour: number;
  aiDraftPerAddressDay: number;
  // ---- site switches (not radar-related, but they ride on the same owner-signed settings row)
  /** show the floating "bug report" button on every page (boss 9.13: must be switchable from /admin) */
  bugButton: boolean;
  /** /tools cross-chain swap (BNB ⇄ Arc USDC via LI.FI, non-custodial). boss 9.15: per-swap USD cap, editable in /admin */
  swapEnabled: boolean;
  swapMaxUsd: number;
  /** Telegram buy bot (9.17): master switch for posts to the official channel (group subscriptions are per-group) */
  tgEnabled: boolean;
  /** official channel posts buys ≥ this many USD */
  tgChannelMinBuyUsd: number;
  /** official channel announces every new launch */
  tgLaunches: boolean;
  /** attach the token logo as a photo to posts (boss 9.17: off — text only) */
  tgPhotos: boolean;
  // ---- automatic buyback & burn (boss 9.18): keeper wallet buys `bbToken` every `bbIntervalMin` minutes with
  // `bbAmountUsd` USDC, swap recipient = dead address; keeps `bbReserveUsd` untouched for gas
  bbEnabled: boolean;
  bbToken: string;
  bbIntervalMin: number;
  bbAmountUsd: number;
  bbReserveUsd: number;
  bbSlippageBps: number;
  // ---- public "next burn" countdown card (boss 9.23): the project burns `burnToken` by hand every `burnIntervalDays`;
  // the card shows the countdown, the planned quantity and its current USD value. Two placements, each with its own
  // /admin switch (boss 9.23 10:57): the home page (default OFF) and the burned token's own page (default on).
  burnCardHome: boolean;
  burnCardToken: boolean;
  /** token being burned; "" = the token of the most recent recorded burn */
  burnToken: string;
  /** planned whole tokens per burn; 0 = the quantity of the most recent recorded burn */
  burnAmount: number;
  burnIntervalDays: number;
  /** ISO anchor of the next burn; "" = last recorded burn + interval. Rolls forward by the interval when it passes. */
  burnNextAt: string;
};

/** The original celebrities (9.8: Musk / CZ / Cathie Wood / Saylor). */
export const ORIGINAL_X_CELEBS = ["elonmusk", "cz_binance", "cathiedwood", "saylor"];

/** Accounts the boss named explicitly (9.11), in his three tiers. */
export const BOSS_X_ACCOUNTS = [
  // tier 1 — pop culture / viral news
  "popbase", "popcrave", "dexerto", "dailyloud", "tmz",
  // tier 2 — film & entertainment
  "discussingfilm", "culturecrave", "filmupdates", "thepophive",
  // tier 3 — wider culture
  "koreaboo", "hotnewhiphop", "marionawfal",
];

/**
 * Boss (9.11): the original celebrities and his 12 lead the list, the filter drawer and the public ordering
 * (their posts carry the most weight).
 */
export const PINNED_X_ACCOUNTS = [...ORIGINAL_X_CELEBS, ...BOSS_X_ACCOUNTS];

/**
 * Default followed accounts = the 16 pinned + 30 across crypto / AI / meme culture / gaming / sports / entertainment /
 * tech / comedy & animals (46 in total, the count he fixed). Editable in /admin; the crawler splits them into
 * ≤512-char query groups.
 */
export const DEFAULT_X_ACCOUNTS = [
  ...PINNED_X_ACCOUNTS,
  // crypto
  "vitalikbuterin", "brian_armstrong",
  // AI
  "sama", "openai", "karpathy", "ylecun",
  // meme culture / internet
  "dril", "weirddalle", "9gag", "memes", "knowyourmeme", "dogecoin",
  // gaming
  "playstation", "pokemon", "fortnitegame",
  // sports
  "nba", "nfl", "premierleague", "f1",
  // entertainment
  "netflix", "marvel", "starwars", "taylorswift13", "mrbeast",
  // tech products
  "apple", "tesla", "nvidia",
  // comedy & animals
  "theonion", "dog_rates", "cats",
];

/** Former defaults dropped (9.11) to make room for the boss's list without changing the total — corporate / news feeds. */
const RETIRED_DEFAULTS = ["coinbase", "binance", "anthropicai", "googledeepmind", "xbox", "nintendoamerica", "espn", "verge", "natgeo"];

/** Rotation order of the regional boards (codes → WOEIDs in sources.ts). */
export const DEFAULT_X_REGIONS = ["WW", "US", "GB", "JP", "KR", "IN", "ID", "BR"];

export const DEFAULT_SETTINGS: HotspotSettings = {
  enabled: true,
  sources: { x: false, weibo: true },
  intervalMs: 10 * 60_000,
  xRegions: DEFAULT_X_REGIONS,
  xRegionsPerTick: 1,
  xTrendIntervalMs: 60 * 60_000,
  xAccounts: DEFAULT_X_ACCOUNTS,
  xAccountsIntervalMs: 60 * 60_000,
  xBusyPostsPerDay: 6,
  xBusyIntervalMs: 3 * 60 * 60_000,
  xBusyReadPerDay: 4,
  // 9.11 night, boss: X must cost ≈ $1/day. Breakout posts never reach the 30 public slots (accounts fill them) → off
  // by default; the owner can switch it on for events.
  xBreakoutEnabled: false,
  xBreakoutIntervalMs: 12 * 60 * 60_000,
  xBreakoutMinLikes: 20_000,
  xBreakoutMinReposts: 5_000,
  xBreakoutLang: "en",
  xDailyPostCap: 160, // $0.80 — plus 24 hourly boards ($0.24) ≈ the $1/day the boss set
  xDailyBudgetUsd: 1,
  publicWindowHours: 24,
  xPublicMax: 30,
  // 9.14 boss: Weibo 50 → 20 so the AI copy / logo budget covers every shown card; 9.23 boss: back to 50 (X is the
  // only other source and it is currently dry, so Weibo is the whole radar)
  weiboPublicMax: 10,
  aiFilter: true,
  // 9.11 night, boss: every card must show its AI logo → copy for the whole shown pool (30 X + 50 Weibo ≈ $0.001 each
  // on DeepSeek) and logos painted in the background (free). Per-IP limit raised: 20/h tripped while he was testing.
  pregenTop: 10,
  pregenLogos: true,
  // 9.14: 500 ran out by evening (the pool churns ~450 new cards/day, each burns one call before dropping out of
  // view). DeepSeek V3 copy ≈ $0.0005/call → 1000 ≈ $0.5/day worst case; past the cap the cards get template copy
  // and still get their (free) logo.
  aiDailyCap: 1000,
  aiPerIpHour: 60,
  blacklist: [],
  quotaPerAddress: 20,
  quotaPerIp: 20,
  tax: { buyTaxBps: 300, sellTaxBps: 300, marketingBps: 5000 },
  aiDraftDailyCap: 300,
  aiDraftPerIpHour: 12,
  aiDraftPerAddressDay: 1,
  bugButton: true,
  swapEnabled: true,
  swapMaxUsd: 10,
  tgEnabled: true,
  tgChannelMinBuyUsd: 50,
  tgLaunches: true,
  tgPhotos: false,
  bbEnabled: false,
  bbToken: "",
  bbIntervalMin: 60,
  bbAmountUsd: 10,
  bbReserveUsd: 5,
  bbSlippageBps: 300,
  burnCardHome: false,
  burnCardToken: true,
  burnToken: "",
  burnAmount: 0,
  burnIntervalDays: 7,
  burnNextAt: "",
};

const KEY = "hotspots";
let cache: { at: number; value: HotspotSettings } | null = null;

export async function getSettings(): Promise<HotspotSettings> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const [row] = await sql`select value from settings where key = ${KEY}`;
  const merged = normalize({ ...DEFAULT_SETTINGS, ...((row?.value as Partial<HotspotSettings>) ?? {}) });
  cache = { at: Date.now(), value: merged };
  return merged;
}

export async function saveSettings(patch: Partial<HotspotSettings>): Promise<HotspotSettings> {
  const cur = await getSettings();
  const next = normalize({ ...cur, ...patch, sources: { ...cur.sources, ...(patch.sources ?? {}) }, tax: { ...cur.tax, ...(patch.tax ?? {}) } });
  await sql`insert into settings (key, value, updated_at) values (${KEY}, ${sql.json(next as never)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  cache = { at: Date.now(), value: next };
  return next;
}

/** Bump when DEFAULT_X_ACCOUNTS gains handles the boss asked for: the stored list is unioned with the defaults once. */
const ACCOUNTS_VERSION = 5;
/** Bump when the boss changes the X spend targets: the stored cost knobs are reset to the new defaults once. */
const COST_VERSION = 2;
/** Bump when the boss changes the shown-pool size / copy cap (9.14: Weibo 20, cap 1000; 9.23: Weibo 50). */
const POOL_VERSION = 2;
const COST_KEYS = [
  "xTrendIntervalMs", "xAccountsIntervalMs", "xBusyPostsPerDay", "xBusyIntervalMs", "xBusyReadPerDay", "xBreakoutEnabled", "xBreakoutIntervalMs", "xDailyPostCap", "xDailyBudgetUsd",
  "pregenTop", "pregenLogos", "aiDailyCap", "aiPerIpHour", // v2 (9.11 night): logos on every card
] as const;

/**
 * Settings migration: v2 (10 Sep) moved from 5 followed accounts to the vertical list and the 10-minute cadence;
 * every later ACCOUNTS_VERSION bump merges newly added default handles into the owner's stored list (never removes);
 * a COST_VERSION bump re-applies the default spend knobs (9.11 night: $1/day).
 */
export async function migrateSettingsV2() {
  const [row] = await sql`select value from settings where key = 'hotspots_v2'`;
  const done = (row?.value ?? null) as { accountsVersion?: number; costVersion?: number; poolVersion?: number } | null;
  const accountsStale = !done || (done.accountsVersion ?? 1) < ACCOUNTS_VERSION;
  const costStale = !done || (done.costVersion ?? 0) < COST_VERSION;
  const poolStale = !done || (done.poolVersion ?? 0) < POOL_VERSION;
  if (!accountsStale && !costStale && !poolStale) return;
  const cur = await getSettings();
  await saveSettings({
    // 9.14 boss: Weibo 20 + copy cap 1000 (only these two knobs; the X spend settings are left alone); 9.23 (pool v2)
    // only re-applies the Weibo pool size — the copy cap the owner may have tuned since is left as is
    ...(poolStale ? { weiboPublicMax: DEFAULT_SETTINGS.weiboPublicMax, ...((done?.poolVersion ?? 0) < 1 ? { aiDailyCap: DEFAULT_SETTINGS.aiDailyCap } : {}) } : {}),
    ...(accountsStale
      ? {
          // defaults first (boss tiers lead), then whatever the owner added by hand; retired defaults go
          xAccounts: [...new Set([...DEFAULT_X_ACCOUNTS, ...cur.xAccounts])].filter((h) => !RETIRED_DEFAULTS.includes(h)),
        }
      : {}),
    ...(costStale ? Object.fromEntries(COST_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) : {}),
    ...(done ? {} : { intervalMs: DEFAULT_SETTINGS.intervalMs, sources: { x: false, weibo: true } }),
  });
  await sql`insert into settings (key, value, updated_at) values ('hotspots_v2', ${sql.json({ at: new Date().toISOString(), accountsVersion: ACCOUNTS_VERSION, costVersion: COST_VERSION, poolVersion: POOL_VERSION })}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  console.log(`[radar] settings migrated (accounts v${ACCOUNTS_VERSION}, cost v${COST_VERSION}, pool v${POOL_VERSION})`);
}

const handleList = (v: unknown, d: string[]) =>
  Array.isArray(v) ? [...new Set(v.map((h) => String(h).replace(/^@/, "").trim().toLowerCase()).filter((h) => /^[a-z0-9_]{1,15}$/.test(h)))].slice(0, 60) : d;

/** Clamp everything to sane bounds so a typo in the admin form cannot wedge the crawler or the API bill. */
function normalize(s: HotspotSettings): HotspotSettings {
  const int = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const regions = Array.isArray(s.xRegions) ? [...new Set(s.xRegions.map((r) => String(r).trim().toUpperCase()).filter((r) => /^[A-Z]{2}$/.test(r)))] : DEFAULT_X_REGIONS;
  return {
    enabled: !!s.enabled,
    sources: { x: s.sources?.x === undefined ? false : !!s.sources.x, weibo: s.sources?.weibo === undefined ? true : !!s.sources.weibo },
    intervalMs: int(s.intervalMs, 60_000, 24 * 3_600_000, DEFAULT_SETTINGS.intervalMs),
    xRegions: regions.length ? regions : DEFAULT_X_REGIONS,
    xRegionsPerTick: int(s.xRegionsPerTick, 1, 8, 1),
    xTrendIntervalMs: int(s.xTrendIntervalMs, 10 * 60_000, 24 * 3_600_000, DEFAULT_SETTINGS.xTrendIntervalMs),
    xAccounts: handleList(s.xAccounts, DEFAULT_X_ACCOUNTS),
    xAccountsIntervalMs: int(s.xAccountsIntervalMs, 15 * 60_000, 24 * 3_600_000, DEFAULT_SETTINGS.xAccountsIntervalMs),
    xBusyPostsPerDay: int(s.xBusyPostsPerDay, 0, 1000, DEFAULT_SETTINGS.xBusyPostsPerDay),
    xBusyIntervalMs: int(s.xBusyIntervalMs, 60 * 60_000, 24 * 3_600_000, DEFAULT_SETTINGS.xBusyIntervalMs),
    xBusyReadPerDay: int(s.xBusyReadPerDay, 1, 100, DEFAULT_SETTINGS.xBusyReadPerDay),
    xBreakoutEnabled: s.xBreakoutEnabled === undefined ? true : !!s.xBreakoutEnabled,
    xBreakoutIntervalMs: int(s.xBreakoutIntervalMs, 15 * 60_000, 24 * 3_600_000, DEFAULT_SETTINGS.xBreakoutIntervalMs),
    xBreakoutMinLikes: int(s.xBreakoutMinLikes, 100, 10_000_000, DEFAULT_SETTINGS.xBreakoutMinLikes),
    xBreakoutMinReposts: int(s.xBreakoutMinReposts, 0, 10_000_000, DEFAULT_SETTINGS.xBreakoutMinReposts),
    xBreakoutLang: /^[a-z]{2}$/.test(String(s.xBreakoutLang ?? "")) ? String(s.xBreakoutLang) : "en",
    xDailyPostCap: int(s.xDailyPostCap, 0, 10_000, DEFAULT_SETTINGS.xDailyPostCap),
    xDailyBudgetUsd: num(s.xDailyBudgetUsd, 0, 1000, DEFAULT_SETTINGS.xDailyBudgetUsd),
    publicWindowHours: int(s.publicWindowHours, 1, 24 * 7, DEFAULT_SETTINGS.publicWindowHours),
    xPublicMax: int(s.xPublicMax, 5, 500, DEFAULT_SETTINGS.xPublicMax),
    weiboPublicMax: int(s.weiboPublicMax, 5, 500, DEFAULT_SETTINGS.weiboPublicMax),
    aiFilter: s.aiFilter === undefined ? true : !!s.aiFilter,
    pregenTop: int(s.pregenTop, 0, 500, DEFAULT_SETTINGS.pregenTop),
    pregenLogos: s.pregenLogos === undefined ? true : !!s.pregenLogos,
    aiDailyCap: int(s.aiDailyCap, 0, 10_000, DEFAULT_SETTINGS.aiDailyCap),
    aiPerIpHour: int(s.aiPerIpHour, 0, 1000, DEFAULT_SETTINGS.aiPerIpHour),
    blacklist: Array.isArray(s.blacklist) ? s.blacklist.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 500) : [],
    quotaPerAddress: int(s.quotaPerAddress, 0, 10_000, DEFAULT_SETTINGS.quotaPerAddress),
    quotaPerIp: int(s.quotaPerIp, 0, 10_000, DEFAULT_SETTINGS.quotaPerIp),
    tax: {
      buyTaxBps: int(s.tax?.buyTaxBps, 0, 1000, DEFAULT_SETTINGS.tax.buyTaxBps),
      sellTaxBps: int(s.tax?.sellTaxBps, 0, 1000, DEFAULT_SETTINGS.tax.sellTaxBps),
      marketingBps: int(s.tax?.marketingBps, 0, 10_000, DEFAULT_SETTINGS.tax.marketingBps),
    },
    aiDraftDailyCap: int(s.aiDraftDailyCap, 0, 100_000, DEFAULT_SETTINGS.aiDraftDailyCap),
    aiDraftPerIpHour: int(s.aiDraftPerIpHour, 0, 1000, DEFAULT_SETTINGS.aiDraftPerIpHour),
    aiDraftPerAddressDay: int(s.aiDraftPerAddressDay, 0, 1000, DEFAULT_SETTINGS.aiDraftPerAddressDay),
    bugButton: s.bugButton === undefined ? true : !!s.bugButton,
    swapEnabled: s.swapEnabled === undefined ? true : !!s.swapEnabled,
    swapMaxUsd: num(s.swapMaxUsd, 0, 100_000, DEFAULT_SETTINGS.swapMaxUsd),
    tgEnabled: s.tgEnabled === undefined ? true : !!s.tgEnabled,
    tgChannelMinBuyUsd: num(s.tgChannelMinBuyUsd, 0, 1_000_000, DEFAULT_SETTINGS.tgChannelMinBuyUsd),
    tgLaunches: s.tgLaunches === undefined ? true : !!s.tgLaunches,
    tgPhotos: !!s.tgPhotos,
    bbEnabled: !!s.bbEnabled,
    bbToken: /^0x[0-9a-fA-F]{40}$/.test(String(s.bbToken ?? "")) ? String(s.bbToken) : "",
    bbIntervalMin: int(s.bbIntervalMin, 1, 60 * 24 * 30, DEFAULT_SETTINGS.bbIntervalMin),
    bbAmountUsd: num(s.bbAmountUsd, 0, 1_000_000, DEFAULT_SETTINGS.bbAmountUsd),
    bbReserveUsd: num(s.bbReserveUsd, 0, 10_000, DEFAULT_SETTINGS.bbReserveUsd),
    bbSlippageBps: int(s.bbSlippageBps, 10, 5_000, DEFAULT_SETTINGS.bbSlippageBps),
    burnCardHome: !!s.burnCardHome,
    burnCardToken: s.burnCardToken === undefined ? true : !!s.burnCardToken,
    burnToken: /^0x[0-9a-fA-F]{40}$/.test(String(s.burnToken ?? "")) ? String(s.burnToken) : "",
    burnAmount: num(s.burnAmount, 0, 1e12, 0),
    burnIntervalDays: num(s.burnIntervalDays, 0.01, 365, DEFAULT_SETTINGS.burnIntervalDays),
    burnNextAt: Number.isFinite(new Date(String(s.burnNextAt ?? "")).getTime()) && s.burnNextAt ? new Date(String(s.burnNextAt)).toISOString() : "",
  };
}
