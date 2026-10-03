"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowSquareOut, CheckCircle, CircleNotch, MagnifyingGlass, XCircle } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MAX_NAME, saveContact, type Contact } from "@/lib/wallet/address-book";

export type Sent = { hash: string; status: "pending" | "success" | "reverted" | "error"; error?: string };

export function SaveContact({ to }: { to: string }) {
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <div className="mt-5 flex items-center gap-1.5 text-[13px] text-up">
        <CheckCircle size={16} weight="fill" />
        已存到地址簿
      </div>
    );
  }
  const save = () => {
    try {
      saveContact(to, name);
      setDone(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="mt-5 w-full rounded-[20px] bg-muted/60 p-3 text-left">
      <div className="text-[13px] font-medium">存到地址簿，下次直接选</div>
      <div className="mt-2 flex gap-2">
        <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} placeholder="名称，例如：交易所充值" className="h-10 w-0 flex-1 rounded-xl bg-card px-3 text-[14px] ring-1 ring-border outline-none focus:ring-foreground" />
        <button type="button" disabled={!name.trim()} onClick={save} className="h-10 rounded-xl bg-foreground px-4 text-[14px] font-semibold text-background disabled:opacity-40">
          保存
        </button>
      </div>
    </div>
  );
}

export function BookPicker({ contacts, recent, current, onPick }: { contacts: Contact[]; recent: string[]; current?: string; onPick: (a: string) => void }) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const list = contacts.filter((c) => !s || c.name.toLowerCase().includes(s) || c.address.toLowerCase().includes(s));
  const others = recent.filter((r) => !contacts.some((c) => c.address === r) && (!s || r.toLowerCase().includes(s)));
  const row = (a: string, name?: string) => (
    <li key={a}>
      <button type="button" onClick={() => onPick(a)} className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left", current === a ? "bg-muted" : "hover:bg-muted/60")}>
        <WalletDot address={a} size={32} />
        <span className="min-w-0 flex-1">
          {name && <span className="block truncate text-[15px] font-semibold">{name}</span>}
          <span className={cn("block truncate font-mono text-muted-foreground", name ? "text-[12px]" : "text-[13px]")}>{shortAddr(a, 8, 6)}</span>
        </span>
      </button>
    </li>
  );
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <span className="w-12" />
        <span className="text-[17px] font-semibold">地址簿</span>
        <Link href="/wallet/addresses" className="w-12 text-right text-[13px] font-medium text-muted-foreground">
          管理
        </Link>
      </div>
      {(contacts.length > 0 || recent.length > 0) && (
        <div className="flex h-10 items-center gap-2 rounded-2xl bg-muted px-3">
          <MagnifyingGlass size={16} className="text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 地址" className="flex-1 bg-transparent text-[14px] outline-none" />
        </div>
      )}
      {list.length > 0 && <ul className="mt-2 space-y-0.5">{list.map((c) => row(c.address, c.name))}</ul>}
      {others.length > 0 && (
        <>
          <div className="mt-3 px-3 text-[12px] font-medium text-muted-foreground">最近转过</div>
          <ul className="mt-1 space-y-0.5">{others.map((a) => row(a))}</ul>
        </>
      )}
      {contacts.length === 0 && (
        <p className="py-6 text-center text-[13px] leading-6 text-muted-foreground">
          还没有保存地址。
          <br />
          转账成功后可以顺手存进来，也可以去
          <Link href="/wallet/addresses" className="font-medium text-foreground underline underline-offset-4">
            管理
          </Link>
          页添加。
        </p>
      )}
    </>
  );
}

export function Result({ sent, explorer, to, saved }: { sent: Sent; explorer: string; to?: string; saved: boolean }) {
  const [wasSaved] = useState(saved);
  const icon = {
    pending: <CircleNotch size={56} className="animate-spin text-muted-foreground" />,
    success: <CheckCircle size={56} weight="fill" className="text-up" />,
    reverted: <XCircle size={56} weight="fill" className="text-down" />,
    error: <XCircle size={56} weight="fill" className="text-down" />,
  }[sent.status];
  const title = { pending: "已发出，等待确认…", success: "转账成功", reverted: "交易失败（链上回滚）", error: "出错了" }[sent.status];
  return (
    <div className="flex flex-col items-center py-4 text-center">
      {icon}
      <div className="mt-4 text-[18px] font-semibold">{title}</div>
      {sent.error && <div className="mt-2 max-w-[300px] text-[12px] break-words text-muted-foreground">{sent.error}</div>}
      <a href={explorer} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-mono text-[12px] text-muted-foreground underline underline-offset-4">
        {shortAddr(sent.hash, 10, 8)}
        <ArrowSquareOut size={13} />
      </a>
      {sent.status === "success" && to && !wasSaved && <SaveContact to={to} />}
      {sent.status !== "pending" && (
        <Link href="/wallet" className="mt-6 flex h-14 w-full items-center justify-center rounded-2xl bg-primary text-[16px] font-semibold text-primary-foreground">
          完成
        </Link>
      )}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex justify-end">{children}</dd>
    </div>
  );
}
