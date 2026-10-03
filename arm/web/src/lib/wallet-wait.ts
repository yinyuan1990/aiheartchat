"use client";

import { toast } from "sonner";
import { type DictKey, translate } from "@/lib/i18n";
import { localeStore } from "@/lib/store";

const tr = (k: DictKey) => translate(k, localeStore.get());

export class WalletAbort extends Error {
  constructor(readonly reason: "cancel" | "timeout") {
    super(tr(reason === "cancel" ? "wallet.cancelled" : "wallet.timeout"));
    this.name = "WalletAbort";
  }
}

export const isWalletAbort = (e: unknown): e is WalletAbort => e instanceof WalletAbort;

/**
 * Races a wallet prompt against a 取消 button and a timeout: some in-app wallets (Ave) never settle the request when the
 * user dismisses it, which would leave the button spinning forever. Rejects with WalletAbort.
 * Pass `toastId` to reuse the caller's loading toast instead of showing a separate one.
 */
export function awaitWallet<T>(p: Promise<T>, opts: { toastId?: string | number; label?: string; timeoutMs?: number; hintAfterMs?: number } = {}): Promise<T> {
  const { timeoutMs = 180_000, hintAfterMs = 4_000 } = opts;
  const own = opts.toastId === undefined;
  const id = opts.toastId ?? `wallet-wait-${Date.now()}-${Math.random()}`;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = () => {
      done = true;
      clearTimeout(hint);
      clearTimeout(limit);
      if (own) toast.dismiss(id);
    };
    const abort = (reason: WalletAbort["reason"]) => {
      if (done) return;
      settle();
      reject(new WalletAbort(reason));
    };
    const hint = setTimeout(() => {
      if (done) return;
      toast.loading(opts.label ? `${opts.label} · ${tr("wallet.waiting")}` : tr("wallet.waiting"), {
        id,
        description: tr("wallet.waitingHint"),
        action: { label: tr("wallet.cancel"), onClick: () => abort("cancel") },
        duration: Infinity,
      });
    }, hintAfterMs);
    const limit = setTimeout(() => abort("timeout"), timeoutMs);
    p.then(
      (v) => {
        if (done) return;
        settle();
        resolve(v);
      },
      (e) => {
        if (done) return;
        settle();
        reject(e);
      },
    );
  });
}
