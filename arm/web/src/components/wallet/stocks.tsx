"use client";

import { Info } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";

/** what a bStock is and isn't; shown on the 美股 list and on every stock's market page */
export function StockNotice({ className }: { className?: string }) {
  return (
    <p className={cn("flex gap-2 rounded-2xl bg-muted/70 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground", className)}>
      <Info size={15} className="mt-px shrink-0" />
      <span>{t("cw.stocks.notice")}</span>
    </p>
  );
}
