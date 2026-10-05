"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleNotch, Crown } from "@phosphor-icons/react";
import { TokenAvatar } from "@/components/shared";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { iconUrl } from "@/lib/wallet/assets";
import { t } from "@/lib/wallet/i18n";
import { callerName, fmtPeak, fmtX, type Caller, type Callout } from "@/lib/wallet/callouts";
import { compactUsd } from "./coin";

/** One pump callout: who called it, the coin, market cap at the call, how it has done since (now / peak), the thesis. */
export function CalloutRow({ c, showCaller = true }: { c: Callout; showCaller?: boolean }) {
  const router = useRouter();
  const up = (c.multiple ?? 0) >= 1;
  return (
    <li>
      <Link href={`/wallet/coin?mint=${c.mint}`} className="-mx-2 block rounded-2xl px-2 py-3 transition active:bg-muted">
        {showCaller && (
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.preventDefault();
              router.push(`/wallet/caller?id=${c.caller.id}`);
            }}
            className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground"
          >
            <TokenAvatar symbol={callerName(c.caller).slice(0, 2)} seed={c.caller.wallet} logo={iconUrl(c.caller.avatar)} size={18} className="rounded-full" />
            <span className="truncate font-medium text-foreground">{callerName(c.caller)}</span>
            <span>{t("cw.callouts.calledAgo", { time: timeAgo(new Date(c.at).getTime()) })}</span>
          </span>
        )}
        <span className="flex items-center gap-3">
          <TokenAvatar symbol={c.symbol ?? "?"} seed={c.mint} logo={iconUrl(c.image)} size={40} className="rounded-xl" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[15px] font-semibold">{c.symbol ? `$${c.symbol}` : `${c.mint.slice(0, 4)}…`}</span>
              <span className="truncate text-[12px] text-muted-foreground">{c.name}</span>
            </span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              {t("cw.callouts.mcapAtCall", { v: c.mcapUsd != null ? compactUsd(c.mcapUsd) : "—" })}
              {!showCaller && ` · ${timeAgo(new Date(c.at).getTime())}`}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className={cn("rounded-lg px-2 py-0.5 font-mono text-[14px] font-semibold", up ? "bg-up/12 text-up" : "bg-down/12 text-down")}>{fmtX(c.multiple)}</span>
            <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{t("cw.callouts.peak", { x: fmtX(c.maxMultiple) })}</span>
          </span>
        </span>
        {c.thesis && <span className="mt-2 line-clamp-2 block text-[13px] leading-5 text-foreground/85">{c.thesis}</span>}
      </Link>
    </li>
  );
}

export function CallerRow({ c, rank }: { c: Caller; rank: number | null }) {
  return (
    <li>
      <Link href={`/wallet/caller?id=${c.id}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
        <span className={cn("w-6 shrink-0 text-center font-mono text-[13px] font-semibold", rank != null && rank <= 3 ? "text-[#f5c542]" : "text-muted-foreground")}>
          {rank != null && rank <= 3 ? <Crown size={16} weight="fill" className="mx-auto" /> : (rank ?? "·")}
        </span>
        <TokenAvatar symbol={callerName(c).slice(0, 2)} seed={c.wallet} logo={iconUrl(c.avatar)} size={40} className="rounded-full" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold">{callerName(c)}</span>
            {c.pinned && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("cw.callouts.featured")}</span>}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            {t("cw.callouts.callerLine", { n: c.total ?? "—", m: fmtX(c.medianMultiple), p: c.pct2x != null ? `${Math.round(c.pct2x * 100)}%` : "—" })}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="font-mono text-[14px] font-semibold text-up">{fmtX(c.avgMultiple)}</span>
          <span className="text-[11px] text-muted-foreground">{t("cw.callouts.avg")}</span>
        </span>
      </Link>
    </li>
  );
}

export function CallerStats({ c }: { c: Caller }) {
  const items = [
    { label: t("cw.callouts.statTotal"), value: c.total != null ? String(c.total) : "—" },
    { label: t("cw.callouts.statAvg"), value: fmtX(c.avgMultiple) },
    { label: t("cw.callouts.statMedian"), value: fmtX(c.medianMultiple) },
    { label: t("cw.callouts.stat2x"), value: c.pct2x != null ? `${Math.round(c.pct2x * 100)}%` : "—" },
    { label: t("cw.callouts.statPeak"), value: fmtPeak(c.avgPeakMs) },
    { label: t("cw.callouts.statRank"), value: `${c.rankWeekly ?? "—"} / ${c.rankMonthly ?? "—"}` },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((s) => (
        <div key={s.label} className="rounded-2xl bg-card px-3 py-2.5 ring-1 ring-border/60">
          <div className="text-[11px] text-muted-foreground">{s.label}</div>
          <div className="mt-0.5 font-mono text-[15px] font-semibold">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

export function ListState({ loading, error, empty }: { loading: boolean; error?: boolean; empty: boolean }) {
  if (loading) return <div className="flex justify-center py-10 text-muted-foreground"><CircleNotch size={22} className="animate-spin" /></div>;
  if (error) return <div className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.callouts.unavailable")}</div>;
  if (empty) return <div className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.callouts.empty")}</div>;
  return null;
}
