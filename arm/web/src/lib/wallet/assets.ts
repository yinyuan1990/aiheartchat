"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits, getAddress, type Address } from "viem";
import { API_BASE, useWallet } from "@/lib/api";
import { useBoatInfo } from "@/lib/boat";
import { SOL_CHAIN, TON_CHAIN, TRON_CHAIN, chainByKey, isEvm, isSolana, isTon, isTron, nativeIcon, publicClientFor, rpcOf, useNodes, type WalletChain } from "./chains";
import { useHeldTokens, useMarketPrices } from "./market";
import { LAMPORTS, WSOL_MINT, getTokenAccounts, solRpc } from "./sol";
import { SUN, USDT_TRC20, tronAccount } from "./tron";
import { NANO, USDT_TON, fetchTonJettons, sameTonAddress, tonAccount } from "./ton";

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
  /** EVM token bought through the 交易 tab → /wallet/market */
  market?: boolean;
  /** TRON: TRC20 contract ("T…"); undefined = TRX */
  trc20?: string;
  /** TON: jetton master ("EQ…"); undefined = GRAM */
  jetton?: string;
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
        logo: mint === USDC_SOL_MINT ? USDC_LOGO : iconUrl(t?.icon),
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

// keep in sync with the indexer's /api/img host list
const PROXIED = /(^|\.)(coingecko\.com|geckoterminal\.com|dexscreener\.com|pump\.fun|ipfs\.io|cf-ipfs\.com|dweb\.link|nftstorage\.link|mypinata\.cloud|pinata\.cloud|arweave\.net|irys\.xyz|axiom-cdn\.io|j7tracker\.io|githubusercontent\.com|defined\.fi|jup\.ag|tonapi\.io)$/i;
/** Token icons from hosts that hang in mainland China go through the indexer's image relay. */
export function iconUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const h = new URL(u);
    return h.protocol === "https:" && PROXIED.test(h.hostname) ? `${API_BASE}/img?u=${encodeURIComponent(u)}` : u;
  } catch {
    return absUrl(u);
  }
}

const COINGECKO: Record<string, string> = { eth: "ethereum", base: "ethereum", arb: "ethereum", bsc: "binancecoin", polygon: "polygon-ecosystem-token", trx: "tron" };

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
  const added = useHeldTokens("arc");
  const addedBal = useQuery({
    queryKey: ["wallet", "arc-added", address, added.map((t) => t.address).join(",")],
    enabled: enabled && !!address && added.length > 0,
    queryFn: () => Promise.all(added.map((t) => publicClientFor(chainByKey("arc")).readContract({ address: t.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address!] }).catch(() => 0n))),
    refetchInterval: 20_000,
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
  if (w.data) {
    added.forEach((t, i) => {
      if (assets.some((a) => a.token?.toLowerCase() === t.address.toLowerCase())) return;
      const raw = addedBal.data?.[i] ?? 0n;
      assets.push({ id: t.address, symbol: t.symbol, name: t.name, logo: iconUrl(t.image), seed: t.address, decimals: t.decimals, raw, amount: Number(formatUnits(raw, t.decimals)), priceUsd: null, valueUsd: null, change24h: null, token: getAddress(t.address) });
    });
  }
  return { assets, loading: w.isLoading, error: w.isError };
}

