"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import { ArrowsDownUp, CaretDown, CheckCircle, CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { useToken, useTokens } from "@/lib/api";
import { cn } from "@/lib/utils";
import { WALLET_CHAINS, explorerTx, isSolana, type WalletChain } from "@/lib/wallet/chains";
import { USDC_LOGO, absUrl, iconUrl, tokenIcon, useAssets } from "@/lib/wallet/assets";
import { useMarketList, type MarketChainKey } from "@/lib/wallet/market";
import { PUMP_DECIMALS, usePumpList } from "@/lib/wallet/pump";
import { ENGINE_NAME, STEP_LABEL, decimalsOf, engineOf, executeSwap, gasReserve, gasToken, getSwapQuote, isArcUsdc, lookupToken, tokenOfArm, tokenOfAsset, type SwapStep, type SwapToken } from "@/lib/wallet/swap";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, ChainPill, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const SLIPS = [0.5, 1, 3, 10] as const;
const SOL_USDC: SwapToken = { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", logo: USDC_LOGO, seed: "sol-usdc", decimals: 6, raw: 0n };

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const fmt = (raw: bigint, decimals: number) => {
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 8 });
};

export default function SwapPage() {
  const { chain } = useVault();
  return <Swap key={chain.key} chain={chain} />;
}

