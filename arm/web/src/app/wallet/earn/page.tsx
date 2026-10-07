"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type LocalAccount } from "viem";
import { ArrowDown, ArrowUp, CheckCircle, CircleNotch, Info, ShieldCheck, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { cn } from "@/lib/utils";
import { USDC_LOGO } from "@/lib/wallet/assets";
import { explorerTx } from "@/lib/wallet/chains";
import { t } from "@/lib/wallet/i18n";
import { EARN_CHAIN, EARN_STEP, USDC_DECIMALS, VAULTS, depositToVault, useEarnPnl, useEarnState, useVaultRates, withdrawFromVault, type EarnState, type EarnStep, type EarnVaultInfo, type VaultRates } from "@/lib/wallet/earn";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const YEAR_MS = 365 * 24 * 3600 * 1000;
/** below this a deposit + approve on Base can fail for gas (~150k gas at a few hundredths of a gwei) */
const MIN_ETH = 2_000_000_000_000n;

const usdcNum = (raw: bigint) => Number(formatUnits(raw, USDC_DECIMALS));
const money = (n: number, digits = 2) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);
const compactUsd = (v: number | null | undefined) => (v == null ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

export default function EarnPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { active, account, setChain } = useVault();
  const user = active?.address;
  const rates = useVaultRates();
  const st = useEarnState(user);
  const pnl = useEarnPnl(user);
  const rateOf = (v: EarnVaultInfo): VaultRates | undefined => rates.data?.find((r) => r.address.toLowerCase() === v.address.toLowerCase());

  const s = st.data;
  const total = s ? s.assets.reduce((a, b) => a + b, 0n) : 0n;
  const blendedApy = s && total > 0n ? VAULTS.reduce((acc, v, i) => acc + usdcNum(s.assets[i]) * (rateOf(v)?.netApy ?? 0), 0) / usdcNum(total) : 0;
  const bestApy = Math.max(0, ...VAULTS.map((v) => rateOf(v)?.netApy ?? 0));
  const earned = (pnl.data ?? []).reduce((a, p) => a + BigInt(p.pnl), 0n);

  const [picked, setPicked] = useState<string | null>(null);
  const defaultVault = useMemo(() => {
    const held = s ? VAULTS.find((_, i) => s.assets[i] > 0n) : undefined;
    if (held) return held;
    return [...VAULTS].sort((a, b) => (rateOf(b)?.netApy ?? 0) - (rateOf(a)?.netApy ?? 0))[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, rates.data]);
  const vault = VAULTS.find((v) => v.address === picked) ?? defaultVault;
  const vi = VAULTS.indexOf(vault);
  const [sheet, setSheet] = useState<null | "deposit" | "withdraw">(null);

  const goChain = (path: string) => {
    setChain(EARN_CHAIN.key);
    router.push(path);
  };

  return (
    <WalletFrame>
      <TopBar
        title={t("cw.earn.title")}
        back="/wallet"
        right={
          <span className="flex h-8 items-center gap-1.5 rounded-full bg-card pr-3 pl-1 text-[13px] font-medium ring-1 ring-border/60">
            <ChainGlyph chain={EARN_CHAIN} size={22} />
            {EARN_CHAIN.name}
          </span>
        }
      />
      <div className="flex-1 space-y-4 px-4 pb-8">
        <section className="relative overflow-hidden rounded-[28px] p-5 text-white shadow-[0_18px_40px_-18px_rgba(0,40,140,0.7)]" style={{ background: "linear-gradient(145deg, #0a2a8f 0%, #0052ff 55%, #3d7bff 100%)" }}>
          <div className="pointer-events-none absolute -top-20 -right-14 size-56 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.28),transparent_65%)]" />
          <div className="relative flex items-center gap-2 text-[13px] text-white/75">
            <TokenAvatar symbol="USDC" seed="base-usdc" logo={USDC_LOGO} size={18} className="rounded-full" />
            {t("cw.earn.heroLabel")}
            {total > 0n && (
              <span className="ml-auto flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium">
                <span className="size-1.5 animate-pulse rounded-full bg-[#7CFFB2]" />
                {t("cw.earn.live")}
              </span>
            )}
          </div>
          {st.isLoading ? <div className="relative mt-2 h-11 w-48 animate-pulse rounded-lg bg-white/15" /> : <Ticker state={s} total={total} apy={blendedApy} />}
          <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            {total > 0n ? (
              <>
                <span className="text-white/70">
                  {t("cw.earn.earned")} <span className="font-mono font-semibold text-[#7CFFB2]">+{money(usdcNum(earned), earned < 10_000_000n ? 4 : 2)}</span>
                </span>
                <span className="text-white/70">
                  {t("cw.earn.apy")} <span className="font-mono font-semibold text-white">{pct(blendedApy)}</span>
                </span>
              </>
            ) : (
              <span className="text-white/80">
                {t("cw.earn.heroEmpty")} · <span className="font-mono font-semibold text-[#7CFFB2]">{t("cw.earn.upTo", { v: pct(bestApy || null) })}</span>
              </span>
            )}
          </div>
          <div className="relative mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setSheet("deposit")} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-white text-[15px] font-semibold text-[#0a2a8f] transition active:scale-95">
              <ArrowDown size={17} weight="bold" />
              {t("cw.earn.deposit")}
            </button>
            <button type="button" disabled={total === 0n} onClick={() => setSheet("withdraw")} className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-white/15 text-[15px] font-semibold text-white transition active:scale-95 disabled:opacity-40">
              <ArrowUp size={17} weight="bold" />
              {t("cw.earn.withdraw")}
            </button>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between px-1 text-[13px]">
            <span className="font-medium text-muted-foreground">{t("cw.earn.vaults")}</span>
            <span className="text-[12px] text-muted-foreground">{t("cw.earn.byMorpho")}</span>
          </div>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-[22px] bg-card ring-1 ring-border/60">
            {VAULTS.map((v, i) => {
              const r = rateOf(v);
              const mine = s?.assets[i] ?? 0n;
              const on = v === vault;
              return (
                <li key={v.address}>
                  <button type="button" onClick={() => setPicked(v.address)} style={on ? { background: "rgba(0,82,255,0.06)" } : undefined} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white" style={{ background: v.color }}>
                      {v.curator[0]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-[15px] font-semibold">
                        <span className="truncate">{v.name}</span>
                        {on && <CheckCircle size={15} weight="fill" className="shrink-0 text-[#0052ff]" />}
                      </span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {t("cw.earn.tvl", { v: compactUsd(r?.tvlUsd) })} · {t("cw.earn.fee", { v: r?.fee != null ? `${Math.round(r.fee * 100)}%` : "—" })}
                      </span>
                      {mine > 0n && <span className="mt-0.5 block truncate text-[12px] font-medium text-[#0052ff]">{t("cw.earn.mine", { v: `${money(usdcNum(mine))} USDC` })}</span>}
                    </span>
                    <span className="text-right">
                      <span className="block font-mono text-[17px] font-semibold text-up">{rates.isLoading ? "…" : pct(r?.netApy)}</span>
                      <span className="block text-[11px] text-muted-foreground">{t("cw.earn.apy")}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {rates.isError && <p className="mt-2 px-1 text-[12px] text-down">{t("cw.earn.ratesFailed")}</p>}
        </section>

        <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="mb-2 flex items-center gap-1.5 text-[14px] font-semibold">
            <Info size={16} />
            {t("cw.earn.howTitle")}
          </div>
          <ul className="space-y-1.5 text-[13px] leading-5 text-muted-foreground">
            <li>· {t("cw.earn.how1")}</li>
            <li>· {t("cw.earn.how2")}</li>
            <li>· {t("cw.earn.how3")}</li>
            <li className="flex gap-1">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-up" />
              {t("cw.earn.how4", { app: t("app.name") })}
            </li>
          </ul>
        </section>
        <p className="flex items-start gap-1.5 px-1 text-[11px] leading-4 text-muted-foreground">
          <Warning size={13} className="mt-px shrink-0" />
          {t("cw.earn.risk")}
        </p>
      </div>

      <BottomSheet open={!!sheet} onClose={() => setSheet(null)}>
        {sheet && s && (
          <MoveSheet
            key={`${sheet}:${vault.address}`}
            kind={sheet}
            vault={vault}
            index={vi}
            state={s}
            apy={rateOf(vault)?.netApy ?? 0}
            goChain={goChain}
            onDone={async (amount, hash) => {
              setSheet(null);
              toast.success(t(sheet === "deposit" ? "cw.earn.deposited" : "cw.earn.withdrew", { v: money(usdcNum(amount)) }), hash !== "0x" ? { action: { label: t("cw.coin.view"), onClick: () => window.open(explorerTx(EARN_CHAIN, hash), "_blank") } } : undefined);
              await qc.invalidateQueries({ queryKey: ["wallet"] });
              void qc.invalidateQueries({ queryKey: ["earn", "pnl"] });
            }}
            account={account}
          />
        )}
      </BottomSheet>
    </WalletFrame>
  );
}

/** Balance that keeps counting up between refreshes at the vaults' current rate (an estimate; the chain read resets it). */
function Ticker({ state, total, apy }: { state?: EarnState; total: bigint; apy: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (total === 0n) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [total]);
  const base = usdcNum(total);
  const v = total > 0n && state ? base * (1 + (apy * Math.max(0, now - state.at)) / YEAR_MS) : 0;
  const [int, dec] = money(v, total > 0n ? 6 : 2).split(".");
  return (
    <div className="relative mt-1 flex items-baseline font-mono tracking-tight">
      <span className="text-[40px] leading-tight font-semibold">{int}</span>
      <span className="text-[22px] font-medium text-white/70">.{dec}</span>
      <span className="ml-2 text-[15px] font-semibold text-white/70">USDC</span>
    </div>
  );
}

function MoveSheet({
  kind,
  vault,
  index,
  state,
  apy,
  goChain,
  onDone,
  account,
}: {
  kind: "deposit" | "withdraw";
  vault: EarnVaultInfo;
  index: number;
  state: EarnState;
  apy: number;
  goChain: (path: string) => void;
  onDone: (amount: bigint, hash: string) => void;
  account: () => LocalAccount;
}) {
  const deposit = kind === "deposit";
  const max = deposit ? state.usdc : state.maxWithdraw[index];
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [step, setStep] = useState<EarnStep | null>(null);
  const [err, setErr] = useState("");

  let raw = 0n;
  try {
    raw = amount && Number(amount) > 0 ? parseUnits(amount, USDC_DECIMALS) : 0n;
  } catch {
    raw = 0n;
  }
  const over = raw > max;
  const noGas = state.eth < MIN_ETH;
  const n = usdcNum(raw);
  const limited = !deposit && state.maxWithdraw[index] < state.assets[index];

  const go = async () => {
    setErr("");
    try {
      const hash = deposit ? await depositToVault(account(), vault.address, raw, setStep) : await withdrawFromVault(account(), vault.address, raw, all && !limited, setStep);
      onDone(raw, hash);
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? t("cw.earn.failed")).split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  return (
    <div>
      <div className="mb-4 text-center text-[17px] font-semibold">{t(deposit ? "cw.earn.depositTo" : "cw.earn.withdrawFrom", { name: vault.name })}</div>
      {deposit && state.usdc === 0n ? (
        <div className="space-y-3">
          <p className="rounded-2xl bg-muted px-4 py-3 text-[13px] leading-5">{t("cw.earn.noUsdc")}</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => goChain("/wallet/receive")} className="h-12 rounded-2xl bg-muted text-[14px] font-semibold">
              {t("cw.home.receive")}
            </button>
            <button type="button" onClick={() => goChain("/wallet/swap")} className="h-12 rounded-2xl bg-foreground text-[14px] font-semibold text-background">
              {t("cw.home.swap")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="rounded-[22px] bg-muted/60 p-4">
            <div className="flex items-center justify-between text-[12px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <TokenAvatar symbol="USDC" seed="base-usdc" logo={USDC_LOGO} size={16} className="rounded-full" />
                USDC · Base
              </span>
              <span className="font-mono">{t(deposit ? "cw.earn.available" : "cw.earn.withdrawable", { v: money(usdcNum(max)) })}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                  setAll(false);
                }}
                inputMode="decimal"
                placeholder="0"
                className={cn("w-0 flex-1 bg-transparent font-mono text-[32px] font-semibold tracking-tight outline-none", over && "text-down")}
              />
              <button
                type="button"
                disabled={max === 0n}
                onClick={() => {
                  setAmount(formatUnits(max, USDC_DECIMALS));
                  setAll(true);
                }}
                className={cn("h-9 rounded-xl px-3 text-[13px] font-semibold transition active:scale-95 disabled:opacity-40", all ? "bg-foreground text-background" : "bg-card")}
              >
                {t("cw.coin.max")}
              </button>
            </div>
          </section>

          <dl className="mt-3 space-y-2 px-1 text-[13px]">
            <Row label={t("cw.earn.apy")} value={pct(apy)} tone="up" />
            {deposit && <Row label={t("cw.earn.perDay")} value={n > 0 ? `+${money((n * apy) / 365, 4)} USDC` : "—"} />}
            {deposit && <Row label={t("cw.earn.perYear")} value={n > 0 ? `+${money(n * apy)} USDC` : "—"} tone={n > 0 ? "up" : undefined} />}
            <Row label={t("cw.earn.netFee")} value={t("cw.earn.netFeeValue")} />
          </dl>

          {limited && <p className="mt-3 rounded-2xl bg-[#d48806]/10 px-3.5 py-2.5 text-[12px] leading-5 text-[#b07005]">{t("cw.earn.liquidityLow", { v: money(usdcNum(state.maxWithdraw[index])) })}</p>}
          {noGas && (
            <div className="mt-3 flex items-center gap-2 rounded-2xl bg-[#d48806]/10 px-3.5 py-2.5 text-[12px] leading-5 text-[#b07005]">
              <Warning size={15} className="shrink-0" />
              <span className="flex-1">{t("cw.earn.noEth")}</span>
              <button type="button" onClick={() => goChain("/wallet/swap")} className="shrink-0 font-semibold underline underline-offset-2">
                {t("cw.earn.getEth")}
              </button>
            </div>
          )}
          {err && <p className="mt-3 text-[12px] break-words text-down">{err}</p>}

          <PrimaryButton className="mt-4" disabled={raw === 0n || over || noGas || !!step} onClick={go}>
            <span className="flex items-center justify-center gap-1.5">
              {step && <CircleNotch size={18} className="animate-spin" />}
              {step ? t(EARN_STEP[step]) : over ? t("transfer.insufficient") : raw === 0n ? t("cw.swap.enterAmount") : t(deposit ? "cw.earn.deposit" : "cw.earn.withdraw")}
            </span>
          </PrimaryButton>
        </>
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "up" }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right font-mono", tone === "up" && "text-up")}>{value}</dd>
    </div>
  );
}