function useEvmAssets(chain: WalletChain, address?: Address, enabled = true) {
  const prices = useNativePrices();
  const held = useHeldTokens(chain.key);
  const q = useQuery({
    queryKey: ["wallet", "evm-balances", chain.key, address, held.map((t) => t.address).join(",")],
    enabled: enabled && !!address,
    queryFn: async () => {
      const pc = publicClientFor(chain);
      const bal = (t: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [address!] }).catch(() => 0n);
      const [native, stables, tokens] = await Promise.all([pc.getBalance({ address: address! }), Promise.all(chain.stables.map((s) => bal(s.address))), Promise.all(held.map((t) => bal(t.address as Address)))]);
      return { native, stables, tokens };
    },
    refetchInterval: 20_000,
  });
  const owned = held.filter((t, i) => (q.data?.tokens[i] ?? 0n) > 0n || t.added);
  const mp = useMarketPrices(
    chain.key,
    owned.map((t) => t.address),
    enabled,
  );
  const assets: Asset[] = [];
  if (q.data) {
    const nc = chain.chain.nativeCurrency;
    const p = prices.data?.[COINGECKO[chain.key]];
    const amount = Number(formatUnits(q.data.native, nc.decimals));
    assets.push({ id: "native", symbol: nc.symbol, name: nc.name, logo: nativeIcon(chain), seed: `${chain.key}-native`, decimals: nc.decimals, raw: q.data.native, amount, priceUsd: p?.usd ?? null, valueUsd: p ? amount * p.usd : null, change24h: p?.usd_24h_change ?? null, gas: true });
    chain.stables.forEach((s, i) => {
      const raw = q.data!.stables[i];
      const amount = Number(formatUnits(raw, s.decimals));
      assets.push({ id: s.address, symbol: s.symbol, name: s.symbol, logo: s.symbol === "USDC" ? USDC_LOGO : undefined, seed: s.address, decimals: s.decimals, raw, amount, priceUsd: 1, valueUsd: amount, change24h: 0, token: s.address });
    });
    held.forEach((t, i) => {
      const raw = q.data!.tokens[i] ?? 0n;
      if (raw === 0n && !t.added) return;
      const amount = Number(formatUnits(raw, t.decimals));
      const p = mp.data?.[t.address];
      const price = p?.priceUsd ?? null;
      assets.push({ id: t.address, symbol: t.symbol, name: t.name, logo: iconUrl(p?.image ?? t.image), seed: t.address, decimals: t.decimals, raw, amount, priceUsd: price, valueUsd: price != null ? amount * price : null, change24h: p?.change24h ?? null, token: getAddress(t.address), market: true });
    });
  }
  return { assets, loading: q.isLoading, error: q.isError };
}

export const USDT_LOGO = "/wallet/usdt.svg";

/** TRX, USDT and the TRC20s the user added (TRON addresses get spam tokens, so others are not listed). */
function useTronAssets(owner?: string, enabled = true): { assets: Asset[]; loading: boolean; error: boolean } {
  useNodes();
  const prices = useNativePrices();
  const added = useHeldTokens(TRON_CHAIN.key);
  const tokens = [{ address: USDT_TRC20, symbol: "USDT", name: "Tether USD", image: USDT_LOGO as string | null, decimals: 6 }, ...added.filter((t) => t.address !== USDT_TRC20)];
  const q = useQuery({
    queryKey: ["wallet", "tron-balances", owner, rpcOf(TRON_CHAIN), tokens.map((t) => t.address).join(",")],
    enabled: enabled && !!owner,
    queryFn: () => tronAccount(owner!, tokens.map((t) => t.address)),
    refetchInterval: 30_000,
  });
  const assets: Asset[] = [];
  if (q.data) {
    const p = prices.data?.tron;
    const amount = Number(q.data.trx) / SUN;
    assets.push({ id: "native", symbol: "TRX", name: "TRON", logo: TRON_CHAIN.icon, seed: "trx-native", decimals: 6, raw: q.data.trx, amount, priceUsd: p?.usd ?? null, valueUsd: p ? amount * p.usd : null, change24h: p?.usd_24h_change ?? null, gas: true });
    for (const t of tokens) {
      const raw = q.data.trc20[t.address] ?? 0n;
      const amount = Number(formatUnits(raw, t.decimals));
      const usd = t.address === USDT_TRC20 ? 1 : null;
      assets.push({ id: t.address, symbol: t.symbol, name: t.name, logo: t.image ?? undefined, seed: t.address, decimals: t.decimals, raw, amount, priceUsd: usd, valueUsd: usd != null ? amount : null, change24h: usd != null ? 0 : null, trc20: t.address });
    }
  }
  return { assets, loading: q.isLoading, error: q.isError };
}

