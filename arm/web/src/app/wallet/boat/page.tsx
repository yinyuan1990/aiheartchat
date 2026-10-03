"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { ArrowSquareOut, CircleNotch, Copy, GameController, Info, Lightning, SealCheck, ShareNetwork } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { useBoatInfo } from "@/lib/boat";
import { fmtNum, fmtSmall, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR } from "@/lib/web3";
import { chainByKey, explorerAddr, explorerTx, publicClientFor } from "@/lib/wallet/chains";
import type { Side, TradeStep } from "@/lib/wallet/arm-trade";
import { boatImpact, boatRoute, executeBoatTrade, quoteBoat, type BoatRoute } from "@/lib/wallet/boat-trade";
import { copyText, nativeBridge, shareText } from "@/lib/wallet/native";
import { USDC_LOGO } from "@/lib/wallet/assets";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, ChainGlyph, IconButton, Num, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const GAME_URL = "https://arm.yyheart.com/games";
const usd = (n: number) => (n >= 1 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${fmtSmall(n)}`);

function openGame() {
  const b = nativeBridge();
  if (b?.openDapp) b.openDapp(GAME_URL);
  else window.open(GAME_URL, "_blank", "noopener");
}

function useBalances(r: BoatRoute | null, me?: Address) {
  return useQuery({
    queryKey: ["wallet", "boat-trade-balances", r?.boat, me],
    enabled: !!r && !!me,
    refetchInterval: 6_000,
    queryFn: async () => {
      const pc = publicClientFor(chainByKey("arc"));
      const [usdc, boat] = await Promise.all([
        pc.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me!] }),
        pc.readContract({ address: r!.boat, abi: erc20Abi, functionName: "balanceOf", args: [me!] }),
      ]);
      return { usdc, boat };
    },
  });
}

export default function BoatRoutePage() {
  const { active } = useVault();
  const me = active?.address;
  const info = useBoatInfo();
  const d = info.data;
  const r = boatRoute(d);
  const bal = useBalances(r, me);
  const [sheet, setSheet] = useState<Side | null>(null);
  const arc = chainByKey("arc");

  if (!d || !r) {
    return (
      <WalletFrame>
        <TopBar back="/wallet/token" title="BOAT" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">
          {info.isError || (d && !r) ? "BOAT 交易暂未开放" : <CircleNotch size={28} className="animate-spin" />}
        </div>
      </WalletFrame>
    );
  }

  const price = d.priceUsdc ?? 0;
  const held = bal.data ? Number(formatUnits(bal.data.boat, 18)) : 0;

  return (
    <WalletFrame>
      <TopBar
        back="/wallet/token"
        title={
          <div className="flex items-center gap-2">
            <TokenAvatar symbol="BOAT" seed={r.boat} size={30} className="rounded-full" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[15px] font-semibold">BOAT</div>
              <button type="button" onClick={async () => (await copyText(r.boat)) && toast.success("合约地址已复制")} className="flex items-center gap-1 font-mono text-[11px] font-normal text-muted-foreground">
                {shortAddr(r.boat, 6, 4)}
                <Copy size={11} />
              </button>
            </div>
          </div>
        }
        right={
          <IconButton label="分享" onClick={() => void shareText(`Speedboat ($BOAT) · ${GAME_URL}`)}>
            <ShareNetwork size={20} />
          </IconButton>
        }
      />

      <div className="flex-1 pb-28">
        <section className="px-4 pt-3">
          <div className="flex items-end justify-between">
            <div>
              <Num value={price > 0 ? usd(price) : "—"} className="text-[34px] leading-none font-semibold tracking-tight" />
              <div className="mt-2 text-[12px] text-muted-foreground">Speedboat 游戏代币 · Uniswap V4</div>
            </div>
            <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium">
              <ChainGlyph chain={arc} size={16} />
              Arc
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {[
              ["市值", d.mcapUsdc != null ? `$${fmtNum(d.mcapUsdc, 1)}` : "—"],
              ["游戏奖池", d.rewardPool != null ? `${fmtNum(d.rewardPool, 1)} BOAT` : "—"],
              ["今日已发", d.paidToday != null ? fmtNum(d.paidToday, 1) : "—"],
              ["累计发放", d.totalPaid != null ? fmtNum(d.totalPaid, 1) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-card px-3 py-2 ring-1 ring-border/60">
                <div className="text-[11px] text-muted-foreground">{k}</div>
                <div className="mt-0.5 font-mono text-[13px] font-semibold">{v}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold">我的持仓</span>
            {bal.data && bal.data.boat > 0n && (
              <Link href={`/wallet/send?asset=${r.boat}`} className="text-[12px] font-medium text-muted-foreground underline underline-offset-4">
                转账
              </Link>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="数量" value={bal.data ? fmtNum(held, 2) : "—"} />
            <Stat label="价值" value={bal.data && price > 0 ? `$${(held * price).toFixed(2)}` : "—"} />
          </div>
        </section>

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border/60">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold">关于 BOAT</span>
            <span className="flex items-center gap-1 text-[12px] text-up">
              <SealCheck size={15} weight="fill" />
              Arm 官方
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            快艇游戏的奖励币。买卖直接和金库合约成交，金库再去 Uniswap V4 池子换；买卖都收 1% 池费，归金库、补进游戏奖池。meme 币价格波动大，只用闲钱。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={openGame} className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-muted text-[13px] font-semibold transition active:scale-95">
              <GameController size={16} weight="fill" />
              去玩快艇
            </button>
            <a href={explorerAddr(arc, r.boat)} target="_blank" rel="noreferrer" className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-muted text-[13px] font-semibold transition active:scale-95">
              <ArrowSquareOut size={16} />
              区块浏览器
            </a>
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto grid max-w-[430px] grid-cols-2 gap-2 bg-background/90 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:absolute">
        <PrimaryButton tone="down" disabled={!bal.data || bal.data.boat === 0n} onClick={() => setSheet("sell")}>
          卖出
        </PrimaryButton>
        <PrimaryButton tone="up" onClick={() => setSheet("buy")}>
          买入
        </PrimaryButton>
      </div>

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && <BoatTradeSheet key={sheet} r={r} spot={price} side={sheet} onSide={setSheet} usdc={bal.data?.usdc ?? 0n} boat={bal.data?.boat ?? 0n} onDone={() => setSheet(null)} />}
      </BottomSheet>
    </WalletFrame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-[14px] font-semibold">{value}</div>
    </div>
  );
}

const SLIPS = [1, 2, 5] as const;
const QUICK_BUY = ["1", "5", "20", "50"];
const STEP_LABEL: Record<TradeStep, string> = { approving: "首次交易，正在授权…", swapping: "签名发送中…", confirming: "等待链上确认…" };

function BoatTradeSheet({ r, spot, side, onSide, usdc, boat, onDone }: { r: BoatRoute; spot: number; side: Side; onSide: (s: Side) => void; usdc: bigint; boat: bigint; onDone: () => void }) {
  const { account } = useVault();
  const qc = useQueryClient();
  const buy = side === "buy";
  const [amount, setAmount] = useState(buy ? "5" : "");
  const [slip, setSlip] = useState<(typeof SLIPS)[number]>(2);
  const [step, setStep] = useState<TradeStep | null>(null);
  const [err, setErr] = useState("");

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
    queryKey: ["wallet", "boat-quote", side, debounced.toString()],
    enabled: debounced > 0n,
    refetchInterval: 6_000,
    retry: false,
    queryFn: () => quoteBoat(r, side, debounced),
  });
  const out = q.data != null && debounced === amountIn ? q.data : null;
  const minOut = out != null ? out - (out * BigInt(slip * 100)) / 10_000n : null;
  const impact = out != null ? boatImpact(side, amountIn, out, spot) : null;
  const insufficient = amountIn > (buy ? usdc : boat);

  const go = async () => {
    if (minOut == null) return;
    setErr("");
    try {
      const rc = await executeBoatTrade(account(), r, side, amountIn, minOut, setStep);
      toast.success(`${buy ? "买入" : "卖出"} BOAT 成功`, { action: { label: "查看", onClick: () => window.open(explorerTx(chainByKey("arc"), rc.transactionHash), "_blank") } });
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      void qc.invalidateQueries({ queryKey: ["boat"] });
      onDone();
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  const fmtOut = (v: bigint) => (buy ? `${fmtNum(Number(formatUnits(v, 18)), 2)} BOAT` : `${Number(formatUnits(v, 6)).toFixed(4)} USDC`);

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
          <span className="font-mono">余额 {buy ? `${Number(formatUnits(usdc, 6)).toFixed(2)} USDC` : `${fmtNum(Number(formatUnits(boat, 18)), 2)} BOAT`}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className={cn("w-0 flex-1 bg-transparent font-mono text-[32px] font-semibold tracking-tight outline-none", insufficient && amountIn > 0n && "text-down")} />
          <span className="flex items-center gap-1.5 text-[15px] font-semibold">
            <TokenAvatar symbol={buy ? "USDC" : "BOAT"} seed={buy ? ADDR.usdc : r.boat} logo={buy ? USDC_LOGO : undefined} size={22} className="rounded-full" />
            {buy ? "USDC" : "BOAT"}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {(buy
            ? QUICK_BUY.map((v) => ({ v, l: `${v}U` }))
            : [25, 50, 75, 100].map((p) => ({ v: formatUnits((boat * BigInt(p)) / 100n, 18), l: p === 100 ? "全部" : `${p}%` }))
          ).map(({ v, l }) => (
            <button key={l} type="button" onClick={() => setAmount(v)} className={cn("h-9 rounded-xl text-[13px] font-semibold transition active:scale-95", amount === v ? "bg-foreground text-background" : "bg-card ring-1 ring-border")}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-2 px-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">预计得到</dt>
          <dd className="font-mono font-semibold">{out != null ? fmtOut(out) : q.isFetching ? "报价中…" : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">最少得到</dt>
          <dd className="font-mono">{minOut != null ? fmtOut(minOut) : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">价格影响</dt>
          <dd className={cn("font-mono", impact != null && impact > 5 ? "text-down" : "")}>{impact != null ? `${impact.toFixed(2)}%` : "—"}</dd>
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
        <PrimaryButton tone={buy ? "up" : "down"} className="mt-4" disabled={minOut == null || !!step} onClick={go}>
          <span className="flex items-center justify-center gap-1.5">
            {step ? <CircleNotch size={18} className="animate-spin" /> : <Lightning size={18} weight="fill" />}
            {step ? STEP_LABEL[step] : buy ? "买入 BOAT" : "卖出 BOAT"}
          </span>
        </PrimaryButton>
      )}
      <p className="mt-2 text-center text-[11px] text-muted-foreground">用你的钱包直接和 BoatVault 合约成交，不经过平台托管</p>
    </>
  );
}
