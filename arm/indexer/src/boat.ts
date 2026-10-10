import { randomBytes } from "node:crypto";
import { getAddress, isAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSync, setSync, sql } from "./db.js";
import { client } from "./chain.js";
import { deployments } from "./config.js";

/**
 * Speedboat game ledger ($BOAT, 10.2). On-chain: BoatVault (arm/contracts/src/game) holds the reward pool, the locked
 * v4 liquidity and pays withdrawals against a cumulative total signed here. Off-chain (this file): balances.
 *   bonus = the 100 welcome tokens, playable only; cash = winnings + deposits, withdrawable.
 * A ranked run costs 10 (bonus first) and pays floor(min(m, 300) · rate) (Neon Strike: m = points / 10); rate = rewardPool / 100M, clamped to
 * [0.1, 1], so the payout shrinks before the pool can run dry. Daily: 10 ranked runs per wallet, 30 per IP.
 * The server can't stop a client from lying about its distance, only bound it: a run can't be longer than its
 * wall-clock time at top speed allows.
 * Env: BOAT_VAULT, BOAT_SIGNER_KEY (only ever read here, never logged), BOAT_DEPLOY_BLOCK.
 */

const VAULT = process.env.BOAT_VAULT && isAddress(process.env.BOAT_VAULT) ? getAddress(process.env.BOAT_VAULT) : null;
const SIGNER = process.env.BOAT_SIGNER_KEY ? privateKeyToAccount(process.env.BOAT_SIGNER_KEY as Hex) : null;
const DEPLOY_BLOCK = BigInt(process.env.BOAT_DEPLOY_BLOCK ?? "0");
const STATE_VIEW: Address = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";

export const WELCOME = 100;
export const ENTRY = 10;
export const MAX_REWARD = 300;
const RUNS_PER_DAY = 10;
const IP_RUNS_PER_DAY = 30;
const IP_WELCOMES_PER_DAY = 3;
const FULL_RATE_POOL = 100_000_000;
const PLAYER_DAILY_CAP = 1_500;
// game metres per second at top speed (46 world m/s ÷ 4) plus slack for frame jitter
const MAX_MPS = 13;
const SESSION_TTL = 7 * 86400_000;
const SIGN_TTL = 5 * 60_000;
const CLAIM_TTL = 30 * 60; // seconds
const E18 = 10n ** 18n;

const vaultAbi = parseAbi([
  "function boat() view returns (address)",
  "function boatIsToken0() view returns (bool)",
  "function poolId() view returns (bytes32)",
  "function rewardPool() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function claimed(address) view returns (uint256)",
  "function claimedOnDay(address, uint256) view returns (uint256)",
  "function paidOnDay(uint256) view returns (uint256)",
  "event Deposited(address indexed player, uint256 amount)",
]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);

/** Games paid from the same $BOAT ledger; the daily ranked-run limits are shared between them. boat and race run at
 *  the same world scale, so MAX_MPS bounds either. shoot (Neon Strike) and tower (Tower Building) score points,
 *  stored in the same `meters` column. */
const GAMES = ["boat", "race", "shoot", "tower"] as const;
type Game = (typeof GAMES)[number];
const gameOf = (g?: string): Game => (GAMES as readonly string[]).includes(g ?? "") ? (g as Game) : "boat";

/** Neon Strike only spawns enemies while their summed base points stay under this budget (same formula as
 *  web/src/components/shoot/engine.ts `spawnBudget`): 40 up front, then 15 points/s rising to 45 over two minutes. */
const shootBudget = (s: number) => 40 + (s <= 120 ? 15 * s + 0.125 * s * s : 3600 + 45 * (s - 120));
/** top combo multiplier, so a perfect run can't score more than this × the budget */
const SHOOT_MAX_MULT = 3;
const SHOOT_POINTS_PER_BOAT = 10;
/** Tower Building lands at most one floor per 1.2 s of game time and a floor scores at most 150 (25, plus 25 for each
 *  perfect in a row, capped at 5); same formula as web/src/components/tower/engine.ts `towerBudget`. */