function Swap({ chain }: { chain: WalletChain }) {
  const { address, account, solKeypair, setChain } = useVault();
  const qc = useQueryClient();
  const engine = engineOf(chain);
  const { assets } = useAssets(chain, address);
  const owned = useMemo(() => assets.map((a) => tokenOfAsset(chain, a)).filter((t): t is SwapToken => !!t), [assets, chain]);
  const fresh = (t: SwapToken | null) => (t ? (owned.find((o) => same(o.address, t.address)) ?? t) : null);

  const [fromSel, setFromSel] = useState<SwapToken | null>(null);
  const [toSel, setToSel] = useState<SwapToken | null>(null);
  const from = fresh(fromSel) ?? owned[0] ?? gasToken(chain);
  const defaultTo = isSolana(chain) ? SOL_USDC : engine === "kyber" ? (owned.find((t) => !t.native && t.symbol.startsWith("USDC")) ?? null) : null;
  // on Arc one side is always USDC: selling an Arm token pins the other side to USDC
  const usdc = owned.find(isArcUsdc) ?? null;
  const to = engine === "arm" && from && !isArcUsdc(from) ? usdc : fresh(toSel) ?? (defaultTo && !same(defaultTo.address, from?.address) ? fresh(defaultTo) : null);

  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState<(typeof SLIPS)[number]>(3);
  const [picker, setPicker] = useState<null | "from" | "to" | "chain">(null);
  const [step, setStep] = useState<SwapStep | null>(null);
  const [err, setErr] = useState("");

  let amountIn = 0n;
  try {
    amountIn = from && amount && Number(amount) > 0 ? parseUnits(amount, from.decimals) : 0n;
  } catch {
    amountIn = 0n;
  }
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 350);
    return () => clearTimeout(id);
  }, [amountIn]);

  const armAddr = engine === "arm" && from && to ? (isArcUsdc(from) ? to.address : isArcUsdc(to) ? from.address : undefined) : undefined;
  const arm = useToken(armAddr);
  const ready = !!from && !!to && !same(from.address, to.address) && to.decimals >= 0 && (engine !== "arm" || !!arm.data);
  const q = useQuery({
    queryKey: ["swap", chain.key, from?.address, to?.address, debounced.toString(), slip],
    enabled: ready && debounced > 0n,
    refetchInterval: 15_000,
    retry: false,
    queryFn: () => getSwapQuote(chain, from!, to!, debounced, slip, arm.data),
  });
  const view = q.data && debounced === amountIn ? q.data : null;

  const reserve = from?.native ? gasReserve(chain) : 0n;
  const spendable = from ? (from.raw > reserve ? from.raw - reserve : 0n) : 0n;
  const insufficient = !!from && amountIn > 0n && amountIn > spendable;

  const flip = () => {
    if (!from || !to) return;
    setFromSel(to);
    setToSel(from);
    setAmount("");
  };

  const go = async () => {
    if (!view || !to) return;
    setErr("");
    try {
      const hash = await executeSwap(chain, view, to, amountIn, slip, { evm: account, sol: solKeypair }, setStep);
      toast.success(`已兑换成 ${to.symbol}`, { action: { label: "查看", onClick: () => window.open(explorerTx(chain, hash), "_blank") } });
      setAmount("");
      void qc.invalidateQueries({ queryKey: ["wallet"] });
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? "兑换失败").split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  const noSol = isSolana(chain) && !address;
  const rate = view && from && to && amountIn > 0n ? Number(formatUnits(view.out, to.decimals)) / Number(formatUnits(amountIn, from.decimals)) : null;

  return (
    <WalletFrame>
      <TopBar title="兑换" back="/wallet" right={<ChainPill chain={chain} onClick={() => setPicker("chain")} />} />
      {!engine ? (
        <p className="px-6 py-10 text-center text-[13px] leading-6 text-muted-foreground">
          {chain.name} 上暂时不能在钱包里兑换，点右上角换个网络。
          <br />
          收到的 TRX / USDT 可以直接转账，或转到交易所兑换。
        </p>
      ) : noSol ? (
        <p className="px-6 py-10 text-center text-[13px] leading-6 text-muted-foreground">私钥导入的钱包没有 Solana 账户，换到助记词钱包或别的网络再兑换。</p>
      ) : (
        <div className="flex-1 px-4 pb-6">
          <div>
            <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
              <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                <span>支付</span>
                <span className="font-mono">余额 {from ? `${fmt(from.raw, from.decimals)}` : "—"}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  placeholder="0"
                  className={cn("w-0 flex-1 bg-transparent font-mono text-[30px] font-semibold tracking-tight outline-none", insufficient && "text-down")}
                />
                <TokenButton token={from} onClick={() => setPicker("from")} />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {[25, 50, 75, 100].map((p) => {
                  const v = from ? formatUnits((spendable * BigInt(p)) / 100n, from.decimals) : "";
                  return (
                    <button key={p} type="button" disabled={!from || spendable === 0n} onClick={() => setAmount(v)} className={cn("h-8 rounded-xl text-[12px] font-semibold transition active:scale-95 disabled:opacity-40", amount === v && v ? "bg-foreground text-background" : "bg-muted")}>
                      {p === 100 ? "最大" : `${p}%`}
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="relative z-10 -my-3 flex justify-center">
              <button type="button" aria-label="互换" onClick={flip} className="flex size-10 items-center justify-center rounded-2xl bg-card ring-4 ring-background transition active:scale-90">
                <ArrowsDownUp size={18} weight="bold" />
              </button>
            </div>

            <section className="rounded-[22px] bg-card p-4 ring-1 ring-border/60">
              <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                <span>获得</span>
                <span className="font-mono">{to && to.raw > 0n ? `余额 ${fmt(to.raw, to.decimals)}` : " "}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className={cn("w-0 flex-1 truncate font-mono text-[30px] font-semibold tracking-tight", !view && "text-muted-foreground/50")}>
                  {view && to ? fmt(view.out, to.decimals) : q.isFetching ? "…" : "0"}
                </span>
                <TokenButton token={to} placeholder="选择代币" onClick={engine === "arm" && from && !isArcUsdc(from) ? undefined : () => setPicker("to")} />
              </div>
            </section>
          </div>

          <dl className="mt-3 space-y-2 px-1 text-[13px]">
            <Row label="汇率" value={rate != null && from && to ? `1 ${from.symbol} ≈ ${rate.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${to.symbol}` : "—"} />
            <Row label="最少获得" value={view && to ? `${fmt(view.minOut, to.decimals)} ${to.symbol}` : "—"} />
            <Row label="价格影响" value={view?.impact != null ? `${view.impact.toFixed(2)}%` : "—"} tone={view?.impact != null && view.impact > 5 ? "down" : undefined} />
            <Row label="路线" value={view?.route ?? "—"} />
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">滑点</dt>
              <dd className="flex gap-1">
                {SLIPS.map((s) => (
                  <button key={s} type="button" onClick={() => setSlip(s)} className={cn("h-7 rounded-lg px-2 font-mono text-[12px]", slip === s ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>
                    {s}%
                  </button>
                ))}
              </dd>
            </div>
          </dl>

          {q.isError && <p className="mt-2 text-[12px] text-down">{(q.error as Error).message || "报价失败，稍后再试"}</p>}
          {engine === "arm" && from && isArcUsdc(from) && !to && <p className="mt-2 text-[12px] text-muted-foreground">Arc 上用 USDC 兑换 Arm 发射的代币，或把它们换回 USDC。</p>}
          {err && <p className="mt-2 text-[12px] break-words text-down">{err}</p>}

          {insufficient ? (
            <Link href="/wallet/receive" className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold">
              {from?.native ? `${from.symbol} 不够（要留网络费），去充值` : "余额不足"}
            </Link>
          ) : (
            <PrimaryButton className="mt-4" disabled={!view || !!step} onClick={go}>
              <span className="flex items-center justify-center gap-1.5">
                {step && <CircleNotch size={18} className="animate-spin" />}
                {step ? STEP_LABEL[step] : !to ? "选择要获得的代币" : amountIn === 0n ? "输入数量" : q.isFetching && !view ? "报价中…" : "兑换"}
              </span>
            </PrimaryButton>
          )}
          {engine && <p className="mt-2 text-center text-[11px] text-muted-foreground">经 {ENGINE_NAME[engine]} 路由，在你的钱包里签名，平台不收手续费</p>}
        </div>
      )}

      <BottomSheet open={picker === "from" || picker === "to"} onClose={() => setPicker(null)}>
        {(picker === "from" || picker === "to") && (
          <TokenPicker
            chain={chain}
            side={picker}
            owned={owned}
            from={from}
            onPick={async (t) => {
              setPicker(null);
              let tok = t;
              if (tok.decimals < 0) {
                try {
                  tok = { ...tok, decimals: await decimalsOf(chain, tok.address) };
                } catch {
                  return toast.error("读不到这个代币的精度");
                }
              }
              if (picker === "from") {
                setFromSel(tok);
                if (same(tok.address, to?.address)) setToSel(from);
                if (!same(tok.address, from?.address)) setAmount("");
              } else {
                setToSel(tok);
                if (same(tok.address, from?.address)) {
                  setFromSel(to);
                  setAmount("");
                }
              }
            }}
          />
        )}
      </BottomSheet>

      <BottomSheet open={picker === "chain"} onClose={() => setPicker(null)}>
        <div className="mb-3 text-center text-[17px] font-semibold">选择网络</div>
        <ul className="space-y-1">
          {WALLET_CHAINS.filter((c) => engineOf(c)).map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => {
                  setChain(c.key);
                  setPicker(null);
                }}
                className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-3", c.key === chain.key ? "bg-muted" : "hover:bg-muted/60")}
              >
                <ChainGlyph chain={c} size={30} />
                <span className="flex-1 text-left text-[15px] font-semibold">{c.name}</span>
                <span className="text-[12px] text-muted-foreground">{ENGINE_NAME[engineOf(c)!]}</span>
                {c.key === chain.key && <CheckCircle size={20} weight="fill" />}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </WalletFrame>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "down" }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right font-mono", tone === "down" && "text-down")}>{value}</dd>
    </div>
  );
}

function TokenButton({ token, placeholder = "选择", onClick }: { token: SwapToken | null; placeholder?: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex h-10 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-[15px] font-semibold transition active:scale-95", token ? "bg-muted" : "bg-foreground pl-3.5 text-background")}>
      {token && <TokenAvatar symbol={token.symbol} seed={token.seed} logo={token.logo} size={28} className="rounded-full" />}
      <span className="max-w-[96px] truncate">{token?.symbol ?? placeholder}</span>
      {onClick && <CaretDown size={13} weight="bold" />}
    </button>
  );
}

function TokenPicker({ chain, side, owned, from, onPick }: { chain: WalletChain; side: "from" | "to"; owned: SwapToken[]; from: SwapToken | null; onPick: (t: SwapToken) => void }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);
  const engine = engineOf(chain);
  const [extra, setExtra] = useState<SwapToken[]>([]);
  const looked = useQuery({ queryKey: ["swap", "lookup", chain.key, dq], enabled: dq.length >= 32, queryFn: () => lookupToken(chain, dq), staleTime: 60_000 });

  const match = (t: SwapToken) => !dq || [t.symbol, t.name, t.address].some((s) => s.toLowerCase().includes(dq.toLowerCase()));
  // on Arc, buying means USDC → an Arm token
  const base = side === "from" ? owned.filter((t) => t.raw > 0n || t.native) : engine === "arm" ? [] : owned;
  const seen = new Set<string>();
  const list = [...base, ...(side === "to" ? extra : []), ...(looked.data ? [looked.data] : [])].filter((t) => {
    const k = t.address.toLowerCase();
    if (seen.has(k) || (side === "to" && engine === "arm" && isArcUsdc(t)) || (side === "to" && same(t.address, from?.address) && engine === "arm")) return false;
    seen.add(k);
    return match(t) || t === looked.data;
  });

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="mb-3 text-center text-[17px] font-semibold">{side === "from" ? "选择支付的代币" : "选择要获得的代币"}</div>
      <label className="flex h-11 shrink-0 items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={side === "to" ? "名称、符号或合约地址" : "搜索"} autoCapitalize="none" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
      </label>
      {side === "to" && engine === "kyber" && <KyberExtras chain={chain.key as MarketChainKey} q={dq} onRows={setExtra} />}
      {side === "to" && engine === "jupiter" && <PumpExtras q={dq} onRows={setExtra} />}
      {side === "to" && engine === "arm" && <ArmExtras onRows={setExtra} />}
      <ul className="no-scrollbar mt-2 flex-1 divide-y divide-border/50 overflow-y-auto">
        {list.map((t) => (
          <li key={t.address}>
            <button type="button" onClick={() => onPick(t)} className="flex w-full items-center gap-3 py-3 text-left">
              <TokenAvatar symbol={t.symbol} seed={t.seed} logo={t.logo} size={36} className="rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{t.symbol}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{t.name}</span>
              </span>
              {t.raw > 0n && <span className="font-mono text-[13px] text-muted-foreground">{fmt(t.raw, t.decimals)}</span>}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">{looked.isFetching ? "查找中…" : "没有找到，可以粘贴合约地址"}</li>}
      </ul>
    </div>
  );
}

function KyberExtras({ chain, q, onRows }: { chain: MarketChainKey; q: string; onRows: (t: SwapToken[]) => void }) {
  const r = useMarketList(chain, "hot", q);
  useEffect(() => onRows((r.data ?? []).map((m) => ({ address: m.address, symbol: m.symbol, name: m.name, logo: tokenIcon(chain, m.address, m.image), seed: m.address, decimals: -1, raw: 0n }))), [r.data, chain, onRows]);
  return null;
}

function PumpExtras({ q, onRows }: { q: string; onRows: (t: SwapToken[]) => void }) {
  const r = usePumpList("hot", q);
  useEffect(() => onRows([SOL_USDC, ...(r.data ?? []).map((c) => ({ address: c.mint, symbol: c.symbol, name: c.name, logo: iconUrl(c.image), seed: c.mint, decimals: PUMP_DECIMALS, raw: 0n }))]), [r.data, onRows]);
  return null;
}

function ArmExtras({ onRows }: { onRows: (t: SwapToken[]) => void }) {
  const r = useTokens("volume", "all", "24h", 100);
  useEffect(() => onRows((r.data ?? []).map((t) => tokenOfArm(t, absUrl(t.logo)))), [r.data, onRows]);
  return null;
}
