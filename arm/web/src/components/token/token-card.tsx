"use client";

import Link from "next/link";
import { Copy, Flame, GraduationCap, LineChart, Percent, Pin, Users } from "lucide-react";
import { toast } from "sonner";
import { isTaxToken, progressOf, type TokenView, type TokenWindow } from "@/lib/api";
import { fmtUsd, fmtNum, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Sparkline, TokenAvatar } from "@/components/shared";

/**
 * Hopium-style token card (boss, 9.18): a big square artwork on top with rank / 24h change / holders pills over it,
 * then name + copyable address, market cap with a 24h sparkline, and the graduation bar. `rank` is the token's
 * position in the current list (1-based); the #1 of the trending list gets the "TRENDING" flame.
 */
export function TokenCard({ token, rank, trending }: { token: TokenView; rank?: number; trending?: boolean; window?: TokenWindow }) {
  const { t } = useApp();
  const progress = token.graduated ? 100 : progressOf(token);
  const change = token.change24h;
  const hasChange = change !== null && change !== undefined && Number.isFinite(change);
  const up = hasChange && (change as number) >= 0;
  const top = trending && rank === 1;

  return (
    <Link href={`/token/${token.address}`} className="fade-up group block h-full">
      <div className={cn("flex h-full flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md", top ? "border-primary/40 ring-1 ring-primary/30" : "border-border hover:border-foreground/25", token.graduated && !top && "border-gold/40")}>
        {/* artwork */}
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          <TokenAvatar logo={token.logo} symbol={token.symbol} seed={token.address} size={512} fontScale={token.logo?.startsWith("emoji:") ? 0.3 : 0.16} className="size-full! rounded-none transition-transform duration-500 group-hover:scale-[1.03] [&>img]:size-full" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/45 to-transparent" />

          <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {rank !== undefined && (
                <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide shadow-sm", top ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground backdrop-blur")}>
                  {top && <Flame size={11} className="fill-current" />}#{rank}{top && <span className="ml-0.5">{t("common.trending")}</span>}
                </span>
              )}
              {token.pinned && <span className="inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur"><Pin size={10} /> {t("common.pinned")}</span>}
            </div>
            {hasChange && (
              <span className={cn("rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold tabular text-white shadow-sm", up ? "bg-up" : "bg-down")}>
                {up ? "+" : ""}{(change as number).toFixed(1)}%
              </span>
            )}
          </div>

          <div className="absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-background/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground backdrop-blur">
              <span className="size-1.5 rounded-full bg-up" />
              <Users size={10} /> {fmtNum(token.holders ?? 0)} {t("common.holders").toLowerCase()}
            </span>
            <div className="flex items-center gap-1">
              {isTaxToken(token) && <Badge variant="gold" className="px-1.5 py-0 text-[10px]" title={`${t("tax.buy")} ${token.buyTaxBps / 100}% · ${t("tax.sell")} ${token.sellTaxBps / 100}%`}><Percent /> {token.buyTaxBps / 100}/{token.sellTaxBps / 100}%</Badge>}
              {token.quote && token.quoteSymbol && <Badge variant="accent" className="px-1.5 py-0 text-[10px]" title={t("token.quoteHint").replace(/\{q\}/g, token.quoteSymbol)}><LineChart /> {token.quoteSymbol}</Badge>}
            </div>
          </div>
        </div>

        {/* body */}
        <div className="flex flex-1 flex-col gap-2.5 p-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h3 className="truncate text-[15px] font-semibold leading-tight">{token.name}</h3>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">${token.symbol}</span>
            </div>
            <button
              type="button"
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(token.address);
                  toast.success(t("common.copied"), { description: token.address });
                } catch {}
              }}
              title={t("common.copy")}
              className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              {shortAddr(token.address, 6, 4)} <Copy size={10} />
            </button>
          </div>

          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="label text-[10px] text-muted-foreground">{t("common.mcap")}</div>
              <div className="font-mono text-lg font-bold leading-none tabular">{fmtUsd(token.mcapUsd, { compact: true })}</div>
            </div>
            <Sparkline data={token.spark} width={76} height={28} />
          </div>

          <div className="mt-auto">
            <div className="mb-1 flex items-center justify-between text-[10px]">
              <span className={cn("label inline-flex items-center gap-1", token.graduated ? "text-gold!" : "text-muted-foreground")}>
                {token.graduated && <GraduationCap size={11} />}
                {token.graduated ? t("common.graduated") : t("common.progress")}
              </span>
              <span className={cn("font-mono font-semibold tabular", token.graduated ? "text-gold" : "text-up")}>{progress.toFixed(0)}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full transition-[width] duration-700", token.graduated ? "bg-gold" : "bg-up")} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
