/**
 * Signal sources for the AI Meme Radar (v2, boss spec 9.10). Each adapter returns flat `RawSignal`s — the service
 * stores them in the raw pool, merges, filters and publishes. Adapters never throw on a bad upstream: they log and
 * return what they have, so one dead source cannot stall the rest.
 *
 *  X (official API v2, pay-per-use — needs X_BEARER_TOKEN):
 *   - trends   : GET /2/trends/by/woeid/{woeid}?max_trends=50 — $0.01 per request, one region per call. The service
 *                rotates regions (1-2 per 10-minute tick) instead of polling all of them.
 *   - accounts : one recent search per handle "from:a -is:retweet -is:reply" (requests are free, only RETURNED posts
 *                bill at $0.005), since_id per account, max_results = 10 (the API minimum), and a `start_time` window
 *                so a prolific account is sampled instead of read in full — see service.ts for the two-tier cadence.
 *   - breakout : hourly recent search for suddenly viral media posts (min_likes / min_reposts), 10 per call.
 *  Weibo: public hot-search JSON, free.
 */

export type Platform = "x" | "weibo";
export type SourceType = "trend" | "key_account" | "community";
export type Lang = "en" | "zh";

export type RawSignal = {
  platform: Platform;
  sourceType: SourceType;
  /** region code of the board (WW for posts) */
  region: string;
  /** stable id within (platform, sourceType, region): the normalized trend name, or the post id */
  itemId: string;
  title: string;
  lang: Lang;
  url: string;
  /** X handle (lower-case, no @) for key-account posts */
  account?: string;
  /** raw numbers as the source reports them (rank, posts, likes…) */
  metrics: Record<string, number | string>;
  /** snippets that describe the topic — fed to the AI copy prompt on click */
  context: string[];
  image?: string | null;
};

const UA = "Mozilla/5.0 (compatible; ArmHotspots/2.0; +https://arm.yyheart.com)";

class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`${status} ${body.slice(0, 200)}`);
  }
}

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export const normKey = (s: string) =>
  s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/^#/, "").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
export const langOf = (s: string): Lang => (/[\u4e00-\u9fff]/.test(s) ? "zh" : "en");

// ------------------------------------------------------------------ X trends

/** Region code → WOEID for GET /2/trends/by/woeid. */
export const X_WOEID: Record<string, number> = {
  WW: 1, US: 23424977, GB: 23424975, JP: 23424856, KR: 23424868, IN: 23424848, ID: 23424846, BR: 23424768,
  SG: 23424948, HK: 24865698, AU: 23424748, CA: 23424775, DE: 23424829, FR: 23424819, ES: 23424950, MX: 23424900, TR: 23424969, NG: 23424908,
};

const xAuth = () => (process.env.X_BEARER_TOKEN ? { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } : null);

/** One regional board, 50 trends, one billable request. */
export async function fetchXTrends(region: string): Promise<RawSignal[]> {
  const auth = xAuth();
  const woeid = X_WOEID[region];
  if (!auth || !woeid) return [];
  type Trends = { data?: { trend_name: string; tweet_count?: number }[] };
  const j = await getJson<Trends>(`https://api.x.com/2/trends/by/woeid/${woeid}?max_trends=50&trend.fields=trend_name,tweet_count`, { headers: auth });
  const list = (j.data ?? []).filter((t) => t.trend_name);
  return list.map((t, i) => ({
    platform: "x" as const,
    sourceType: "trend" as const,
    region,
    itemId: normKey(t.trend_name) || t.trend_name.toLowerCase(),
    title: t.trend_name.replace(/^#/, ""),
    lang: langOf(t.trend_name),
    url: `https://x.com/search?q=${encodeURIComponent(t.trend_name)}&src=trend_click`,
    metrics: { posts: t.tweet_count ?? 0, rank: i + 1 },
    context: [],
  }));
}

// ------------------------------------------------------------------ X posts (accounts + breakout)

type XPost = { id: string; text: string; created_at?: string; lang?: string; author_id?: string; public_metrics?: Record<string, number>; referenced_tweets?: { type: string; id: string }[]; attachments?: { media_keys?: string[] } };
type XIncludes = { users?: { id: string; username: string }[]; tweets?: XPost[]; media?: { media_key: string; url?: string; preview_image_url?: string }[] };
type XSearch = { data?: XPost[]; includes?: XIncludes; meta?: { newest_id?: string; result_count?: number; next_token?: string } };

const stripPost = (s: string) => s.replace(/https?:\/\/t\.co\/\w+/g, "").replace(/\s+/g, " ").trim();

/** Search request shared by the account reader and the breakout finder. Returns posts + how many were read (billed). */
async function searchRecent(query: string, opts: { maxResults: number; sinceId?: string; startTime?: Date }): Promise<{ posts: RawSignal[]; read: number; newestId?: string }> {
  const auth = xAuth();
  if (!auth) return { posts: [], read: 0 };
  const q = new URLSearchParams({
    query,
    max_results: String(Math.min(100, Math.max(10, opts.maxResults))),
    "tweet.fields": "created_at,public_metrics,lang,author_id,referenced_tweets,attachments",
    expansions: "author_id,attachments.media_keys,referenced_tweets.id",
    "user.fields": "username",
    "media.fields": "url,preview_image_url,type",
  });
  // 9.20: X now rejects since_id together with start_time ("At most one of [start_time, since_id] can be provided" →
  // 400, every account read failed for ~a day). start_time wins when both are known: the window is never wider than
  // "since the last visit", so it is the narrower bound and still never re-reads (re-bills) posts we already saw.
  // X wants start_time ≥ 10 s in the past and within the last 7 days.
  if (opts.startTime) q.set("start_time", new Date(Math.max(Date.now() - 6.9 * 86_400_000, Math.min(opts.startTime.getTime(), Date.now() - 30_000))).toISOString().replace(/\.\d{3}Z$/, "Z"));
  else if (opts.sinceId) q.set("since_id", opts.sinceId);
  const r = await getJson<XSearch>(`https://api.x.com/2/tweets/search/recent?${q}`, { headers: auth });
  const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username.toLowerCase()]));
  const quoted = new Map((r.includes?.tweets ?? []).map((t) => [t.id, t]));
  const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m.url ?? m.preview_image_url ?? null]));
  const posts: RawSignal[] = [];
  for (const p of r.data ?? []) {
    const own = stripPost(p.text);
    const ref = p.referenced_tweets?.find((t) => t.type === "quoted");
    const qt = ref ? stripPost(quoted.get(ref.id)?.text ?? "") : "";
    // "True" / "!!" pointing at a quote: the quote IS the topic; the reaction becomes context
    const title = own.length >= 12 || !qt ? own : qt;
    if (title.length < 4) continue; // bare image / link posts have nothing to name a token after
    const handle = users.get(p.author_id ?? "") ?? "i";
    const m = p.public_metrics ?? {};
    posts.push({
      platform: "x",
      sourceType: "key_account",
      region: "WW",
      itemId: p.id,
      title: title.slice(0, 140),
      lang: langOf(title),
      url: `https://x.com/${handle}/status/${p.id}`,
      account: handle,
      metrics: { likes: m.like_count ?? 0, reposts: m.retweet_count ?? 0, replies: m.reply_count ?? 0, views: m.impression_count ?? 0, posted: p.created_at ?? "" },
      context: [`@${handle}: ${own || "(link)"}`, qt ? `Quoted: ${qt}` : ""].filter(Boolean).map((c) => c.slice(0, 240)),
      image: p.attachments?.media_keys?.map((k) => media.get(k)).find(Boolean) ?? null,
    });
  }
  return { posts, read: r.meta?.result_count ?? (r.data?.length ?? 0), newestId: r.meta?.newest_id };
}