export const GRAM_LOGO = "/wallet/chains/ton.png";

/** GRAM, USDT and the jettons the user added (like TRON: TON addresses get spam jettons, so others are not listed). */
function useTonAssets(owner?: string, enabled = true): { assets: Asset[]; loading: boolean; error: boolean } {
  useNodes();
  const added = useHeldTokens(TON_CHAIN.key);
  const tokens = [{ address: USDT_TON, symbol: "USDT", name: "Tether USD", image: USDT_LOGO as string | null, decimals: 6 }, ...added.filter((t) => !sameTonAddress(t.address, USDT_TON))];
  const q = useQuery({
    queryKey: ["wallet", "ton-balances", owner, rpcOf(TON_CHAIN), tokens.map((t) => t.address).join(",")],
    enabled: enabled && !!owner,
    queryFn: () => tonAccount(owner!, tokens.map((t) => t.address)),
    refetchInterval: 30_000,
  });
  const info = useQuery({
    queryKey: ["wallet", "ton-jettons", tokens.map((t) => t.address).join(",")],
    enabled,
    queryFn: () => fetchTonJettons(["ton", ...tokens.map((t) => t.address)]),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  });
  const assets: Asset[] = [];
  if (q.data) {
    const p = info.data?.ton;
    const amount = Number(q.data.ton) / NANO;
    assets.push({ id: "native", symbol: "GRAM", name: "Gram（原 Toncoin）", logo: GRAM_LOGO, seed: "ton-native", decimals: 9, raw: q.data.ton, amount, priceUsd: p?.priceUsd ?? null, valueUsd: p?.priceUsd != null ? amount * p.priceUsd : null, change24h: p?.change24h ?? null, gas: true });
    for (const t of tokens) {
      const raw = q.data.jettons[t.address] ?? 0n;
      const amount = Number(formatUnits(raw, t.decimals));
      const m = info.data?.[t.address];
      const usd = sameTonAddress(t.address, USDT_TON) ? 1 : (m?.priceUsd ?? null);
      assets.push({ id: t.address, symbol: t.symbol, name: t.name, logo: t.image ? iconUrl(t.image) : iconUrl(m?.image), seed: t.address, decimals: t.decimals, raw, amount, priceUsd: usd, valueUsd: usd != null ? amount * usd : null, change24h: sameTonAddress(t.address, USDT_TON) ? 0 : (m?.change24h ?? null), jetton: t.address });
    }
  }
  return { assets, loading: q.isLoading, error: q.isError };
}

/** Balances of `address` on `chain`, highest value first (gas coin pinned on top). */
export function useAssets(chain: WalletChain, address?: string) {
  const sol = isSolana(chain);
  const tron = isTron(chain);
  const ton = isTon(chain);
  const arc = useArcAssets(address as Address | undefined, chain.key === "arc");
  const evm = useEvmAssets(chain, address as Address | undefined, chain.key !== "arc" && isEvm(chain));
  const solana = useSolAssets(address, sol);
  const tronR = useTronAssets(address, tron);
  const tonR = useTonAssets(address, ton);
  const r = sol ? solana : tron ? tronR : ton ? tonR : chain.key === "arc" ? arc : evm;
  const assets = [...r.assets].sort((a, b) => Number(!!b.gas) - Number(!!a.gas) || (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const total = assets.reduce((s, a) => s + (a.valueUsd ?? 0), 0);
  const change = assets.reduce((s, a) => s + (a.valueUsd && a.change24h ? a.valueUsd - a.valueUsd / (1 + a.change24h / 100) : 0), 0);
  return { assets, total, change, loading: r.loading, error: r.error };
}
