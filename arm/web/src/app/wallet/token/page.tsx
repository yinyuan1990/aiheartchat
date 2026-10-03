"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { ArrowSquareOut, CircleNotch, Copy, Info, Lightning, LockSimple, MagnifyingGlass, SealCheck, ShareNetwork, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { PriceChart, type Candle as ChartCandle } from "@/components/token/price-chart";
import { TokenAvatar } from "@/components/shared";
import { isTaxToken, useCandles, useToken, useTokens, useTrades, useWallet, type TokenView } from "@/lib/api";
import { fmtNum, fmtSmall, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR } from "@/lib/web3";
import { chainByKey, explorerTx, publicClientFor } from "@/lib/wallet/chains";
import { executeTrade, quote, sellableOf, shapeQuote, type Side, type TradeStep } from "@/lib/wallet/arm-trade";
import { copyText, shareText } from "@/lib/wallet/native";
import { USDC_LOGO, absUrl } from "@/lib/wallet/assets";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomNav, BottomSheet, ChainGlyph, IconButton, Num, Pct, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const usd = (n: number) => (n >= 1 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${fmtSmall(n)}`);
const compactUsd = (n: number) => `$${fmtNum(n, 1)}`;

export default function TokenRoute() {
  return (
    <Suspense fallback={<WalletFrame>{null}</WalletFrame>}>
      <TokenRouteInner />
    </Suspense>
  );
}

function TokenRouteInner() {
  const address = useSearchParams().get("address");
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? <TokenDetail address={address.toLowerCase()} /> : <TokenList />;
}

/* ───────────── list ───────────── */

const SORTS = [
  { key: "volume", label: "热门" },
  { key: "new", label: "新币" },
  { key: "mcap", label: "市值" },
] as const;

function TokenList() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("volume");
  const [q, setQ] = useState("");
  const list = useTokens(sort, "all", "24h", 100);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list.data ?? []).filter((t) => !s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.address.toLowerCase() === s);
  }, [list.data, q]);
  const arc = chainByKey("arc");

  return (
    <WalletFrame>
      <TopBar title="交易" right={<span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium"><ChainGlyph chain={arc} size={16} />Arm · Arc</span>} />
      <div className="px-4">
        <div className="flex h-11 items-center gap-2 rounded-2xl bg-card px-3 ring-1 ring-border/60">
          <MagnifyingGlass size={18} className="text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索代币名称 / 合约地址" className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        <div className="mt-3 flex gap-1">
          {SORTS.map((s) => (
            <button key={s.key} type="button" onClick={() => setSort(s.key)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium transition", sort === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-2 flex-1 divide-y divide-border/50 px-4">
        {list.isLoading &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <span className="size-[42px] animate-pulse rounded-full bg-muted" />
              <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
            </li>
          ))}
        {rows.map((t) => (
          <li key={t.address}>
            <Link href={`/wallet/token?address=${t.address}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol={t.symbol} seed={t.address} logo={absUrl(t.logo)} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold">{t.symbol}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  市值 {compactUsd(t.mcapUsd)} · {sort === "new" ? timeAgo(new Date(t.launchTs).getTime()) : `成交 ${compactUsd(Number(t.volume24hUsdc ?? t.volumeUsdc ?? 0) / 1e6)}`}
                </div>
              </div>
              <div className="text-right">
                <Num value={usd(t.price)} className="text-[14px] font-medium" />
                <div>{t.change24h != null ? <Pct value={t.change24h} className="text-[12px]" /> : <span className="text-[12px] text-muted-foreground">—</span>}</div>
              </div>
            </Link>
          </li>
        ))}
        {!list.isLoading && rows.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">没有找到</li>}
      </ul>
      <BottomNav />
    </WalletFrame>
  );
}

/* ───────────── detail ───────────── */

const RANGES = [
  { key: "1m", label: "1分" },
  { key: "15m", label: "15分" },
  { key: "1h", label: "1时" },
  { key: "4h", label: "4时" },
  { key: "1d", label: "1天" },
];

function useBalances(token?: TokenView, me?: Address) {
  return useQuery({
    queryKey: ["wallet", "trade-balances", token?.address, me],
    enabled: !!token && !!me,
    refetchInterval: 6_000,
    queryFn: async () => {
      const pc = publicClientFor(chainByKey("arc"));
      const [usdc, tok] = await Promise.all([
        pc.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me!] }),
        pc.readContract({ address: token!.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [me!] }),
      ]);
      return { usdc, tok };
    },
  });
}

