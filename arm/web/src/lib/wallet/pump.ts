"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { SolRpcError, b58, b64, explainSolError, sendAndConfirm, signBytes, signSerialized, type SolKeypair } from "./sol";
import { t } from "./i18n";

/**
 * pump.fun coins in the wallet: data comes from the indexer's /api/pump/* (pump's own feeds, cached server-side),
 * trades go through Jupiter (/api/sol/quote + /api/sol/swap build the transaction, the wallet signs it locally).
 * Jupiter routes both curve coins ("Pump.fun") and graduated ones (PumpSwap / Raydium).
 */

export type PumpTab = "hot" | "new" | "graduating" | "graduated";
export type PumpCoinRow = { mint: string; name: string; symbol: string; image: string | null; mcapUsd: number; createdAt: number; lastTradeAt: number | null; progress: number; complete: boolean; replies: number; live: boolean };
export type PumpCoin = PumpCoinRow & {
  description: string | null;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  creator: string;
  creatorName: string | null;
  creatorImage: string | null;
  athMcapUsd: number | null;
  athAt: number | null;
  kingAt: number | null;
  solInCurve: number;
  toGraduateUsd: number | null;
  priceUsd: number;
  pool: string | null;
  venue: "curve" | "pumpswap" | "raydium";
  tokenProgram: string;
  holders: { total: number; top10Pct: number | null; devPct: number | null; snipersPct: number | null } | null;
  solPrice: number;
};
export type PumpTrade = { sig: string; at: number; side: "buy" | "sell"; trader: string; tokens: number; sol: number; usd: number; priceUsd: number; venue: string };
export type PumpCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type PumpHolder = { address: string; amount: number; pct: number; isDev: boolean; isSniper: boolean; isBundler: boolean; isPool: boolean };
export type SolComment = { id: number; author: string; text: string; replyTo: number | null; time: string };

/** pump coins: 6 decimals, 1B supply */
export const PUMP_DECIMALS = 6;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? t("cw.coin.errCoinNotFound") : t("cw.coin.errSourceUnavailable")), { status: r.status });
  return r.json();
}

export const usePumpList = (tab: PumpTab, q: string) =>
  useQuery({ queryKey: ["pump", "list", tab, q], queryFn: () => get<PumpCoinRow[]>(q ? `/pump/coins?q=${encodeURIComponent(q)}` : `/pump/coins?tab=${tab}`), refetchInterval: 15_000, staleTime: 10_000 });

export const usePumpCoin = (mint: string) =>
  useQuery({ queryKey: ["pump", "coin", mint], queryFn: () => get<PumpCoin>(`/pump/coin/${mint}`), refetchInterval: 8_000, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2 });

/** `user`: only that wallet's trades (full history, newest 100) — mine for the cost basis, the creator's for bubbles. */
export const usePumpTrades = (mint: string, enabled = true, user?: string) =>
  useQuery({ queryKey: ["pump", "trades", mint, user ?? ""], enabled, queryFn: () => get<PumpTrade[]>(`/pump/coin/${mint}/trades?limit=100${user ? `&user=${user}` : ""}`), refetchInterval: user ? 20_000 : 5_000 });

export const usePumpCandles = (mint: string, interval: string, limit = 300) =>
  useQuery({ queryKey: ["pump", "candles", mint, interval, limit], queryFn: () => get<PumpCandle[]>(`/pump/coin/${mint}/candles?interval=${interval}&limit=${limit}`), refetchInterval: interval === "1m" ? 10_000 : 20_000 });

export const usePumpHolders = (mint: string, enabled = true) =>
  useQuery({ queryKey: ["pump", "holders", mint], enabled, queryFn: () => get<PumpHolder[]>(`/pump/coin/${mint}/holders`), refetchInterval: 30_000 });

