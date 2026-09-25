"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { ExternalLink, Flame, Timer } from "lucide-react";
import { tok, useBurn, type BurnView } from "@/lib/api";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { secondClockStore } from "@/lib/store";
import { txUrl } from "@/lib/web3";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";
import { LiveCountdown, TimeAgo, TokenAvatar } from "@/components/shared";

/**
 * Public "next burn" card (boss 9.23): the project buys back and burns its token by hand on a fixed cadence; this shows
 * the countdown to the next burn, how many tokens go, what that is worth at today's price and the recorded history.
 * Two placements, each behind its own /admin switch (boss 9.23 10:57): the home page strip (default off) and the
 * burned token's own page (default on) — on the token page it renders only on that token.
 */
export function BurnCard({ where, tokenAddress, className }: { where: "home" | "token"; tokenAddress?: string; className?: string }) {
  const { data } = useBurn();
  if (!data?.token || !data.nextAt) return null;
  if (where === "home" && !data.showHome) return null;
  if (where === "token" && (!data.showToken || !tokenAddress || tokenAddress.toLowerCase() !== data.token.address.toLowerCase())) return null;
  return <BurnCardBody data={data} linkToken={where === "home"} className={className} />;
}

function BurnCardBody({ data, linkToken, className }: { data: BurnView; linkToken: boolean; className?: string }) {
  const { t } = useApp();
  const token = data.token!;
  const nextMs = new Date(data.nextAt!).getTime();
  const eta = Math.floor(nextMs / 1000);
  const symbol = token.symbol ?? shortAddr(token.address, 4, 4);
  const amount = tok(data.amount);
  const total = tok(data.totalBurned);
  const cadence = t("burn.card.every").replace("{d}", trimNum(data.intervalDays));
  const dateUtc = new Date(nextMs).toISOString().slice(5, 16).replace("T", " ");

  const identity = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <TokenAvatar logo={token.logo ?? undefined} symbol={symbol} seed={token.address} size={28} />
      <span className="truncate text-sm font-semibold">{token.name ?? symbol}</span>
      <span className="font-mono text-xs text-muted-foreground">${symbol}</span>
    </span>
  );

  // One wide strip (md+): ring + countdown | this burn | burned so far | token + last tx. Stacks 2-up on phones.
  return (
    <Card className={cn("relative gap-0 overflow-hidden py-0", className)}>
      <div className="pointer-events-none absolute -top-20 right-1/4 size-56 rounded-full bg-gold/10 blur-3xl" />
      <CardContent className="relative px-4 py-3 md:px-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="label inline-flex items-center gap-1.5"><Flame size={13} className="text-gold" /> {t("burn.card.title")}</span>
          <span className="inline-flex items-center gap-1 text-muted-foreground"><Timer size={12} /> {cadence}</span>
        </div>

        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 md:grid-cols-[auto_1fr_1fr_auto] md:items-center">
          <div className="flex items-center gap-3 sm:col-span-2 md:col-span-1 md:pr-2">
            <CycleRing nextMs={nextMs} intervalMs={data.intervalDays * 86_400_000} size={64} />
            <div className="min-w-0">
              <div className="text-[11px] text-muted-foreground">{t("burn.card.next")}</div>
              <LiveCountdown eta={eta} className="block text-2xl font-bold leading-none tracking-tight whitespace-nowrap" />
              <div className="mt-1 font-mono text-[11px] text-muted-foreground tabular">{dateUtc} UTC</div>
            </div>
          </div>

          <div className="text-xs md:border-l md:pl-5">
            <div className="text-muted-foreground">{t("burn.card.amount")}</div>
            <div className="mt-0.5 font-mono text-lg font-semibold leading-tight whitespace-nowrap tabular">{amount > 0 ? fmtNum(amount) : "—"} <span className="text-xs font-normal text-muted-foreground">{symbol}</span></div>
            <div className="font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular">{amount > 0 ? `≈ ${fmtUsd(data.amountUsd)}` : t("burn.card.tbd")}</div>
          </div>

          <div className="text-xs md:border-l md:pl-5">
            <div className="text-muted-foreground">{t("burn.card.total")}</div>
            <div className="mt-0.5 font-mono text-lg font-semibold leading-tight whitespace-nowrap tabular">{fmtNum(total)} <span className="text-xs font-normal text-muted-foreground">{symbol}</span></div>
            {/* on-chain total = dead-address balance, whoever burned it; boss 9.23 16:50: no platform / others split
                shown (it read as if every burn were the platform's) */}
            <div className="font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular">≈ {fmtUsd(data.totalBurnedUsd)}</div>
          </div>

          <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground sm:col-span-2 sm:flex-row sm:items-center sm:justify-between md:col-span-1 md:flex-col md:items-end md:border-l md:pl-5">
            {linkToken ? <Link href={`/token/${token.address}`} className="min-w-0 hover:underline">{identity}</Link> : identity}
            {data.lastBurn ? (
              <a href={txUrl(data.lastBurn.hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono whitespace-nowrap hover:underline">
                {t("burn.card.last")} <TimeAgo ts={data.lastBurn.time} /> · {shortAddr(data.lastBurn.hash, 6, 4)} <ExternalLink size={10} />
              </a>
            ) : (
              <span>{t("burn.card.none")}</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Progress of the current cycle (time elapsed since the previous burn slot), ticking every second. */
function CycleRing({ nextMs, intervalMs, size = 84 }: { nextMs: number; intervalMs: number; size?: number }) {
  const now = useSyncExternalStore(secondClockStore.subscribe, secondClockStore.get, secondClockStore.getServer);
  const pct = now === null || intervalMs <= 0 ? 0 : Math.max(0, Math.min(100, (1 - (nextMs - now) / intervalMs) * 100));
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gold)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${dash} ${c - dash}`} className="transition-[stroke-dasharray] duration-700" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <Flame size={size * 0.34} className="text-gold" />
      </div>
    </div>
  );
}

const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));
