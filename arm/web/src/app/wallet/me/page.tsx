"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AddressBook, CaretRight, Fingerprint, HandCoins, Lock, LockKeyOpen, ScanSmiley, ShieldWarning, TreeStructure } from "@phosphor-icons/react";
import { toast } from "sonner";
import { shortAddr } from "@/lib/format";
import { quickSupported, type Secret } from "@/lib/wallet/vault";
import { bioDisable, bioEnable, bioName, bioStatus, type BioStatus } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { loadPayee, payeeSupported, publishPayee, unpublishPayee, type Payee } from "@/lib/wallet/payee";
import { useVault } from "@/components/wallet/wallet-context";
import { t } from "@/lib/wallet/i18n";
import { PasswordGate } from "@/components/wallet/wallet-manage";
import { BottomNav, BottomSheet, TopBar, WalletFrame } from "@/components/wallet/ui";

const noSubscribe = () => () => {};

/** 钱包列表和改名 / 导出 / 删除在首页点钱包名弹出的「我的钱包」里，这里只放设置 */
export default function MePage() {
  const { lock, quick, setQuick } = useVault();
  const [quickSheet, setQuickSheet] = useState(false);
  const canQuick = useSyncExternalStore(noSubscribe, quickSupported, () => false);
  const toggleQuick = async () => {
    if (!quick) return setQuickSheet(true);
    try {
      await setQuick(null);
      toast.success(t("cw.me.quickRestored"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const enableQuick = async (pw: string) => {
    try {
      await setQuick(pw);
      setQuickSheet(false);
      toast.success(t("cw.me.quickEnabled"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
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
    toast.success(t("cw.me.bioDisabled", { name: bioName(bio) }));
    refreshBio();
  };
  const enableBio = async (pw: string) => {
    try {
      if (await bioEnable(pw)) {
        toast.success(t("cw.me.bioEnabled", { name: bioName(bio) }));
        setBioSheet(false);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
    refreshBio();
  };

  return (
    <WalletFrame>
      <TopBar title={t("tab.me")} />
      <div className="flex-1 space-y-3 px-4 pb-4">
        <section className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
          <button type="button" onClick={lock} className="flex w-full items-center gap-3 px-4 py-4 text-left">
            <Lock size={20} />
            <span className="flex-1 text-[15px]">{t("cw.me.lockNow")}</span>
            <span className="text-[12px] text-muted-foreground">{quick ? t("cw.me.noAutoLock") : t("cw.me.autoLock")}</span>
          </button>
          {canQuick && (
            <button type="button" role="switch" aria-checked={!quick} onClick={() => void toggleQuick()} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              <LockKeyOpen size={20} />
              <span className="flex-1">
                <span className="block text-[15px]">{t("cw.me.requirePassword")}</span>
                <span className="block text-[12px] text-muted-foreground">{quick ? t("cw.me.quickOnDesc") : t("cw.me.quickOffDesc")}</span>
              </span>
              <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", !quick ? "justify-end bg-up" : "justify-start bg-border")}>
                <span className="size-6 rounded-full bg-white shadow-sm" />
              </span>
            </button>
          )}
          {bio && (bio.available || bio.enabled) && (
            <button type="button" role="switch" aria-checked={bio.enabled} onClick={() => void toggleBio()} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              {bio.kind === "face" ? <ScanSmiley size={20} /> : <Fingerprint size={20} />}
              <span className="flex-1">
                <span className="block text-[15px]">{t("cw.me.bioUnlock", { name: bioName(bio) })}</span>
                <span className="block text-[12px] text-muted-foreground">{t("cw.me.bioDesc")}</span>
              </span>
              <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", bio.enabled ? "justify-end bg-up" : "justify-start bg-border")}>
                <span className="size-6 rounded-full bg-white shadow-sm" />
              </span>
            </button>
          )}
          <PayeeRow />
          <Link href="/wallet/addresses" className="flex items-center gap-3 px-4 py-4">
            <AddressBook size={20} />
            <span className="flex-1 text-[15px]">{t("cw.send.book")}</span>
            <span className="text-[12px] text-muted-foreground">{t("cw.me.bookDesc")}</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
          <Link href="/wallet/nodes" className="flex items-center gap-3 px-4 py-4">
            <TreeStructure size={20} />
            <span className="flex-1 text-[15px]">{t("cw.nodes.title")}</span>
            <span className="text-[12px] text-muted-foreground">{t("cw.me.nodesDesc")}</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
          <Link href="/" className="flex items-center gap-3 px-4 py-4">
            <span className="flex size-5 items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="" className="size-5 rounded" />
            </span>
            <span className="flex-1 text-[15px]">{t("cw.me.openArm")}</span>
            <CaretRight size={16} className="text-muted-foreground" />
          </Link>
        </section>

        <p className="flex gap-1.5 px-2 text-[12px] leading-5 text-muted-foreground">
          <ShieldWarning size={14} className="mt-0.5 shrink-0" />
          {t("cw.me.securityNote")}
        </p>
      </div>
      <BottomNav />

      <BottomSheet open={bioSheet} onClose={() => setBioSheet(false)}>
        {bioSheet && <PasswordGate title={t("cw.me.enableBio", { name: bioName(bio) })} onOk={(pw) => void enableBio(pw)} />}
      </BottomSheet>
      <BottomSheet open={quickSheet} onClose={() => setQuickSheet(false)}>
        {quickSheet && (
          <>
            <p className="mb-4 flex gap-1.5 rounded-2xl bg-[#d48806]/10 px-3.5 py-3 text-[12px] leading-5 text-[#b07005]">
              <ShieldWarning size={16} className="mt-0.5 shrink-0" />
              {t("cw.me.quickWarning")}
            </p>
            <PasswordGate title={t("cw.me.disablePassword")} onOk={(pw) => void enableQuick(pw)} />
          </>
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

/** 「允许好友给我转账」: publishes the current wallet's addresses to the 心之音 account (signed, see lib/wallet/payee.ts). */
function PayeeRow() {
  const vault = useVault();
  const { active } = vault;
  const supported = useSyncExternalStore(noSubscribe, payeeSupported, () => false);
  const [payee, setPayee] = useState<Payee | null>(null);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    loadPayee().then(
      (p) => alive && setPayee(p),
      (e: Error) => alive && toast.error(e.message),
    );
    return () => {
      alive = false;
    };
  }, [supported]);
  if (!supported || !active) return null;

  const on = !!(payee?.evm || payee?.sol);
  const other = on && payee?.evm?.toLowerCase() !== active.address.toLowerCase();
  const publish = async (secret: Secret) => {
    if (!payee) return;
    setBusy(true);
    try {
      setPayee(await publishPayee(payee.userId, secret));
      toast.success(t("cw.me.payeeOn"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () => {
    const s = vault.secretOf(active.id);
    if (s) void publish(s);
    else setGate(true);
  };
  const toggle = async () => {
    if (busy || !payee) return;
    if (!on) return start();
    setBusy(true);
    try {
      setPayee(await unpublishPayee());
      toast.success(t("cw.me.payeeOff"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" role="switch" aria-checked={on} disabled={busy || !payee} onClick={() => void toggle()} className="flex w-full items-center gap-3 px-4 py-4 text-left disabled:opacity-60">
        <HandCoins size={20} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t("cw.me.payeeTitle")}</span>
          <span className="block text-[12px] text-muted-foreground">
            {on ? t("cw.me.payeeVisible", { list: [payee?.evm && shortAddr(payee.evm, 6, 4), payee?.sol && `◎ ${shortAddr(payee.sol, 4, 4)}`, payee?.trx && `TRON ${shortAddr(payee.trx, 4, 4)}`, payee?.ton && `TON ${shortAddr(payee.ton, 4, 4)}`].filter(Boolean).join(" · ") }) : t("cw.me.payeeHint")}
          </span>
        </span>
        <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", on ? "justify-end bg-up" : "justify-start bg-border")}>
          <span className="size-6 rounded-full bg-white shadow-sm" />
        </span>
      </button>
      {other && (
        <div className="flex items-center gap-2 px-4 pb-3 text-[12px] text-[#b07005]">
          <span className="flex-1">{t("cw.me.payeeOther", { name: active.name })}</span>
          <button type="button" disabled={busy} onClick={start} className="shrink-0 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
            {t("cw.me.payeeUseCurrent")}
          </button>
        </div>
      )}
      <BottomSheet open={gate} onClose={() => setGate(false)}>
        {gate && (
          <PasswordGate
            title={t("cw.me.payeeGate")}
            onOk={async (pw) => {
              try {
                await vault.unlock(pw);
              } catch {
                return void toast.error(t("cw.ui.wrongPassword"));
              }
              setGate(false);
              const s = vault.secretOf(active.id);
              if (s) void publish(s);
            }}
          />
        )}
      </BottomSheet>
    </>
  );
}
