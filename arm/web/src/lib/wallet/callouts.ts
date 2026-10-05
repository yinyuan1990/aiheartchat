"use client";

import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { t } from "./i18n";

/** pump.fun callouts (喊单) as collected by the indexer (indexer/src/callouts.ts, /api/pump/callouts | callers). */

export type CallerRef = { id: string; wallet: string; name: string | null; avatar: string | null };
export type Callout = {
  id: string;
  caller: CallerRef;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  /** market cap / price at the moment of the call */
  mcapUsd: number | null;
  priceUsd: number | null;
  /** latest price ÷ call price */
  multiple: number | null;
  maxMultiple: number | null;
  maxAt: string | null;
  thesis: string | null;
  at: string;
};
export type Caller = CallerRef & {
  total: number | null;
  avgMultiple: number | null;
  medianMultiple: number | null;
  /** share of calls that reached 2× (0–1) */
  pct2x: number | null;
  avgPeakMs: number | null;
  rankWeekly: number | null;
  rankMonthly: number | null;
  pinned: boolean;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? t("cw.callouts.notFound") : t("cw.callouts.unavailableShort")), { status: r.status });
  return r.json();
}

export const useCallouts = (q: { caller?: string; mint?: string } = {}, enabled = true) => {
  const p = new URLSearchParams({ limit: "40", ...(q.caller ? { caller: q.caller } : {}), ...(q.mint ? { mint: q.mint } : {}) });
  return useQuery({ queryKey: ["callouts", q.caller ?? "", q.mint ?? ""], enabled, queryFn: () => get<Callout[]>(`/pump/callouts?${p}`), refetchInterval: 20_000 });
};

export const useCallers = (sort: "weekly" | "monthly") =>
  useQuery({ queryKey: ["callers", sort], queryFn: () => get<Caller[]>(`/pump/callers?sort=${sort}`), staleTime: 60_000, refetchInterval: 120_000 });

export const useCaller = (id: string) =>
  useQuery({ queryKey: ["caller", id], enabled: !!id, queryFn: () => get<Caller>(`/pump/callers/${encodeURIComponent(id)}`), retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2 });

export const callerName = (c: CallerRef) => c.name || `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)}`;
export const fmtX = (m: number | null) => (m == null ? "—" : m >= 100 ? `${Math.round(m)}x` : m >= 10 ? `${m.toFixed(1)}x` : `${m.toFixed(2)}x`);
export const fmtPeak = (ms: number | null) => {
  if (ms == null) return "—";
  const m = Math.round(ms / 60_000);
  return m < 60 ? t("cw.coin.ageMin", { n: m }) : m < 48 * 60 ? t("cw.coin.ageHour", { n: (m / 60).toFixed(1) }) : t("cw.coin.ageDay", { n: Math.round(m / 1440) });
};