export const useSolComments = (mint: string, enabled = true) =>
  useQuery({ queryKey: ["pump", "comments", mint], enabled, queryFn: () => get<SolComment[]>(`/sol/coins/${mint}/comments`), refetchInterval: 15_000 });

/** Must match the indexer's `solCommentMessage`. */
const commentMessage = (mint: string, text: string, ts: number, replyTo: number | null) => `Arm comment\nmint: ${mint}\nreply: ${replyTo ?? "-"}\nts: ${ts}\n${text}`;

export async function postSolComment(kp: SolKeypair, mint: string, text: string, replyTo: number | null = null) {
  const ts = Date.now();
  const signature = b58.encode(signBytes(new TextEncoder().encode(commentMessage(mint, text, ts, replyTo)), kp));
  const r = await fetch(`${API_BASE}/sol/coins/${mint}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ author: kp.address, text, replyTo, ts, signature }) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(r.status === 429 ? t("cw.coin.errTooFast") : (j.error ?? `HTTP ${r.status}`));
}

/** % change between the last close and the close `windowSec` ago (null when the coin is younger than that). */
export function changeOver(candles: { time: number; close: number }[], windowSec: number): number | null {
  const last = candles.at(-1);
  if (!last) return null;
  const from = last.time - windowSec;
  if (candles[0].time > from) return null;
  let ref = candles[0];
  for (const c of candles) {
    if (c.time > from) break;
    ref = c;
  }
  return ref.close > 0 ? (last.close / ref.close - 1) * 100 : null;
}

// ---------- trading (Jupiter) ----------

export type JupQuote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: { swapInfo: { label?: string } }[];
};

export class QuoteError extends Error {
  constructor(message: string, readonly code: "not_tradable" | "no_route" | "other") {
    super(message);
  }
}

export async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupQuote> {
  const p = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), swapMode: "ExactIn" });
  const r = await fetch(`${API_BASE}/sol/quote?${p}`);
  const j = (await r.json().catch(() => ({}))) as JupQuote & { error?: string; errorCode?: string };
  if (!r.ok || j.error) {
    const code = j.errorCode ?? j.error ?? "";
    if (/NOT_TRADABLE/i.test(code)) throw new QuoteError(t("cw.coin.errNotIndexed"), "not_tradable");
    if (/NO_ROUTES|COULD_NOT_FIND|ROUTE/i.test(code)) throw new QuoteError(t("cw.coin.errNoRoute"), "no_route");
    throw new QuoteError(j.error ? String(j.error).slice(0, 120) : t("cw.coin.errQuote", { status: r.status }), "other");
  }
  return j;
}

export const routeLabel = (q: JupQuote) => [...new Set(q.routePlan.map((r) => r.swapInfo.label).filter(Boolean))].join(" → ") || "Jupiter";

export type SolSwapStep = "building" | "confirming";

/** Builds the swap for `quote`, signs it with `kp` and waits for confirmation. Resolves the signature. */
export async function executeSolSwap(kp: SolKeypair, quote: JupQuote, rpcUrl: string, priority: "medium" | "high" | "veryHigh", onStep: (s: SolSwapStep) => void): Promise<string> {
  onStep("building");
  const r = await fetch(`${API_BASE}/sol/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: kp.address, priorityLevel: priority }) });
  const j = (await r.json().catch(() => ({}))) as { swapTransaction?: string; lastValidBlockHeight?: number; simulationError?: { error?: string; errorCode?: string } | null; error?: string };
  if (!r.ok || !j.swapTransaction) throw new Error(j.error ? String(j.error).slice(0, 120) : t("cw.coin.errBuild", { status: r.status }));
  if (j.simulationError) throw new SolRpcError(explainSolError(j.simulationError.error ?? j.simulationError.errorCode ?? j.simulationError));
  const { tx, signature } = signSerialized(b64.decode(j.swapTransaction), kp);
  onStep("confirming");
  return sendAndConfirm(rpcUrl, tx, signature, j.lastValidBlockHeight);
}