function TokenDetail({ address }: { address: string }) {
  const { active } = useVault();
  const me = active?.address;
  const tq = useToken(address);
  const token = tq.data;
  const [range, setRange] = useState("15m");
  const candles = useCandles(address, range);
  const trades = useTrades(address, 1, 8);
  const bal = useBalances(token, me);
  const wallet = useWallet(me);
  const [sheet, setSheet] = useState<Side | null>(null);
  const chart = useMemo<ChartCandle[]>(() => (candles.data ?? []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volumeUsdc) / 1e6 })), [candles.data]);
  const arc = chainByKey("arc");

  if (!token) {
    return (
      <WalletFrame>
        <TopBar back="/wallet/token" title="代币" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{tq.isError ? "没找到这个代币" : <CircleNotch size={28} className="animate-spin" />}</div>
      </WalletFrame>
    );
  }

  const tokBal = bal.data ? Number(formatUnits(bal.data.tok, 18)) : 0;
  const posValue = tokBal * token.price;
  const mine = (wallet.data?.trades ?? []).filter((t) => t.token.toLowerCase() === address);
  const netCost = mine.reduce((s, t) => s + (t.side === "buy" ? 1 : -1) * (Number(t.usdc) / 1e6), 0);
  const pnl = posValue - netCost;
  const taxed = isTaxToken(token);

  return (
    <WalletFrame>
      <TopBar
        back="/wallet/token"
        title={
          <div className="flex items-center gap-2">
            <TokenAvatar symbol={token.symbol} seed={token.address} logo={absUrl(token.logo)} size={30} className="rounded-full" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[15px] font-semibold">{token.symbol}</div>
              <button type="button" onClick={async () => (await copyText(token.address)) && toast.success("合约地址已复制")} className="flex items-center gap-1 font-mono text-[11px] font-normal text-muted-foreground">
                {shortAddr(token.address, 6, 4)}
                <Copy size={11} />
              </button>
            </div>
          </div>
        }
        right={
          <IconButton label="分享" onClick={() => void shareText(`${token.name} ($${token.symbol}) · https://arm.yyheart.com/token/${token.address}`)}>
            <ShareNetwork size={20} />
          </IconButton>
        }
      />

      <div className="flex-1 pb-28">
        <section className="px-4 pt-3">
          <div className="flex items-end justify-between">
            <div>
              <Num value={usd(token.price)} className="text-[34px] leading-none font-semibold tracking-tight" />
              <div className="mt-2 flex items-center gap-2">
                {token.change24h != null && <Pct value={token.change24h} className={cn("rounded-full px-2 py-0.5", token.change24h >= 0 ? "bg-up/12" : "bg-down/12")} />}
                <span className="text-[12px] text-muted-foreground">24 小时</span>
              </div>
            </div>
            <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
              <ChainGlyph chain={arc} size={16} />
              Arc
            </span>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {[
              ["市值", compactUsd(token.mcapUsd)],
              ["24h 成交", compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6)],
              ["持币人", fmtNum(token.holders ?? 0)],
              ["已毕业", token.graduated ? "是" : `${Math.min(100, Math.round((Number(token.pairedUsdc) / Math.max(1, Number(token.graduationThreshold))) * 100))}%`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-card px-2.5 py-2 ring-1 ring-border/60">
                <div className="text-[11px] text-muted-foreground">{k}</div>
                <div className="mt-0.5 font-mono text-[13px] font-semibold">{v}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-4">
          <div className="flex gap-1 px-4">
            {RANGES.map((r) => (
              <button key={r.key} type="button" onClick={() => setRange(r.key)} className={cn("h-8 rounded-full px-3 text-[13px] font-medium transition", r.key === range ? "bg-foreground text-background" : "text-muted-foreground")}>
                {r.label}
              </button>
            ))}
          </div>
          {chart.length > 1 ? <PriceChart candles={chart} className="mt-2 h-[240px]" /> : <div className="mt-2 flex h-[240px] items-center justify-center text-[13px] text-muted-foreground">{candles.isLoading ? "加载中…" : "暂无成交"}</div>}
        </section>

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold">合约检查</span>
            <span className="flex items-center gap-1 text-[12px] text-up">
              <SealCheck size={15} weight="fill" />
              Arm 发射
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip ok icon={LockSimple} label="LP 永久锁定" />
            <Chip ok label="无增发 · 无 owner" />
            <Chip ok={!taxed} label={taxed ? `买税 ${token.buyTaxBps / 100}% · 卖税 ${token.sellTaxBps / 100}%` : "买卖税 0%"} />
          </div>
        </section>

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="text-[14px] font-semibold">我的持仓</div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="数量" value={fmtNum(tokBal, 2)} />
            <Stat label="价值" value={`$${posValue.toFixed(2)}`} />
            <Stat label="盈亏" value={mine.length ? `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}` : "—"} className={mine.length ? (pnl >= 0 ? "text-up" : "text-down") : ""} />
          </div>
        </section>

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="text-[14px] font-semibold">最新成交</div>
          <ul className="mt-2 divide-y divide-border/50">
            {(trades.data?.items ?? []).map((t) => (
              <li key={t.hash}>
                <a href={explorerTx(arc, t.hash)} target="_blank" rel="noreferrer" className="flex items-center gap-3 py-2.5 text-[13px]">
                  <span className={cn("w-9 rounded-md py-0.5 text-center text-[11px] font-semibold", t.side === "buy" ? "bg-up/12 text-up" : "bg-down/12 text-down")}>{t.side === "buy" ? "买" : "卖"}</span>
                  <span className="flex-1 font-mono text-muted-foreground">{shortAddr(t.wallet, 6, 4)}</span>
                  <span className="font-mono font-medium">${(Number(t.usdc) / 1e6).toFixed(2)}</span>
                  <span className="w-10 text-right text-[12px] text-muted-foreground">{timeAgo(new Date(t.time).getTime())}</span>
                </a>
              </li>
            ))}
            {trades.data && trades.data.items.length === 0 && <li className="py-4 text-center text-[13px] text-muted-foreground">还没有成交</li>}
          </ul>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto grid max-w-[430px] grid-cols-2 gap-2 bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:absolute">
        <PrimaryButton tone="down" disabled={!bal.data || bal.data.tok === 0n} onClick={() => setSheet("sell")}>
          卖出
        </PrimaryButton>
        <PrimaryButton tone="up" onClick={() => setSheet("buy")}>
          买入
        </PrimaryButton>
      </div>

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && <TradeSheet key={sheet} token={token} side={sheet} onSide={setSheet} usdc={bal.data?.usdc ?? 0n} tok={bal.data?.tok ?? 0n} onDone={() => setSheet(null)} />}
      </BottomSheet>
    </WalletFrame>
  );
}

