import { sql } from "../db.js";
import { getSettings, migrateSettingsV2, type HotspotSettings } from "./settings.js";
import { fetchWeibo, fetchXAccount, fetchXBreakout, fetchXTrends, xAvailable, XRateLimited, type Lang, type Platform, type RawSignal, type SourceType } from "./sources.js";
import { classifySafety, generateIdeas, generateLogo, imageProvider, templateIdeas, textProvider, type Ideas, type MemeCategory, type Verdict } from "./ai.js";
import { localBlock } from "./filter.js";
import { findDuplicate, normalize, sigTokens, type DedupeCandidate } from "./dedupe.js";

/**
 * AI Meme Radar v2 pipeline (boss spec 9.10), one tick every `intervalMs`:
 *
 *   fetch (X: hourly regional board + per-account two-tier reads + optional breakout, all under a paced $/day; Weibo)
 *     → raw signal pool (hotspot_signals: every occurrence, tiny rows, no AI)
 *     → merge into public hotspots (local dedupe: same id / key / link / ≥ 85 % similar within 6 h → related signals)
 *     → layer-1 local rules block (politics / war / tragedy / minors / adult / hate / medical / spam / low engagement)
 *     → layer-2 batched AI safety verdict, cached forever by title (SAFE → published, else blocked)
 *     → expire what has not been seen for `publicWindowHours`, then cap the pool per platform (`xPublicMax` / `weiboPublicMax`)
 *     → pre-generate token copy for the top `pregenTop` (everything else is generated when a user clicks Launch)
 *     → daily counters (hotspot_daily) for /admin
 *
 * Nothing here touches the chain. Settings are re-read every tick so /admin changes apply without a restart.
 */

export type HotspotStatus = "pending" | "published" | "blocked" | "merged" | "expired" | "hidden";

export type HotspotRow = {
  id: number;
  /** legacy source id kept for the unique (source, key) constraint and old rows: x | xuser | weibo */
  source: string; key: string;
  platform: Platform; source_type: SourceType; account: string | null;
  title: string; lang: Lang; norm_key: string; url: string | null; region: string | null; regions: string[];
  metrics: Record<string, number | string>; context: string[];
  signals: number; related: number; rising: boolean; key_account: boolean;
  status: HotspotStatus; blocked_reason: string | null; verdict: Verdict | null; category: MemeCategory | null; merged_into: number | null;
  ideas: (Ideas & { logoBy?: string }) | null; logo: string | null; generated_at: Date | null;
  first_seen: Date; last_seen: Date;
  // legacy, unused by v2
  score: number; rank: number | null; meme_score: number | null; filled: boolean;
  priority: number | null; acct_rank: number | null;
};

/**
 * Public ordering. Boss (9.11): the followed X accounts carry the most weight and come FIRST, in the order of the
 * account list (his 12 → elonmusk → …): round 1 = every account's newest post in list order, then round 2, … so no
 * single prolific account can push the others out. After the accounts, the spec §5 order — new within 2 h → seen in
 * several regions → rank rising → still active. `acct_rank` / `priority` are recomputed every tick (rankAccounts).
 */
export const PUBLIC_ORDER = sql`order by key_account desc, acct_rank asc nulls last, priority asc nulls last, (first_seen > now() - interval '2 hours') desc, cardinality(regions) desc, rising desc, last_seen desc, id desc`;

/** Recompute the two account ordering columns for the live X pool from the current account list. */
async function rankAccounts(accounts: string[]) {
  await sql`update hotspots h set priority = coalesce(array_position(${sql.array(accounts)}::text[], h.account), 999), acct_rank = r.rn
    from (select id, row_number() over (partition by account order by last_seen desc, id desc) as rn
          from hotspots where status = 'published' and platform = 'x' and key_account) r
    where r.id = h.id`;
  // posts from accounts no longer followed lose the key-account boost (they age out with the window)
  await sql`update hotspots set key_account = false, priority = null, acct_rank = null
    where key_account and platform = 'x' and source_type = 'key_account' and status = 'published' and (account is null or account <> all(${sql.array(accounts)}::text[]))`;
}

