"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { trades, type HlTrade } from "@/lib/wallet/hl";
import { useVault } from "@/components/wallet/wallet-context";
import { DIR, Spinner, px, sUsd, usd } from "@/components/wallet/perp-parts";
import { TopBar, WalletFrame } from "@/components/wallet/ui";

const PAGE = 20;
const REASON: Record<HlTrade["reason"], { label: string; cls: string }> = {
  tp: { label: "止盈触发", cls: "bg-up/15 text-up" },
  sl: { label: "止损触发", cls: "bg-down/15 text-down" },
  liq: { label: "强平", cls: "bg-down text-white" },
  market: { label: "市价", cls: "bg-muted text-muted-foreground" },
  limit: { label: "限价", cls: "bg-muted text-muted-foreground" },
};
const isClose = (t: HlTrade) => /^Close|>/.test(t.dir);
const netOf = (t: HlTrade) => t.pnl - t.fee - t.openFee;

/** 合约成交记录: every order's fills merged (hl.ts `trades`), filtered by coin, 20 a page. */
export default function PerpTradesPage() {
  const vault = useVault();
  const user = vault.active?.address as Address | undefined;
  const q = useQuery({ queryKey: ["hl", "trades", user], queryFn: () => trades(user!), enabled: !!user, refetchInterval: 30_000 });
  const rows = q.data ?? [];
  const [coin, setCoin] = useState("");
  const [page, setPage] = useState(0);

  const coins = useMemo(() => [...new Set(rows.map((t) => t.coin))], [rows]);
  const shown = coin ? rows.filter((t) => t.coin === coin) : rows;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const closes = shown.filter(isClose);
  const wins = closes.filter((t) => netOf(t) > 0).length;
  const total = closes.reduce((s, t) => s + netOf(t), 0);
  const fees = shown.reduce((s, t) => s + t.fee, 0);

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
      <TopBar title="成交记录" back="/wallet/perp" />
      <div className="flex-1 px-4 pb-6">
        {coins.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {["", ...coins].map((c) => (
              <button key={c || "all"} type="button" onClick={() => pick(c)} className={cn("h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium ring-1", c === coin ? "bg-foreground text-background ring-foreground" : "ring-border text-muted-foreground")}>
                {c || "全部"}
              </button>
            ))}
          </div>
        )}

        {closes.length > 0 && (
          <section className="mt-3 rounded-2xl bg-muted/60 p-3 text-[11px] text-muted-foreground">
            平仓净盈亏（扣手续费）
            <b className={cn("block truncate font-mono text-[20px]", total >= 0 ? "text-up" : "text-down")}>{sUsd(total)}</b>
            <div className="mt-1 flex flex-wrap gap-x-4">
              <span>
                平仓 <b className="font-mono text-foreground">{closes.length}</b> 笔，盈利 <b className="font-mono text-foreground">{wins}</b> 笔
              </span>
              <span>
                手续费 <b className="font-mono text-foreground">{usd(fees)}</b>
              </span>
            </div>
          </section>
        )}

        {!user ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">先解锁钱包</p>
        ) : q.isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner />
          </div>
        ) : q.isError ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">成交记录暂时拿不到，稍后再试</p>
        ) : shown.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-muted-foreground">还没有成交</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/50">
            {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((t) => (
              <TradeRow key={t.oid} t={t} />
            ))}
          </ul>
        )}

        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between">
            <button type="button" disabled={cur === 0} onClick={() => go(cur - 1)} className="flex h-9 items-center gap-1 rounded-xl bg-muted px-3 text-[13px] font-medium disabled:opacity-35">
              <CaretLeft size={14} weight="bold" />
              上一页
            </button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {cur + 1} / {pages}
            </span>
            <button type="button" disabled={cur >= pages - 1} onClick={() => go(cur + 1)} className="flex h-9 items-center gap-1 rounded-xl bg-muted px-3 text-[13px] font-medium disabled:opacity-35">
              下一页
              <CaretRight size={14} weight="bold" />
            </button>
          </div>
        )}
        {shown.length > 0 && <p className="mt-4 text-center text-[11px] leading-5 text-muted-foreground">共 {shown.length} 笔，Hyperliquid 只提供最近 2000 笔成交</p>}
      </div>
    </WalletFrame>
  );
}

function TradeRow({ t }: { t: HlTrade }) {
  const closing = isClose(t);
  const net = netOf(t);
  const r = REASON[t.reason];
  return (
    <li className="py-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{t.coin}</span>
        <span className={["Open Long", "Close Short", "Short > Long"].includes(t.dir) ? "text-up" : "text-down"}>{DIR[t.dir] ?? t.dir}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", r.cls)}>{r.label}</span>
        {closing && <span className={cn("ml-auto font-mono text-[13px] font-semibold", net >= 0 ? "text-up" : "text-down")}>{sUsd(net)}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-muted-foreground">
        <span>{new Date(t.time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <span>@ {px(t.px)}</span>
        <span>{t.size}</span>
        <span>手续费 {usd(t.fee, 3)}</span>
      </div>
      {closing && (
        <div className="mt-0.5 text-muted-foreground">
          价差盈亏 {sUsd(t.pnl, 3)}，扣开平仓手续费 {usd(t.fee + t.openFee, 3)} 后 {sUsd(net, 3)}
        </div>
      )}
    </li>
  );
}
