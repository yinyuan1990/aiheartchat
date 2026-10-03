"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useCallers, useCallouts } from "@/lib/wallet/callouts";
import { CoinFrame } from "@/components/wallet/coin";
import { CalloutRow, CallerRow, ListState } from "@/components/wallet/callout-rows";
import { BottomNav, TopBar } from "@/components/wallet/ui";

const TABS = [
  { key: "feed", label: "最新喊单" },
  { key: "weekly", label: "周榜" },
  { key: "monthly", label: "月榜" },
] as const;

/** pump.fun callouts: the latest calls of the ranked callers, and the weekly / monthly caller boards. */
export default function CalloutsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("feed");
  const feed = useCallouts({}, tab === "feed");
  const board = useCallers(tab === "monthly" ? "monthly" : "weekly");
  return (
    <CoinFrame>
      <TopBar title="喊单" back="/wallet/token" />
      <div className="flex gap-1 px-4">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium transition", tab === t.key ? "bg-foreground text-background" : "text-muted-foreground")}>
            {t.label}
          </button>
        ))}
      </div>
      <ul className="mt-2 flex-1 divide-y divide-border/50 px-4">
        {tab === "feed" ? (
          <>
            <ListState loading={feed.isLoading} error={feed.isError} empty={!!feed.data && feed.data.length === 0} />
            {(feed.data ?? []).map((c) => (
              <CalloutRow key={c.id} c={c} />
            ))}
          </>
        ) : (
          <>
            <ListState loading={board.isLoading} error={board.isError} empty={!!board.data && board.data.length === 0} />
            {(board.data ?? []).map((c) => (
              <CallerRow key={c.id} c={c} rank={tab === "monthly" ? c.rankMonthly : c.rankWeekly} />
            ))}
          </>
        )}
      </ul>
      <p className="px-6 py-4 text-center text-[11px] leading-5 text-muted-foreground">
        数据来自 pump.fun 的公开喊单，倍数 = 现价 ÷ 喊单时的价格。喊单不构成投资建议，meme 币可能归零。
      </p>
      <BottomNav />
    </CoinFrame>
  );
}
