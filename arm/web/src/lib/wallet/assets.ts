"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type Address } from "viem";
import { API_BASE, useWallet } from "@/lib/api";
import { useBoatInfo } from "@/lib/boat";
import { SOL_CHAIN, chainByKey, isSolana, publicClientFor, rpcOf, useNodes, type WalletChain } from "./chains";
import { LAMPORTS, WSOL_MINT, getTokenAccounts, solRpc } from "./sol";

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
  /** $BOAT → /wallet/boat */
  boat?: boolean;
  /** Solana SPL token: mint, its token program and the account we send from (the largest one holding it) */
  mint?: string;
  program?: string;
  solAccount?: string;
  solAccountRaw?: bigint;
  /** launched on pump.fun → pump-style detail / trade page */
  pump?: boolean;
  spark?: number[];
};

export type SolTokenInfo = { mint: string; name: string; symbol: string; icon: string | null; decimals: number; usdPrice: number | null; change24h: number | null; mcap: number | null; liquidity: number | null; verified: boolean; launchpad: string | null };

export async function fetchSolTokens(mints: string[]): Promise<Record<string, SolTokenInfo | null>> {
  if (mints.length === 0) return {};
  const r = await fetch(`${API_BASE}/sol/tokens?mints=${mints.join(",")}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export const isPumpMint = (mint: string, info?: SolTokenInfo | null) => mint.endsWith("pump") || /pump/i.test(info?.launchpad ?? "");

function useSolAssets(owner?: string, enabled = true): { assets: Asset[]; loading: boolean; error: boolean } {
  useNodes();
  const url = rpcOf(SOL_CHAIN);
  const q = useQuery({
    queryKey: ["wallet", "sol-balances", owner, url],
    enabled: enabled && !!owner,
    queryFn: async () => {
      // some public nodes refuse token-account scans; still show SOL then
      const [bal, accts] = await Promise.all([solRpc<{ value: number }>(url, "getBalance", [owner, { commitment: "confirmed" }]), getTokenAccounts(url, owner!).catch(() => [])]);
      return { lamports: BigInt(bal.value), accts };
    },
    refetchInterval: 20_000,
  });
  const held = new Map<string, { raw: bigint; decimals: number; program: string; best: { pubkey: string; amount: bigint } }>();
  for (const a of q.data?.accts ?? []) {
    if (a.amount === 0n) continue;
    const h = held.get(a.mint);
    if (!h) held.set(a.mint, { raw: a.amount, decimals: a.decimals, program: a.program, best: { pubkey: a.pubkey, amount: a.amount } });
    else {
      h.raw += a.amount;
      if (a.amount > h.best.amount) h.best = { pubkey: a.pubkey, amount: a.amount };
    }
  }
  const mints = [WSOL_MINT, ...[...held.keys()].sort()];
  const info = useQuery({
    queryKey: ["wallet", "sol-tokens", mints.join(",")],
    enabled: enabled && !!q.data,
    queryFn: () => fetchSolTokens(mints),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const assets: Asset[] = [];
  if (q.data) {
    const sol = info.data?.[WSOL_MINT];
    const amount = Number(q.data.lamports) / LAMPORTS;
    assets.push({ id: "native", symbol: "SOL", name: "Solana", logo: SOL_LOGO, seed: "sol-native", decimals: 9, raw: q.data.lamports, amount, priceUsd: sol?.usdPrice ?? null, valueUsd: sol?.usdPrice != null ? amount * sol.usdPrice : null, change24h: sol?.change24h ?? null, gas: true });
    for (const [mint, h] of held) {
      const t = info.data?.[mint];
      const amount = Number(formatUnits(h.raw, h.decimals));
      assets.push({
        id: mint,
        symbol: t?.symbol ?? `${mint.slice(0, 4)}…`,
        name: t?.name ?? "未知代币",
        logo: mint === USDC_SOL_MINT ? USDC_LOGO : (t?.icon ?? undefined),
        seed: mint,
        decimals: h.decimals,
        raw: h.raw,
        amount,
        priceUsd: t?.usdPrice ?? null,
        valueUsd: t?.usdPrice != null ? amount * t.usdPrice : null,
        change24h: t?.change24h ?? null,
        mint,
        program: h.program,
        solAccount: h.best.pubkey,
        solAccountRaw: h.best.amount,
        pump: isPumpMint(mint, t),
      });
    }
  }
  return { assets, loading: q.isLoading, error: q.isError };
}

export const USDC_LOGO = "/wallet/usdc.svg";
export const SOL_LOGO = "/wallet/sol.svg";
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
    assets.push({ id: boatAddr, symbol: "BOAT", name: "Speedboat", seed: boatAddr, decimals: 18, raw: boatBal.data, amount, priceUsd: p, valueUsd: p == null ? null : amount * p, change24h: null, token: boatAddr, boat: true });
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
export function useAssets(chain: WalletChain, address?: string) {
  const sol = isSolana(chain);
  const arc = useArcAssets(address as Address | undefined, chain.key === "arc");
  const evm = useEvmAssets(chain, address as Address | undefined, chain.key !== "arc" && !sol);
  const solana = useSolAssets(address, sol);
  const r = sol ? solana : chain.key === "arc" ? arc : evm;
  const assets = [...r.assets].sort((a, b) => Number(!!b.gas) - Number(!!a.gas) || (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const total = assets.reduce((s, a) => s + (a.valueUsd ?? 0), 0);
  const change = assets.reduce((s, a) => s + (a.valueUsd && a.change24h ? a.valueUsd - a.valueUsd / (1 + a.change24h / 100) : 0), 0);
  return { assets, total, change, loading: r.loading, error: r.error };
}
