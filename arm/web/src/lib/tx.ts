"use client";

import { useCallback } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { toast } from "sonner";
import type { Hex } from "viem";
import { txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { logDebug } from "@/lib/debuglog";

/**
 * Small wrapper around wagmi's writeContract that toasts sent → confirmed/failed with explorer links.
 * Returns the receipt on success, or null if the user rejected / it failed (already toasted).
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const { t } = useApp();

  const run = useCallback(
    async (label: string, write: Parameters<typeof writeContractAsync>[0]) => {
      const id = toast.loading(`${label} · ${t("tx.confirming")}`);
      try {
        const hash: Hex = await writeContractAsync(write);
        toast.loading(`${label} · ${t("tx.sent")}`, { id, description: hash.slice(0, 18) + "…", action: { label: t("tx.view"), onClick: () => window.open(txUrl(hash), "_blank") } });
        const rc = await client!.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(t("tx.failed"));
        toast.success(`${label} · ${t("tx.success")}`, { id, action: { label: t("tx.view"), onClick: () => window.open(txUrl(hash), "_blank") } });
        return rc;
      } catch (e) {
        logDebug("tx.failed", label, JSON.stringify({ to: write.address, fn: write.functionName, args: write.args }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), e);
        toast.error(`${label} · ${t("tx.failed")}`, { id, description: errMsg(e) });
        return null;
      }
    },
    [writeContractAsync, client, t],
  );

  return { run, client };
}
