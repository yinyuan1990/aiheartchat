import { getAddress, isAddress, verifyMessage, type Address } from "viem";
import { client, keeperWallet } from "./chain.js";
import { sql } from "./db.js";
import { splitterAbi } from "./abi.js";
import { keeperLog } from "./keeper-log.js";

/**
 * Arm promoter referrals (scheme B), off-chain half.
 *
 * Binding: a promoter shares `?ref=<wallet>`; when a visitor connects, the site asks them to sign `bindMessage` and
 * posts it here. First touch wins — a wallet's referrer never changes (self-referral is allowed).
 *
 * Attribution: every indexed swap stores the trader and their referrer at trade time (indexer.ts onSwap).
 *
 * Settlement (keeper, per token whose splitter has a pool): the splitter reserved `referralBps` of every creator payout
 * as an upper bound. For the period since the last settlement the keeper computes
 *     share(referrer) = pool × referredVolume(referrer) / totalVolume
 * and calls `settle(pool, referrers, amounts)`; the splitter returns the unreferred remainder to the creator. Rounding
 * only ever goes down, so Σ amounts ≤ pool always holds on chain.
 */

export const bindMessage = (wallet: string, referrer: string, ts: number) =>
  `Arm referral\nwallet: ${wallet.toLowerCase()}\nreferrer: ${referrer.toLowerCase()}\nts: ${ts}`;

const BIND_WINDOW_S = 10 * 60;
/** Settle a token's pool at most this often, and only when it holds at least MIN_POOL (6dp USDC). */
const SETTLE_EVERY_MS = 24 * 3600 * 1000;
const MIN_POOL = 100_000n; // 0.10 USDC
const MAX_REFERRERS = 200;

export async function bindReferral(body: { wallet?: string; referrer?: string; ts?: number; sig?: string }) {
  const { wallet, referrer, ts, sig } = body;
  if (!wallet || !referrer || !ts || !sig || !isAddress(wallet) || !isAddress(referrer)) return { ok: false, error: "bad request" };
  if (Math.abs(Date.now() / 1000 - ts) > BIND_WINDOW_S) return { ok: false, error: "signature expired" };
  const valid = await verifyMessage({ address: wallet as Address, message: bindMessage(wallet, referrer, ts), signature: sig as `0x${string}` }).catch(() => false);
  if (!valid) return { ok: false, error: "bad signature" };
  const w = wallet.toLowerCase(), r = referrer.toLowerCase();
  const rows = await sql`insert into referral_bindings (wallet, referrer, sig) values (${w}, ${r}, ${sig}) on conflict (wallet) do nothing returning referrer`;
  if (rows.length) return { ok: true, referrer: getAddress(r), bound: true };
  const [cur] = await sql<{ referrer: string }[]>`select referrer from referral_bindings where wallet = ${w}`;
  return { ok: true, referrer: getAddress(cur.referrer), bound: false };
}

export async function referralOf(wallet: string) {
  const [b] = await sql<{ referrer: string; bound_at: Date }[]>`select referrer, bound_at from referral_bindings where wallet = ${wallet.toLowerCase()}`;
  return b ? { referrer: getAddress(b.referrer), boundAt: b.bound_at } : null;
}

/** A promoter's dashboard: invited wallets, referred volume, paid and estimated-pending commission. */
export async function promoterStats(wallet: string) {
  const r = wallet.toLowerCase();
  const [inv] = await sql<{ n: string }[]>`select count(*) as n from referral_bindings where referrer = ${r}`;
  const [vol] = await sql<{ v: string; n: string }[]>`select coalesce(sum(usdc),0) as v, count(*) as n from trades where referrer = ${r}`;
  const [paid] = await sql<{ v: string }[]>`select coalesce(sum(amount),0) as v from referral_payouts where referrer = ${r}`;
  const byToken = await sql<{ token: string; symbol: string; logo: string; referral_bps: number; volume: string; paid: string }[]>`
    select t.address as token, t.symbol, t.logo, t.referral_bps,
      coalesce((select sum(usdc) from trades x where x.token = t.address and x.referrer = ${r}), 0) as volume,
      coalesce((select sum(amount) from referral_payouts p where p.token = t.address and p.referrer = ${r}), 0) as paid
    from tokens t
    where exists (select 1 from trades x where x.token = t.address and x.referrer = ${r})
    order by volume desc limit 100`;
  const payouts = await sql`select p.amount, p.volume, p.token, t.symbol, s.tx_hash, s.ts from referral_payouts p
    join referral_settlements s on s.id = p.settlement_id join tokens t on t.address = p.token
    where p.referrer = ${r} order by s.ts desc limit 100`;
  return {
    wallet: getAddress(wallet),
    invited: Number(inv.n),
    referredVolumeUsdc: vol.v,
    referredTrades: Number(vol.n),
    paidUsdc: paid.v,
    // estimate: 1% fee × 78% creator share × each token's referral share, on volume not yet settled
    pendingEstimateUsdc: (await pendingEstimate(r)).toString(),
    tokens: byToken,
    payouts,
  };
}

