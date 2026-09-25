"use client";

import { useCallback } from "react";
import { parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { ADDR, STOCK, erc20Abi, factoryAbi, stockFactoryAbi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { useApp } from "@/components/providers";

export type LaunchInput = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { website: string; twitter: string; telegram: string; discord: string; farcaster: string };
  /** creator fee wallet; zero = the connected wallet */
  payout?: Address;
  buyTaxBps: number;
  sellTaxBps: number;
  marketingWallet?: Address;
  teamWallet?: Address;
  marketingBps: number;
  /** first buy in USDC (6dp) — for stock launches the factory routes it USDC → quote → token */
  initialBuyUsdc: bigint;
  /** stock generation: the whitelisted tokenized stock the pool is quoted in; undefined = USDC pool (default factory) */
  quote?: Address;
  /** Arm: share of the creator fees offered to promoters (bps, 0 = off, ≤ 5000) */
  referralBps?: number;
};

/**
 * The one launch path shared by the manual create page and the AI hotspot page:
 * USDC approve (if allowance is short) → factory.launch() with a padded gas limit → TokenLaunched parsed.
 *
 * Gas: the token address is CREATE2 with the previous block hash in the salt, so the address (hence token0/token1
 * order and the exact gas path) differs between the wallet's estimate and the mined block. A bare estimate has come
 * up ~5% short in practice; we pad the estimate by 30%.
 */
export function useLaunch() {
  const { run, client } = useTx();
  const { address, t } = useApp();

  const launch = useCallback(
    async (input: LaunchInput, creationFee6: bigint): Promise<{ token: Address | undefined; hash: Hex } | null> => {
      const me = address as Address | undefined;
      if (!me || !client) return null;
      // stock-paired launch → StockLaunchFactory (same fee, same USDC first buy, extra `quote` param)
      const stock = !!input.quote;
      if (stock && !STOCK) throw new Error("stock factory not deployed");
      const factory = stock ? STOCK!.factory : ADDR.factory;
      const need6 = creationFee6 + input.initialBuyUsdc;
      if (need6 > 0n) {
        const allowance = await client.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "allowance", args: [me, factory] });
        if (allowance < need6) {
          const rc = await run(t("create.step.approve"), { address: ADDR.usdc, abi: erc20Abi, functionName: "approve", args: [factory, need6] });
          if (!rc) return null;
        }
      }
      // Uploads are stored host-relative (multi-domain site); the on-chain string must be absolute, so pin it to the
      // domain the creator is launching from.
      const logo = input.logo.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${input.logo}` : input.logo;
      const params = {
        name: input.name,
        symbol: input.symbol,
        logo,
        description: input.description,
        socials: input.socials,
        payout: input.payout ?? zeroAddress,
        buyTaxBps: input.buyTaxBps,
        sellTaxBps: input.sellTaxBps,
        marketingWallet: input.marketingWallet ?? zeroAddress,
        teamWallet: input.teamWallet ?? zeroAddress,
        marketingBps: input.marketingBps,
      } as const;
      // the two factories share every param except `quote`; viem's generics need one concrete ABI per call site,
      // hence the two branches (the estimate is best-effort: a failure falls back to the wallet's own estimate)
      const withGas = async <C extends { address: Address }>(call: C, est: () => Promise<bigint>) => {
        let gas: bigint | undefined;
        try {
          gas = ((await est()) * 13n) / 10n;
        } catch {}
        return { ...call, gas };
      };
      const rc = stock
        ? await (async () => {
            const call = { address: factory, abi: stockFactoryAbi, functionName: "launch" as const, args: [{ ...params, quote: input.quote!, initialBuyUsdc: input.initialBuyUsdc, minTokensOut: 0n }] as const };
            return run(t("create.step.launch"), await withGas(call, () => client.estimateContractGas({ ...call, account: me })));
          })()
        : await (async () => {
            const call = { address: factory, abi: factoryAbi, functionName: "launch" as const, args: [{ ...params, initialBuyUsdc: input.initialBuyUsdc, minTokensOut: 0n, referralBps: input.referralBps ?? 0 }] as const };
            return run(t("create.step.launch"), await withGas(call, () => client.estimateContractGas({ ...call, account: me })));
          })();
      if (!rc) return null;
      const logs = parseEventLogs({ abi: factoryAbi, logs: rc.logs, eventName: "TokenLaunched" });
      return { token: logs[0]?.args.token, hash: rc.transactionHash };
    },
    [address, client, run, t],
  );

  return { launch };
}
