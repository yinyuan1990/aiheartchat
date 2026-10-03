"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardText, Info } from "@phosphor-icons/react";
import { toast } from "sonner";
import { normalizeMnemonic, normalizePrivateKey, type Secret } from "@/lib/wallet/vault";
import { setSecureScreen } from "@/lib/wallet/native";
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
  const [name, setName] = useState(firstWallet ? "我的钱包" : `钱包 ${wallets.length + 1}`);
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
  const inputError = input.trim() && !secret ? (mode === "mnemonic" ? (wordCount < 12 ? null : "助记词不正确，请检查拼写和顺序") : "私钥应为 64 位十六进制") : null;

  const submit = async () => {
    if (!secret) return;
    setBusy(true);
    try {
      const r = await addSecret(name.trim() || "我的钱包", secret, firstWallet ? pw : undefined);
      if (r.duplicate) {
        await switchTo(r.duplicate.id);
        toast("这个钱包已经导入过，已切换过去");
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
      toast.error("无法读取剪贴板，请手动粘贴");
    }
  };

  return (
    <WalletFrame>
      <TopBar back={firstWallet ? "/wallet/welcome" : "/wallet"} title="导入钱包" />
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
              {m === "mnemonic" ? "助记词" : "私钥"}
            </button>
          ))}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">{mode === "mnemonic" ? "助记词（12 / 24 个单词，用空格分开）" : "私钥"}</span>
            <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
              <ClipboardText size={14} />
              粘贴
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
            {mode === "mnemonic" && <span className="font-mono text-muted-foreground">{wordCount} 个词</span>}
          </div>
        </div>

        <div className="mt-3 space-y-4">
          <Field label="钱包名称">
            <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className="flex-1 bg-transparent text-[16px] outline-none" />
          </Field>
          {firstWallet && <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />}
        </div>

        <p className="mt-4 flex gap-1.5 text-[12px] leading-5 text-muted-foreground">
          <Info size={14} className="mt-0.5 shrink-0" />
          助记词 / 私钥只在这台设备上加密保存，不会上传到任何服务器。
        </p>

        <div className="mt-auto pt-8 pb-[max(20px,env(safe-area-inset-bottom))]">
          <PrimaryButton disabled={!secret || busy || (firstWallet && !passwordsOk(pw, pw2))} onClick={submit}>
            {busy ? "正在加密保存…" : "导入"}
          </PrimaryButton>
        </div>
      </div>
    </WalletFrame>
  );
}