const towerBudget = (s: number) => 150 * (1 + Math.floor(s / 1.2));
const TOWER_POINTS_PER_BOAT = 10;
const maxScore = (game: Game, secs: number) =>
  Math.floor(game === "shoot" ? SHOOT_MAX_MULT * shootBudget(secs) : game === "tower" ? towerBudget(secs) : secs * MAX_MPS);
/** reward units before the pool rate: metres for boat / race, every 10 points for shoot and tower */
const rewardUnits = (game: Game, score: number) =>
  game === "shoot" ? Math.floor(score / SHOOT_POINTS_PER_BOAT) : game === "tower" ? Math.floor(score / TOWER_POINTS_PER_BOAT) : score;

export const loginMessage = (wallet: string, ts: number) => `Arm · Speedboat\nWallet: ${getAddress(wallet)}\nTime: ${ts}`;
/** Same day boundary as BoatVault.today(): 00:00 UTC+8. */
const today = () => Math.floor((Date.now() / 1000 + 8 * 3600) / 86400);
const id = () => randomBytes(12).toString("base64url");

let ready: Promise<void> | null = null;
function ensure() {
  ready ??= (async () => {
    await sql`create table if not exists boat_players (
      wallet text primary key, bonus bigint not null default 0, cash bigint not null default 0,
      earned bigint not null default 0, best int not null default 0, ip text, created_at timestamptz not null default now())`;
    await sql`create table if not exists boat_sessions (token text primary key, wallet text not null, expires_at timestamptz not null)`;
    await sql`create table if not exists boat_runs (
      id text primary key, wallet text not null, day int not null, ip text not null, ranked boolean not null,
      started_at timestamptz not null, ended_at timestamptz, meters int, reward int)`;
    await sql`alter table boat_runs add column if not exists game text not null default 'boat'`;
    await sql`create index if not exists boat_runs_day_wallet on boat_runs (day, wallet)`;
    await sql`create index if not exists boat_runs_day_ip on boat_runs (day, ip)`;
    await sql`create table if not exists boat_withdrawals (
      id serial primary key, wallet text not null, amount bigint not null, total numeric(78,0) not null,
      deadline bigint not null, settled boolean not null default false, created_at timestamptz not null default now())`;
    await sql`create table if not exists boat_deposits (
      tx text not null, log_index int not null, wallet text not null, amount numeric(78,0) not null, credited bigint not null,
      primary key (tx, log_index))`;
  })();
  return ready;
}

// ---------------------------------------------------------------- chain reads

type Chain = { boat: Address; boatIsToken0: boolean; poolId: Hex; rewardPool: number; totalPaid: number; paidToday: number; mcapUsdc: number; priceUsdc: number };
let chainCache: { at: number; v: Chain } | null = null;
async function chainState(): Promise<Chain | null> {
  if (!VAULT) return null;
  if (chainCache && Date.now() - chainCache.at < 20_000) return chainCache.v;
  const [boat, isT0, pid, pool, paid, paidToday] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: VAULT, abi: vaultAbi, functionName: "boat" },
      { address: VAULT, abi: vaultAbi, functionName: "boatIsToken0" },
      { address: VAULT, abi: vaultAbi, functionName: "poolId" },
      { address: VAULT, abi: vaultAbi, functionName: "rewardPool" },
      { address: VAULT, abi: vaultAbi, functionName: "totalPaid" },
      { address: VAULT, abi: vaultAbi, functionName: "paidOnDay", args: [BigInt(today())] },
    ],
  });
  const [sqrtP] = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [pid] });
  // raw price = (sqrtP / 2^96)^2 in token1 per token0; BOAT has 18 decimals, USDC 6
  const raw = (Number(sqrtP) / 2 ** 96) ** 2;
  const perBoat = (isT0 ? raw : 1 / raw) * 1e12; // USDC per BOAT
  const v: Chain = {
    boat, boatIsToken0: isT0, poolId: pid,
    rewardPool: Number(pool / E18), totalPaid: Number(paid / E18), paidToday: Number(paidToday / E18),
    priceUsdc: perBoat, mcapUsdc: perBoat * 1e9,
  };
  chainCache = { at: Date.now(), v };
  return v;
}

const rateFor = (pool: number) => Math.min(1, Math.max(0.1, pool / FULL_RATE_POOL));
/** the pool's reward rate right now (other $BOAT games, e.g. story.ts, scale their payouts by it too) */
export const rateNow = async () => rateFor((await chainState().catch(() => null))?.rewardPool ?? 0);

