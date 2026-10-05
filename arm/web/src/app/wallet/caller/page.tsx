"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { iconUrl } from "@/lib/wallet/assets";
import { copyText } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
import { callerName, useCaller, useCallouts } from "@/lib/wallet/callouts";
import { CoinFrame } from "@/components/wallet/coin";
import { CalloutRow, CallerStats, ListState } from "@/components/wallet/callout-rows";
import { TopBar } from "@/components/wallet/ui";

export default function CallerPage() {
  return (
    <Suspense>
      <Caller />
    </Suspense>
  );
}

/** One pump caller: track record from the leaderboard, then their latest calls. */
function Caller() {
  const id = useSearchParams().get("id") ?? "";
  const caller = useCaller(id);
  const calls = useCallouts({ caller: id }, !!id);
  const c = caller.data;
  return (
    <CoinFrame>
      <TopBar title={t("cw.callouts.caller")} back="/wallet/callouts" />
      <div className="flex-1 px-4 pb-6">
        {caller.isError ? (
          <ListState loading={false} error empty={false} />
        ) : !c ? (
          <ListState loading empty={false} />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <TokenAvatar symbol={callerName(c).slice(0, 2)} seed={c.wallet} logo={iconUrl(c.avatar)} size={56} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[18px] font-semibold">{callerName(c)}</div>
                <button type="button" onClick={async () => (await copyText(c.wallet)) && toast.success(t("card.addressCopied"))} className="flex items-center gap-1 font-mono text-[12px] text-muted-foreground">
                  {shortAddr(c.wallet, 6, 4)}
                  <Copy size={12} />
                </button>
              </div>
              <a href={`https://pump.fun/profile/${c.wallet}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-[12px] font-medium">
                pump.fun
                <ArrowSquareOut size={12} />
              </a>
            </div>
            <div className="mt-4">
              <CallerStats c={c} />
            </div>
          </>
        )}
        <div className="mt-5 text-[13px] font-medium text-muted-foreground">{t("cw.callouts.recent")}</div>
        <ul className="divide-y divide-border/50">
          <ListState loading={calls.isLoading} error={calls.isError} empty={!!calls.data && calls.data.length === 0} />
          {(calls.data ?? []).map((x) => (
            <CalloutRow key={x.id} c={x} showCaller={false} />
          ))}
        </ul>
      </div>
    </CoinFrame>
  );
}
