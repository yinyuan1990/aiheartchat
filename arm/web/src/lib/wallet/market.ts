"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { createWalletClient, erc20Abi, getAddress, http, type Address, type Hex, type LocalAccount } from "viem";
import { API_BASE } from "@/lib/api";
import { publicClientFor, rpcOf, type WalletChain } from "./chains";
import { storeRead, storeWrite } from "./native";

/**
 * EVM token markets in the wallet (Ethereum / BNB Chain / Base / Arbitrum / Polygon): data from the indexer's /api/mkt/*
 * (GeckoTerminal + DexScreener, cached server-side), trades routed by KyberSwap — the indexer relays the route and
 * builds the calldata, the wallet checks the router and signs locally. No platform fee.
 */

export const MARKET_CHAINS = ["eth", "bsc", "base", "arb", "polygon"] as const;
export type MarketChainKey = (typeof MARKET_CHAINS)[number];
export const isMarketChain = (k: string): k is MarketChainKey => (MARKET_CHAINS as readonly string[]).includes(k);
export type MarketTab = "hot" | "new" | "gainers";

export type MarketRow = { address: string; pool: string; name: string; symbol: string; image: string | null; priceUsd: number | null; change1h: number | null; change24h: number | null; mcapUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; createdAt: number | null; dex: string | null };
type Window4 = { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
export type MarketToken = {
  address: string;
  name: string;
  symbol: string;
  image: string | null;
  header: string | null;
  priceUsd: number | null;
  priceNative: number | null;
  changes: Window4;
  volume: Window4;
  txns24h: { buys: number; sells: number } | null;
  liquidityUsd: number | null;
  mcapUsd: number | null;
  fdvUsd: number | null;
  pool: string;
  dex: string;
  dexLabel: string | null;
  quote: { address: string; symbol: string };
  pairCreatedAt: number | null;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  description: string | null;
  holders: number | null;
  top10Pct: number | null;
};
export type MarketCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type MarketTrade = { hash: string; at: number; side: "buy" | "sell"; trader: string; tokens: number; usd: number; priceUsd: number };
export type MarketPrice = { priceUsd: number | null; change24h: number | null; symbol: string; name: string; image: string | null };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? "没找到这个币" : "行情数据暂时拿不到"), { status: r.status });
  return r.json();
}

/** GeckoTerminal-backed data can be briefly out of budget server-side (503 → 502): keep retrying a few seconds apart. */
const patient = { retry: (n: number, e: unknown) => (e as { status?: number }).status !== 404 && n < 5, retryDelay: (n: number) => 2_500 * (n + 1) };

export const useMarketList = (chain: MarketChainKey, tab: MarketTab, q: string) =>
  useQuery({ queryKey: ["mkt", chain, "list", tab, q], queryFn: () => get<MarketRow[]>(q ? `/mkt/${chain}/coins?q=${encodeURIComponent(q)}` : `/mkt/${chain}/coins?tab=${tab}`), refetchInterval: 60_000, staleTime: 30_000, ...patient });

export const useMarketToken = (chain: string, address: string) =>
  useQuery({ queryKey: ["mkt", chain, "token", address], queryFn: () => get<MarketToken>(`/mkt/${chain}/token/${address}`), refetchInterval: 15_000, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2 });

export const useMarketCandles = (chain: string, pool: string | undefined, interval: string, token: string) =>
  useQuery({ queryKey: ["mkt", chain, "candles", pool, interval], enabled: !!pool, queryFn: () => get<MarketCandle[]>(`/mkt/${chain}/candles?pool=${pool}&interval=${interval}&token=${token}`), refetchInterval: interval === "1m" ? 20_000 : 45_000, ...patient });

export const useMarketTrades = (chain: string, pool: string | undefined, token: string, enabled = true) =>
  useQuery({ queryKey: ["mkt", chain, "trades", pool], enabled: enabled && !!pool, queryFn: () => get<MarketTrade[]>(`/mkt/${chain}/trades?pool=${pool}&token=${token}`), refetchInterval: 30_000, ...patient });

export const useMarketPrices = (chain: string, addrs: string[], enabled = true) =>
  useQuery({ queryKey: ["mkt", chain, "prices", addrs.join(",")], enabled: enabled && addrs.length > 0, queryFn: () => get<Record<string, MarketPrice | null>>(`/mkt/${chain}/prices?addrs=${addrs.join(",")}`), staleTime: 30_000, refetchInterval: 60_000 });

// ---------- tokens bought through the 交易 tab (so the asset list can show them) ----------

export type HeldToken = { address: string; symbol: string; name: string; image: string | null; decimals: number };
type Held = Record<string, HeldToken[]>;
const HELD_KEY = "evmTokens";
let held: Held = {};
let heldLoaded: Promise<void> | null = null;
const heldSubs = new Set<() => void>();