let depositSyncAt = 0;
/** Credit Deposited events to cash (whole tokens). Cheap enough to run lazily from /me. */
async function syncDeposits() {
  if (!VAULT || Date.now() - depositSyncAt < 15_000) return;
  depositSyncAt = Date.now();
  const head = await client.getBlockNumber();
  let from = BigInt((await getSync("boat_deposit_block")) ?? String(DEPLOY_BLOCK));
  while (from <= head) {
    const to = from + 9_999n > head ? head : from + 9_999n;
    const logs = await client.getContractEvents({ address: VAULT, abi: vaultAbi, eventName: "Deposited", fromBlock: from, toBlock: to });
    for (const l of logs) {
      const wallet = getAddress(l.args.player!);
      const amount = l.args.amount!;
      const credited = Number(amount / E18);
      await sql.begin(async (tx) => {
        const r = await tx`insert into boat_deposits (tx, log_index, wallet, amount, credited)
          values (${l.transactionHash}, ${l.logIndex}, ${wallet}, ${amount.toString()}, ${credited}) on conflict do nothing returning tx`;
        if (!r.length) return;
        await tx`insert into boat_players (wallet, cash) values (${wallet}, ${credited})
          on conflict (wallet) do update set cash = boat_players.cash + ${credited}`;
      });
    }
    await setSync("boat_deposit_block", String(to + 1n));
    from = to + 1n;
  }
}

/** Expired withdrawals give back whatever the vault didn't pay (daily caps can make a claim partial). */
async function settleWithdrawals(wallet: string) {
  if (!VAULT) return;
  const open = await sql<{ id: number; total: string; deadline: string }[]>`
    select id, total, deadline from boat_withdrawals where wallet = ${wallet} and not settled order by id`;
  if (!open.length) return;
  const claimed = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "claimed", args: [wallet as Address] });
  const now = Math.floor(Date.now() / 1000);
  for (const w of open) {
    const total = BigInt(w.total);
    if (claimed >= total) { await sql`update boat_withdrawals set settled = true where id = ${w.id}`; continue; }
    if (now <= Number(w.deadline)) continue;
    // the signature can't be used any more: refund the unpaid part (later signatures build on `claimed`)
    const refund = Number((total - claimed) / E18);
    await sql.begin(async (tx) => {
      const r = await tx`update boat_withdrawals set settled = true where id = ${w.id} and not settled returning id`;
      if (r.length && refund > 0) await tx`update boat_players set cash = cash + ${refund} where wallet = ${wallet}`;
    });
  }
}

// ---------------------------------------------------------------- sessions

export async function walletOf(token: string | undefined) {
  if (!token || !/^[\w-]{16,40}$/.test(token)) return null;
  await ensure();
  const [s] = await sql<{ wallet: string }[]>`select wallet from boat_sessions where token = ${token} and expires_at > now()`;
  return s?.wallet ?? null;
}

export async function boatLogin(ip: string, body: { wallet?: string; ts?: number; sig?: string }) {
  await ensure();
  if (!body.wallet || !isAddress(body.wallet) || !body.ts || !body.sig || Math.abs(Date.now() - body.ts) > SIGN_TTL) return { error: "bad signature" as const };
  const wallet = getAddress(body.wallet);
  const ok = await verifyMessage({ address: wallet, message: loginMessage(wallet, body.ts), signature: body.sig as Hex }).catch(() => false);
  if (!ok) return { error: "bad signature" as const };
  let welcomed = false;
  const [p] = await sql`select wallet from boat_players where wallet = ${wallet}`;
  if (!p) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from boat_players where ip = ${ip} and created_at > now() - interval '1 day'`;
    const bonus = n < IP_WELCOMES_PER_DAY ? WELCOME : 0;
    const r = await sql`insert into boat_players (wallet, bonus, ip) values (${wallet}, ${bonus}, ${ip}) on conflict do nothing returning wallet`;
    welcomed = r.length > 0 && bonus > 0;
  }
  const token = randomBytes(18).toString("base64url");
  await sql`insert into boat_sessions (token, wallet, expires_at) values (${token}, ${wallet}, ${new Date(Date.now() + SESSION_TTL)})`;
  return { token, welcomed, me: await me(wallet) };
}

export async function me(wallet: string) {
  const [p] = await sql<{ bonus: string; cash: string; earned: string; best: number }[]>`
    select bonus, cash, earned, best from boat_players where wallet = ${wallet}`;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from boat_runs where day = ${today()} and wallet = ${wallet} and ranked`;
  const [w] = await sql<{ amount: string; total: string; deadline: string }[]>`
    select amount, total, deadline from boat_withdrawals where wallet = ${wallet} and not settled order by id desc limit 1`;
  return {
    wallet,
    bonus: Number(p?.bonus ?? 0), cash: Number(p?.cash ?? 0), earned: Number(p?.earned ?? 0), best: p?.best ?? 0,
    runsToday: n, runsPerDay: RUNS_PER_DAY,
    pending: w ? { amount: Number(w.amount), total: w.total, deadline: Number(w.deadline) } : null,
  };
}

