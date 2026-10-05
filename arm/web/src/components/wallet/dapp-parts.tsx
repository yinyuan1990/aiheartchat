"use client";

import { useState } from "react";
import { CaretDown, CaretUp, Eye, EyeSlash, Globe, Info, SealCheck, Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/wallet/i18n";
import type { RpcError } from "@/lib/wallet/native";
import { hostOf, isTrusted } from "@/lib/wallet/dapp-store";
import { isListed } from "@/lib/wallet/dapp-catalog";
import type { Line, Risk } from "@/lib/wallet/dapp-decode";

/** Building blocks shared by the EVM and Solana request sheets. */

export const E = {
  rejected: { code: 4001, message: "User rejected the request." },
  unauthorized: { code: 4100, message: "The requested account and/or method has not been authorized by the user." },
  unsupported: (what: string) => ({ code: 4200, message: `The wallet does not support ${what}.` }),
  unknownChain: (id: unknown) => ({ code: 4902, message: `Unrecognized chain ID ${String(id)}.` }),
  invalid: (msg: string) => ({ code: -32602, message: msg }),
};

export function rpcErrorOf(e: unknown): RpcError {
  const x = e as { code?: unknown; shortMessage?: string; details?: string; message?: string };
  const message = (x.shortMessage ?? x.details ?? x.message ?? "Internal error").split("\n")[0];
  return { code: typeof x.code === "number" ? x.code : -32603, message };
}

export function Origin({ origin, connected }: { origin: string; connected: boolean }) {
  const trusted = isTrusted(origin);
  const [icon, setIcon] = useState(true);
  const insecure = origin.startsWith("http:");
  return (
    <div className="flex flex-col items-center text-center">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${origin}/favicon.ico`} alt="" onError={() => setIcon(false)} className="size-14 rounded-2xl bg-muted object-cover shadow-sm ring-1 ring-border" />
      ) : (
        <span className="flex size-14 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
          <Globe size={26} weight="duotone" />
        </span>
      )}
      <div className="mt-2 flex max-w-full items-center gap-1 text-[15px] font-semibold">
        <span className="truncate">{hostOf(origin)}</span>
        {trusted && <SealCheck size={16} weight="fill" className="shrink-0 text-up" />}
      </div>
      <div className={cn("text-[12px]", trusted ? "text-muted-foreground" : "text-[#d48806]")}>
        {trusted
          ? connected
            ? t("cw.dapp.originArmConnected")
            : t("cw.dapp.originArm")
          : insecure
            ? t("cw.dapp.originInsecure")
            : connected
              ? t("cw.dapp.originThirdConnected")
              : isListed(origin)
                ? t("cw.dapp.originThirdListed")
                : t("cw.dapp.originThirdUnlisted")}
      </div>
    </div>
  );
}

export function Lines({ lines, danger }: { lines: Line[]; danger?: boolean }) {
  if (!lines.length) return null;
  return (
    <dl className={cn("divide-y divide-border/60 rounded-2xl px-3.5 text-[13px]", danger ? "bg-down/8 ring-1 ring-down/30" : "bg-muted/60")}>
      {lines.map((l, i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-2.5">
          <dt className="shrink-0 text-muted-foreground">{l.label}</dt>
          <dd className={cn("min-w-0 text-right break-all", l.mono && "font-mono", l.tone === "up" && "text-up", l.tone === "down" && "text-down")}>{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MessageBox({ text, mono }: { text: string; mono?: boolean }) {
  const [full, setFull] = useState(false);
  const long = text.length > 120 || text.split("\n").length > 3;
  return (
    <div className="rounded-2xl bg-muted/60 px-3.5 py-3">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        {t("cw.dapp.messageContent")}
        {long && (
          <button type="button" onClick={() => setFull((v) => !v)} className="flex items-center gap-0.5">
            {full ? t("cw.dapp.collapse") : t("cw.dapp.expand")}
            {full ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>
        )}
      </div>
      <pre className={cn("mt-1.5 max-h-[40vh] overflow-y-auto text-[12.5px] leading-5 break-all whitespace-pre-wrap", mono ? "font-mono" : "font-sans", !full && long && "line-clamp-3")}>{text}</pre>
    </div>
  );
}

export function Raw({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl bg-muted/60 px-3.5 text-[13px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full justify-between py-2.5 text-muted-foreground">
        {label}
        {open ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>
      {open && <pre className="max-h-[40vh] overflow-y-auto pb-3 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted-foreground">{text}</pre>}
    </div>
  );
}

export function Notes({ risk, notes }: { risk: Risk; notes: string[] }) {
  if (!notes.length) return null;
  const cls = risk === "danger" ? "bg-down/10 text-down" : risk === "warn" ? "bg-[#d48806]/10 text-[#b07005] dark:text-[#e0a030]" : "bg-up/10 text-up";
  const Icon = risk === "none" ? Info : Warning;
  return (
    <div className={cn("space-y-1 rounded-2xl px-3.5 py-2.5 text-[12px] leading-5", cls)}>
      {notes.map((n, i) => (
        <p key={i} className="flex items-start gap-1.5">
          <Icon size={14} className="mt-0.5 shrink-0" />
          {n}
        </p>
      ))}
    </div>
  );
}

export function RiskAck({ ack, onChange }: { ack: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-3 flex items-center gap-2 px-1 text-[13px]">
      <input type="checkbox" checked={ack} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--down)]" />
      {t("cw.dapp.riskAck")}
    </label>
  );
}

/** Password box shown inside a request sheet while the vault is locked. */
export function UnlockField({ pw, err, onChange }: { pw: string; err: string; onChange: (pw: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="mt-3">
      <div className={cn("flex h-12 items-center rounded-2xl bg-card px-4 ring-1 transition", err ? "ring-down" : "ring-border focus-within:ring-foreground")}>
        <input
          type={show ? "text" : "password"}
          value={pw}
          autoComplete="current-password"
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("cw.dapp.passwordPlaceholder")}
          className="flex-1 bg-transparent text-[15px] outline-none"
        />
        <button type="button" aria-label={show ? t("cw.dapp.hidePassword") : t("cw.dapp.showPassword")} onClick={() => setShow((v) => !v)} className="text-muted-foreground">
          {show ? <EyeSlash size={18} /> : <Eye size={18} />}
        </button>
      </div>
      <div className="mt-1 h-4 px-1 text-[12px] text-down">{err}</div>
    </div>
  );
}
