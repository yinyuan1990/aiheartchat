"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { useApp } from "@/components/providers";
import { BoatError, boatLogin, boatLoginMessage, boatSession, clearBoatSession, saveBoatSession, useBoatMe } from "@/lib/boat";

/** Wallet-signed session for the $BOAT ledger. The session is per wallet; switching wallets needs a new signature. */
export function useBoatAccount() {
  const { connected, address, toggleConnect } = useApp();
  const qc = useQueryClient();
  const { signMessageAsync } = useSignMessage();
  const [bump, setBump] = useState(0);
  const [welcomed, setWelcomed] = useState(false);
  const [busy, setBusy] = useState(false);
  // re-read localStorage whenever the wallet changes or we log in / out (bump)
  const token = connected && address ? (bump >= 0 ? boatSession(address) : null) : null;
  const me = useBoatMe(token);
  if (me.error instanceof BoatError && me.error.status === 401 && token) {
    clearBoatSession();
    queueMicrotask(() => setBump((b) => b + 1));
  }

  const login = useCallback(async () => {
    if (!connected || !address) { toggleConnect(); return null; }
    setBusy(true);
    try {
      const ts = Date.now();
      const sig = await signMessageAsync({ message: boatLoginMessage(address, ts) });
      const r = await boatLogin(address, ts, sig);
      saveBoatSession(r.token, address);
      setWelcomed(r.welcomed);
      setBump((b) => b + 1);
      qc.setQueryData(["boat", "me", r.token], r.me);
      return r.token;
    } finally {
      setBusy(false);
    }
  }, [connected, address, toggleConnect, signMessageAsync, qc]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["boat"] }), [qc]);

  return { connected, address, token, me: me.data ?? null, login, busy, welcomed, refresh, toggleConnect };
}