function loadHeld() {
  heldLoaded ??= (async () => {
    try {
      const v = JSON.parse((await storeRead(HELD_KEY)) ?? "{}") as Held;
      if (v && typeof v === "object") held = v;
    } catch {}
    heldSubs.forEach((f) => f());
  })();
  return heldLoaded;
}

export function rememberToken(chain: string, t: HeldToken) {
  const list = (held[chain] ?? []).filter((x) => x.address !== t.address);
  held = { ...held, [chain]: [t, ...list].slice(0, 100) };
  heldSubs.forEach((f) => f());
  void storeWrite(HELD_KEY, JSON.stringify(held));
}

export function useHeldTokens(chain: string): HeldToken[] {
  const all = useSyncExternalStore(
    (f) => {
      heldSubs.add(f);
      void loadHeld();
      return () => heldSubs.delete(f);
    },
    () => held,
    () => held,
  );
  return all[chain] ?? EMPTY;
}
const EMPTY: HeldToken[] = [];

// ---------- trading (KyberSwap) ----------

export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** KyberSwap MetaAggregationRouterV2, the same address on every chain we trade on; anything else is refused. */
const KYBER_ROUTER: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

export type KyberQuote = { routeSummary: { tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; amountInUsd: string; amountOutUsd: string; gasUsd?: string; route?: { exchange: string }[][] }; routerAddress: string };

export class MarketQuoteError extends Error {
  constructor(message: string, readonly code: "no_route" | "other") {
    super(message);
  }
}

export async function kyberQuote(chain: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberQuote> {
  const p = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString() });
  const r = await fetch(`${API_BASE}/mkt/${chain}/quote?${p}`);
  const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: KyberQuote; error?: string };
  if (!r.ok || j.code !== 0 || !j.data) {
    if (j.code === 4008 || /route not found/i.test(j.message ?? "")) throw new MarketQuoteError("没有可成交的路线（流动性不足）", "no_route");
    throw new MarketQuoteError((j.message ?? j.error ?? `报价失败 ${r.status}`).slice(0, 120), "other");
  }
  return j.data;
}

export const kyberDexes = (q: KyberQuote) => [...new Set((q.routeSummary.route ?? []).flat().map((s) => s.exchange))].slice(0, 3).join(" · ") || "KyberSwap";

/** % lost between the USD value going in and coming out (Kyber's own USD estimates; includes the pool fees). */
export function kyberImpact(q: KyberQuote): number | null {
  const i = Number(q.routeSummary.amountInUsd);
  const o = Number(q.routeSummary.amountOutUsd);
  return i > 0 && o > 0 ? Math.max(0, (1 - o / i) * 100) : null;
}

export type MarketStep = "approving" | "building" | "swapping" | "confirming";

/**
 * Approves exactly `amountIn` when selling a token (never unlimited), builds the route on the indexer, checks the
 * calldata targets Kyber's router, then signs and waits. Resolves the swap transaction hash.
 */
export async function executeKyberSwap(account: LocalAccount, chain: WalletChain, quote: KyberQuote, slippageBps: number, onStep: (s: MarketStep) => void): Promise<Hex> {
  const pc = publicClientFor(chain);
  const wc = createWalletClient({ account, chain: chain.chain, transport: http(rpcOf(chain)) });
  const me = account.address;
  const tokenIn = quote.routeSummary.tokenIn;
  const amountIn = BigInt(quote.routeSummary.amountIn);
  if (getAddress(quote.routerAddress) !== KYBER_ROUTER) throw new Error("路由合约不对，已停止");

  if (tokenIn.toLowerCase() !== NATIVE.toLowerCase()) {
    const allowance = await pc.readContract({ address: tokenIn as Address, abi: erc20Abi, functionName: "allowance", args: [me, KYBER_ROUTER] });
    if (allowance < amountIn) {
      onStep("approving");
      const h = await wc.writeContract({ address: tokenIn as Address, abi: erc20Abi, functionName: "approve", args: [KYBER_ROUTER, amountIn] });
      const rc = await pc.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      if (rc.status !== "success") throw new Error("授权失败");
    }
  }

  onStep("building");
  const r = await fetch(`${API_BASE}/mkt/${chain.key}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routeSummary: quote.routeSummary, sender: me, slippageBps }) });
  const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: { data: Hex; routerAddress: string; transactionValue: string } };
  if (!r.ok || j.code !== 0 || !j.data) throw new Error((j.message ?? `生成交易失败 ${r.status}`).slice(0, 120));
  if (getAddress(j.data.routerAddress) !== KYBER_ROUTER) throw new Error("路由合约不对，已停止");

  onStep("swapping");
  const hash = await wc.sendTransaction({ to: KYBER_ROUTER, data: j.data.data, value: BigInt(j.data.transactionValue || "0") });
  onStep("confirming");
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw Object.assign(new Error("交易失败（链上回滚，可能是滑点不够）"), { hash });
  return hash;
}
