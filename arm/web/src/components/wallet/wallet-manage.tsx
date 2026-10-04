"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toHex } from "viem";
import type { HDAccount } from "viem/accounts";
import { accountOf, verifyPassword, type Secret, type WalletMeta } from "@/lib/wallet/vault";
import { exportSolKey, solKeypairOf } from "@/lib/wallet/sol";
import { setSecureScreen } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { Field } from "@/components/wallet/password-fields";
import { GhostButton, PrimaryButton } from "@/components/wallet/ui";

/** 钱包管理（首页「我的钱包」弹框里每个钱包的改名 / 导出 / 删除），弹框内容放在 BottomSheet 里用 */
export type ManageAction = { kind: "rename" | "export" | "delete"; wallet: WalletMeta };

export function ManageBody({ action, onDone }: { action: ManageAction; onDone: () => void }) {
  if (action.kind === "rename") return <Rename wallet={action.wallet} onDone={onDone} />;
  if (action.kind === "export") return <Export wallet={action.wallet} />;
  return <Delete wallet={action.wallet} onDone={onDone} />;
}

function Rename({ wallet, onDone }: { wallet: WalletMeta; onDone: () => void }) {
  const { rename } = useVault();
  const [name, setName] = useState(wallet.name);
  return (
    <>
      <div className="mb-4 text-center text-[17px] font-semibold">修改钱包名称</div>
      <Field label="名称">
        <input value={name} maxLength={20} autoFocus onChange={(e) => setName(e.target.value)} className="flex-1 bg-transparent text-[16px] outline-none" />
      </Field>
      <PrimaryButton
        className="mt-4"
        disabled={!name.trim()}
        onClick={async () => {
          await rename(wallet.id, name.trim());
          onDone();
        }}
      >
        保存
      </PrimaryButton>
    </>
  );
}

export function PasswordGate({ title, onOk }: { title: string; onOk: (password: string) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="mb-4 text-center text-[17px] font-semibold">{title}</div>
      <Field label="输入钱包密码确认" error={err || null}>
        <input
          type="password"
          value={pw}
          autoFocus
          onChange={(e) => {
            setPw(e.target.value);
            setErr("");
          }}
          className="flex-1 bg-transparent text-[16px] outline-none"
        />
      </Field>
      <PrimaryButton
        className="mt-4"
        disabled={!pw || busy}
        onClick={async () => {
          setBusy(true);
          if (await verifyPassword(pw)) onOk(pw);
          else setErr("密码不对");
          setBusy(false);
        }}
      >
        {busy ? "验证中…" : "确认"}
      </PrimaryButton>
    </>
  );
}

function Export({ wallet }: { wallet: WalletMeta }) {
  const { secretOf } = useVault();
  const [ok, setOk] = useState(false);
  const [mode, setMode] = useState<"mnemonic" | "key">(wallet.kind === "mnemonic" ? "mnemonic" : "key");
  useEffect(() => {
    setSecureScreen(ok);
    return () => setSecureScreen(false);
  }, [ok]);
  if (!ok) return <PasswordGate title={`导出「${wallet.name}」`} onOk={() => setOk(true)} />;
  const s = secretOf(wallet.id);
  if (!s) return <div className="py-6 text-center text-[14px] text-muted-foreground">钱包已锁定</div>;
  return (
    <>
      <div className="mb-3 text-center text-[17px] font-semibold">{mode === "mnemonic" ? "助记词" : "私钥"}</div>
      {s.kind === "mnemonic" && (
        <div className="mb-3 grid grid-cols-2 rounded-2xl bg-muted p-1">
          {(["mnemonic", "key"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cn("h-9 rounded-xl text-[14px] font-semibold", mode === m ? "bg-card shadow-sm" : "text-muted-foreground")}>
              {m === "mnemonic" ? "助记词" : "私钥"}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-down/30 bg-down/8 p-3 text-[12px] leading-5 text-down">拿到这些内容的人可以直接转走全部资产。不要截图、不要发给任何人。</div>
      {mode === "mnemonic" && s.kind === "mnemonic" ? (
        <ol className="mt-3 grid grid-cols-3 gap-2">
          {s.phrase.split(" ").map((w, i) => (
            <li key={i} className="flex h-11 items-center gap-2 rounded-xl bg-muted/70 px-3">
              <span className="w-5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <span className="font-mono text-[14px] font-medium">{w}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ExportKey secret={s} />
      )}
    </>
  );
}

function ExportKey({ secret }: { secret: Secret }) {
  const hex = secret.kind === "key" ? secret.key : toHex((accountOf(secret) as HDAccount).getHdKey().privateKey ?? new Uint8Array());
  const kp = solKeypairOf(secret);
  return (
    <>
      <div className="mt-3 text-[12px] font-medium text-muted-foreground">EVM 私钥（Arc / 以太坊 / BNB 等通用）</div>
      <div className="mt-1 rounded-2xl bg-muted/70 p-3 font-mono text-[13px] leading-6 break-all">{hex}</div>
      {kp && (
        <>
          <div className="mt-3 text-[12px] font-medium text-muted-foreground">Solana 私钥（可导入 Phantom / Solflare）</div>
          <div className="mt-1 rounded-2xl bg-muted/70 p-3 font-mono text-[13px] leading-6 break-all">{exportSolKey(kp)}</div>
        </>
      )}
    </>
  );
}

function Delete({ wallet, onDone }: { wallet: WalletMeta; onDone: () => void }) {
  const { remove } = useVault();
  const router = useRouter();
  const [ok, setOk] = useState(false);
  if (!ok) return <PasswordGate title={`删除「${wallet.name}」`} onOk={() => setOk(true)} />;
  return (
    <>
      <div className="text-center text-[17px] font-semibold text-down">确定删除？</div>
      <p className="mt-3 text-center text-[14px] leading-6 text-muted-foreground">只是从这台设备上移除，链上的资产还在。之后只能用助记词或私钥重新导入，请确认已经备份。</p>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <GhostButton onClick={onDone}>取消</GhostButton>
        <PrimaryButton
          tone="danger"
          onClick={async () => {
            await remove(wallet.id);
            onDone();
            router.replace("/wallet");
          }}
        >
          删除
        </PrimaryButton>
      </div>
    </>
  );
}
