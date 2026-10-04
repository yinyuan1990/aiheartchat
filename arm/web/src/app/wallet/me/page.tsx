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
      toast.success("已恢复：解锁需要密码");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const enableQuick = async (pw: string) => {
    try {
      await setQuick(pw);
      setQuickSheet(false);
      toast.success("已关闭密码：之后打开钱包不用再输");
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
        <section className="divide-y divide-border/60 rounded-[22px] bg-card ring-1 ring-border/60">
          <button type="button" onClick={lock} className="flex w-full items-center gap-3 px-4 py-4 text-left">
            <Lock size={20} />
            <span className="flex-1 text-[15px]">立即锁定</span>
            <span className="text-[12px] text-muted-foreground">{quick ? "已关闭解锁密码，不会自动锁定" : "切到后台 5 分钟自动锁定"}</span>
          </button>
          {canQuick && (
            <button type="button" role="switch" aria-checked={!quick} onClick={() => void toggleQuick()} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              <LockKeyOpen size={20} />
              <span className="flex-1">
                <span className="block text-[15px]">解锁需要密码</span>
                <span className="block text-[12px] text-muted-foreground">{quick ? "已关闭：打开钱包、转账都不用输密码" : "关掉后，打开钱包、转账都不用再输密码"}；导出助记词 / 私钥仍要密码</span>
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
                <span className="block text-[15px]">{bioName(bio)}解锁</span>
                <span className="block text-[12px] text-muted-foreground">导出助记词 / 私钥仍要输入密码</span>
              </span>
              <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", bio.enabled ? "justify-end bg-up" : "justify-start bg-border")}>
                <span className="size-6 rounded-full bg-white shadow-sm" />
              </span>
            </button>
          )}
          <PayeeRow />
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

      <BottomSheet open={bioSheet} onClose={() => setBioSheet(false)}>
        {bioSheet && <PasswordGate title={`开启${bioName(bio)}解锁`} onOk={(pw) => void enableBio(pw)} />}
      </BottomSheet>
      <BottomSheet open={quickSheet} onClose={() => setQuickSheet(false)}>
        {quickSheet && (
          <>
            <p className="mb-4 flex gap-1.5 rounded-2xl bg-[#d48806]/10 px-3.5 py-3 text-[12px] leading-5 text-[#b07005]">
              <ShieldWarning size={16} className="mt-0.5 shrink-0" />
              开启后，任何拿到这台已解锁手机的人打开钱包就能直接转账。密码加密保存在本机安全存储里，不会上传。
            </p>
            <PasswordGate title="关闭解锁密码" onOk={(pw) => void enableQuick(pw)} />
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
      toast.success("已开启：聊过天的好友可以直接给你转账");
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
      toast.success("已关闭，好友看不到你的收款地址了");
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
          <span className="block text-[15px]">允许好友给我转账</span>
          <span className="block text-[12px] text-muted-foreground">
            {on ? `聊过天的人能看到：${[payee?.evm && shortAddr(payee.evm, 6, 4), payee?.sol && `◎ ${shortAddr(payee.sol, 4, 4)}`, payee?.trx && `TRON ${shortAddr(payee.trx, 4, 4)}`, payee?.ton && `TON ${shortAddr(payee.ton, 4, 4)}`].filter(Boolean).join(" · ")}` : "打开后，聊过天的人在聊天里点「转账」就能直接给你转"}
          </span>
        </span>
        <span className={cn("flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors", on ? "justify-end bg-up" : "justify-start bg-border")}>
          <span className="size-6 rounded-full bg-white shadow-sm" />
        </span>
      </button>
      {other && (
        <div className="flex items-center gap-2 px-4 pb-3 text-[12px] text-[#b07005]">
          <span className="flex-1">公开的是另一个钱包的地址，不是「{active.name}」</span>
          <button type="button" disabled={busy} onClick={start} className="shrink-0 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
            改用当前钱包
          </button>
        </div>
      )}
      <BottomSheet open={gate} onClose={() => setGate(false)}>
        {gate && (
          <PasswordGate
            title="输入钱包密码，用钱包签名确认收款地址"
            onOk={async (pw) => {
              try {
                await vault.unlock(pw);
              } catch {
                return void toast.error("密码不对");
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
