"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, LineChart, Lock, Percent, Settings2, ShieldCheck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useReadContract } from "wagmi";
import { encodePacked, formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { afterBuyTax, isTaxToken, maxSellable, sellTaxOn, type TokenView } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR, NET, POOL_FEE, addrsFor, erc20Abi, quoterAbi, routerAbi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { logDebug } from "@/lib/debuglog";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TokenAvatar } from "@/components/shared";

const QUICK_USDC = [1, 5, 10, 50];
const QUICK_PCT = [25, 50, 75, 100];
type Side = "buy" | "sell";

function impactTone(pct: number) {
  if (pct >= 10) return "text-down";
  if (pct >= 5) return "text-gold";
  return "";
}

export function TradePanel({ token, className, bare }: { token: TokenView; className?: string; bare?: boolean }) {
  const { t, connected, address, wrongChain, toggleConnect } = useApp();
  const { run } = useTx();
  const client = usePublicClient();
  const qc = useQueryClient();
  const A = addrsFor(token.factory); // router / quoter of the factory generation that launched this token
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(2);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);

  const tokenAddr = token.address as Address;
  const me = address as Address | undefined;

  // Stock generation: the pool is quoted in a tokenized stock, but the trader still pays / receives USDC - we route
  // two hops through the stock/USDC pool (USDC -> stock -> token on buys, token -> stock -> USDC on sells).
  const quoteAddr = token.quote && token.quote !== ADDR.usdc.toLowerCase() ? (token.quote as Address) : undefined;
  const quoteFee = token.quoteUsdcFee ?? 0;
  const path = useMemo(() => {
    if (!quoteAddr) return undefined;
    return side === "buy"
      ? encodePacked(["address", "uint24", "address", "uint24", "address"], [ADDR.usdc, quoteFee, quoteAddr, POOL_FEE, tokenAddr])
      : encodePacked(["address", "uint24", "address", "uint24", "address"], [tokenAddr, POOL_FEE, quoteAddr, quoteFee, ADDR.usdc]);
  }, [quoteAddr, quoteFee, side, tokenAddr]);

  const usdcBal = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 6000 } });
  const tokBal = useReadContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 6000 } });

  const usdcBalance = usdcBal.data ?? 0n;
  const tokenBalance = tokBal.data ?? 0n;

  // parse input
  const amountIn = useMemo(() => {
    try {
      if (!amount || Number(amount) <= 0) return 0n;
      return side === "buy" ? parseUnits(amount, 6) : parseUnits(amount, 18);
    } catch {
      return 0n;
    }
  }, [amount, side]);

  // debounce for quoting
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 250);
    return () => clearTimeout(id);
  }, [amountIn]);

  const quote = useQuery({
    queryKey: ["quote", token.address, side, debounced.toString()],
    enabled: debounced > 0n && !!client,
    refetchInterval: 6000,
    queryFn: async () => {
      if (path) {
        const { result } = await client!.simulateContract({ address: A.quoter, abi: quoterAbi, functionName: "quoteExactInput", args: [path, debounced] });
        return result[0] as bigint;
      }
      const { result } = await client!.simulateContract({
        address: A.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: side === "buy" ? ADDR.usdc : tokenAddr, tokenOut: side === "buy" ? tokenAddr : ADDR.usdc, amountIn: debounced, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
      });
      return result[0] as bigint;
    },
  });

  // Tax mode. `out` / `minOut` are pool-side (what the router checks); the token contract then applies the tax:
  //   buy  → the wallet receives out × (1 − buyTax)
  //   sell → the seller is charged amountIn × sellTax on top, so the balance must cover amountIn + tax
  const taxed = isTaxToken(token);
  const buyTax = token.buyTaxBps ?? 0;
  const sellTax = token.sellTaxBps ?? 0;
  const out = quote.data ?? 0n;
  const outNet = side === "buy" && buyTax > 0 ? afterBuyTax(out, buyTax) : out;
  const sellTaxAmt = side === "sell" && sellTax > 0 ? sellTaxOn(amountIn, sellTax) : 0n;
  const sellMax = sellTax > 0 ? maxSellable(tokenBalance, sellTax) : tokenBalance;
  const outNum = side === "buy" ? Number(formatUnits(outNet, 18)) : Number(formatUnits(out, 6));
  const inNum = side === "buy" ? Number(formatUnits(amountIn, 6)) : Number(formatUnits(amountIn, 18));
  const execPrice = outNum > 0 && inNum > 0 ? (side === "buy" ? inNum / outNum : outNum / inNum) : 0;
  const impact = token.price > 0 && execPrice > 0 ? Math.max(0, (side === "buy" ? execPrice / token.price - 1 : 1 - execPrice / token.price) * 100) : 0;
  const minOut = out - (out * BigInt(Math.round(slippage * 100))) / 10_000n;
  const minOutNet = side === "buy" && buyTax > 0 ? afterBuyTax(minOut, buyTax) : minOut;
  const fee = side === "buy" ? inNum * 0.01 : outNum * 0.01;
  const insufficient = side === "buy" ? amountIn > usdcBalance : amountIn + sellTaxAmt > tokenBalance;

  const recvLabel = side === "buy" ? `${fmtNum(outNum)} ${token.symbol}` : fmtUsd(outNum);
  const minLabel = side === "buy" ? `${fmtNum(Number(formatUnits(minOutNet, 18)))} ${token.symbol}` : fmtUsd(Number(formatUnits(minOut, 6)));
  const buyTaxTokens = side === "buy" ? Number(formatUnits(out - outNet, 18)) : 0;
  const sellTaxTokens = Number(formatUnits(sellTaxAmt, 18));

  const refresh = () => {
    void usdcBal.refetch();
    void tokBal.refetch();
    void qc.invalidateQueries({ queryKey: ["token", token.address] });
    void qc.invalidateQueries({ queryKey: ["trades", token.address] });
    void qc.invalidateQueries({ queryKey: ["candles", token.address] });
    void qc.invalidateQueries({ queryKey: ["holders", token.address] });
    void qc.invalidateQueries({ queryKey: ["activity"] });
    void qc.invalidateQueries({ queryKey: ["tokens"] });
  };

  // Boss 9.11: confirming closes the dialog at once and greys the trade button until the tx settles, so nobody can
  // fire a second order while the first one is still pending in the wallet.
  const confirm = async () => {
    if (!me || !client || busy) return;
    setBusy(true);
    setReview(false);
    logDebug("trade", `${side} ${token.symbol} amountIn=${amountIn} out=${out} minOut=${minOut} slippage=${slippage}`);
    try {
      const tokenIn = side === "buy" ? ADDR.usdc : tokenAddr;
      const allowance = await client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [me, A.router] });
      logDebug("trade", `allowance=${allowance}`);
      if (allowance < amountIn) {
        const rc = await run(t("tx.approving"), { address: tokenIn, abi: erc20Abi, functionName: "approve", args: [A.router, maxUint256] });
        if (!rc) return;
      }
      const label = `${side === "buy" ? t("common.buy") : t("common.sell")} ${token.symbol}`;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const rc = path
        ? await run(label, {
            address: A.router,
            abi: routerAbi,
            functionName: "exactInput",
            args: [{ path, recipient: me, deadline, amountIn, amountOutMinimum: minOut }],
          })
        : await run(label, {
            address: A.router,
            abi: routerAbi,
            functionName: "exactInputSingle",
            args: [{
              tokenIn,
              tokenOut: side === "buy" ? tokenAddr : ADDR.usdc,
              fee: POOL_FEE,
              recipient: me,
              deadline,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            }],
          });
      if (rc) {
        setAmount("");
        setTimeout(refresh, 1500);
      }
    } catch (e) {
      logDebug("trade.error", e);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      <div className="flex items-center gap-2">
        <Tabs value={side} onValueChange={(v) => { setSide(v as Side); setAmount(""); }} className="flex-1">
          <TabsList className="h-10 w-full">
            <TabsTrigger value="buy" className="font-semibold data-active:bg-up! data-active:text-black!">{t("common.buy")}</TabsTrigger>
            <TabsTrigger value="sell" className="font-semibold data-active:bg-down! data-active:text-white!">{t("common.sell")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon-lg" className="size-10" title={t("token.settings")}>
              <Settings2 />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <div className="text-sm font-medium">{t("token.settings")}</div>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("common.slippage")}</span>
              <span className="font-mono">{slippage}%</span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1">
              {[0.5, 1, 2, 5].map((s) => (
                <Button key={s} size="xs" variant={slippage === s ? "default" : "outline"} className="font-mono" onClick={() => setSlippage(s)}>{s}%</Button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{t("token.slippageHint")}</p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("token.youPay")}</span>
          <span className="font-mono tabular">
            {t("common.balance")}: {side === "buy" ? `${fmtNum(Number(formatUnits(usdcBalance, 6)), 2)} USDC` : `${fmtNum(Number(formatUnits(tokenBalance, 18)))} ${token.symbol}`}
          </span>
        </div>
        <div className={cn("flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30", insufficient && amountIn > 0n && "border-down")}>
          <input
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-xl outline-none tabular placeholder:text-muted-foreground"
          />
          <span className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 font-mono text-xs">
            {side === "buy" ? <span className="size-3.5 rounded-full bg-[#2775ca]" /> : <TokenAvatar logo={token.logo} symbol={token.symbol} seed={token.address} size={14} className="rounded-sm" />}
            {side === "buy" ? "USDC" : token.symbol}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {(side === "buy" ? QUICK_USDC : QUICK_PCT).map((q) => (
            <Button
              key={q}
              variant="outline"
              size="xs"
              className="font-mono"
              onClick={() => setAmount(side === "buy" ? String(q) : formatUnits((sellMax * BigInt(q)) / 100n, 18))}
            >
              {side === "buy" ? `$${q}` : `${q}%`}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg bg-muted p-3 text-xs">
        <Row label={side === "buy" && buyTax > 0 ? `${t("token.youReceive")} (${t("tax.afterTax")})` : t("token.youReceive")} value={amountIn > 0n ? (quote.isFetching && !quote.data ? "…" : recvLabel) : "—"} strong />
        <Row label={t("token.minReceived")} value={amountIn > 0n && out > 0n ? minLabel : "—"} />
        <Row label={t("token.priceImpact")} value={amountIn > 0n && out > 0n ? `${impact.toFixed(2)}%` : "—"} className={impactTone(impact)} />
        <Row label={`${t("common.fee")} (1%)`} value={amountIn > 0n ? fmtUsd(fee) : "—"} />
        {side === "buy" && buyTax > 0 && <Row label={`${t("tax.taxLine")} (${buyTax / 100}%)`} value={amountIn > 0n && out > 0n ? `−${fmtNum(buyTaxTokens)} ${token.symbol}` : "—"} className="text-gold" />}
        {side === "sell" && sellTax > 0 && (
          <>
            <Row label={`${t("tax.sellOnTop")} (${sellTax / 100}%)`} value={amountIn > 0n ? `−${fmtNum(sellTaxTokens)} ${token.symbol}` : "—"} className="text-gold" />
            <Row label={t("tax.totalCost")} value={amountIn > 0n ? `${fmtNum(inNum + sellTaxTokens)} ${token.symbol}` : "—"} />
          </>
        )}
        <Row label={t("common.slippage")} value={`${slippage}%`} />
        {quoteAddr && (
          <Row label={t("token.route")} value={side === "buy" ? `USDC → ${token.quoteSymbol} → ${token.symbol}` : `${token.symbol} → ${token.quoteSymbol} → USDC`} />
        )}
        {quote.isError && <div className="text-down">{t("tx.quoteFailed")}</div>}
      </div>

      {quoteAddr && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-primary/10 p-2.5 text-[11px] text-primary">
          <LineChart size={14} className="mt-0.5 shrink-0" />
          <span>{t("token.quoteRouted").replace(/\{q\}/g, token.quoteSymbol ?? "").replace("{f}", String(quoteFee / 10_000))}</span>
        </div>
      )}

      {taxed && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-gold/10 p-2.5 text-[11px] text-gold">
          <Percent size={14} className="mt-0.5 shrink-0" />
          <span>{t("tax.badge").replace("{b}", String(buyTax / 100)).replace("{s}", String(sellTax / 100))} · {t("tax.immutable")}</span>
        </div>
      )}

      {token.protectionActive && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-gold/15 p-2.5 text-[11px] text-gold">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          {t("token.protectionActive")}
        </div>
      )}

      <Button
        size="xl"
        variant={!connected || wrongChain ? "glow" : side === "buy" ? "up" : "down"}
        className="mt-4 w-full"
        onClick={!connected || wrongChain ? toggleConnect : () => setReview(true)}
        disabled={busy || (connected && !wrongChain && (amountIn <= 0n || out <= 0n || insufficient))}
      >
        {busy ? t("tx.confirming") : !connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`) : insufficient && amountIn > 0n ? t("tx.insufficient") : t("token.review")}
      </Button>

      <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Lock size={11} /> {t("token.lpLocked")}</span>
        <span className="inline-flex items-center gap-1"><Info size={11} /> {t("common.finality")}</span>
      </div>

      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("token.review")}</DialogTitle>
            <DialogDescription>
              {side === "buy" ? t("common.buy") : t("common.sell")} {token.symbol} · {t("common.usdcSettled")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="rounded-lg bg-muted p-3">
              <div className="text-[11px] text-muted-foreground">{t("token.youPay")}</div>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-xl font-semibold tabular">{side === "buy" ? fmtUsd(inNum) : fmtNum(inNum)}</span>
                <span className="font-mono text-sm">{side === "buy" ? "USDC" : token.symbol}</span>
              </div>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <div className="text-[11px] text-muted-foreground">{t("token.youReceive")}</div>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-xl font-semibold tabular">{side === "buy" ? fmtNum(outNum) : fmtUsd(outNum)}</span>
                <span className="font-mono text-sm">{side === "buy" ? token.symbol : "USDC"}</span>
              </div>
            </div>
            <Separator className="my-1" />
            <div className="space-y-1.5 text-xs">
              <Row label={t("token.rate")} value={`1 ${token.symbol} = ${fmtUsd(execPrice)}`} />
              <Row label={t("token.minReceived")} value={minLabel} />
              <Row label={t("token.priceImpact")} value={`${impact.toFixed(2)}%`} className={impactTone(impact)} />
              <Row label={`${t("common.fee")} (1%)`} value={fmtUsd(fee)} />
              {side === "buy" && buyTax > 0 && <Row label={`${t("tax.taxLine")} (${buyTax / 100}%)`} value={`−${fmtNum(buyTaxTokens)} ${token.symbol}`} className="text-gold" />}
              {side === "sell" && sellTax > 0 && <Row label={`${t("tax.sellOnTop")} (${sellTax / 100}%)`} value={`−${fmtNum(sellTaxTokens)} ${token.symbol}`} className="text-gold" />}
              <Row label="Gas" value="~$0.01 USDC" />
            </div>
            {impact >= 5 && (
              <div className={cn("flex items-start gap-2 rounded-lg p-2.5 text-[11px]", impact >= 10 ? "bg-down/15 text-down" : "bg-gold/15 text-gold")}>
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {t("token.impactHigh")}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button size="xl" variant={side === "buy" ? "up" : "down"} className="w-full" onClick={confirm} disabled={busy}>
              {busy ? t("tx.confirming") : `${t("token.confirm")} ${side === "buy" ? t("common.buy") : t("common.sell")}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (bare) return <div className={className}>{body}</div>;
  return (
    <Card className={className}>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function Row({ label, value, strong, className }: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular", strong && "font-semibold text-foreground", className)}>{value}</span>
    </div>
  );
}
