"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { trades, type HlTrade } from "@/lib/wallet/hl";
import { useVault } from "@/components/wallet/wallet-context";
import { Spinner, dirText, px, sUsd, usd } from "@/components/wallet/perp-parts";
import { TopBar, WalletFrame } from "@/components/wallet/ui";
import { t } from "@/lib/wallet/i18n";

const PAGE = 20;
const REASON: Record<HlTrade["reason"], { label: string; cls: string }> = {
  tp: { label: "cw.perp.reasonTp", cls: "bg-up/15 text-up" },
  sl: { label: "cw.perp.reasonSl", cls: "bg-down/15 text-down" },
  liq: { label: "cw.perp.liq", cls: "bg-down text-white" },
  market: { label: "cw.perp.market", cls: "bg-muted text-muted-foreground" },
  limit: { label: "cw.perp.limit", cls: "bg-muted text-muted-foreground" },
};
const isClose = (tr: HlTrade) => /^Close|>/.test(tr.dir);
const netOf = (tr: HlTrade) => tr.pnl - tr.fee - tr.openFee;
/** fills a translated template's {placeholders} with bold values */
const boldArgs = (s: string, args: Record<string, number>) =>
  s.split(/(\{\w+\})/).map((part, i) => {
    const k = part.match(/^\{(\w+)\}$/)?.[1];
    return k && k in args ? (
      <b key={i} className="font-mono text-foreground">
        {args[k]}
      </b>
    ) : (
      part
    );
  });

/** 合约成交记录: every order's fills merged (hl.ts `trades`), filtered by coin, 20 a page. */
export default function PerpTradesPage() {
  const vault = useVault();
  const user = vault.active?.address as Address | undefined;
  const q = useQuery({ queryKey: ["hl", "trades", user], queryFn: () => trades(user!), enabled: !!user, refetchInterval: 30_000 });
  const rows = q.data ?? [];
  const [coin, setCoin] = useState("");
  const [page, setPage] = useState(0);

  const coins = useMemo(() => [...new Set(rows.map((tr) => tr.coin))], [rows]);
  const shown = coin ? rows.filter((tr) => tr.coin === coin) : rows;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const closes = shown.filter(isClose);
  const wins = closes.filter((tr) => netOf(tr) > 0).length;
  const total = closes.reduce((s, tr) => s + netOf(tr), 0);
  const fees = shown.reduce((s, tr) => s + tr.fee, 0);

  const go = (p: number) => {
    setPage(p);
    window.scrollTo(0, 0);
  };
  const pick = (c: string) => {
    setCoin(c);
    setPage(0);
  };

  return (
    <WalletFrame>
      <TopBar title={t("cw.perp.trades")} back="/wallet/perp" />
      <div className="flex-1 px-4 pb-6">
        {coins.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {["", ...coins].map((c) => (
              <button key={c || "all"} type="button" onClick={() => pick(c)} className={cn("h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium ring-1", c === coin ? "bg-foreground text-background ring-foreground" : "ring-border text-muted-foreground")}>
                {c || t("transfer.all")}
              </button>
            ))}
          </div>
        )}

        {closes.length > 0 && (
          <section className="mt-3 rounded-2xl bg-muted/60 p-3 text-[11px] text-muted-foreground">
            {t("cw.perp.netPnl")}
            <b className={cn("block truncate font-mono text-[20px]", total >= 0 ? "text-up" : "text-down")}>{sUsd(total)}</b>
            <div className="mt-1 flex flex-wrap gap-x-4">
              <span>{boldArgs(t("cw.perp.closeStats"), { n: closes.length, wins })}</span>
              <span>
                {t("cw.perp.fees")} <b className="font-mono text-foreground">{usd(fees)}</b>
              </span>
            </div>
          </section>
        )}

        {!user ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">{t("cw.perp.unlockFirst")}</p>
        ) : q.isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner />
          </div>
        ) : q.isError ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">{t("cw.perp.tradesError")}</p>
        ) : shown.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">{t("cw.perp.noTrades")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/50">
            {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((tr) => (
              <TradeRow key={tr.oid} tr={tr} />
            ))}
          </ul>
        )}

        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between">
            <button type="button" disabled={cur === 0} onClick={() => go(cur - 1)} className="flex h-9 items-center gap-1 rounded-xl bg-muted px-3 text-[13px] font-medium disabled:opacity-35">
              <CaretLeft size={14} weight="bold" />
              {t("cw.perp.prevPage")}
            </button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {cur + 1} / {pages}
            </span>
            <button type="button" disabled={cur >= pages - 1} onClick={() => go(cur + 1)} className="flex h-9 items-center gap-1 rounded-xl bg-muted px-3 text-[13px] font-medium disabled:opacity-35">
              {t("cw.perp.nextPage")}
              <CaretRight size={14} weight="bold" />
            </button>
          </div>
        )}
        {shown.length > 0 && <p className="mt-4 text-center text-[11px] leading-5 text-muted-foreground">{t("cw.perp.tradesFooter", { n: shown.length })}</p>}
      </div>
    </WalletFrame>
  );
}

function TradeRow({ tr }: { tr: HlTrade }) {
  const closing = isClose(tr);
  const net = netOf(tr);
  const r = REASON[tr.reason];
  return (
    <li className="py-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{tr.coin}</span>
        <span className={["Open Long", "Close Short", "Short > Long"].includes(tr.dir) ? "text-up" : "text-down"}>{dirText(tr.dir)}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", r.cls)}>{t(r.label)}</span>
        {closing && <span className={cn("ml-auto font-mono text-[13px] font-semibold", net >= 0 ? "text-up" : "text-down")}>{sUsd(net)}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-muted-foreground">
        <span>{new Date(tr.time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <span>@ {px(tr.px)}</span>
        <span>{tr.size}</span>
        <span>{t("cw.perp.fees")} {usd(tr.fee, 3)}</span>
      </div>
      {closing && (
        <div className="mt-0.5 text-muted-foreground">
          {t("cw.perp.tradePnl", { pnl: sUsd(tr.pnl, 3), fees: usd(tr.fee + tr.openFee, 3), net: sUsd(net, 3) })}
        </div>
      )}
    </li>
  );
}
