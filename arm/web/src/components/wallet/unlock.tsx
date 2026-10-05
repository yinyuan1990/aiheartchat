"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeSlash, Fingerprint, LockKey, ScanSmiley } from "@phosphor-icons/react";
import { WrongPasswordError } from "@/lib/wallet/vault";
import { bioDisable, bioName, bioStatus, bioUnlock, type BioStatus } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";
import { useVault } from "./wallet-context";
import { GhostButton, PrimaryButton, WalletFrame } from "./ui";

export function UnlockScreen() {
  const { unlock, wallets } = useVault();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [bio, setBio] = useState<BioStatus | null>(null);
  const prompted = useRef(false);

  const tryBio = useCallback(async () => {
    setErr("");
    let secret: string | null;
    try {
      secret = await bioUnlock();
    } catch (e) {
      const m = (e as Error).message;
      if (m === "invalidated" || m === "not enabled") {
        setBio((b) => b && { ...b, enabled: false });
        setErr(t("cw.unlock.bioChanged"));
      } else setErr(m);
      return;
    }
    if (!secret) return;
    setBusy(true);
    try {
      await unlock(secret);
    } catch (e) {
      setBusy(false);
      if (e instanceof WrongPasswordError) {
        await bioDisable();
        setBio((b) => b && { ...b, enabled: false });
        setErr(t("cw.unlock.bioExpired"));
      } else setErr(t("cw.unlock.failed"));
    }
  }, [unlock]);

  useEffect(() => {
    let alive = true;
    void bioStatus().then((s) => {
      if (!alive) return;
      setBio(s);
      if (s?.enabled && !prompted.current) {
        prompted.current = true;
        void tryBio();
      }
    });
    return () => {
      alive = false;
    };
  }, [tryBio]);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(pw);
    } catch (e) {
      setErr(e instanceof WrongPasswordError ? t("cw.ui.wrongPassword") : t("cw.unlock.failed"));
      setBusy(false);
    }
  };

  return (
    <WalletFrame>
      <div className="flex flex-1 flex-col px-6 pt-24">
        <span className="mx-auto flex size-20 items-center justify-center rounded-[28px] bg-[#0d0d0f] text-white shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)] dark:bg-[#17171c] dark:ring-1 dark:ring-white/10">
          <LockKey size={36} weight="duotone" />
        </span>
        <h1 className="mt-6 text-center text-[24px] font-semibold">{t("cw.unlock.welcome")}</h1>
        <p className="mt-1 text-center text-[14px] text-muted-foreground">{wallets.length > 1 ? t("cw.unlock.walletCount", { n: wallets.length }) : wallets[0]?.name} · {t("cw.unlock.prompt")}</p>

        <form
          className="mt-10"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className={cn("flex h-14 items-center rounded-2xl bg-card px-4 ring-1 transition", err ? "ring-down" : "ring-border focus-within:ring-foreground")}>
            <input
              type={show ? "text" : "password"}
              value={pw}
              autoFocus
              autoComplete="current-password"
              onChange={(e) => {
                setPw(e.target.value);
                setErr("");
              }}
              placeholder={t("cw.pwd.label")}
              className="flex-1 bg-transparent text-[16px] outline-none"
            />
            <button type="button" aria-label={show ? t("cw.pwd.hide") : t("cw.pwd.show")} onClick={() => setShow((v) => !v)} className="text-muted-foreground">
              {show ? <EyeSlash size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <div className="mt-2 h-5 px-1 text-[13px] text-down">{err}</div>
          <PrimaryButton className="mt-2" disabled={!pw || busy} onClick={() => void submit()}>
            {busy ? t("cw.unlock.unlocking") : t("cw.unlock.unlock")}
          </PrimaryButton>
          {bio?.enabled && (
            <GhostButton className="mt-3 gap-2" disabled={busy} onClick={() => void tryBio()}>
              {bio.kind === "face" ? <ScanSmiley size={20} /> : <Fingerprint size={20} />}
              {t("cw.unlock.withBio", { name: bioName(bio) })}
            </GhostButton>
          )}
        </form>

        <p className="mt-auto pb-10 text-center text-[12px] leading-5 text-muted-foreground">
          {t("cw.unlock.forgot")}
        </p>
      </div>
    </WalletFrame>
  );
}
