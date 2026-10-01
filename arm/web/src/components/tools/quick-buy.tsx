"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Wallet, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContract } from "wagmi";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { useApp } from "@/components/providers";
import { Addr } from "@/components/shared";
import { ADDR, FEE_TIERS, NET, erc20Abi, quoterAbi, routerAbi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { logDebug } from "@/lib/debuglog";
import type { RadarItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const AMOUNTS = [1, 5, 10, 20];
const SLIPPAGES = [2, 5, 10];

type Quote = { fee: number; out: bigint };
const fmt = (raw: bigint, decimals: number) => {
  const n = Number(formatUnits(raw, decimals));
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 4 : 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

/** Radar one-click trade: USDC → coin (preset sizes) and coin → USDC (half / all), straight through the Uniswap V3 router. */
export function QuickBuy({ item, open, onClose }: { item: RadarItem; open: boolean; onClose: () => void }) {
  const { t, connected, address, wrongChain, toggleConnect } = useApp();
  const { run } = useTx();
  const client = usePublicClient();
  const me = address as Address | undefined;
  const token = item.token as Address;
  const [usd, setUsd] = useState(5);
  const [slip, setSlip] = useState(5);
  const [busy, setBusy] = useState<"buy" | "sell" | null>(null);

  const dec = useReadContract({ address: token, abi: erc20Abi, functionName: "decimals", query: { enabled: open } });
  const usdcBal = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: open && !!me, refetchInterval: 8000 } });
  const coinBal = useReadContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: open && !!me, refetchInterval: 8000 } });
  const sym = useReadContract({ address: token, abi: erc20Abi, functionName: "symbol", query: { enabled: open && (!item.symbol || item.symbol === "?") } });
  const symbol = item.symbol && item.symbol !== "?" ? item.symbol : sym.data ?? "?";
  const decimals = dec.data ?? 18;
  const amountIn = parseUnits(String(usd), 6);

  const best = async (a: Address, b: Address, amt: bigint): Promise<Quote | null> => {
    const outs = await Promise.all(FEE_TIERS.map(async (fee) => {
      try {
        const { result } = await client!.simulateContract({ address: ADDR.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: a, tokenOut: b, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] });
        return result[0] as bigint;
      } catch {
        return 0n;
      }
    }));
    let i = -1;
    outs.forEach((o, k) => { if (o > 0n && (i < 0 || o > outs[i])) i = k; });
    return i < 0 ? null : { fee: FEE_TIERS[i], out: outs[i] };
  };

  const quote = useQuery({
    queryKey: ["quickbuy", token, usd],
    enabled: open && !!client,
    refetchInterval: 8000,
    retry: false,
    queryFn: () => best(ADDR.usdc, token, amountIn),
  });

  const approve = async (asset: Address, need: bigint) => {
    const allowance = await client!.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [me!, ADDR.router] });
    if (allowance >= need) return true;
    return !!(await run(t("tx.approving"), { address: asset, abi: erc20Abi, functionName: "approve", args: [ADDR.router, maxUint256] }));
  };
  const swap = async (side: "buy" | "sell", tokenIn: Address, tokenOut: Address, amt: bigint, q: Quote) => {
    const minOut = q.out - (q.out * BigInt(slip * 100)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    logDebug("quickbuy", `${side} ${symbol} in=${amt} out=${q.out} min=${minOut} fee=${q.fee}`);
    return run(side === "buy" ? `USDC → ${symbol}` : `${symbol} → USDC`, {
      address: ADDR.router, abi: routerAbi, functionName: "exactInputSingle",
      args: [{ tokenIn, tokenOut, fee: q.fee, recipient: me!, deadline, amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    });
  };

  const buy = async () => {
    if (!me || !client || !quote.data || busy) return;
    setBusy("buy");
    try {
      if (await approve(ADDR.usdc, amountIn)) await swap("buy", ADDR.usdc, token, amountIn, quote.data);
    } catch (e) {
      logDebug("quickbuy.error", e);
    } finally {
      setBusy(null);
      void usdcBal.refetch(); void coinBal.refetch();
    }
  };
  const sell = async (part: 2n | 1n) => {
    const bal = coinBal.data ?? 0n;
    if (!me || !client || !bal || busy) return;
    setBusy("sell");
    try {
      const amt = bal / part;
      const q = await best(token, ADDR.usdc, amt);
      if (!q) return;
      if (await approve(token, amt)) await swap("sell", token, ADDR.usdc, amt, q);
    } catch (e) {
      logDebug("quickbuy.error", e);
    } finally {
      setBusy(null);
      void usdcBal.refetch(); void coinBal.refetch();
    }
  };

  const insufficient = usdcBal.data !== undefined && amountIn > usdcBal.data;
  const noRoute = quote.isFetched && !quote.data;
  const risky = item.verdict !== "buy" || item.dead;
  const canBuy = connected && !wrongChain && !!quote.data && !insufficient && !busy;
  const cta = busy === "buy" ? t("tx.confirming") : !connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`)
    : insufficient ? t("tools.insufficient") : noRoute ? t("tools.noRoute") : t("scan.buy.cta").replace("{n}", String(usd));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5"><Zap className="size-4 text-primary" /> {t("scan.buy.title").replace("{s}", symbol)}</DialogTitle>
          <Addr value={item.token} head={10} tail={8} className="self-start" />
        </DialogHeader>

        {risky && (
          <div className="flex gap-2 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {item.dead ? t("scan.buy.dead") : item.verdict === "pending" ? t("scan.buy.pending") : t("scan.buy.skip")}
              {item.reasons.filter((r) => r !== "pass" && r !== "smart").length > 0 && (
                <> {item.reasons.filter((r) => r !== "pass" && r !== "smart").map((r) => t(`scan.reason.${r}`)).join(" · ")}</>
              )}
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("tools.pay")}</span>
            {connected && usdcBal.data !== undefined && <span className="font-mono">{t("tools.balance")} {fmt(usdcBal.data, 6)} USDC</span>}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {AMOUNTS.map((a) => (
              <Button key={a} size="sm" variant={usd === a ? "default" : "outline"} className="font-mono" onClick={() => setUsd(a)} disabled={!!busy}>{a}u</Button>
            ))}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <dt>{t("tools.receive")}</dt>
          <dd className="text-right font-mono text-foreground">
            {quote.isFetching && !quote.data ? t("tools.quoting") : quote.data ? `${fmt(quote.data.out, decimals)} ${symbol}` : "—"}
          </dd>
          <dt>{t("common.slippage")}</dt>
          <dd className="flex justify-end gap-1">
            {SLIPPAGES.map((s) => (
              <button key={s} type="button" onClick={() => setSlip(s)} className={cn("rounded px-1.5 font-mono", slip === s ? "bg-primary text-primary-foreground" : "hover:text-foreground")}>{s}%</button>
            ))}
          </dd>
          {quote.data && <><dt>{t("tools.route")}</dt><dd className="text-right font-mono">Uniswap V3 · {quote.data.fee / 10_000}%</dd></>}
        </dl>

        <Button size="lg" variant={canBuy || !connected || wrongChain ? "glow" : "outline"} className="w-full"
          disabled={connected && !wrongChain && !canBuy} onClick={!connected || wrongChain ? toggleConnect : () => void buy()}>
          {busy === "buy" ? <Loader2 className="animate-spin" /> : !connected ? <Wallet /> : <Zap />} {cta}
        </Button>

        {connected && !!coinBal.data && coinBal.data > 0n && (
          <div className="space-y-1.5 rounded-lg border px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("scan.buy.holding")}</span>
              <span className="font-mono">{fmt(coinBal.data, decimals)} {symbol}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" onClick={() => void sell(2n)} disabled={!!busy}>{busy === "sell" ? <Loader2 className="animate-spin" /> : null} {t("scan.buy.sellHalf")}</Button>
              <Button size="sm" variant="outline" onClick={() => void sell(1n)} disabled={!!busy}>{t("scan.buy.sellAll")}</Button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("scan.buy.note")}</p>
      </DialogContent>
    </Dialog>
  );
}