function Chip({ ok, label, icon: Icon = SealCheck }: { ok: boolean; label: string; icon?: typeof SealCheck }) {
  return (
    <span className={cn("flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium", ok ? "bg-up/10 text-up" : "bg-[#f5a524]/12 text-[#b77700] dark:text-[#f5c26b]")}>
      {ok ? <Icon size={13} weight="fill" /> : <Warning size={13} weight="fill" />}
      {label}
    </span>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[14px] font-semibold", className)}>{value}</div>
    </div>
  );
}

const SLIPS = [2, 5, 10] as const;
const QUICK_BUY = ["1", "5", "10", "50"];
const STEP_LABEL: Record<TradeStep, string> = { approving: "首次交易，正在授权…", swapping: "签名发送中…", confirming: "等待链上确认…" };

function TradeSheet({ token, side, onSide, usdc, tok, onDone }: { token: TokenView; side: Side; onSide: (s: Side) => void; usdc: bigint; tok: bigint; onDone: () => void }) {
  const { account } = useVault();
  const qc = useQueryClient();
  const buy = side === "buy";
  const [amount, setAmount] = useState(buy ? "5" : "");
  const [slip, setSlip] = useState<(typeof SLIPS)[number]>(token.buyTaxBps || token.sellTaxBps ? 5 : 2);
  const [step, setStep] = useState<TradeStep | null>(null);
  const [err, setErr] = useState("");
  const sellable = sellableOf(token, tok);

  let amountIn = 0n;
  try {
    amountIn = amount && Number(amount) > 0 ? parseUnits(amount, buy ? 6 : 18) : 0n;
  } catch {
    amountIn = 0n;
  }
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 250);
    return () => clearTimeout(id);
  }, [amountIn]);

  const q = useQuery({
    queryKey: ["wallet", "quote", token.address, side, debounced.toString()],
    enabled: debounced > 0n,
    refetchInterval: 6_000,
    queryFn: () => quote(token, side, debounced),
  });
  const view = q.data != null && debounced === amountIn ? shapeQuote(token, side, amountIn, q.data, slip) : null;
  const insufficient = buy ? amountIn > usdc : amountIn + (view?.sellTax ?? 0n) > tok;

  const go = async () => {
    if (!view) return;
    setErr("");
    try {
      const rc = await executeTrade(account(), token, side, amountIn, view.minOut, setStep);
      toast.success(`${buy ? "买入" : "卖出"} ${token.symbol} 成功`, { action: { label: "查看", onClick: () => window.open(explorerTx(chainByKey("arc"), rc.transactionHash), "_blank") } });
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      void qc.invalidateQueries({ queryKey: ["token", token.address] });
      void qc.invalidateQueries({ queryKey: ["trades", token.address] });
      onDone();
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  const outLabel = view ? (buy ? `${fmtNum(Number(formatUnits(view.outNet, 18)), 2)} ${token.symbol}` : `${Number(formatUnits(view.out, 6)).toFixed(4)} USDC`) : q.isFetching ? "报价中…" : "—";
  const minLabel = view ? (buy ? `${fmtNum(Number(formatUnits(view.minOutNet, 18)), 2)} ${token.symbol}` : `${Number(formatUnits(view.minOut, 6)).toFixed(4)} USDC`) : "—";

  return (
    <>
      <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" disabled={!!step} onClick={() => onSide(s)} className={cn("h-10 rounded-xl text-[15px] font-semibold transition", side === s ? (s === "buy" ? "bg-up text-white shadow" : "bg-down text-white shadow") : "text-muted-foreground")}>
            {s === "buy" ? "买入" : "卖出"}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>{buy ? "支付" : "卖出数量"}</span>
          <span className="font-mono">余额 {buy ? `${Number(formatUnits(usdc, 6)).toFixed(2)} USDC` : `${fmtNum(Number(formatUnits(tok, 18)), 2)} ${token.symbol}`}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className={cn("w-0 flex-1 bg-transparent font-mono text-[32px] font-semibold tracking-tight outline-none", insufficient && amountIn > 0n && "text-down")} />
          <span className="flex items-center gap-1.5 text-[15px] font-semibold">
            <TokenAvatar symbol={buy ? "USDC" : token.symbol} seed={buy ? ADDR.usdc : token.address} logo={buy ? USDC_LOGO : absUrl(token.logo)} size={22} className="rounded-full" />
            {buy ? "USDC" : token.symbol}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {(buy
            ? QUICK_BUY.map((v) => ({ v, l: `${v}U` }))
            : [25, 50, 75, 100].map((p) => ({ v: formatUnits((sellable * BigInt(p)) / 100n, 18), l: p === 100 ? "全部" : `${p}%` }))
          ).map(({ v, l }) => (
            <button key={l} type="button" onClick={() => setAmount(v)} className={cn("h-9 rounded-xl text-[13px] font-semibold transition active:scale-95", amount === v ? "bg-foreground text-background" : "bg-card ring-1 ring-border")}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-2 px-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">预计得到{buy && token.buyTaxBps ? "（扣税后）" : ""}</dt>
          <dd className="font-mono font-semibold">{outLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">最少得到</dt>
          <dd className="font-mono">{minLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">价格影响</dt>
          <dd className={cn("font-mono", view && view.impact > 5 ? "text-down" : "")}>{view ? `${view.impact.toFixed(2)}%` : "—"}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="flex items-center gap-1 text-muted-foreground">
            滑点
            <Info size={13} />
          </dt>
          <dd className="flex gap-1">
            {SLIPS.map((s) => (
              <button key={s} type="button" onClick={() => setSlip(s)} className={cn("h-7 rounded-lg px-2 font-mono text-[12px]", slip === s ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>
                {s}%
              </button>
            ))}
          </dd>
        </div>
        {!!(token.buyTaxBps || token.sellTaxBps) && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">代币税</dt>
            <dd className="font-mono text-[#b77700] dark:text-[#f5c26b]">买 {token.buyTaxBps / 100}% · 卖 {token.sellTaxBps / 100}%</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted-foreground">手续费</dt>
          <dd className="font-mono text-muted-foreground">池费 1% · 网络费 ≈0.001 USDC</dd>
        </div>
      </dl>

      {q.isError && <p className="mt-2 text-[12px] text-down">报价失败，稍后再试</p>}
      {err && <p className="mt-2 text-[12px] break-words text-down">{err}</p>}

      {insufficient && amountIn > 0n ? (
        <Link href="/wallet/receive?deposit=1" className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold">
          余额不足，去充值
        </Link>
      ) : (
        <PrimaryButton tone={buy ? "up" : "down"} className="mt-4" disabled={!view || !!step} onClick={go}>
          <span className="flex items-center justify-center gap-1.5">
            {step ? <CircleNotch size={18} className="animate-spin" /> : <Lightning size={18} weight="fill" />}
            {step ? STEP_LABEL[step] : buy ? `买入 ${token.symbol}` : `卖出 ${token.symbol}`}
          </span>
        </PrimaryButton>
      )}
      <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
        用你的钱包直接在 Uniswap 成交，不经过平台托管
        <a href={`https://arm.yyheart.com/token/${token.address}`} target="_blank" rel="noreferrer">
          <ArrowSquareOut size={12} />
        </a>
      </p>
    </>
  );
}
