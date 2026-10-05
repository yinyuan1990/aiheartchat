"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { AddressBook, ClipboardText, Copy, PaperPlaneTilt, Plus, Scan, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { WalletDot } from "@/components/shared";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MAX_NAME, familyOf, normalizeAddr, removeContact, saveContact, useAddressBook, type Contact } from "@/lib/wallet/address-book";
import { parseScanned, parseScannedSol, parseScannedTon } from "@/lib/wallet/scan";
import { copyText, hasFeature, scanQr } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
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
        title={t("cw.send.book")}
        back="/wallet/me"
        right={
          <button type="button" onClick={() => setSheet({ kind: "add" })} className="flex h-9 items-center gap-1 rounded-full bg-muted px-3 text-[13px] font-medium transition active:scale-95">
            <Plus size={14} weight="bold" />
            {t("bot.add")}
          </button>
        }
      />
      <div className="flex-1 px-4 pb-6">
        {contacts.length > 0 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.send.searchBook")} className="h-11 w-full rounded-2xl bg-card px-4 text-[15px] ring-1 ring-border/60 outline-none" />
        )}
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            <AddressBook size={44} className="text-muted-foreground/60" />
            <p className="mt-3 text-[14px] text-muted-foreground">{t("cw.book.empty")}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{t("cw.book.emptyHint")}</p>
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
                      <span className="rounded bg-muted px-1 py-px font-sans text-[10px] font-medium">{{ evm: "EVM", sol: "Solana", trx: "TRON", ton: "TON" }[familyOf(c.address)]}</span>
                      <span className="truncate">{shortAddr(c.address, 8, 6)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="py-6 text-center text-[13px] text-muted-foreground">{t("cw.book.noMatch")}</li>}
          </ul>
        )}
        <p className="mt-4 px-2 text-[12px] leading-5 text-muted-foreground">{t("cw.book.note")}</p>
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
      const to = parseScanned(text)?.to ?? parseScannedTon(text)?.to ?? parseScannedSol(text)?.to;
      if (!to) return void toast.error(t("cw.book.scanUnknown"));
      setAddr(to);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const paste = async () => {
    try {
      setAddr((await navigator.clipboard.readText()).trim());
    } catch {
      toast.error(t("cw.send.clipboardFail"));
    }
  };
  const save = () => {
    try {
      saveContact(addr, name);
      toast.success(existing ? t("cw.book.renamed") : t("common.saved"));
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <div className="mb-4 text-center text-[17px] font-semibold">{t("cw.book.addTitle")}</div>
      <div className="rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">{t("cw.book.address")}</span>
          <span className="flex gap-1.5">
            {canScan && (
              <button type="button" onClick={scan} className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12px] font-medium">
                <Scan size={14} />
                {t("me.scan")}
              </button>
            )}
            <button type="button" onClick={paste} className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12px] font-medium">
              <ClipboardText size={14} />
              {t("cw.send.paste")}
            </button>
          </span>
        </div>
        <textarea value={addr} onChange={(e) => setAddr(e.target.value)} rows={2} spellCheck={false} autoCapitalize="none" placeholder={t("cw.book.addrPlaceholder")} className="mt-1 w-full resize-none bg-transparent font-mono text-[15px] leading-6 break-all outline-none" />
        {addr.trim() && !valid && <div className="text-[12px] text-down">{t("cw.send.badAddress")}</div>}
        {existing && <div className="text-[12px] text-[#d48806]">{t("cw.book.exists", { name: existing.name })}</div>}
      </div>
      <div className="mt-3 rounded-[20px] bg-muted/60 p-4">
        <div className="text-[13px] font-medium text-muted-foreground">{t("bot.name")}</div>
        <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} placeholder={t("cw.book.namePlaceholder")} className="mt-1 w-full bg-transparent text-[16px] outline-none" />
      </div>
      <PrimaryButton className="mt-4" disabled={!valid || !name.trim()} onClick={save}>
        {t("common.save")}
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
      toast.success(t("common.saved"));
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <div className="flex flex-col items-center">
        <WalletDot address={c.address} size={48} />
        <button type="button" onClick={async () => (await copyText(c.address)) && toast.success(t("card.addressCopied"))} className="mt-3 flex max-w-[300px] items-start gap-1 text-center font-mono text-[13px] break-all text-muted-foreground">
          {c.address}
          <Copy size={13} className="mt-1 shrink-0" />
        </button>
      </div>
      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="text-[13px] font-medium text-muted-foreground">{t("bot.name")}</div>
        <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} className="mt-1 w-full bg-transparent text-[16px] outline-none" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link href={`/wallet/send?to=${c.address}`} className="flex h-14 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[16px] font-semibold">
          <PaperPlaneTilt size={18} />
          {t("cw.send.title")}
        </Link>
        <PrimaryButton disabled={!name.trim() || name.trim() === c.name} onClick={save}>
          {t("common.save")}
        </PrimaryButton>
      </div>
      <GhostButton
        className={cn("mt-2 gap-1.5 bg-transparent text-[15px]", confirmDel ? "text-white bg-down" : "text-down")}
        onClick={() => {
          if (!confirmDel) return setConfirmDel(true);
          removeContact(c.address);
          toast.success(t("cw.book.deleted"));
          onDone();
        }}
      >
        <Trash size={18} />
        {confirmDel ? t("cw.book.confirmDelete") : t("common.delete")}
      </GhostButton>
    </>
  );
}