export async function boatMe(token: string | undefined) {
  const wallet = await walletOf(token);
  if (!wallet) return null;
  await syncDeposits().catch((e) => console.error("[boat] deposit sync", e instanceof Error ? e.message : e));
  await settleWithdrawals(wallet).catch((e) => console.error("[boat] settle", e instanceof Error ? e.message : e));
  return me(wallet);
}

// ---------------------------------------------------------------- runs

export async function boatRunStart(token: string | undefined, ip: string, gameIn?: string) {
  const game = gameOf(gameIn);
  const wallet = await walletOf(token);
  if (!wallet) return { error: "login" as const };
  const day = today();
  const runId = id();
  const res = await sql.begin(async (tx) => {
    const [p] = await tx<{ bonus: string; cash: string }[]>`select bonus, cash from boat_players where wallet = ${wallet} for update`;
    const [{ w }] = await tx<{ w: number }[]>`select count(*)::int as w from boat_runs where day = ${day} and wallet = ${wallet} and ranked`;
    const [{ i }] = await tx<{ i: number }[]>`select count(*)::int as i from boat_runs where day = ${day} and ip = ${ip} and ranked`;
    const bonus = Number(p?.bonus ?? 0), cash = Number(p?.cash ?? 0);
    let why: "runs" | "ip" | "balance" | null = null;
    if (w >= RUNS_PER_DAY) why = "runs";
    else if (i >= IP_RUNS_PER_DAY) why = "ip";
    else if (bonus + cash < ENTRY) why = "balance";
    const ranked = !why;
    if (ranked) {
      const fromBonus = Math.min(bonus, ENTRY);
      await tx`update boat_players set bonus = bonus - ${fromBonus}, cash = cash - ${ENTRY - fromBonus} where wallet = ${wallet}`;
    }
    await tx`insert into boat_runs (id, wallet, day, ip, ranked, started_at, game) values (${runId}, ${wallet}, ${day}, ${ip}, ${ranked}, now(), ${game})`;
    return { ranked, practiceReason: why };
  });
  const c = await chainState().catch(() => null);
  return { id: runId, ...res, rate: rateFor(c?.rewardPool ?? 0), me: await me(wallet) };
}

export async function boatRunEnd(token: string | undefined, runId: string, metersIn: number) {
  const wallet = await walletOf(token);
  if (!wallet) return { error: "login" as const };
  const c = await chainState().catch(() => null);
  const rate = rateFor(c?.rewardPool ?? 0);
  const out = await sql.begin(async (tx) => {
    const [r] = await tx<{ ranked: boolean; started_at: Date; ended_at: Date | null; game: string }[]>`
      select ranked, started_at, ended_at, game from boat_runs where id = ${runId} and wallet = ${wallet} for update`;
    if (!r) return { error: "not found" as const };
    if (r.ended_at) return { error: "ended" as const };
    const game = gameOf(r.game);
    const secs = (Date.now() - r.started_at.getTime()) / 1000;
    const meters = Math.max(0, Math.min(Math.floor(Number(metersIn) || 0), maxScore(game, secs)));
    const reward = r.ranked ? Math.floor(Math.min(rewardUnits(game, meters), MAX_REWARD) * rate) : 0;
    await tx`update boat_runs set ended_at = now(), meters = ${meters}, reward = ${reward} where id = ${runId}`;
    // `best` is shown as metres, so points don't go in it
    const best = game === "shoot" || game === "tower" ? 0 : meters;
    await tx`update boat_players set cash = cash + ${reward}, earned = earned + ${reward}, best = greatest(best, ${best}) where wallet = ${wallet}`;
    return { meters, reward, ranked: r.ranked, capped: meters < Math.floor(Number(metersIn) || 0) };
  });
  if ("error" in out) return out;
  return { ...out, rate, me: await me(wallet) };
}

