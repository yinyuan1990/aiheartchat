import { createWalletClient, erc20Abi, http, maxUint256, type Address, type LocalAccount, type PublicClient } from "viem";
import { ADDR } from "@/lib/web3";
import { V4, v4QuoterAbi, vaultAbi, type BoatInfo } from "@/lib/boat";
import { chainByKey, publicClientFor, rpcOf } from "./chains";
import type { Side, TradeStep } from "./arm-trade";

/**
 * $BOAT swaps signed by the wallet's own key: same path as the site's /games Trade card (BoatVault.buy / sell, which
 * swaps through the Uniswap V4 pool and keeps the 1% pool fee for the reward pool).
 */

const arc = () => chainByKey("arc");

export type BoatRoute = { vault: Address; boat: Address; boatIsToken0: boolean };

export function boatRoute(info?: BoatInfo): BoatRoute | null {
  return info?.enabled && info.vault && info.boat ? { vault: info.vault, boat: info.boat, boatIsToken0: !!info.boatIsToken0 } : null;
}

/** Pool-side output for `amountIn` (USDC 6dp on buys, BOAT 18dp on sells). */
export async function quoteBoat(r: BoatRoute, side: Side, amountIn: bigint, pc: PublicClient = publicClientFor(arc())): Promise<bigint> {
  const key = await pc.readContract({ address: r.vault, abi: vaultAbi, functionName: "poolKey" });
  const zeroForOne = side === "buy" ? !r.boatIsToken0 : r.boatIsToken0;
  const { result } = await pc.simulateContract({ address: V4.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }] });
  return result[0];
}

/** % worse than the indexer's spot price. */
export function boatImpact(side: Side, amountIn: bigint, out: bigint, spot?: number) {
  const inNum = side === "buy" ? Number(amountIn) / 1e6 : Number(amountIn) / 1e18;
  const outNum = side === "buy" ? Number(out) / 1e18 : Number(out) / 1e6;
  if (!spot || !(inNum > 0) || !(outNum > 0)) return 0;
  const exec = side === "buy" ? inNum / outNum : outNum / inNum;
  return Math.max(0, (side === "buy" ? exec / spot - 1 : 1 - exec / spot) * 100);
}

/** Approves the vault once (max, like the site) if needed, then buys / sells; resolves with the receipt. */
export async function executeBoatTrade(account: LocalAccount, r: BoatRoute, side: Side, amountIn: bigint, minOut: bigint, onStep?: (s: TradeStep) => void) {
  const chain = arc();
  const pc = publicClientFor(chain);
  const wc = createWalletClient({ account, chain: chain.chain, transport: http(rpcOf(chain)) });
  const me = account.address;
  const tokenIn = side === "buy" ? ADDR.usdc : r.boat;

  const allowance = await pc.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [me, r.vault] });
  if (allowance < amountIn) {
    onStep?.("approving");
    const h = await wc.writeContract({ address: tokenIn, abi: erc20Abi, functionName: "approve", args: [r.vault, maxUint256] });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error("授权失败");
  }

  onStep?.("swapping");
  const hash = await wc.writeContract({ address: r.vault, abi: vaultAbi, functionName: side, args: [amountIn, minOut, me] });
  onStep?.("confirming");
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw Object.assign(new Error("交易失败（链上回滚，可能是滑点不够）"), { hash });
  return rc;
}
