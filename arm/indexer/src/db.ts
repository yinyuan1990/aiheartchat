import postgres from "postgres";
import { config, contractSets } from "./config.js";

const oldestFactory = () => contractSets.reduce((a, b) => (b.deployBlock < a.deployBlock ? b : a)).launchFactory;

export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  transform: { undefined: null },
  types: {
    // keep numerics as strings; callers convert to BigInt/Number explicitly
    bigint: postgres.BigInt,
  },
});

export async function migrate() {
  await sql`create table if not exists sync_state (key text primary key, value text not null)`;

  await sql`create table if not exists tokens (
    address text primary key,
    name text not null,
    symbol text not null,
    logo text default '',
    description text default '',
    website text default '',
    twitter text default '',
    telegram text default '',
    discord text default '',
    farcaster text default '',
    deployer text not null,
    payout text not null,
    pool text not null,
    position_id numeric(78,0) not null,
    is_token0 boolean not null,
    launch_block bigint not null,
    launch_ts timestamptz not null,
    launch_tx text not null,
    restrictions_end_block bigint not null,
    graduation_threshold numeric(78,0) not null,
    initial_buy_usdc numeric(78,0) not null default 0,
    creation_fee_paid numeric(78,0) not null default 0,
    creator_share_bps int not null default 7800,
    graduated boolean not null default false,
    graduated_at timestamptz,
    paired_usdc numeric(78,0) not null default 0,
    last_price double precision not null default 0,
    last_mcap6 numeric(78,0) not null default 0,
    fees_usdc_total numeric(78,0) not null default 0,
    fees_creator_usdc_total numeric(78,0) not null default 0,
    last_distributed_at timestamptz,
    volume_since_distribute numeric(78,0) not null default 0,
    updated_at timestamptz not null default now()
  )`;

  // owner moderation (9.16): hidden tokens stay tradable by direct URL but leave every public list / feed / stat
  await sql`alter table tokens add column if not exists hidden boolean not null default false`;
  // which LaunchFactory generation launched the token (9.16: the factory was redeployed onto the official Uniswap V3;
  // tokens from the first generation keep trading through their own locker / router). Rows that predate the column
  // all came from the oldest generation.
  await sql`alter table tokens add column if not exists factory text`;
  await sql`update tokens set factory = ${oldestFactory()} where factory is null`;
  // owner "pin": pinned tokens lead every public list regardless of sort (most recently pinned first)
  await sql`alter table tokens add column if not exists pinned_at timestamptz`;
  await sql`alter table tokens add column if not exists discord text default ''`;
  await sql`alter table tokens add column if not exists farcaster text default ''`;
  // tax mode (creator-set, immutable): 0/0 = standard token
  await sql`alter table tokens add column if not exists buy_tax_bps int not null default 0`;
  await sql`alter table tokens add column if not exists sell_tax_bps int not null default 0`;
  await sql`alter table tokens add column if not exists tax_marketing_wallet text not null default ''`;
  await sql`alter table tokens add column if not exists tax_team_wallet text not null default ''`;
  await sql`alter table tokens add column if not exists tax_marketing_bps int not null default 0`;
  await sql`alter table tokens add column if not exists tax_usdc_total numeric(78,0) not null default 0`;
  await sql`alter table tokens drop column if exists tax_burn_bps`;
  await sql`alter table tokens drop column if exists tax_creator_usdc_total`;
  // stock generation (9.18): the pool is quoted in a tokenized stock. quote = '' → USDC (every earlier token).
  // graduation_threshold / paired_usdc stay in the pool's own quote units (what the contract compares); trades.usdc,
  // candles.volume_usdc, last_price, last_mcap6 are always USD-equivalent (converted at the quote's USDC price).
  await sql`alter table tokens add column if not exists quote text not null default ''`;
  await sql`alter table tokens add column if not exists quote_symbol text not null default 'USDC'`;
  await sql`alter table tokens add column if not exists quote_decimals int not null default 6`;
  await sql`alter table tokens add column if not exists quote_usdc_fee int not null default 0`;
  await sql`alter table tokens add column if not exists quote_pool text not null default ''`;
  await sql`alter table tokens add column if not exists quote_price_usdc_launch numeric(78,0) not null default 1000000`;
  // Arm: the lock pays this per-token CreatorFeeSplitter (payout column = the creator wallet behind it);
  // splitter_active = false once the creator `exit`s to a plain wallet
  await sql`alter table tokens add column if not exists splitter text not null default ''`;
  await sql`alter table tokens add column if not exists splitter_active boolean not null default true`;
  await sql`create index if not exists tokens_quote on tokens (quote) where quote <> ''`;
  // latest USDC price of every whitelisted quote asset (refreshed with the on-chain refresh loop)
  await sql`create table if not exists quote_prices (
    address text primary key,
    symbol text not null,
    decimals int not null,
    usdc_fee int not null,
    usdc_pool text not null,
    price_usdc numeric(78,0) not null default 0,
    twap_usdc numeric(78,0) not null default 0,
    enabled boolean not null default true,
    updated_at timestamptz not null default now()
  )`;

  await sql`create table if not exists trades (
    id bigserial primary key,
    token text not null references tokens(address),
    pool text not null,
    tx_hash text not null,
    log_index int not null,
    block_number bigint not null,
    ts timestamptz not null,
    side text not null check (side in ('buy','sell')),
    usdc numeric(78,0) not null,
    tokens numeric(78,0) not null,
    price double precision not null,
    mcap6 numeric(78,0) not null,
    sender text not null,
    recipient text not null,
    unique (tx_hash, log_index)
  )`;
  await sql`create index if not exists trades_token_ts on trades (token, ts desc)`;
  await sql`create index if not exists trades_ts on trades (ts desc)`;
  // stock generation: the raw quote-asset leg of the swap and the quote's USDC price used for the conversion
  await sql`alter table trades add column if not exists quote_amount numeric(78,0)`;
  await sql`alter table trades add column if not exists quote_price_usdc numeric(78,0)`;

  // ---------- Arm: promoter referrals (scheme B) ----------
  // first-touch binding, signed by the buyer: once a wallet is bound it never changes
  await sql`create table if not exists referral_bindings (
    wallet text primary key,
    referrer text not null,
    bound_at timestamptz not null default now(),
    sig text not null
  )`;
  await sql`create index if not exists referral_bindings_referrer on referral_bindings (referrer)`;
  // the wallet that actually traded (trades.recipient, falling back to the tx sender) and its referrer at trade time
  await sql`alter table trades add column if not exists trader text`;
  await sql`alter table trades add column if not exists referrer text`;
  await sql`create index if not exists trades_token_referrer on trades (token, referrer) where referrer is not null`;
  // one row per keeper settlement of a splitter pool
  await sql`create table if not exists referral_settlements (
    id bigserial primary key,
    token text not null,
    tx_hash text not null,
    ts timestamptz not null,
    pool_amount numeric(78,0) not null,
    to_referrers numeric(78,0) not null,
    to_creator numeric(78,0) not null,
    period_from timestamptz not null,
    period_to timestamptz not null,
    volume_total numeric(78,0) not null,
    volume_referred numeric(78,0) not null,
    unique (tx_hash, token)
  )`;
  await sql`create table if not exists referral_payouts (
    id bigserial primary key,
    settlement_id bigint not null references referral_settlements(id),
    token text not null,
    referrer text not null,
    amount numeric(78,0) not null,
    volume numeric(78,0) not null
  )`;
  await sql`create index if not exists referral_payouts_referrer on referral_payouts (referrer)`;
  await sql`alter table tokens add column if not exists referral_bps int not null default 0`;
  await sql`alter table tokens add column if not exists referral_settled_to timestamptz`;

  await sql`create table if not exists candles (
    token text not null references tokens(address),
    bucket_ts timestamptz not null,
    open double precision not null,
    high double precision not null,
    low double precision not null,
    close double precision not null,
    volume_usdc numeric(78,0) not null default 0,
    trades int not null default 0,
    primary key (token, bucket_ts)
  )`;

  await sql`create table if not exists holders (
    token text not null references tokens(address),
    address text not null,
    balance numeric(78,0) not null,
    primary key (token, address)
  )`;
  await sql`create index if not exists holders_token_balance on holders (token, balance desc)`;

  await sql`create table if not exists fee_events (
    id bigserial primary key,
    token text not null references tokens(address),
    tx_hash text not null,
    log_index int not null,
    block_number bigint not null,
    ts timestamptz not null,
    quote_creator numeric(78,0) not null,
    quote_protocol numeric(78,0) not null,
    token_converted numeric(78,0) not null default 0,
    usdc_from_token numeric(78,0) not null default 0,
    creator_paid boolean not null,
    payout text not null,
    kind text not null default 'fee'
  )`;
  // FeeLocker v2: token-side fees are converted to USDC inside distribute; the old per-asset token split is gone.
  await sql`alter table fee_events add column if not exists token_converted numeric(78,0) not null default 0`;
  await sql`alter table fee_events add column if not exists usdc_from_token numeric(78,0) not null default 0`;
  await sql`alter table fee_events drop column if exists token_creator`;
  await sql`alter table fee_events drop column if exists token_protocol`;
  // 'fee' = 75/25 pool-fee split (payout = creator); 'tax_marketing' / 'tax_team' = tax proceeds to the two
  // tax wallets (payout = that wallet, quote_protocol = 0). One TaxDistributed log yields two rows, hence the
  // unique key includes kind.
  await sql`alter table fee_events add column if not exists kind text not null default 'fee'`;
  await sql`alter table fee_events drop constraint if exists fee_events_tx_hash_log_index_key`;
  await sql`create unique index if not exists fee_events_uq on fee_events (tx_hash, log_index, kind)`;
  await sql`create index if not exists fee_events_payout_ts on fee_events (payout, ts desc)`;

  // v2.10 (9.14): the Treasury no longer buys back on-chain; `burns` (on-chain slices) is gone. Weekly settlements
  // land in `settlements`; burns the project performs by hand from the buyback multisig are entered in /admin.
  await sql`drop table if exists burns`;
  await sql`create table if not exists settlements (
    id bigserial primary key,
    tx_hash text not null unique,
    block_number bigint not null,
    ts timestamptz not null,
    usdc_to_eco numeric(78,0) not null,
    usdc_to_buyback numeric(78,0) not null,
    usdc_to_dev numeric(78,0) not null
  )`;
  await sql`create table if not exists manual_burns (
    id bigserial primary key,
    tx_hash text not null unique,
    block_number bigint not null,
    ts timestamptz not null,
    sender text not null,
    token text,
    token_symbol text,
    tokens_burned numeric(78,0) not null default 0,
    usdc_spent numeric(78,0) not null default 0,
    note text not null default '',
    added_by text not null,
    added_at timestamptz not null default now()
  )`;

  await sql`create table if not exists comments (
    id bigserial primary key,
    token text not null references tokens(address),
    author text not null,
    text text not null,
    reply_to bigint references comments(id),
    signature text not null,
    ts timestamptz not null default now()
  )`;
  await sql`create index if not exists comments_token_ts on comments (token, ts desc)`;

  await sql`create table if not exists comment_likes (
    comment_id bigint not null references comments(id),
    author text not null,
    primary key (comment_id, author)
  )`;

  // v2.9: the community-takeover request table is gone; drop it on databases created before that.
  await sql`drop table if exists cto_requests`;

  await sql`create table if not exists claims (
    id bigserial primary key,
    account text not null,
    asset text not null,
    amount numeric(78,0) not null,
    tx_hash text not null,
    ts timestamptz not null,
    unique (tx_hash, account, asset)
  )`;

  // ---- AI hotspot launches -------------------------------------------------------------------------
  // Owner-editable runtime settings (hotspot sources, quotas, ...). Written only through owner-signed admin calls.
  await sql`create table if not exists settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
  )`;
  // One row per trending topic per source. `ideas` holds the AI-prepared token identity (name / symbol /
  // description / logo prompt); `logo` is our hosted image. Generation happens once per hotspot, never per user.
  await sql`create table if not exists hotspots (
    id bigserial primary key,
    source text not null,
    key text not null,
    title text not null,
    url text,
    region text,
    metrics jsonb not null default '{}'::jsonb,
    score double precision not null default 0,
    rank integer,
    context jsonb not null default '[]'::jsonb,
    ideas jsonb,
    logo text,
    status text not null default 'new' check (status in ('new','ready','hidden','failed')),
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    generated_at timestamptz,
    unique (source, key)
  )`;
  await sql`create index if not exists hotspots_list on hotspots (status, last_seen desc, score desc)`;
  // language of the source title (en / zh); the AI stores the other language inside `ideas`
  await sql`alter table hotspots add column if not exists lang text not null default 'en'`;
  // meme gate (9.8): AI-scored meme-coin potential 0..100 + category; topics under the threshold become 'rejected'
  // and never reach the public list. null = not classified yet.
  // followed X account (lower-case handle) for source = 'xuser'; each account is its own public tab
  await sql`alter table hotspots add column if not exists account text`;
  await sql`create index if not exists hotspots_account on hotspots (account) where account is not null`;
  await sql`alter table hotspots add column if not exists meme_score integer`;
  await sql`alter table hotspots add column if not exists category text`;
  // 9.10: gate-rejected topic promoted to fill a meme tab up to settings.minPerSource; ranked after real memes
  await sql`alter table hotspots add column if not exists filled boolean not null default false`;
  // ---- Radar v2 (boss spec, 9.10 night): raw signal pool + public hotspot pool, no AI scores.
  // hotspots = the PUBLIC pool: one row per event (several raw signals merge into it).
  await sql`alter table hotspots add column if not exists platform text`;            // x | weibo
  await sql`alter table hotspots add column if not exists source_type text`;         // trend | key_account | community
  await sql`alter table hotspots add column if not exists norm_key text`;            // normalized title (dedupe key)
  await sql`alter table hotspots add column if not exists regions text[] not null default '{}'`;
  await sql`alter table hotspots add column if not exists signals integer not null default 1`;   // raw signals merged in
  await sql`alter table hotspots add column if not exists related integer not null default 0`;   // distinct other titles merged in
  await sql`alter table hotspots add column if not exists rising boolean not null default false`;
  await sql`alter table hotspots add column if not exists key_account boolean not null default false`;
  await sql`alter table hotspots add column if not exists blocked_reason text`;
  await sql`alter table hotspots add column if not exists verdict text`;             // SAFE | POLITICS | TRAGEDY | LOW_QUALITY
  await sql`alter table hotspots add column if not exists merged_into bigint`;
  await sql`alter table hotspots add column if not exists priority int`;               // position of the account in the followed list (1 = boss tier 1)
  await sql`alter table hotspots add column if not exists acct_rank int`;              // 1 = the account's newest published post
  await sql`alter table hotspots add column if not exists shown boolean not null default true`; // inside the per-platform pool cap
  // 9.11 one-off: the first cap implementation parked overflow as expired; account posts are never re-seen, so bring them back
  await sql`update hotspots set status = 'published' where status = 'expired' and platform = 'x' and key_account and last_seen > now() - interval '24 hours'`;
  await sql`update hotspots set platform = case when source in ('x','xuser') then 'x' else source end where platform is null`;
  await sql`update hotspots set source_type = case when source = 'xuser' then (case when metrics->>'kind' = 'ugc' then 'community' else 'key_account' end) else 'trend' end where source_type is null`;
  await sql`update hotspots set norm_key = key where norm_key is null`;
  await sql`update hotspots set regions = array[region] where cardinality(regions) = 0 and region is not null`;
  await sql`update hotspots set key_account = true where source_type = 'key_account' and not key_account`;
  // status v2: pending → (published | blocked) ; published → expired (24 h idle) ; merged ; hidden (owner)
  await sql`alter table hotspots drop constraint if exists hotspots_status_check`;
  await sql`update hotspots set status = 'published' where status in ('ready','failed')`;
  await sql`update hotspots set status = 'pending' where status = 'new'`;
  await sql`update hotspots set status = 'blocked', blocked_reason = coalesce(blocked_reason, 'gate') where status = 'rejected'`;
  await sql`alter table hotspots add constraint hotspots_status_check check (status in ('pending','published','blocked','merged','expired','hidden'))`;
  // a post's media thumbnail was briefly used as the default logo — it is context, not a token logo
  await sql`update hotspots set logo = null where logo like 'https://pbs.twimg.com/%' and (ideas->>'logoBy') is null`;
  await sql`create index if not exists hotspots_pub on hotspots (platform, status, last_seen desc)`;
  await sql`create index if not exists hotspots_norm on hotspots (platform, norm_key)`;
  // raw signal pool: every (platform, source type, region, item) occurrence, tiny rows, no AI anything
  await sql`create table if not exists hotspot_signals (
    id bigserial primary key,
    hotspot_id bigint references hotspots(id) on delete set null,
    platform text not null,
    source_type text not null,
    region text not null default 'WW',
    item_id text not null,
    title text not null,
    norm_key text not null,
    url text,
    account text,
    metrics jsonb not null default '{}'::jsonb,
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    unique (platform, source_type, region, item_id)
  )`;
  await sql`create index if not exists hotspot_signals_hotspot on hotspot_signals (hotspot_id)`;
  await sql`create index if not exists hotspot_signals_seen on hotspot_signals (first_seen desc)`;
  // AI safety verdicts, cached forever by normalized title (one batched call per 30-50 new titles)
  await sql`create table if not exists hotspot_verdicts (
    norm_key text primary key,
    verdict text not null,
    category text,
    by text not null,
    ts timestamptz not null default now()
  )`;
  // per-UTC-day pipeline counters (fetched / blocked / merged / published) and X spend, for /admin and the logs
  await sql`create table if not exists hotspot_daily (
    day date primary key,
    fetched integer not null default 0,
    blocked integer not null default 0,
    merged integer not null default 0,
    published integer not null default 0,
    x_requests integer not null default 0,
    x_posts integer not null default 0,
    ai_calls integer not null default 0
  )`;
  // Every "confirm launch" click reserves a claim (quota accounting by address + IP). The indexer fills in
  // token / tx_hash when the matching TokenLaunched shows up; the frontend also posts them right away.
  await sql`create table if not exists hotspot_claims (
    id bigserial primary key,
    hotspot_id bigint not null references hotspots(id),
    address text not null,
    ip text not null default '',
    mode text not null check (mode in ('standard','tax')),
    symbol text not null,
    token text,
    tx_hash text,
    ts timestamptz not null default now()
  )`;
  await sql`create index if not exists hotspot_claims_address_ts on hotspot_claims (address, ts desc)`;
  await sql`create index if not exists hotspot_claims_ip_ts on hotspot_claims (ip, ts desc)`;
  await sql`create index if not exists hotspot_claims_hotspot on hotspot_claims (hotspot_id, ts desc)`;
  // which language the launcher chose for the on-chain name / description
  await sql`alter table hotspot_claims add column if not exists lang text not null default 'en'`;
  // the launcher may overwrite the AI name / logo before launching; keep what actually went on-chain
  await sql`alter table hotspot_claims add column if not exists name text`;
  await sql`alter table hotspot_claims add column if not exists logo text`;

  // AI drafts requested from the create page (name → symbol / description / logo). Cached by name for a day and
  // rate-limited per IP so the AI bill stays bounded. (Created before the logo-normalization loop below, which
  // touches this table — on a fresh DB the old order crashed startup.)
  await sql`create table if not exists ai_drafts (
    id bigserial primary key,
    name_key text not null,
    name text not null,
    symbol text not null,
    description text not null,
    logo text not null,
    by_copy text not null,
    by_logo text not null,
    ip text not null default '',
    ts timestamptz not null default now()
  )`;
  await sql`create index if not exists ai_drafts_key_ts on ai_drafts (name_key, ts desc)`;
  await sql`create index if not exists ai_drafts_ip_ts on ai_drafts (ip, ts desc)`;
  // wallet that requested the draft (quota is per wallet per day)
  await sql`alter table ai_drafts add column if not exists address text not null default ''`;
  await sql`create index if not exists ai_drafts_address_ts on ai_drafts (lower(address), ts desc)`;

  // Telegram buy bot (9.17): which groups want which token's buys. chat_id is text (Telegram ids exceed int32 and
  // are negative for groups). `active` flips off when the bot is removed from the chat or an admin runs /untrack.
  await sql`create table if not exists tg_subscriptions (
    id bigserial primary key,
    chat_id text not null,
    chat_title text not null default '',
    token text not null references tokens(address),
    min_buy_usd double precision not null default 0,
    added_by bigint,
    active boolean not null default true,
    added_at timestamptz not null default now(),
    unique (chat_id, token)
  )`;
  await sql`create index if not exists tg_subscriptions_token on tg_subscriptions (token) where active`;

  // Multi-domain (9.9): uploads are referenced host-relatively so a dead domain never breaks pictures. Fold any
  // absolute "https://<old host>/api/uploads/x" left from earlier domains into "/api/uploads/x". For `tokens` this is
  // display-only — the on-chain string cannot change — but that is exactly what the UI reads.
  for (const t of ["hotspots", "hotspot_claims", "ai_drafts", "tokens"]) {
    // note the doubled backslash: inside a JS template literal a bare \1 is a control character, not a backreference
    await sql`update ${sql(t)} set logo = regexp_replace(logo, '^https?://[^/]+/(api/uploads|brand)/', '/\\1/')
              where logo ~ '^https?://[^/]+/(api/uploads|brand)/'`;
  }
}

export async function getSync(key: string): Promise<string | null> {
  const r = await sql`select value from sync_state where key = ${key}`;
  return r[0]?.value ?? null;
}

export async function setSync(key: string, value: string) {
  await sql`insert into sync_state (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value`;
}
