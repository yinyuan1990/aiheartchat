"use client";

import { useState } from "react";
import { parseAbi, type Address } from "viem";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import type { TokenView } from "@/lib/api";
import { refLink } from "@/lib/referral";
import { useTx } from "@/lib/tx";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const splitterAbi = parseAbi(["function setReferralBps(uint16 newBps)"]);

/**
 * Token header actions for promoter referrals: a "Referral x%" badge + copy-my-link button when the creator shares
 * fees, and — for the creator — a small editor that calls `setReferralBps` on the token's splitter.
 */
export function TokenReferral({ token }: { token: TokenView }) {
  const { t, connected, address, toggleConnect } = useApp();
  const { run } = useTx();
  const qc = useQueryClient();
  const bps = token.referralBps ?? 0;
  const isCreator = !!address && !!token.splitter && token.payout.toLowerCase() === address.toLowerCase();
  const [pct, setPct] = useState(String(bps / 100));
  const [open, setOpen] = useState(false);

  const copyLink = async () => {
    if (!connected || !address) return toggleConnect();
    await navigator.clipboard.writeText(refLink(address, `/token/${token.address}`)).catch(() => {});
    toast.success(t("promote.copied"));
  };

  const save = async () => {
    const next = Math.round(Math.min(50, Math.max(0, parseFloat(pct) || 0)) * 100);
    const rc = await run(t("token.referralSet"), { address: token.splitter as Address, abi: splitterAbi, functionName: "setReferralBps", args: [next] });
    if (rc) {
      toast.success(t("token.referralSaved"));
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["token", token.address] });
    }
  };

  if (!token.splitter || (bps === 0 && !isCreator)) return null;
  return (
    <>
      {bps > 0 && (
        <Button variant="outline" size="sm" onClick={copyLink} title={t("promote.howItWorks")}>
          <Megaphone /> {t("token.referral").replace("{pct}", String(bps / 100))} · {t("token.promote")}
        </Button>
      )}
      {isCreator && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm"><Megaphone /> {t("token.referralSet")}</Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 space-y-3">
            <div className="text-sm font-medium">{t("create.referral")}</div>
            <p className="text-xs text-muted-foreground">{t("create.referralHint")}</p>
            <div className="flex items-center gap-2">
              <input type="number" min={0} max={50} step={1} value={pct} onChange={(e) => setPct(e.target.value)} className="h-9 min-w-0 flex-1 rounded-md border bg-muted px-2 font-mono outline-none" />
              <span className="font-mono text-sm">%</span>
              <Button size="sm" onClick={save}>OK</Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
