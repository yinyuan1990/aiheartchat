"use client";

import Link from "next/link";
import { useActivity, useTokens, usd } from "@/lib/api";
import { fmtUsd, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { PctChange, TokenAvatar, WalletDot } from "@/components/shared";

const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

/**
 * Two-row live strip, pump.fun style:
 *  row 1 — activity feed (wallet bought/sold $X of TOKEN, new launches)
 *  row 2 — price ticker for top tokens
 */
export function Ticker() {
  const { t } = useApp();
  const activity = useActivity().data ?? [];
  const top = useTokens("volume", "all").data ?? [];

  const activityRow = (k: string) => (
    <div key={k} className="flex shrink-0 items-center">
      {activity.map((a, i) => {
        const isBurn = a.wallet.toLowerCase() === BURN_ADDRESS;
        return (
        <Link key={k + a.tx + i} href={`/token/${a.token}`} className="flex items-center gap-2 border-r px-3 py-1.5 text-xs hover:bg-accent">
          {isBurn ? <span className="text-[13px] leading-none">🔥</span> : <WalletDot address={a.wallet} />}
          <span className="font-mono text-muted-foreground">{isBurn ? "Arm" : shortAddr(a.wallet, 4, 3)}</span>
          <span className={cn("font-medium", isBurn ? "text-gold" : a.kind === "buy" ? "text-up" : a.kind === "sell" ? "text-down" : "text-gold")}>
            {isBurn ? t("activity.burned") : a.kind === "buy" ? t("activity.bought") : a.kind === "sell" ? t("activity.sold") : t("activity.launched")}
          </span>
          {a.usdc !== undefined && <span className="font-mono tabular">{fmtUsd(usd(a.usdc))}</span>}
          {a.usdc !== undefined && <span className="text-muted-foreground">{t("activity.of")}</span>}
          <TokenAvatar logo={a.logo} symbol={a.symbol} seed={a.token} size={16} className="rounded-sm" />
          <span className="font-semibold">{a.symbol}</span>
        </Link>
        );
      })}
    </div>
  );

  const priceRow = (k: string) => (
    <div key={k} className="flex shrink-0 items-center">
      {top.slice(0, 12).map((tok) => (
        <Link key={k + tok.address} href={`/token/${tok.address}`} className="flex items-center gap-2 border-r px-4 py-1 text-[11px] hover:bg-accent">
          <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={14} className="rounded-sm" />
          <span className="font-semibold">{tok.symbol}</span>
          <span className="font-mono text-secondary-foreground tabular">{fmtUsd(tok.price)}</span>
          <PctChange value={tok.change24h} className="text-[11px]" />
        </Link>
      ))}
    </div>
  );

  const empty = activity.length === 0 && top.length === 0;

  return (
    <div className="border-t bg-sidebar/60">
      <div className="flex items-stretch border-b">
        <div className="flex shrink-0 items-center gap-1.5 border-r px-3 font-mono text-[10px] text-primary">
          <span className="blink size-1.5 rounded-full bg-primary" />
          {t("common.live")}
        </div>
        <div className="no-scrollbar flex-1 overflow-hidden">
          {empty ? (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">{t("common.noData")}</div>
          ) : (
            <div className={cn("marquee [animation-duration:90s]", activity.length < 8 && "[animation-duration:40s]")}>{[activityRow("a"), activityRow("b")]}</div>
          )}
        </div>
      </div>
      {top.length > 0 && (
        <div className="hidden items-stretch bg-background/40 md:flex">
          <div className="flex shrink-0 items-center border-r px-3 font-mono text-[10px] text-muted-foreground">{t("common.price")}</div>
          <div className="no-scrollbar flex-1 overflow-hidden opacity-90">
            <div className="marquee">{[priceRow("a"), priceRow("b")]}</div>
          </div>
        </div>
      )}
    </div>
  );
}
