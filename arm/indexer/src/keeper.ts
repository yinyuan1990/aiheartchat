import type { Address } from "viem";
import { client, keeperWallet, ADDR, addrsFor } from "./chain.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { factoryAbi, lockerAbi, splitterAbi, treasuryAbi } from "./abi.js";
import { keeperLog, keeperTicked } from "./keeper-log.js";
import { settleReferrals } from "./referral.js";

/**
 * Keeper: pushes creator/protocol fees on a schedule and persists graduation.
 * Decision uses indexed volume (Uniswap's tokensOwed is only refreshed on collect, so it can't be read ahead).
 */
export async function startKeeper() {
  const { account, wallet } = keeperWallet();
  console.log(`[keeper] enabled as ${account.address}, every ${config.keeper.intervalMs / 1000}s`);
  for (;;) {
    try {
      await tick(wallet, account.address);
    } catch (e) {
      console.error("[keeper] error:", (e as Error).message);
      keeperLog({ action: "error", detail: (e as Error).message.split("\n")[0], ok: false });
    }
    keeperTicked();
    await new Promise((r) => setTimeout(r, config.keeper.intervalMs));
  }
}

async function tick(wallet: ReturnType<typeof keeperWallet>["wallet"], _me: Address) {
  const rows = await sql<{ address: string; volume_since_distribute: string; last_distributed_at: Date | null; launch_ts: Date; graduated: boolean; paired_usdc: string; graduation_threshold: string; factory: string | null; splitter: string; splitter_active: boolean }[]>`
    select address, volume_since_distribute, last_distributed_at, launch_ts, graduated, paired_usdc, graduation_threshold, factory, splitter, splitter_active from tokens`;
  const now = Date.now();
  for (const t of rows) {
    const A = addrsFor(t.factory); // the locker / factory generation this token lives on
    const vol = BigInt(t.volume_since_distribute);
    const estFee = vol / 100n; // 1% pool fee
    const since = (t.last_distributed_at ?? t.launch_ts).getTime();
    const stale = now - since >= config.keeper.maxAgeMs;
    if (vol > 0n && (estFee >= config.keeper.feeThresholdUsdc || stale)) {
      // Slippage guard for the token→USDC conversion inside distribute: dry-run with minOut=0 to learn
      // how much USDC the token-side fees fetch right now, then require 97% of that on the real call.
      let minOut = 0n;
      try {
        const { result } = await client.simulateContract({
          address: A.locker, abi: lockerAbi, functionName: "distribute", args: [t.address as Address, 0n], account: wallet.account!,
        });
        minOut = (result[1] * 97n) / 100n;
      } catch (e) {
        console.warn(`[keeper] distribute dry-run failed for ${t.address}, using minOut=0:`, (e as Error).message.split("\n")[0]);
      }
      // wallet client is bound to the local private-key account → signs locally, no eth_sendTransaction
      const hash = await wallet.writeContract({ address: A.locker, abi: lockerAbi, functionName: "distribute", args: [t.address as Address, minOut], chain: wallet.chain, account: wallet.account! });
      const rc = await client.waitForTransactionReceipt({ hash });
      console.log(`[keeper] distribute ${t.address} estFee=${estFee} minOut=${minOut} → ${rc.status} ${hash}`);
      keeperLog({ action: "distribute", token: t.address, detail: `estFee=${estFee} minOut=${minOut}`, hash, ok: rc.status === "success" });
      // Arm: the creator share just landed in the token's splitter; sync forwards it to the creator (minus the referral pool)
      if (rc.status === "success" && t.splitter && t.splitter_active) {
        const sh = await wallet.writeContract({ address: t.splitter as Address, abi: splitterAbi, functionName: "sync", chain: wallet.chain, account: wallet.account! });
        const src = await client.waitForTransactionReceipt({ hash: sh });
        console.log(`[keeper] splitter.sync ${t.address} → ${src.status} ${sh}`);
        keeperLog({ action: "sync", token: t.address, detail: `splitter=${t.splitter}`, hash: sh, ok: src.status === "success" });
      }
    }
    // Persist graduation once the pool crosses the threshold (emits Graduated for the indexer).
    if (!t.graduated && BigInt(t.paired_usdc) >= BigInt(t.graduation_threshold) && BigInt(t.graduation_threshold) > 0n) {
      const hash = await wallet.writeContract({ address: A.factory, abi: factoryAbi, functionName: "markGraduated", args: [t.address as Address], chain: wallet.chain, account: wallet.account! });
      const rc = await client.waitForTransactionReceipt({ hash });
      console.log(`[keeper] markGraduated ${t.address} → ${rc.status} ${hash}`);
      keeperLog({ action: "markGraduated", token: t.address, detail: `paired=${t.paired_usdc}`, hash, ok: rc.status === "success" });
    }
  }
  await settle(wallet);
  await settleReferrals(wallet);
}

/** Treasury: weekly `execute()` — 16/22 → reserve, 5/22 → buyback, 1/22 → dev team. Permissionless,
 *  pure USDC transfers, so there is nothing to quote or guard. */
async function settle(wallet: ReturnType<typeof keeperWallet>["wallet"]) {
  const [nextAt, pending] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "nextExecuteAt" },
      { address: ADDR.treasury, abi: treasuryAbi, functionName: "pendingRevenue" },
    ],
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < nextAt) return;
  const toEco = (pending * 16n) / 22n;
  const toBuyback = (pending * 5n) / 22n;
  const toDev = (pending * 1n) / 22n;
  if (toEco === 0n && toBuyback === 0n && toDev === 0n) return;
  const hash = await wallet.writeContract({ address: ADDR.treasury, abi: treasuryAbi, functionName: "execute", chain: wallet.chain, account: wallet.account! });
  const rc = await client.waitForTransactionReceipt({ hash });
  const detail = `eco=${toEco} buyback=${toBuyback} dev=${toDev}`;
  console.log(`[keeper] treasury.execute ${detail} → ${rc.status} ${hash}`);
  keeperLog({ action: "execute", detail, hash, ok: rc.status === "success" });
}
