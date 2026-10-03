"use client";

import { useState } from "react";
import { Eye, EyeSlash, LockKey } from "@phosphor-icons/react";
import { WrongPasswordError } from "@/lib/wallet/vault";
import { cn } from "@/lib/utils";
import { useVault } from "./wallet-context";
import { PrimaryButton, WalletFrame } from "./ui";

export function UnlockScreen() {
  const { unlock, wallets } = useVault();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(pw);
    } catch (e) {
      setErr(e instanceof WrongPasswordError ? "密码不对" : "解锁失败，请重试");
      setBusy(false);
    }
  };

  return (
    <WalletFrame>
      <div className="flex flex-1 flex-col px-6 pt-24">
        <span className="mx-auto flex size-20 items-center justify-center rounded-[28px] bg-[#0d0d0f] text-white shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)] dark:bg-[#17171c] dark:ring-1 dark:ring-white/10">
          <LockKey size={36} weight="duotone" />
        </span>
        <h1 className="mt-6 text-center text-[24px] font-semibold">欢迎回来</h1>
        <p className="mt-1 text-center text-[14px] text-muted-foreground">{wallets.length > 1 ? `${wallets.length} 个钱包` : wallets[0]?.name} · 输入钱包密码解锁</p>

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
              placeholder="钱包密码"
              className="flex-1 bg-transparent text-[16px] outline-none"
            />
            <button type="button" aria-label={show ? "隐藏密码" : "显示密码"} onClick={() => setShow((v) => !v)} className="text-muted-foreground">
              {show ? <EyeSlash size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <div className="mt-2 h-5 px-1 text-[13px] text-down">{err}</div>
          <PrimaryButton className="mt-2" disabled={!pw || busy} onClick={() => void submit()}>
            {busy ? "解锁中…" : "解锁"}
          </PrimaryButton>
        </form>

        <p className="mt-auto pb-10 text-center text-[12px] leading-5 text-muted-foreground">
          忘记密码无法找回。可以删除本机钱包后，用助记词重新导入并设置新密码。
        </p>
      </div>
    </WalletFrame>
  );
}
