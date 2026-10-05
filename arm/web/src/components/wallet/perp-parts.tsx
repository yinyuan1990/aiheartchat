"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createWalletClient, erc20Abi, formatUnits, http, parseUnits, type LocalAccount } from "viem";
import { CheckCircle, CircleNotch, Eye, EyeSlash, MagnifyingGlass, Robot, ShieldWarning, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { chainByKey, explorerTx, publicClientFor, rpcOf } from "@/lib/wallet/chains";
import { ARB_USDC, HL_BRIDGE, MIN_DEPOSIT, WITHDRAW_FEE, withdraw, type HlAsset } from "@/lib/wallet/hl";
import { AI_PROVIDERS, DEFAULT_RISK, providerName, providerOf, testAi, type AiConfig, type AiResult } from "@/lib/wallet/ai-trade";
import { t } from "@/lib/wallet/i18n";
import { GhostButton, PrimaryButton } from "./ui";

/** Inline gradient: Tailwind 4 gradient utilities don't render in Chromium 99. */
export const AI_GRADIENT = "linear-gradient(90deg, #7c3aed, #2563eb)";
export const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
/** "+$1.20" / "-$0.19" */
export const sUsd = (n: number, d = 2) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n), d)}`;
export const px = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4));

/** Hyperliquid fill `dir` → i18n key */
const DIR: Record<string, string> = { "Open Long": "cw.perp.dirOpenLong", "Close Long": "cw.perp.dirCloseLong", "Open Short": "cw.perp.dirOpenShort", "Close Short": "cw.perp.dirCloseShort", "Long > Short": "cw.perp.dirLongToShort", "Short > Long": "cw.perp.dirShortToLong", Settlement: "cw.perp.dirSettlement" };
export const dirText = (dir: string) => (DIR[dir] ? t(DIR[dir]) : dir);

export function RiskGate({ onAccept }: { onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <>
      <div className="flex items-center justify-center gap-1.5 text-[17px] font-semibold text-down">
        <ShieldWarning size={20} weight="fill" />
        {t("cw.perp.riskTitle")}
      </div>
      <ul className="mt-4 space-y-2 text-[13px] leading-6 text-muted-foreground">
        <li>· {t("cw.perp.risk1")}</li>
        <li>· {t("cw.perp.risk2", { app: t("app.name") })}</li>
        <li>· {t("cw.perp.risk3")}</li>
        <li>· {t("cw.perp.risk4")}</li>
      </ul>
      <label className="mt-4 flex items-center gap-2 text-[14px]">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="size-4" />
        {t("cw.perp.riskAccept")}
      </label>
      <PrimaryButton className="mt-4" disabled={!ok} onClick={onAccept}>
        {t("cw.perp.continue")}
      </PrimaryButton>
    </>
  );
}

/** USDC on Arbitrum → Hyperliquid's bridge (credited to the same address in about a minute) */
export function DepositSheet({ main, onDone }: { main: LocalAccount; onDone: () => void }) {
  const arb = chainByKey("arb");
  const bal = useQuery({
    queryKey: ["hl", "deposit-bal", main.address],
    queryFn: async () => {
      const pc = publicClientFor(arb);
      const [usdc, eth] = await Promise.all([pc.readContract({ address: ARB_USDC, abi: erc20Abi, functionName: "balanceOf", args: [main.address] }), pc.getBalance({ address: main.address })]);
      return { usdc, eth };
    },
    refetchInterval: 10_000,
  });
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  let raw: bigint | null = null;
  try {
    raw = amount ? parseUnits(amount, 6) : null;
  } catch {}
  const usdc = bal.data?.usdc ?? 0n;
  const noGas = bal.data && bal.data.eth === 0n;
  const problem = raw == null ? null : raw < BigInt(MIN_DEPOSIT * 1e6) ? t("cw.perp.depMin", { n: MIN_DEPOSIT }) : raw > usdc ? t("cw.perp.depNoUsdc") : noGas ? t("cw.perp.depNoGas") : null;
  const send = async () => {
    if (!raw || problem) return;
    setBusy(true);
    try {
      const wc = createWalletClient({ account: main, chain: arb.chain, transport: http(rpcOf(arb)) });
      const hash = await wc.writeContract({ address: ARB_USDC, abi: erc20Abi, functionName: "transfer", args: [HL_BRIDGE, raw] });
      toast.info(t("cw.perp.depSent"));
      const rc = await publicClientFor(arb).waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error(t("cw.perp.txFailed"));
      toast.success(t("cw.perp.depDone"), { action: { label: t("cw.perp.view"), onClick: () => window.open(explorerTx(arb, hash), "_blank") } });
      onDone();
    } catch (e) {
      toast.error((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="text-center text-[17px] font-semibold">{t("cw.perp.depTitle")}</div>
      <p className="mt-2 text-center text-[12px] leading-5 text-muted-foreground">{t("cw.perp.depSub")}</p>
      <div className="mt-4 rounded-2xl bg-muted/70 p-4">
        <div className="flex justify-between text-[13px] text-muted-foreground">
          <span>Arbitrum USDC</span>
          <button type="button" className="font-mono text-foreground" onClick={() => setAmount(formatUnits(usdc, 6))}>
            {bal.data ? formatUnits(usdc, 6) : "…"} {t("transfer.all")}
          </button>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className="mt-2 w-full bg-transparent font-mono text-[30px] font-semibold outline-none" />
        {problem && <div className="text-[12px] text-down">{problem}</div>}
      </div>
      <ul className="mt-3 space-y-1 text-[12px] leading-5 text-muted-foreground">
        <li>· {t("cw.perp.depNote1", { n: MIN_DEPOSIT })}</li>
        <li>· {bal.data ? t("cw.perp.depNote2Have", { eth: Number(formatUnits(bal.data.eth, 18)).toFixed(5) }) : t("cw.perp.depNote2")}</li>
        <li>· {t("cw.perp.depNote3")}</li>
      </ul>
      <PrimaryButton className="mt-4" disabled={!raw || !!problem || busy} onClick={() => void send()}>
        {busy ? t("cw.perp.depositing") : t("cw.perp.confirmDeposit")}
      </PrimaryButton>
    </>
  );
}

export function WithdrawSheet({ main, available, onDone }: { main: LocalAccount; available: number; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const v = Number(amount);
  const problem = !amount ? null : !(v > WITHDRAW_FEE) ? t("cw.perp.wdMinFee", { n: WITHDRAW_FEE }) : v > available ? t("cw.perp.wdNoBalance") : null;
  const go = async () => {
    if (problem || !(v > 0)) return;
    setBusy(true);
    try {
      await withdraw(main, v);
      toast.success(t("cw.perp.wdDone", { n: WITHDRAW_FEE }));
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="text-center text-[17px] font-semibold">{t("cw.perp.wdTitle")}</div>
      <div className="mt-4 rounded-2xl bg-muted/70 p-4">
        <div className="flex justify-between text-[13px] text-muted-foreground">
          <span>{t("cw.perp.wdAvailable")}</span>
          <button type="button" className="font-mono text-foreground" onClick={() => setAmount(String(Math.floor(available * 100) / 100))}>
            {usd(available)} {t("transfer.all")}
          </button>
        </div>
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className="mt-2 w-full bg-transparent font-mono text-[30px] font-semibold outline-none" />
        {problem && <div className="text-[12px] text-down">{problem}</div>}
      </div>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">{t("cw.perp.wdNote", { n: WITHDRAW_FEE })}</p>
      <PrimaryButton className="mt-4" disabled={!!problem || !(v > 0) || busy} onClick={() => void go()}>
        {busy ? t("realname.submitting") : t("cw.perp.confirmWithdraw")}
      </PrimaryButton>
    </>
  );
}

export function AiSettingsSheet({ cfg, onSave, onClear }: { cfg: AiConfig | null; onSave: (c: AiConfig) => Promise<void>; onClear: () => Promise<void> }) {
  const [provider, setProvider] = useState(cfg?.provider ?? "deepseek");
  const [model, setModel] = useState(cfg?.model ?? "");
  const [key, setKey] = useState(cfg?.key ?? "");
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? "");
  const [maxLeverage, setMaxLeverage] = useState(cfg?.maxLeverage ?? DEFAULT_RISK.maxLeverage);
  const [maxPct, setMaxPct] = useState(cfg?.maxPct ?? DEFAULT_RISK.maxPct);
  const [minConfidence, setMinConfidence] = useState(cfg?.minConfidence ?? DEFAULT_RISK.minConfidence);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const p = providerOf(provider);
  const draft: AiConfig = { provider, model: model.trim(), key: key.trim(), baseUrl: baseUrl.trim() || undefined, maxLeverage, maxPct, minConfidence };
  const ready = !!draft.key && (provider !== "custom" || (!!draft.baseUrl && !!draft.model));
  const test = async () => {
    setBusy("test");
    try {
      const r = await testAi(draft);
      toast.success(t("cw.perp.aiConnected", { model: r.model }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="flex items-center justify-center gap-1.5 text-[17px] font-semibold">
        <Robot size={20} />
        {t("cw.perp.aiSettings")}
      </div>
      <p className="mt-2 text-center text-[12px] leading-5 text-muted-foreground">{t("cw.perp.aiSettingsSub")}</p>
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">{t("cw.perp.aiProvider")}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {AI_PROVIDERS.map((x) => (
          <button key={x.id} type="button" onClick={() => setProvider(x.id)} className={cn("h-9 rounded-full px-3 text-[13px] font-medium ring-1", provider === x.id ? "bg-foreground text-background ring-foreground" : "bg-card ring-border")}>
            {providerName(x)}
          </button>
        ))}
      </div>
      {p.note && <p className="mt-2 text-[12px] text-muted-foreground">{t(p.note)}</p>}
      {provider === "custom" && (
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t("cw.perp.aiBaseUrlPh")} autoCapitalize="none" spellCheck={false} className="mt-3 h-11 w-full rounded-xl bg-muted px-3 font-mono text-[13px] outline-none" />
      )}
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.model ? t("cw.perp.aiModelDefault", { model: p.model }) : t("cw.perp.aiModelName")} autoCapitalize="none" spellCheck={false} className="mt-3 h-11 w-full rounded-xl bg-muted px-3 font-mono text-[13px] outline-none" />
      <div className="mt-3 flex h-11 items-center rounded-xl bg-muted px-3">
        <input value={key} onChange={(e) => setKey(e.target.value)} type={show ? "text" : "password"} placeholder="API key" autoCapitalize="none" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
        <button type="button" aria-label={t("cw.perp.showKey")} onClick={() => setShow((v) => !v)} className="text-muted-foreground">
          {show ? <EyeSlash size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {p.keyUrl && (
        <a href={p.keyUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[12px] text-muted-foreground underline underline-offset-4">
          {t("cw.perp.aiGetKey", { name: providerName(p) })}
        </a>
      )}
      <div className="mt-4 text-[13px] font-medium text-muted-foreground">{t("cw.perp.aiRisk")}</div>
      <Slider label={t("cw.perp.aiMaxLev")} value={maxLeverage} min={1} max={20} unit={t("cw.perp.xUnit")} onChange={setMaxLeverage} />
      <Slider label={t("cw.perp.aiMaxPct")} value={maxPct} min={5} max={100} step={5} unit="%" onChange={setMaxPct} />
      <Slider label={t("cw.perp.aiMinConf")} value={minConfidence} min={30} max={90} step={5} unit="" onChange={setMinConfidence} />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <GhostButton disabled={!ready || !!busy} onClick={() => void test()}>
          {busy === "test" ? t("cw.perp.testing") : t("cw.perp.testConn")}
        </GhostButton>
        <PrimaryButton
          disabled={!ready || !!busy}
          onClick={async () => {
            setBusy("save");
            try {
              await onSave(draft);
            } finally {
              setBusy("");
            }
          }}
        >
          {t("common.save")}
        </PrimaryButton>
      </div>
      {cfg && (
        <button type="button" onClick={() => void onClear()} className="mt-3 w-full text-center text-[13px] text-down">
          {t("cw.perp.deleteKey")}
        </button>
      )}
    </>
  );
}

export function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="mt-3 block">
      <span className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="font-mono font-semibold">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-foreground" />
    </label>
  );
}

export function CoinPicker({ list, current, onPick }: { list: HlAsset[]; current: string; onPick: (c: string) => void }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => [...list].sort((a, b) => b.volume - a.volume).filter((a) => !q || a.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80), [list, q]);
  return (
    <>
      <div className="mb-3 text-center text-[17px] font-semibold">{t("cw.perp.pickCoin")}</div>
      <label className="flex h-11 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.perp.searchPh")} autoCapitalize="characters" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
      </label>
      <ul className="mt-2 max-h-[55vh] divide-y divide-border/50 overflow-y-auto">
        {rows.map((a) => {
          const ch = a.prevDay ? (a.mark / a.prevDay - 1) * 100 : 0;
          return (
            <li key={a.name}>
              <button type="button" onClick={() => onPick(a.name)} className={cn("flex w-full items-center gap-3 px-1 py-3 text-left", a.name === current && "font-semibold")}>
                <span className="w-20 text-[15px] font-semibold">{a.name}</span>
                <span className="flex-1 text-[11px] text-muted-foreground">{t("cw.perp.pickerRow", { n: a.maxLeverage, vol: `${usd(a.volume / 1e6, 1)}M` })}</span>
                <span className="text-right font-mono text-[13px]">
                  {px(a.mark)}
                  <span className={cn("ml-2", ch >= 0 ? "text-up" : "text-down")}>
                    {ch >= 0 ? "+" : ""}
                    {ch.toFixed(2)}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ACTION_TEXT: Record<string, { text: string; tone: string }> = {
  long: { text: "cw.perp.aiLong", tone: "bg-up/12 text-up" },
  short: { text: "cw.perp.aiShort", tone: "bg-down/12 text-down" },
  close: { text: "cw.perp.aiClose", tone: "bg-[#d48806]/12 text-[#b07005]" },
  hold: { text: "cw.perp.aiHold", tone: "bg-muted text-foreground" },
  wait: { text: "cw.perp.aiWait", tone: "bg-muted text-foreground" },
};

export function AiCard({ r, onApply, onClose }: { r: AiResult; onApply?: () => void; onClose?: () => void }) {
  const d = r.decision;
  const a = ACTION_TEXT[d.action];
  const [ago, setAgo] = useState(() => t("time.justNow"));
  useEffect(() => {
    const tick = () => setAgo(t("time.minutesAgo", { n: Math.max(0, Math.round((Date.now() - r.at) / 60_000)) }));
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [r.at]);
  return (
    <div className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
      <div className="flex items-center gap-2">
        <span className={cn("rounded-full px-3 py-1 text-[13px] font-semibold", a.tone)}>{t(a.text)}</span>
        <span className="text-[13px] font-semibold">{r.coin}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {ago} · {r.model}
        </span>
      </div>
      <div className="mt-3 text-[15px] leading-6 font-medium">{d.summary}</div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
        {t("cw.perp.confidence")}
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", d.confidence >= 70 ? "bg-up" : d.confidence >= 50 ? "bg-[#d48806]" : "bg-down")} style={{ width: `${d.confidence}%` }} />
        </span>
        <span className="font-mono">{d.confidence}</span>
      </div>
      {(d.action === "long" || d.action === "short") && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
          <Cell k={t("cw.perp.aiEntry")} v={d.entry ? px(d.entry) : t("cw.perp.market")} />
          <Cell k={t("card.perp.sl")} v={d.stopLoss ? px(d.stopLoss) : "—"} tone="text-down" />
          <Cell k={t("card.perp.tp")} v={d.takeProfit ? px(d.takeProfit) : "—"} tone="text-up" />
          <Cell k={t("cw.perp.leverage")} v={`${d.leverage}x`} />
          <Cell k={t("cw.perp.aiSize")} v={t("cw.perp.aiSizeV", { n: d.sizePct })} />
          <Cell k={t("cw.perp.aiHorizon")} v={d.horizon || "—"} />
        </div>
      )}
      {d.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-[13px] leading-5">
          {d.reasons.map((x, i) => (
            <li key={i} className="flex gap-1.5">
              <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-up" />
              {x}
            </li>
          ))}
        </ul>
      )}
      {d.risks.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12px] leading-5 text-muted-foreground">
          {d.risks.map((x, i) => (
            <li key={i} className="flex gap-1.5">
              <Warning size={13} className="mt-0.5 shrink-0" />
              {x}
            </li>
          ))}
        </ul>
      )}
      {r.warnings.length > 0 && (
        <div className="mt-3 rounded-xl bg-[#d48806]/10 px-3 py-2 text-[12px] leading-5 text-[#b07005]">
          {r.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}
      <div className="mt-3 text-[11px] text-muted-foreground">
        {t("cw.perp.aiUsage", { total: r.usage.total.toLocaleString(), prompt: r.usage.prompt.toLocaleString(), completion: r.usage.completion.toLocaleString() })}
      </div>
      {(onApply || onClose) && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {onClose && <GhostButton onClick={onClose}>{t("cw.perp.aiDismiss")}</GhostButton>}
          {onApply && <PrimaryButton onClick={onApply}>{d.action === "close" ? t("cw.perp.aiGoClose") : t("cw.perp.aiApply")}</PrimaryButton>}
        </div>
      )}
    </div>
  );
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-muted/70 px-2 py-2">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className={cn("mt-0.5 truncate font-mono text-[13px] font-semibold", tone)}>{v}</div>
    </div>
  );
}

export const Spinner = () => <CircleNotch size={18} className="animate-spin" />;
