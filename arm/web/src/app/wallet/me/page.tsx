"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AddressBook, CaretRight, Copy, Fingerprint, Key, Lock, PencilSimple, Plus, ScanSmiley, ShieldWarning, Trash, TreeStructure, Wallet as WalletIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { toHex } from "viem";
import type { HDAccount } from "viem/accounts";
import { accountOf, verifyPassword, type Secret, type WalletMeta } from "@/lib/wallet/vault";
import { bioDisable, bioEnable, bioName, bioStatus, copyText, setSecureScreen, type BioStatus } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { useVault } from "@/components/wallet/wallet-context";
import { Field } from "@/components/wallet/password-fields";
import { BottomNav, BottomSheet, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

type Sheet = { kind: "rename" | "export" | "delete"; wallet: WalletMeta } | null;

export default function MePage() {
  const { wallets, active, lock } = useVault();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [bio, setBio] = useState<BioStatus | null>(null);
  const [bioSheet, setBioSheet] = useState(false);
  const refreshBio = () => void bioStatus().then(setBio);
  useEffect(() => {
    void bioStatus().then(setBio);
  }, []);

  const toggleBio = async () => {
    if (!bio) return;
    if (!bio.enabled) return setBioSheet(true);
    await bioDisable();
    toast.success(`已关闭${bioName(bio)}解锁`);
    refreshBio();
  };
  const enableBio = async (pw: string) => {
    try {
      if (await bioEnable(pw)) {
        toast.success(`已开启${bioName(bio)}解锁`);
        setBioSheet(false);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
    refreshBio();
  };

  return (
    <WalletFrame>
      <TopBar title="我的" />
      <div className="flex-1 space-y-3 px-4 pb-4">
        <section className="rounded-[22px] bg-card p-2 ring-1 ring-border/60">
          <div className="px-2 pt-2 pb-1 text-[13px] font-medium text-muted-foreground">钱包（{wallets.length}）</div>
          <ul>
            {wallets.map((w) => (
              <li key={w.id} className="flex items-center gap-3 rounded-2xl px-2 py-2.5">
                <WalletDot address={w.address} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[15px] font-semibold">
                    <span className="truncate">{w.name}</span>
                    {w.id === active?.id && <span className="rounded-md bg-foreground px-1.5 py-px text-[10px] font-medium text-background">当前</span>}
                  </div>
                  <button type="button" onClick={async () => (await copyText(w.address)) && toast.success("地址已复制")} className="flex items-center gap-1 font-mono text-[12px] text-muted-foreground">
                    {shortAddr(w.address, 6, 4)}
                    <Copy size={12} />
                  </button>
                </div>
                <button type="button" aria-label="改名" onClick={() => setSheet({ kind: "rename", wallet: w })} className="flex size-9 items-center justify-center rounded-full hover:bg-muted">
                  <PencilSimple size={18} />
                </button>
                <button type="button" aria-label="导出" onClick={() => setSheet({ kind: "export", wallet: w })} className="flex size-9 items-center justify-center rounded-full hover:bg-muted">
                  <Key size={18} />
                </button>
                <button type="button" aria-label="删除" onClick={() => setSheet({ kind: "delete", wallet: w })} className="flex size-9 items-center justify-center rounded-full text-down hover:bg-down/10">
                  <Trash size={18} />
                </button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2 p-2">
            <Link href="/wallet/create" className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-muted text-[14px] font-semibold">
              <Plus size={16} weight="bold" />
              新建钱包
            </Link>
            <Link href="/wallet/import" className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-muted text-[14px] font-semibold">
              <WalletIcon size={16} weight="bold" />
              导入钱包
            </Link>
          </div>
        </section>

        <section className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
          <button type="button" onClick={lock} className="flex w-full items-center gap-3 px-4 py-4 text-left">
            <Lock size={20} />
            <span className="flex-1 text-[15px]">立即锁定</span>
            <span className="text-[12px] text-muted-foreground">切到后台 5 分钟自动锁定</span>
          </button>
          {bio && (bio.available || bio.enabled) && (
            <button type="button" role="switch" aria-checked={bio.enabled} onClick={() => void toggleBio()} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              {bio.kind === "face" ? <ScanSmiley size={20} /> : <Fingerprint size={20} />}
              <span className="flex-1">
                <span className="block text-[15px]">{bioName(bio)}解锁</span>
                <span className="block text-[12px] text-muted-foreground">导出助记词 / 私钥仍要输入密码</span>
              </span>
              <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", bio.enabled ? "justify-end bg-up" : "justify-start bg-border")}>
                <span className="size-6 rounded-full bg-white shadow-sm" />
              </span>
            </button>
          )}
          <Link href="/wallet/addresses" className="flex items-center gap-3 px-4 py-4">
            <AddressBook size={20} />
            <span className="flex-1 text-[15px]">地址簿</span>
            <span className="text-[12px] text-muted-foreground">常用收款地址</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
          <Link href="/wallet/nodes" className="flex items-center gap-3 px-4 py-4">
            <TreeStructure size={20} />
            <span className="flex-1 text-[15px]">节点</span>
            <span className="text-[12px] text-muted-foreground">各条链的 RPC 节点、测速、切换</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
          <Link href="/" className="flex items-center gap-3 px-4 py-4">
            <span className="flex size-5 items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="" className="size-5 rounded" />
            </span>
            <span className="flex-1 text-[15px]">打开 Arm</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
        </section>

        <p className="flex gap-1.5 px-2 text-[12px] leading-5 text-muted-foreground">
          <ShieldWarning size={14} className="mt-0.5 shrink-0" />
          钱包密码和助记词只保存在这台设备上。平台和客服永远不会向你要它们。
        </p>
      </div>
      <BottomNav />

      <BottomSheet open={!!sheet} onClose={() => setSheet(null)}>
        {sheet?.kind === "rename" && <Rename wallet={sheet.wallet} onDone={() => setSheet(null)} />}
        {sheet?.kind === "export" && <Export wallet={sheet.wallet} />}
        {sheet?.kind === "delete" && <Delete wallet={sheet.wallet} onDone={() => setSheet(null)} />}
      </BottomSheet>
      <BottomSheet open={bioSheet} onClose={() => setBioSheet(false)}>
        {bioSheet && <PasswordGate title={`开启${bioName(bio)}解锁`} onOk={(pw) => void enableBio(pw)} />}
      </BottomSheet>
    </WalletFrame>
  );
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

function PasswordGate({ title, onOk }: { title: string; onOk: (password: string) => void }) {
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
  return <div className="mt-3 rounded-2xl bg-muted/70 p-3 font-mono text-[13px] leading-6 break-all">{hex}</div>;
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
