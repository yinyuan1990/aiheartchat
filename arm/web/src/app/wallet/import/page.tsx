"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardText, Info } from "@phosphor-icons/react";
import { toast } from "sonner";
import { normalizeMnemonic, normalizePrivateKey, type Secret } from "@/lib/wallet/vault";
import { setSecureScreen } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { Field, PasswordFields, passwordsOk } from "@/components/wallet/password-fields";
import { PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

export default function ImportWalletPage() {
  const { status, wallets, addSecret, switchTo } = useVault();
  const router = useRouter();
  const firstWallet = status === "empty";
  const [mode, setMode] = useState<"mnemonic" | "key">("mnemonic");
  const [input, setInput] = useState("");
  const [name, setName] = useState(firstWallet ? t("cw.create.defaultName") : t("cw.create.nameN", { n: wallets.length + 1 }));
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSecureScreen(true);
    return () => setSecureScreen(false);
  }, []);

  const secret: Secret | null = (() => {
    if (mode === "mnemonic") {
      const p = normalizeMnemonic(input);
      return p ? { kind: "mnemonic", phrase: p } : null;
    }
    const k = normalizePrivateKey(input);
    return k ? { kind: "key", key: k } : null;
  })();
  const wordCount = input.trim() ? input.trim().split(/\s+/).length : 0;
  const inputError = input.trim() && !secret ? (mode === "mnemonic" ? (wordCount < 12 ? null : t("cw.import.badMnemonic")) : t("cw.import.badKey")) : null;

  const submit = async () => {
    if (!secret) return;
    setBusy(true);
    try {
      const r = await addSecret(name.trim() || t("cw.create.defaultName"), secret, firstWallet ? pw : undefined);
      if (r.duplicate) {
        await switchTo(r.duplicate.id);
        toast(t("cw.import.duplicate"));
      }
      router.replace("/wallet");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      setInput(await navigator.clipboard.readText());
    } catch {
      toast.error(t("cw.send.clipboardFail"));
    }
  };

  return (
    <WalletFrame>
      <TopBar back={firstWallet ? "/wallet/welcome" : "/wallet"} title={t("cw.import.title")} />
      <div className="flex flex-1 flex-col px-4 pt-2">
        <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
          {(["mnemonic", "key"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setInput("");
              }}
              className={cn("h-10 rounded-xl text-[15px] font-semibold transition", mode === m ? "bg-card shadow-sm" : "text-muted-foreground")}
            >
              {m === "mnemonic" ? t("cw.ui.mnemonic") : t("cw.ui.privateKey")}
            </button>
          ))}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">{mode === "mnemonic" ? t("cw.import.mnemonicLabel") : t("cw.ui.privateKey")}</span>
            <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
              <ClipboardText size={14} />
              {t("cw.send.paste")}
            </button>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={mode === "mnemonic" ? 4 : 3}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={mode === "mnemonic" ? "word1 word2 word3 …" : "0x…"}
            className={cn("mt-1.5 w-full resize-none rounded-2xl bg-card p-4 font-mono text-[15px] leading-6 ring-1 outline-none", inputError ? "ring-down" : "ring-border focus:ring-foreground")}
          />
          <div className="mt-1.5 flex justify-between px-1 text-[12px]">
            <span className="text-down">{inputError}</span>
            {mode === "mnemonic" && <span className="font-mono text-muted-foreground">{t("cw.import.wordCount", { n: wordCount })}</span>}
          </div>
        </div>

        <div className="mt-3 space-y-4">
          <Field label={t("cw.create.nameLabel")}>
            <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className="flex-1 bg-transparent text-[16px] outline-none" />
          </Field>
          {firstWallet && <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />}
        </div>

        <p className="mt-4 flex gap-1.5 text-[12px] leading-5 text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0" />
          {t("cw.import.localOnly")}
        </p>

        <div className="mt-auto pt-8 pb-[max(20px,env(safe-area-inset-bottom))]">
          <PrimaryButton disabled={!secret || busy || (firstWallet && !passwordsOk(pw, pw2))} onClick={submit}>
            {busy ? t("cw.create.saving") : t("cw.home.import")}
          </PrimaryButton>
        </div>
      </div>
    </WalletFrame>
  );
}
