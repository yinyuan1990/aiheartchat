"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { AddressBook, ClipboardText, Copy, PaperPlaneTilt, Plus, Scan, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MAX_NAME, isSolEntry, normalizeAddr, removeContact, saveContact, useAddressBook, type Contact } from "@/lib/wallet/address-book";
import { parseScanned, parseScannedSol } from "@/lib/wallet/scan";
import { copyText, hasFeature, scanQr } from "@/lib/wallet/native";
import { BottomSheet, GhostButton, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const noSubscribe = () => () => {};

export default function AddressesPage() {
  const { contacts } = useAddressBook();
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState<{ kind: "add" } | { kind: "edit"; c: Contact } | null>(null);
  const s = q.trim().toLowerCase();
  const list = contacts.filter((c) => !s || c.name.toLowerCase().includes(s) || c.address.toLowerCase().includes(s));

  return (
    <WalletFrame>
      <TopBar
        title="地址簿"
        back="/wallet/me"
        right={
          <button type="button" onClick={() => setSheet({ kind: "add" })} className="flex h-9 items-center gap-1 rounded-full bg-muted px-3 text-[13px] font-medium transition active:scale-95">
            <Plus size={14} weight="bold" />
            添加
          </button>
        }
      />
      <div className="flex-1 px-4 pb-6">
        {contacts.length > 0 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 地址" className="h-11 w-full rounded-2xl bg-card px-4 text-[15px] ring-1 ring-border/60 outline-none" />
        )}
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            <AddressBook size={44} className="text-muted-foreground/60" />
            <p className="mt-3 text-[14px] text-muted-foreground">还没有保存地址</p>
            <p className="mt-1 text-[12px] text-muted-foreground">转账成功后也可以顺手存进来</p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border/50 rounded-[22px] bg-card px-2 ring-1 ring-border/60">
            {list.map((c) => (
              <li key={c.address}>
                <button type="button" onClick={() => setSheet({ kind: "edit", c })} className="flex w-full items-center gap-3 px-2 py-3 text-left">
                  <WalletDot address={c.address} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{c.name}</span>
                    <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
                      <span className="rounded bg-muted px-1 py-px font-sans text-[10px] font-medium">{isSolEntry(c.address) ? "Solana" : "EVM"}</span>
                      <span className="truncate">{shortAddr(c.address, 8, 6)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="py-6 text-center text-[13px] text-muted-foreground">没有找到</li>}
          </ul>
        )}
        <p className="mt-4 px-2 text-[12px] leading-5 text-muted-foreground">同一个 0x 地址在各条 EVM 链上通用，Solana 地址只能在 Solana 上用；转账前仍请确认对方用的是哪条链。地址簿只保存在这台设备上。</p>
      </div>

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet?.kind === "add" && <AddForm key="add" onDone={() => setSheet(null)} />}
        {sheet?.kind === "edit" && <EditForm key={sheet.c.address} c={sheet.c} onDone={() => setSheet(null)} />}
      </BottomSheet>
    </WalletFrame>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const { contacts } = useAddressBook();
  const [addr, setAddr] = useState("");
  const [name, setName] = useState("");
  const canScan = useSyncExternalStore(noSubscribe, () => hasFeature("scan"), () => false);
  const norm = normalizeAddr(addr);
  const valid = !!norm;
  const existing = norm ? contacts.find((c) => c.address === norm) : undefined;

  const scan = async () => {
    try {
      const text = await scanQr();
      if (!text) return;
      const to = parseScanned(text)?.to ?? parseScannedSol(text)?.to;
      if (!to) return void toast.error("没认出地址，请换一个二维码或手动粘贴");
      setAddr(to);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const paste = async () => {
    try {
      setAddr((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error("无法读取剪贴板，请手动粘贴");
    }
  };
  const save = () => {
    try {
      saveContact(addr, name);
      toast.success(existing ? "已更新名称" : "已保存");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <div className="mb-4 text-center text-[17px] font-semibold">添加地址</div>
      <div className="rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">地址</span>
          <span className="flex gap-1.5">
            {canScan && (
              <button type="button" onClick={scan} className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12px] font-medium">
                <Scan size={14} />
                扫一扫
              </button>
            )}
            <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12px] font-medium">
              <ClipboardText size={14} />
              粘贴
            </button>
          </span>
        </div>
        <textarea value={addr} onChange={(e) => setAddr(e.target.value)} rows={2} spellCheck={false} autoCapitalize="none" placeholder="0x… 或 Solana 地址" className="mt-1 w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none" />
        {addr.trim() && !valid && <div className="text-[12px] text-down">地址格式不对</div>}
        {existing && <div className="text-[12px] text-[#d48806]">已经存过（{existing.name}），保存会改成新名称</div>}
      </div>
      <div className="mt-3 rounded-[20px] bg-muted/60 p-4">
        <div className="text-[13px] font-medium text-muted-foreground">名称</div>
        <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} placeholder="例如：交易所充值、小明" className="mt-1 w-full bg-transparent text-[16px] outline-none" />
      </div>
      <PrimaryButton className="mt-4" disabled={!valid || !name.trim()} onClick={save}>
        保存
      </PrimaryButton>
    </>
  );
}

function EditForm({ c, onDone }: { c: Contact; onDone: () => void }) {
  const [name, setName] = useState(c.name);
  const [confirmDel, setConfirmDel] = useState(false);
  const save = () => {
    try {
      saveContact(c.address, name);
      toast.success("已保存");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <div className="flex flex-col items-center">
        <WalletDot address={c.address} size={48} />
        <button type="button" onClick={async () => (await copyText(c.address)) && toast.success("地址已复制")} className="mt-3 flex max-w-[300px] items-start gap-1 text-center font-mono text-[13px] break-all text-muted-foreground">
          {c.address}
          <Copy size={13} className="mt-1 shrink-0" />
        </button>
      </div>
      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="text-[13px] font-medium text-muted-foreground">名称</div>
        <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} className="mt-1 w-full bg-transparent text-[16px] outline-none" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link href={`/wallet/send?to=${c.address}`} className="flex h-14 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[16px] font-semibold">
          <PaperPlaneTilt size={18} />
          转账
        </Link>
        <PrimaryButton disabled={!name.trim() || name.trim() === c.name} onClick={save}>
          保存
        </PrimaryButton>
      </div>
      <GhostButton
        className={cn("mt-2 gap-1.5 bg-transparent text-[15px]", confirmDel ? "text-white bg-down" : "text-down")}
        onClick={() => {
          if (!confirmDel) return setConfirmDel(true);
          removeContact(c.address);
          toast.success("已删除");
          onDone();
        }}
      >
        <Trash size={18} />
        {confirmDel ? "再点一次确认删除" : "删除"}
      </GhostButton>
    </>
  );
}
