"use client";

import { useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Megaphone, X } from "lucide-react";
import { postReferralBind, useReferralOf } from "@/lib/api";
import { bindMessage, captureRef, clearRef, storedRef } from "@/lib/referral";
import { shortAddr } from "@/lib/format";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { errMsg } from "@/components/shared";

/**
 * Captures `?ref=` on every page and, once a wallet is connected that has no referrer yet, offers a one-click signature
 * to bind it (free, no gas). Hidden when there is no stored ref, the wallet is already bound, or the visitor dismissed it.
 */
export function ReferralBindBanner() {
  const { t, connected, address, wrongChain } = useApp();
  const [ref, setRef] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const binding = useReferralOf(connected ? address : undefined);

  useEffect(() => {
    captureRef();
    setRef(storedRef());
  }, []);

  if (!ref || dismissed || !connected || !address || wrongChain || binding.isLoading || binding.data !== null) return null;

  const bind = async () => {
    setBusy(true);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await signMessageAsync({ message: bindMessage(address, ref, ts) });
      const r = await postReferralBind({ wallet: address, referrer: ref, ts, sig });
      if (!r.ok) throw new Error(r.error ?? "bind failed");
      toast.success(t("ref.bound"));
      clearRef();
      qc.invalidateQueries({ queryKey: ["referralOf", address] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
      <Megaphone className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t("ref.bindPrompt").replace("{ref}", shortAddr(ref, 6, 4))}</span>
      <Button size="sm" disabled={busy} onClick={bind}>{busy ? t("ref.binding") : t("ref.bindBtn")}</Button>
      <button aria-label="close" className="text-muted-foreground hover:text-foreground" onClick={() => setDismissed(true)}>
        <X className="size-4" />
      </button>
    </div>
  );
}