// X pay-per-use list prices (USD)
const X_TREND_REQ = 0.01;
const X_POST_READ = 0.005;

/**
 * Per followed account: newest post id read (since_id), last visit, and a windowed posting-rate estimate — `obsN`
 * posts seen across `obsMs` of observed window (capped at 48 h) → posts / day. The rate decides the tier: prolific
 * accounts (≥ `xBusyPostsPerDay`) are sampled with small windows instead of read in full.
 */
type AccountState = { since?: string; at?: number; obsMs?: number; obsN?: number };
const perDay = (a: AccountState) => (a.obsMs ? ((a.obsN ?? 0) / a.obsMs) * 86_400_000 : 0);

/** Persisted X crawler state: since_ids, region cursor, today's usage. A restart never re-reads (re-pays for) posts. */
type XState = {
  /** breakout since_id (legacy account-group keys may linger; they are seeded into `accounts` once) */
  since: Record<string, string>;
  accounts: Record<string, AccountState>;
  cursor: number; day: string; requests: number; searches: number; posts: number;
  lastTrends: number; lastAccounts: number; lastBreakout: number; breakoutError: string | null;
};
const utcDay = () => new Date().toISOString().slice(0, 10);
/** fraction of the current UTC day elapsed (0–1) — the spend pacing line */
const dayFraction = () => (Date.now() % 86_400_000) / 86_400_000;
async function loadXState(): Promise<XState> {
  const [row] = await sql`select value from settings where key = 'x_state'`;
  const v = (row?.value ?? {}) as Partial<XState>;
  const st: XState = {
    since: v.since ?? {}, accounts: v.accounts ?? {}, cursor: v.cursor ?? 0, day: v.day ?? utcDay(), requests: v.requests ?? 0, searches: v.searches ?? 0, posts: v.posts ?? 0,
    lastTrends: v.lastTrends ?? 0, lastAccounts: v.lastAccounts ?? 0, lastBreakout: v.lastBreakout ?? 0, breakoutError: v.breakoutError ?? null,
  };
  // one-time: the old grouped search kept one since_id per "a,b,c" group — seed every member so the first per-account
  // round does not re-read (re-pay) posts we already have
  for (const [key, id] of Object.entries(st.since)) {
    if (key === "breakout" || !key.includes(",")) continue;
    for (const h of key.split(",")) if (!st.accounts[h]?.since) (st.accounts[h] ??= {}).since = id;
    delete st.since[key];
  }
  if (st.day !== utcDay()) Object.assign(st, { day: utcDay(), requests: 0, searches: 0, posts: 0 });
  return st;
}
const saveXState = (st: XState) => sql`insert into settings (key, value, updated_at) values ('x_state', ${sql.json(st)}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
export const xCostUsd = (st: Pick<XState, "requests" | "posts">) => st.requests * X_TREND_REQ + st.posts * X_POST_READ;

/**
 * One account round. Every account gets one request (free — only returned posts bill): normal accounts read all new
 * posts since the last visit (window bounded to 3 h so downtime never backfills 10 old posts); prolific accounts are
 * visited only every `xBusyIntervalMs` and read a window sized for `xBusyReadPerDay` posts / day. The list order is the
 * boss's priority order, so when the budget / pace / rate limit stops the round early the pinned accounts came first.
 */
async function pollAccounts(s: HotspotSettings, xs: XState, budgetPosts: number, allowUsd: () => number) {
  const out: RawSignal[] = [];
  let read = 0, requests = 0, sampled = 0, stopped: string | null = null;
  const now = Date.now();
  for (const h of s.xAccounts) {
    if (budgetPosts - read < 10) { stopped = "cap"; break; } // a request cannot return fewer than 10
    if (allowUsd() - (read * X_POST_READ) <= 0) { stopped = "pace"; break; }
    const a = (xs.accounts[h] ??= {});
    const rate = perDay(a);
    const busy = s.xBusyPostsPerDay > 0 && rate >= s.xBusyPostsPerDay;
    if (busy && now - (a.at ?? 0) < s.xBusyIntervalMs) continue;
    const windowMs = busy
      ? Math.max(5 * 60_000, Math.min(s.xBusyIntervalMs, (s.xBusyIntervalMs * s.xBusyReadPerDay) / rate))
      : a.at ? Math.min(3 * 3_600_000, Math.max(s.xAccountsIntervalMs, now - a.at)) : s.xAccountsIntervalMs;
    let r: Awaited<ReturnType<typeof fetchXAccount>>;
    try {
      requests++;
      r = await fetchXAccount(h, { sinceId: a.since, startTime: new Date(now - windowMs) });
    } catch (e) {
      if (e instanceof XRateLimited) { console.warn("[radar:x] rate limited, round stopped at", h); stopped = "429"; break; }
      throw e;
    }
    read += r.read;
    if (r.newestId) a.since = r.newestId;
    a.at = now;
    // windowed rate: add this window, keep at most 48 h of observation
    let obsMs = (a.obsMs ?? 0) + windowMs, obsN = (a.obsN ?? 0) + r.read;
    if (obsMs > 48 * 3_600_000) { const k = (48 * 3_600_000) / obsMs; obsMs *= k; obsN *= k; }
    a.obsMs = Math.round(obsMs); a.obsN = Math.round(obsN * 100) / 100;
    if (busy) sampled++;
    out.push(...r.signals);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { signals: out, read, requests, sampled, stopped };
}

export const radarState = {
  lastTick: null as string | null,
  lastError: null as string | null,
  /** what the last tick did, for /admin */
  last: { fetched: 0, merged: 0, blocked: 0, published: 0, aiBatches: 0, ms: 0 },
  sources: {} as Record<string, { ok: boolean; count: number; at: string }>,
  x: {
    day: utcDay(), requests: 0, searches: 0, posts: 0, costUsd: 0, nextRegion: "WW", breakoutError: null as string | null,
    /** spend allowed so far today by the pacing line */
    paceUsd: 0,
    /** accounts currently in the prolific (sampled) tier, with their estimated posts / day */
    busy: [] as { handle: string; perDay: number }[],
    /** why the last account round ended early, if it did: cap | pace | 429 */
    lastRoundStop: null as string | null,
  },
};

let running = false;

export async function startHotspots() {
  console.log("[radar] loop started");
  await migrateSettingsV2().catch((e) => console.warn("[radar] settings migration failed", (e as Error).message));
  for (;;) {
    const s = await getSettings().catch(() => null);
    try {
      if (s?.enabled) await refreshHotspots(s);
    } catch (e) {
      radarState.lastError = (e as Error).message;
      console.error("[radar]", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, s?.intervalMs ?? 600_000));
  }
}

export async function refreshHotspots(given?: HotspotSettings) {
  if (running) return;
  running = true;
  const t0 = Date.now();
  try {
    const s = given ?? (await getSettings());
    const xs = await loadXState();
    const before = { req: xs.requests + xs.searches, posts: xs.posts };
    const signals: RawSignal[] = [];
    const mark = (id: string, ok: boolean, n: number) => (radarState.sources[id] = { ok, count: n, at: new Date().toISOString() });

    // ---- 1. fetch
    // pacing line: spend may run at most 15 % of the budget ahead of the clock, so the evening (US daytime) is never dark
    const paceUsd = () => Math.min(s.xDailyBudgetUsd, s.xDailyBudgetUsd * (dayFraction() + 0.15));
    if (s.sources.x && xAvailable()) {
      const overBudget = () => xCostUsd(xs) >= s.xDailyBudgetUsd;
      const allowUsd = () => paceUsd() - xCostUsd(xs);
      // regional trend boards, rotating, at most once per xTrendIntervalMs ($0.01 each)
      if (Date.now() - xs.lastTrends >= s.xTrendIntervalMs && !overBudget()) {
        let trendN = 0;
        for (let k = 0; k < s.xRegionsPerTick && !overBudget(); k++) {
          const region = s.xRegions[(xs.cursor + k) % s.xRegions.length];
          try {
            const list = await fetchXTrends(region);
            xs.requests++;
            trendN += list.length;
            signals.push(...list);
          } catch (e) {
            xs.requests++;
            console.warn(`[radar:x] trends ${region} failed:`, (e as Error).message);
          }
        }
        xs.cursor = (xs.cursor + s.xRegionsPerTick) % s.xRegions.length;
        xs.lastTrends = Date.now();
        mark("x", trendN > 0, trendN);
      }
      // followed accounts, one request each, two tiers (see pollAccounts)
      if (Date.now() - xs.lastAccounts >= s.xAccountsIntervalMs && s.xAccounts.length && !overBudget() && allowUsd() > 0) {
        // keep room for the breakout search (≤ 10 reads) so the account list cannot starve it
        const reserve = s.xBreakoutEnabled && !xs.breakoutError ? 10 : 0;
        const r = await pollAccounts(s, xs, s.xDailyPostCap - xs.posts - reserve, allowUsd);
        xs.posts += r.read;
        xs.searches += r.requests;
        xs.lastAccounts = Date.now();
        radarState.x.lastRoundStop = r.stopped;
        signals.push(...r.signals);
        mark("x_accounts", true, r.signals.length);
        if (r.stopped) console.log(`[radar:x] account round stopped (${r.stopped}) after ${r.requests} requests, ${r.read} posts, ${r.sampled} sampled`);
      }
      // breakout finder (off by default since 9.11 — its posts never reach the 30 account-filled public slots)
      if (s.xBreakoutEnabled && !xs.breakoutError && Date.now() - xs.lastBreakout >= s.xBreakoutIntervalMs && !overBudget() && allowUsd() > 0) {
        const r = await fetchXBreakout({ minLikes: s.xBreakoutMinLikes, minReposts: s.xBreakoutMinReposts, lang: s.xBreakoutLang }, xs, Math.min(10, s.xDailyPostCap - xs.posts));
        xs.posts += r.read;
        xs.searches += r.requests;
        xs.lastBreakout = Date.now();
        if (r.error) xs.breakoutError = r.error; // tier rejected the operators — stop paying to retry; /admin shows it
        signals.push(...r.signals);
        mark("x_breakout", !r.error, r.signals.length);
      }
      // forget accounts the owner removed
      for (const h of Object.keys(xs.accounts)) if (!s.xAccounts.includes(h)) delete xs.accounts[h];
      await saveXState(xs);
    }
    if (s.sources.weibo) {
      const list = await fetchWeibo();
      mark("weibo", list.length > 0, list.length);
      signals.push(...list);
    }
    Object.assign(radarState.x, {
      day: xs.day, requests: xs.requests, searches: xs.searches, posts: xs.posts, costUsd: Number(xCostUsd(xs).toFixed(3)), nextRegion: s.xRegions[xs.cursor % s.xRegions.length], breakoutError: xs.breakoutError,
      paceUsd: Number(paceUsd().toFixed(3)),
      busy: s.xAccounts.filter((h) => s.xBusyPostsPerDay > 0 && perDay(xs.accounts[h] ?? {}) >= s.xBusyPostsPerDay).map((h) => ({ handle: h, perDay: Math.round(perDay(xs.accounts[h])) })),
    });

    // ---- 2. raw pool + merge into public hotspots
    const merged = await ingest(signals);
    // ---- 3. filters
    const blocked1 = await filterLocal(s);
    const ai = await filterAi(s);
    // ---- 4. expire
    await sql`update hotspots set status = 'expired' where status in ('published', 'pending') and last_seen < now() - (${s.publicWindowHours} || ' hours')::interval`;
    // ---- 4b. account weighting, then the per-platform pool cap (boss 9.11: X stays at 30). The cap is a `shown` flag, not a
    // status change: account posts are fetched once (since_id) and would never come back if we parked them as expired.
    await rankAccounts(s.xAccounts);
    for (const [platform, max] of [["x", s.xPublicMax], ["weibo", s.weiboPublicMax]] as const) {
      await sql`update hotspots set shown = id in (select id from hotspots where status = 'published' and platform = ${platform} ${PUBLIC_ORDER} limit ${max})
        where platform = ${platform} and status = 'published'`;
    }
    // ---- 5. pre-generate copy for the top of the public list
    await pregenerate(s);
    // ---- 6. counters
    const [{ n: publishedNow }] = await sql`select count(*)::int as n from hotspots where status = 'published'`;
    await bumpDaily({ fetched: signals.length, merged: merged.merged, blocked: blocked1 + ai.blocked, published: ai.published, x_requests: xs.requests + xs.searches - before.req, x_posts: xs.posts - before.posts, ai_calls: ai.batches }); // generateOne() counts its own calls
    radarState.last = { fetched: signals.length, merged: merged.merged, blocked: blocked1 + ai.blocked, published: Number(publishedNow), aiBatches: ai.batches, ms: Date.now() - t0 };
    radarState.lastTick = new Date().toISOString();
    radarState.lastError = null;
  } finally {
    running = false;
  }
}

// ------------------------------------------------------------------ raw pool + merge

/** Signals in the raw pool with their public hotspot; new events become `pending` hotspots. */
async function ingest(signals: RawSignal[]): Promise<{ merged: number; touched: number[] }> {
  if (signals.length === 0) return { merged: 0, touched: [] };
  // recent hotspots per platform are the dedupe candidates (spec: 6 h window). Loaded once, extended as we insert.
  const recent = await sql<{ id: number; platform: string; norm_key: string }[]>`select id, platform, norm_key from hotspots
    where last_seen > now() - interval '6 hours' and status <> 'merged' order by last_seen desc limit 3000`;
  const cands: Record<string, DedupeCandidate[]> = {};
  for (const r of recent) (cands[r.platform] ??= []).push({ id: Number(r.id), norm: r.norm_key, tokens: sigTokens(r.norm_key) });
  const touched = new Set<number>();
  let merged = 0;
  for (const sig of signals) {
    const norm = normalize(sig.title) || sig.itemId;
    // raw pool upsert; previous rank is kept so "rising" can be computed
    const [row] = await sql<{ id: number; hotspot_id: number | null; inserted: boolean }[]>`insert into hotspot_signals (platform, source_type, region, item_id, title, norm_key, url, account, metrics)
      values (${sig.platform}, ${sig.sourceType}, ${sig.region}, ${sig.itemId}, ${sig.title}, ${norm}, ${sig.url}, ${sig.account ?? null}, ${sql.json(sig.metrics)})
      on conflict (platform, source_type, region, item_id) do update set last_seen = now(), title = excluded.title,
        metrics = excluded.metrics || jsonb_build_object('prevRank', hotspot_signals.metrics->'rank')
      returning id, hotspot_id, (xmax = 0) as inserted`;
    let hid = row.hotspot_id ? Number(row.hotspot_id) : null;
    if (!hid) {
      // 1. exact key on any platform, 2. same link, 3. similar title within the platform
      const [exact] = await sql<{ id: number }[]>`select id from hotspots where norm_key = ${norm} and status <> 'merged' order by (platform = ${sig.platform}) desc, last_seen desc limit 1`;
      if (exact) hid = Number(exact.id);
      else {
        const [byUrl] = sig.url ? await sql<{ id: number }[]>`select id from hotspots where url = ${sig.url} and status <> 'merged' limit 1` : [];
        if (byUrl) hid = Number(byUrl.id);
        else {
          const dup = findDuplicate(norm, sigTokens(norm), cands[sig.platform] ?? []);
          if (dup) { hid = dup.id; merged++; }
        }
      }
      if (!hid) {
        const legacySource = sig.platform === "x" ? (sig.sourceType === "trend" ? "x" : "xuser") : sig.platform;
        const [h] = await sql<{ id: number }[]>`insert into hotspots (source, key, platform, source_type, account, title, lang, norm_key, url, region, regions, metrics, context, key_account, status, first_seen, last_seen)
          values (${legacySource}, ${sig.itemId}, ${sig.platform}, ${sig.sourceType}, ${sig.account ?? null}, ${sig.title}, ${sig.lang}, ${norm}, ${sig.url}, ${sig.region}, ${sql.array([sig.region])}, ${sql.json(sig.metrics)}, ${sql.json(sig.context)}, ${sig.sourceType === "key_account"}, 'pending', now(), now())
          on conflict (source, key) do update set last_seen = now(), title = excluded.title, metrics = excluded.metrics
          returning id`;
        hid = Number(h.id);
        (cands[sig.platform] ??= []).unshift({ id: hid, norm, tokens: sigTokens(norm) });
      }
      await sql`update hotspot_signals set hotspot_id = ${hid} where id = ${row.id}`;
    }
    touched.add(hid);
    // a fresh post about a topic carries better context than a bare trend name — keep the richest snippets; the post's
    // picture is kept as context only (metrics.image), never as the token logo (that is AI-generated / uploaded / monogram)
    if (sig.context.length || sig.image) {
      await sql`update hotspots set context = case when jsonb_array_length(context) = 0 then ${sql.json(sig.context)} else context end,
        metrics = case when ${sig.image ?? null}::text is null then metrics else metrics || jsonb_build_object('image', ${sig.image ?? null}::text) end where id = ${hid}`;
    }
  }
  const ids = [...touched];
  // aggregates from the raw pool: signal count, related titles, regions, rising, key account, last seen
  await sql`update hotspots h set signals = a.n, related = a.rel, regions = a.regions, last_seen = a.last, rising = a.rising, key_account = a.ka,
      metrics = case when h.source_type = 'trend' then h.metrics || a.best else h.metrics end,
      status = case when h.status = 'expired' then 'published' else h.status end
    from (select hotspot_id, count(*)::int as n, (count(distinct norm_key) - 1)::int as rel, array_agg(distinct region order by region) as regions, max(last_seen) as last,
                 bool_or(source_type = 'key_account') as ka,
                 bool_or(coalesce((metrics->>'prevRank')::int, 0) > coalesce((metrics->>'rank')::int, 0) and (metrics->>'rank') is not null) as rising,
                 jsonb_build_object('rank', min((metrics->>'rank')::int), 'posts', max(coalesce((metrics->>'posts')::numeric, (metrics->>'heat')::numeric, 0))) as best
          from hotspot_signals where hotspot_id in ${sql(ids)} group by hotspot_id) a
    where h.id = a.hotspot_id`;
  return { merged, touched: ids };
}

// ------------------------------------------------------------------ filters

async function filterLocal(s: HotspotSettings): Promise<number> {
  const rows = await sql<HotspotRow[]>`select * from hotspots where status = 'pending' limit 1000`;
  let n = 0;
  for (const h of rows) {
    const reason = localBlock({ title: h.title, context: h.context ?? [], sourceType: h.source_type, metrics: h.metrics ?? {}, platform: h.platform }, s.blacklist);
    if (!reason) continue;
    await sql`update hotspots set status = 'blocked', blocked_reason = ${reason} where id = ${h.id}`;
    n++;
  }
  return n;
}

/** Layer 2: cached verdicts first, then one batched AI call per ≤ 40 unseen titles. */
async function filterAi(s: HotspotSettings): Promise<{ published: number; blocked: number; batches: number }> {
  const rows = await sql<HotspotRow[]>`select * from hotspots where status = 'pending' order by first_seen asc limit 400`;
  if (rows.length === 0) return { published: 0, blocked: 0, batches: 0 };
  const cached = new Map<string, { verdict: Verdict; category: MemeCategory | null }>();
  for (const r of await sql<{ norm_key: string; verdict: Verdict; category: MemeCategory | null }[]>`select norm_key, verdict, category from hotspot_verdicts where norm_key in ${sql([...new Set(rows.map((r) => r.norm_key))])}`) cached.set(r.norm_key, r);
  let published = 0, blocked = 0, batches = 0;
  const apply = async (h: HotspotRow, v: Verdict, cat: MemeCategory | null) => {
    if (v === "SAFE") { await sql`update hotspots set status = 'published', verdict = 'SAFE', category = ${cat && cat !== "none" ? cat : null} where id = ${h.id}`; published++; }
    else { await sql`update hotspots set status = 'blocked', verdict = ${v}, blocked_reason = ${v.toLowerCase()}, category = null where id = ${h.id}`; blocked++; }
  };
  const fresh: HotspotRow[] = [];
  for (const h of rows) {
    const c = cached.get(h.norm_key);
    if (c) await apply(h, c.verdict, c.category);
    else fresh.push(h);
  }
  if (!s.aiFilter) {
    for (const h of fresh) await apply(h, "SAFE", null);
    return { published, blocked, batches };
  }
  for (let i = 0; i < fresh.length; i += 40) {
    const batch = fresh.slice(i, i + 40);
    const verdicts = await classifySafety(batch.map((h) => ({ title: h.title, lang: h.lang, context: h.context ?? [] })));
    batches++;
    for (const [k, h] of batch.entries()) {
      const v = verdicts[k];
      if (v.by !== "none") await sql`insert into hotspot_verdicts (norm_key, verdict, category, by) values (${h.norm_key}, ${v.verdict}, ${v.category}, ${v.by}) on conflict (norm_key) do nothing`;
      await apply(h, v.verdict, v.category);
    }
  }
  return { published, blocked, batches };
}

// ------------------------------------------------------------------ copy generation (on click + small daily top)

const inflight = new Map<number, Promise<HotspotRow | null>>();

export async function aiCallsToday(): Promise<number> {
  const [r] = await sql`select ai_calls from hotspot_daily where day = current_date`;
  return Number(r?.ai_calls ?? 0);
}

/**
 * Generate (once) the token identity for a hotspot; `withLogo` also renders the picture. Returns the fresh row.
 * `template` = do not spend an AI call: deterministic copy (`by: "template"`), used when the daily cap is spent so the
 * card still gets its (free) logo; pregenerate() upgrades template rows to AI copy once budget is back.
 * Re-generating copy (force / upgrade) clears the logo so the painter draws one that matches the new prompt.
 */
export function generateOne(h: HotspotRow, opts: { withLogo?: boolean; force?: boolean; template?: boolean } = {}): Promise<HotspotRow | null> {
  const key = Number(h.id);
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = (async () => {
    try {
      let ideas = h.ideas;
      if (!ideas || opts.force) {
        const topic = { title: h.title, source: h.platform === "x" ? (h.source_type === "trend" ? "x" : "xuser") : h.platform, context: h.context ?? [], lang: h.lang, account: h.account ?? undefined };
        ideas = opts.template ? templateIdeas(topic) : await generateIdeas(topic);
        const hadLogo = !!h.ideas;
        await sql`update hotspots set ideas = ${sql.json(ideas as never)}, generated_at = now(), logo = case when ${hadLogo}::boolean then null else logo end where id = ${key}`;
        if (ideas.by !== "template") await bumpDaily({ ai_calls: 1 }); // a failed call (template fallback) is not spend
      }
      // a monogram is the "no picture" fallback (Pollinations was down / 429), never a cached result
      if (opts.withLogo && (opts.force || !hasAiLogo(h))) {
        const logo = await generateLogo(ideas, `hot:${key}`);
        await sql`update hotspots set logo = ${logo.url}, ideas = ${sql.json({ ...ideas, logoBy: logo.by } as never)} where id = ${key}`;
      }
      const [row] = await sql<HotspotRow[]>`select * from hotspots where id = ${key}`;
      return row ?? null;
    } catch (e) {
      console.warn("[radar:ai] generate failed", key, (e as Error).message);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** True when the row carries a real AI-rendered logo (not the SVG monogram fallback, which is retried later). */
export const hasAiLogo = (h: Pick<HotspotRow, "logo" | "ideas">) => !!h.logo && !!h.ideas?.logoBy && h.ideas.logoBy !== "monogram";

/**
 * Background logo painter (boss 9.11 night: every card shows its AI picture). Independent of the crawl tick so a slow
 * image never delays fetching: every 15 s it takes the top shown hotspot that has copy but no AI logo and renders it
 * (Pollinations, free, ~10–30 s). When the renderer falls back to a monogram (429 / outage) it pauses 5 minutes so
 * we do not hammer a struggling endpoint.
 */
export async function startLogoPainter() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(20_000);
  for (;;) {
    let wait = 15_000;
    try {
      const s = await getSettings();
      if (s.enabled && s.pregenLogos) {
        const [h] = await sql<HotspotRow[]>`select * from hotspots where status = 'published' and shown and ideas is not null
          and (logo is null or ideas->>'logoBy' is null or ideas->>'logoBy' = 'monogram') ${PUBLIC_ORDER} limit 1`;
        if (h) {
          const row = await generateOne(h, { withLogo: true });
          if (!row || !hasAiLogo(row)) wait = 5 * 60_000;
          else wait = 3_000;
        }
      }
    } catch (e) {
      console.warn("[radar:logo]", (e as Error).message);
      wait = 60_000;
    }
    await sleep(wait);
  }
}

/**
 * Copy for the shown pool, top first. Budget left → AI copy (template rows from a capped day are upgraded too);
 * budget spent → template copy so the painter can still draw the logo (9.14: 529/500 left the whole board without
 * pictures — the pool churns ~450 new cards a day and each one had burned a call before dropping out of view).
 */
async function pregenerate(s: HotspotSettings): Promise<number> {
  if (s.pregenTop <= 0) return 0;
  let left = s.aiDailyCap - (await aiCallsToday());
  const top = await sql<HotspotRow[]>`select * from hotspots where status = 'published' and shown ${PUBLIC_ORDER} limit ${s.pregenTop}`;
  let n = 0;
  for (const h of top) {
    const isTemplate = h.ideas?.by === "template";
    if (h.ideas && !isTemplate) continue;
    // a template row is retried at most hourly (it is also what generateIdeas() returns when the AI endpoint fails)
    if (isTemplate && h.generated_at && Date.now() - new Date(h.generated_at).getTime() < 60 * 60_000) continue;
    if (left > 0) {
      if (await generateOne(h, { force: isTemplate })) { n++; left--; }
    } else if (!h.ideas) {
      await generateOne(h, { template: true });
    }
  }
  return n;
}

async function bumpDaily(d: Partial<{ fetched: number; blocked: number; merged: number; published: number; x_requests: number; x_posts: number; ai_calls: number }>) {
  await sql`insert into hotspot_daily (day, fetched, blocked, merged, published, x_requests, x_posts, ai_calls)
    values (current_date, ${d.fetched ?? 0}, ${d.blocked ?? 0}, ${d.merged ?? 0}, ${d.published ?? 0}, ${d.x_requests ?? 0}, ${d.x_posts ?? 0}, ${d.ai_calls ?? 0})
    on conflict (day) do update set fetched = hotspot_daily.fetched + excluded.fetched, blocked = hotspot_daily.blocked + excluded.blocked,
      merged = hotspot_daily.merged + excluded.merged, published = hotspot_daily.published + excluded.published,
      x_requests = hotspot_daily.x_requests + excluded.x_requests, x_posts = hotspot_daily.x_posts + excluded.x_posts, ai_calls = hotspot_daily.ai_calls + excluded.ai_calls`;
}

// ------------------------------------------------------------------ quotas & claims

export async function quotaLeft(address: string, ip: string, s?: HotspotSettings) {
  s ??= await getSettings();
  const [a] = await sql`select count(*)::int as n from hotspot_claims where lower(address) = ${address.toLowerCase()} and ts > now() - interval '24 hours'`;
  const [i] = ip ? await sql`select count(*)::int as n from hotspot_claims where ip = ${ip} and ts > now() - interval '24 hours'` : [{ n: 0 }];
  return { address: Math.max(0, s.quotaPerAddress - Number(a.n)), ip: Math.max(0, s.quotaPerIp - Number(i.n)), perAddress: s.quotaPerAddress, perIp: s.quotaPerIp };
}

/** Called from the indexer on TokenLaunched: attach the token to the most recent open claim of that wallet/symbol. */
export async function attachLaunch(deployer: string, symbol: string, token: string, txHash: string) {
  await sql`update hotspot_claims set token = ${token}, tx_hash = ${txHash}
            where id = (select id from hotspot_claims where lower(address) = ${deployer.toLowerCase()} and symbol = ${symbol} and token is null
                        and ts > now() - interval '2 hours' order by ts desc limit 1)`;
}

export const aiStatus = () => ({ copy: textProvider(), logo: imageProvider(), x: xAvailable(), weibo: true });
