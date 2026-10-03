"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type Address } from "viem";
import { API_BASE, useWallet } from "@/lib/api";
import { useBoatInfo } from "@/lib/boat";
import { chainByKey, publicClientFor, type WalletChain } from "./chains";

export type Asset = {
  id: string;
  symbol: string;
  name: string;
  logo?: string;
  seed: string;
  decimals: number;
  raw: bigint;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  change24h: number | null;
  /** ERC-20 contract; undefined = the chain's native coin (on Arc, USDC itself is sent as ERC-20) */
  token?: Address;
  /** pays network fees on this chain */
  gas?: boolean;
  /** Arm-launched token → has a detail / trade page */
  arm?: boolean;
  spark?: number[];
};

export const USDC_LOGO = "/wallet/usdc.svg";

/** Indexer uploads come back host-relative ("/api/uploads/…"); the wallet may run on another origin than the API. */
export function absUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  if (u.startsWith("/api/") && API_BASE.startsWith("http")) return new URL(API_BASE).origin + u;
  return u;
}

const COINGECKO: Record<string, string> = { eth: "ethereum", base: "ethereum", arb: "ethereum", bsc: "binancecoin", polygon: "polygon-ecosystem-token" };

function useNativePrices() {
  return useQuery({
    queryKey: ["wallet", "native-prices"],
    queryFn: async () => {
      const ids = [...new Set(Object.values(COINGECKO))].join(",");
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
    },
    staleTime: 120_000,
    refetchInterval: 120_000,
    retry: 1,
  });
}

function useArcAssets(address?: Address, enabled = true): { assets: Asset[]; loading: boolean; error: boolean } {
  const w = useWallet(enabled ? address : undefined);
  const boat = useBoatInfo();
  const boatAddr = boat.data?.boat;
  const boatBal = useQuery({
    queryKey: ["wallet", "boat-balance", address, boatAddr],
    enabled: enabled && !!address && !!boatAddr,
    queryFn: () => publicClientFor(chainByKey("arc")).readContract({ address: boatAddr!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
    refetchInterval: 15_000,
  });
  const assets: Asset[] = [];
  if (w.data) {
    const raw = BigInt(w.data.usdcBalance);
    const amount = Number(formatUnits(raw, 6));
    assets.push({ id: "usdc", symbol: "USDC", name: "USD Coin", logo: USDC_LOGO, seed: "0x3600000000000000000000000000000000000000", decimals: 6, raw, amount, priceUsd: 1, valueUsd: amount, change24h: 0, token: "0x3600000000000000000000000000000000000000", gas: true });
    for (const h of w.data.holdings) {
      const raw = BigInt(h.balance);
      assets.push({
        id: h.token.address,
        symbol: h.token.symbol,
        name: h.token.name,
        logo: absUrl(h.token.logo),
        seed: h.token.address,
        decimals: 18,
        raw,
        amount: Number(formatUnits(raw, 18)),
        priceUsd: h.token.price,
        valueUsd: h.valueUsd,
        change24h: h.token.change24h ?? null,
        token: h.token.address as Address,
        arm: true,
      });
    }
  }
  if (boatBal.data && boatBal.data > 0n && boatAddr) {
    const amount = Number(formatUnits(boatBal.data, 18));
    const p = boat.data?.priceUsdc ?? null;
    assets.push({ id: boatAddr, symbol: "BOAT", name: "Speedboat", seed: boatAddr, decimals: 18, raw: boatBal.data, amount, priceUsd: p, valueUsd: p == null ? null : amount * p, change24h: null, token: boatAddr });
  }
  return { assets, loading: w.isLoading, error: w.isError };
}

function useEvmAssets(chain: WalletChain, address?: Address, enabled = true) {
  const prices = useNativePrices();
  const q = useQuery({
    queryKey: ["wallet", "evm-balances", chain.key, address],
    enabled: enabled && !!address,
    queryFn: async () => {
      const pc = publicClientFor(chain);
      const [native, ...stables] = await Promise.all([
        pc.getBalance({ address: address! }),
        ...chain.stables.map((s) => pc.readContract({ address: s.address, abi: erc20Abi, functionName: "balanceOf", args: [address!] }).catch(() => 0n)),
      ]);
      return { native, stables };
    },
    refetchInterval: 20_000,
  });
  const assets: Asset[] = [];
  if (q.data) {
    const nc = chain.chain.nativeCurrency;
    const p = prices.data?.[COINGECKO[chain.key]];
    const amount = Number(formatUnits(q.data.native, nc.decimals));
    assets.push({ id: "native", symbol: nc.symbol, name: nc.name, seed: `${chain.key}-native`, decimals: nc.decimals, raw: q.data.native, amount, priceUsd: p?.usd ?? null, valueUsd: p ? amount * p.usd : null, change24h: p?.usd_24h_change ?? null, gas: true });
    chain.stables.forEach((s, i) => {
      const raw = q.data!.stables[i];
      const amount = Number(formatUnits(raw, s.decimals));
      assets.push({ id: s.address, symbol: s.symbol, name: s.symbol, logo: s.symbol === "USDC" ? USDC_LOGO : undefined, seed: s.address, decimals: s.decimals, raw, amount, priceUsd: 1, valueUsd: amount, change24h: 0, token: s.address });
    });
  }
  return { assets, loading: q.isLoading, error: q.isError };
}

/** Balances of `address` on `chain`, highest value first (gas coin pinned on top). */
export function useAssets(chain: WalletChain, address?: Address) {
  const arc = useArcAssets(address, chain.key === "arc");
  const evm = useEvmAssets(chain, address, chain.key !== "arc");
  const r = chain.key === "arc" ? arc : evm;
  const assets = [...r.assets].sort((a, b) => Number(!!b.gas) - Number(!!a.gas) || (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const total = assets.reduce((s, a) => s + (a.valueUsd ?? 0), 0);
  const change = assets.reduce((s, a) => s + (a.valueUsd && a.change24h ? a.valueUsd - a.valueUsd / (1 + a.change24h / 100) : 0), 0);
  return { assets, total, change, loading: r.loading, error: r.error };
}