async function pendingEstimate(r: string): Promise<bigint> {
  const rows = await sql<{ v: string; bps: number }[]>`
    select coalesce(sum(x.usdc),0) as v, t.referral_bps as bps from trades x join tokens t on t.address = x.token
    where x.referrer = ${r} and x.ts > coalesce(t.referral_settled_to, t.launch_ts) and t.referral_bps > 0
    group by t.address, t.referral_bps`;
  return rows.reduce((s, x) => s + (BigInt(x.v) * 78n * BigInt(x.bps)) / (100n * 100n * 10_000n), 0n);
}

/** Keeper: settle every splitter whose pool is worth it and whose last settlement is older than SETTLE_EVERY_MS. */
export async function settleReferrals(wallet: ReturnType<typeof keeperWallet>["wallet"]) {
  const rows = await sql<{ address: string; splitter: string; referral_settled_to: Date | null; launch_ts: Date }[]>`
    select address, splitter, referral_settled_to, launch_ts from tokens where splitter <> '' and splitter_active`;
  const now = new Date();
  for (const t of rows) {
    const from = t.referral_settled_to ?? t.launch_ts;
    if (now.getTime() - from.getTime() < SETTLE_EVERY_MS) continue;
    const splitter = t.splitter as Address;
    const [pool, bps] = await Promise.all([
      client.readContract({ address: splitter, abi: splitterAbi, functionName: "pool" }),
      client.readContract({ address: splitter, abi: splitterAbi, functionName: "referralBps" }),
    ]);
    await sql`update tokens set referral_bps = ${Number(bps)} where address = ${t.address}`;
    if (pool < MIN_POOL) {
      // nothing worth a transaction; still move the window so volume of an empty period is not paid later
      if (pool === 0n) await sql`update tokens set referral_settled_to = ${now} where address = ${t.address}`;
      continue;
    }
    const [tot] = await sql<{ v: string }[]>`select coalesce(sum(usdc),0) as v from trades where token = ${t.address} and ts > ${from} and ts <= ${now}`;
    const refs = await sql<{ referrer: string; v: string }[]>`select referrer, sum(usdc) as v from trades
      where token = ${t.address} and ts > ${from} and ts <= ${now} and referrer is not null group by referrer order by sum(usdc) desc limit ${MAX_REFERRERS}`;
    const total = BigInt(tot.v);
    const referrers: Address[] = [], amounts: bigint[] = [];
    let referred = 0n;
    for (const x of refs) {
      const v = BigInt(x.v);
      referred += v;
      const amt = total > 0n ? (pool * v) / total : 0n;
      if (amt > 0n) { referrers.push(getAddress(x.referrer)); amounts.push(amt); }
    }
    const paid = amounts.reduce((s, a) => s + a, 0n);
    try {
      const hash = await wallet.writeContract({ address: splitter, abi: splitterAbi, functionName: "settle", args: [pool, referrers, amounts], chain: wallet.chain, account: wallet.account! });
      const rc = await client.waitForTransactionReceipt({ hash });
      const ok = rc.status === "success";
      keeperLog({ action: "settle", token: t.address, detail: `pool=${pool} referrers=${referrers.length} paid=${paid}`, hash, ok });
      if (!ok) continue;
      const [s] = await sql<{ id: string }[]>`insert into referral_settlements (token, tx_hash, ts, pool_amount, to_referrers, to_creator, period_from, period_to, volume_total, volume_referred)
        values (${t.address}, ${hash}, ${now}, ${pool.toString()}, ${paid.toString()}, ${(pool - paid).toString()}, ${from}, ${now}, ${total.toString()}, ${referred.toString()})
        on conflict (tx_hash, token) do nothing returning id`;
      if (s) for (let i = 0; i < referrers.length; i++) {
        const v = refs.find((x) => x.referrer.toLowerCase() === referrers[i].toLowerCase())?.v ?? "0";
        await sql`insert into referral_payouts (settlement_id, token, referrer, amount, volume) values (${s.id}, ${t.address}, ${referrers[i].toLowerCase()}, ${amounts[i].toString()}, ${v})`;
      }
      await sql`update tokens set referral_settled_to = ${now} where address = ${t.address}`;
      console.log(`[keeper] referral settle ${t.address} pool=${pool} paid=${paid} to ${referrers.length} → ${rc.status} ${hash}`);
    } catch (e) {
      keeperLog({ action: "settle", token: t.address, detail: (e as Error).message.split("\n")[0], ok: false });
    }
  }
}