// ---------------------------------------------------------------- withdraw

export async function boatWithdraw(token: string | undefined) {
  const wallet = await walletOf(token);
  if (!wallet) return { error: "login" as const };
  if (!VAULT || !SIGNER) return { error: "disabled" as const };
  await settleWithdrawals(wallet);
  const [open] = await sql<{ amount: string; total: string; deadline: string }[]>`
    select amount, total, deadline from boat_withdrawals where wallet = ${wallet} and not settled order by id desc limit 1`;
  let total: bigint, deadline: number, amount: number;
  if (open) {
    // re-sign the same total so a dropped wallet popup can be retried without waiting for expiry
    total = BigInt(open.total); deadline = Number(open.deadline); amount = Number(open.amount);
  } else {
    const [claimed, onDay] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: VAULT, abi: vaultAbi, functionName: "claimed", args: [wallet as Address] },
        { address: VAULT, abi: vaultAbi, functionName: "claimedOnDay", args: [wallet as Address, BigInt(today())] },
      ],
    });
    const room = PLAYER_DAILY_CAP - Number(onDay / E18);
    const res = await sql.begin(async (tx) => {
      const [p] = await tx<{ cash: string }[]>`select cash from boat_players where wallet = ${wallet} for update`;
      const amt = Math.min(Number(p?.cash ?? 0), room);
      if (amt <= 0) return null;
      const t = claimed + BigInt(amt) * E18;
      const dl = Math.floor(Date.now() / 1000) + CLAIM_TTL;
      await tx`update boat_players set cash = cash - ${amt} where wallet = ${wallet}`;
      await tx`insert into boat_withdrawals (wallet, amount, total, deadline) values (${wallet}, ${amt}, ${t.toString()}, ${dl})`;
      return { t, dl, amt };
    });
    if (!res) return { error: room <= 0 ? ("daily cap" as const) : ("nothing" as const) };
    total = res.t; deadline = res.dl; amount = res.amt;
  }
  const sig = await SIGNER.signTypedData({
    domain: { name: "BoatVault", version: "1", chainId: deployments.chainId, verifyingContract: VAULT },
    types: { Claim: [{ name: "player", type: "address" }, { name: "total", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Claim",
    message: { player: wallet as Address, total, deadline: BigInt(deadline) },
  });
  return { vault: VAULT, amount, total: total.toString(), deadline, sig, me: await me(wallet) };
}

// ---------------------------------------------------------------- public

export async function boatInfo() {
  const c = await chainState().catch((e) => { console.error("[boat] chain", e instanceof Error ? e.message : e); return null; });
  return {
    enabled: !!VAULT && !!SIGNER,
    vault: VAULT,
    ...(c ?? {}),
    rate: rateFor(c?.rewardPool ?? 0),
    rules: {
      welcome: WELCOME, entry: ENTRY, maxReward: MAX_REWARD, runsPerDay: RUNS_PER_DAY, playerDailyCap: PLAYER_DAILY_CAP, globalDailyCap: 1_000_000,
      shootPointsPerBoat: SHOOT_POINTS_PER_BOAT,
      towerPointsPerBoat: TOWER_POINTS_PER_BOAT,
      towerMaxFloorScore: 150,
      towerDropGap: 1.2,
    },
  };
}

export async function boatBoard(gameIn?: string) {
  await ensure();
  const game = gameOf(gameIn);
  const rows = await sql<{ wallet: string; meters: number }[]>`
    select wallet, max(meters)::int as meters from boat_runs where day = ${today()} and ranked and meters is not null and game = ${game}
    group by wallet order by meters desc limit 20`;
  return { day: today(), game, rows };
}