/**
 * One followed account: its own posts inside the `startTime` window (`sinceId` is only the fallback when there is no
 * window — X refuses both at once), newest first, at most 10 (the API
 * minimum — we pay per returned post, never per request). Throws `XRateLimited` on 429 so the caller can stop the
 * round; any other upstream error is logged and yields nothing.
 */
export class XRateLimited extends Error {}
export async function fetchXAccount(handle: string, opts: { sinceId?: string; startTime: Date }): Promise<{ signals: RawSignal[]; read: number; newestId?: string }> {
  try {
    const r = await searchRecent(`from:${handle} -is:retweet -is:reply`, { maxResults: 10, sinceId: opts.sinceId, startTime: opts.startTime });
    return { signals: r.posts, read: r.read, newestId: r.newestId };
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw new XRateLimited(e.message);
    console.warn(`[radar:x] account @${handle} failed:`, (e as Error).message);
    return { signals: [], read: 0 };
  }
}

/**
 * Breakout finder: not-yet-trending posts that just exploded (high likes / reposts, media, no retweets / replies /
 * promos), newest first, ≤ 10 per call. `min_likes` / `min_reposts` are the API-side operators (web-search
 * `min_faves` / `min_retweets` are NOT accepted). If the tier rejects the operators the error is returned so /admin
 * can show it and the service stops retrying every hour.
 */
export async function fetchXBreakout(opts: { minLikes: number; minReposts: number; lang: string }, state: { since: Record<string, string> }, budgetPosts: number): Promise<{ signals: RawSignal[]; read: number; requests: number; error?: string }> {
  if (budgetPosts <= 0) return { signals: [], read: 0, requests: 0 };
  const query = `min_likes:${opts.minLikes} min_reposts:${opts.minReposts} has:media -is:retweet -is:reply -is:quote lang:${opts.lang} -giveaway -airdrop -promo`;
  try {
    const r = await searchRecent(query, { maxResults: 10, sinceId: state.since.breakout });
    if (r.newestId) state.since.breakout = r.newestId;
    return { signals: r.posts.map((p) => ({ ...p, sourceType: "community" as const })), read: r.read, requests: 1 };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn("[radar:x] breakout search failed:", msg);
    return { signals: [], read: 0, requests: 1, error: e instanceof HttpError && e.status === 400 ? msg : undefined };
  }
}

// ------------------------------------------------------------------ Weibo hot search (public JSON, free)

export async function fetchWeibo(): Promise<RawSignal[]> {
  type Resp = { ok?: number; data?: { realtime?: { word: string; note?: string; num?: number; realpos?: number; label_name?: string }[] } };
  try {
    const j = await getJson<Resp>("https://weibo.com/ajax/side/hotSearch", { headers: { referer: "https://weibo.com/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36" } });
    const list = (j.data?.realtime ?? []).filter((r) => r.word && !/^(广告|推荐)$/.test(r.label_name ?? "")).slice(0, 50);
    return list.map((r, i) => ({
      platform: "weibo" as const,
      sourceType: "trend" as const,
      region: "CN",
      itemId: normKey(r.word) || r.word,
      title: r.word,
      lang: "zh" as const,
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${r.word}#`)}`,
      metrics: { heat: r.num ?? 0, rank: r.realpos ?? i + 1 },
      context: r.note && r.note !== r.word ? [r.note] : [],
    }));
  } catch (e) {
    console.warn("[radar:weibo] failed", (e as Error).message);
    return [];
  }
}

export const xAvailable = () => !!process.env.X_BEARER_TOKEN;
