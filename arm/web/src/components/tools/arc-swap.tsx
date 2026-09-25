"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownUp, ChevronDown, Flame, Loader2, Search, Settings2, Wallet } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useReadContract } from "wagmi";
import { encodePacked, formatUnits, isAddress, maxUint256, parseUnits, type Address, type Hex } from "viem";
import { useTokens } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR, FEE_TIERS, NET, erc20Abi, isLegacyFactory, quoterAbi, routerAbi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { logDebug } from "@/lib/debuglog";
import { useApp } from "@/components/providers";
import { TokenAvatar } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Arc on-chain swap: any ERC-20 ⇄ any ERC-20 through the official Uniswap V3 (same router / quoter our gen2 launches use).
 * Routing is done client-side: probe every fee tier for a direct pool, and — when neither side is USDC — the two-hop
 * path via USDC; the best quote wins. Nothing is custodied and no extra fee is charged; only the pool fee applies.
 */

export type SwapToken = { address: Address; symbol: string; decimals: number; logo?: string; tag?: "usdc" | "hot" | "ark" };

const USDC_TOKEN: SwapToken = { address: ADDR.usdc, symbol: "USDC", decimals: 6, tag: "usdc" };
/** Curated non-Arm tokens shown in the picker. Empty by the boss's call (9.18) — competitors' tokens are not listed;
 *  anyone can still paste an address. Add `{ address, symbol, decimals: 18, tag: "hot" }` here to feature one. */
const HOT_TOKENS: SwapToken[] = [];

type Route =
  | { kind: "direct"; fee: number; out: bigint }
  | { kind: "hop"; feeIn: number; feeOut: number; out: bigint };

const fmtAmt = (raw: bigint, decimals: number) => {
  const n = Number(formatUnits(raw, decimals));
  return n >= 1 ? fmtNum(n, n < 1000 ? 4 : 2) : n.toLocaleString("en-US", { maximumFractionDigits: 8 });
};
const feeLabel = (fee: number) => `${fee / 10_000}%`;

export function ArcSwap() {
  const { t, connected, address, wrongChain, toggleConnect } = useApp();
  const { run } = useTx();
  const client = usePublicClient();
  const qc = useQueryClient();
  const me = address as Address | undefined;

  const [tokenIn, setTokenIn] = useState<SwapToken>(USDC_TOKEN);
  const [tokenOut, setTokenOut] = useState<SwapToken | null>(null);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(2);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const [busy, setBusy] = useState(false);

  const balIn = useReadContract({ address: tokenIn.address, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me, refetchInterval: 8000 } });
  const balOut = useReadContract({ address: tokenOut?.address, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me && !!tokenOut, refetchInterval: 8000 } });

  const amountIn = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount, tokenIn.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, tokenIn.decimals]);
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 300);
    return () => clearTimeout(id);
  }, [amountIn]);

  const same = !!tokenOut && tokenOut.address.toLowerCase() === tokenIn.address.toLowerCase();

  const route = useQuery({
    queryKey: ["arcswap", "route", tokenIn.address, tokenOut?.address, debounced.toString()],
    enabled: !!client && !!tokenOut && !same && debounced > 0n,
    refetchInterval: 10_000,
    retry: false,
    queryFn: async (): Promise<Route> => {
      const out = tokenOut!.address;
      const single = async (a: Address, b: Address, amt: bigint, fee: number) => {
        try {
          const { result } = await client!.simulateContract({ address: ADDR.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: a, tokenOut: b, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] });
          return result[0] as bigint;
        } catch {
          return 0n;
        }
      };
      const best = async (a: Address, b: Address, amt: bigint) => {
        const outs = await Promise.all(FEE_TIERS.map((fee) => single(a, b, amt, fee)));
        let i = -1;
        outs.forEach((o, k) => { if (o > 0n && (i < 0 || o > outs[i])) i = k; });
        return i < 0 ? null : { fee: FEE_TIERS[i], out: outs[i] };
      };
      const candidates: Route[] = [];
      const direct = await best(tokenIn.address, out, debounced);
      if (direct) candidates.push({ kind: "direct", ...direct });
      const usdc = ADDR.usdc.toLowerCase();
      if (tokenIn.address.toLowerCase() !== usdc && out.toLowerCase() !== usdc) {
        const leg1 = await best(tokenIn.address, ADDR.usdc, debounced);
        if (leg1) {
          const leg2 = await best(ADDR.usdc, out, leg1.out);
          if (leg2) candidates.push({ kind: "hop", feeIn: leg1.fee, feeOut: leg2.fee, out: leg2.out });
        }
      }
      if (!candidates.length) throw new Error("no-route");
      return candidates.reduce((a, b) => (b.out > a.out ? b : a));
    },
  });

  const out = route.data?.out ?? 0n;
  const minOut = out - (out * BigInt(Math.round(slippage * 100))) / 10_000n;
  const insufficient = balIn.data !== undefined && amountIn > balIn.data;
  const outNum = tokenOut ? Number(formatUnits(out, tokenOut.decimals)) : 0;
  const inNum = Number(formatUnits(amountIn, tokenIn.decimals));
  const rate = inNum > 0 && outNum > 0 ? outNum / inNum : 0;

  const flip = () => {
    if (!tokenOut) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmount("");
  };
  const pick = (tok: SwapToken) => {
    if (picking === "in") {
      if (tokenOut && tok.address.toLowerCase() === tokenOut.address.toLowerCase()) setTokenOut(tokenIn);
      setTokenIn(tok);
    } else if (picking === "out") {
      if (tok.address.toLowerCase() === tokenIn.address.toLowerCase()) setTokenIn(tokenOut ?? USDC_TOKEN);
      setTokenOut(tok);
    }
    setPicking(null);
    setAmount("");
  };

  const confirm = async () => {
    if (!me || !client || !tokenOut || !route.data || busy) return;
    setBusy(true);
    const r = route.data;
    logDebug("arcswap", `${tokenIn.symbol}→${tokenOut.symbol} in=${amountIn} out=${out} min=${minOut} route=${JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    try {
      const allowance = await client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: "allowance", args: [me, ADDR.router] });
      if (allowance < amountIn) {
        const rc = await run(t("tx.approving"), { address: tokenIn.address, abi: erc20Abi, functionName: "approve", args: [ADDR.router, maxUint256] });
        if (!rc) return;
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const label = `${tokenIn.symbol} → ${tokenOut.symbol}`;
      const rc = r.kind === "direct"
        ? await run(label, { address: ADDR.router, abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: r.fee, recipient: me, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] })
        : await run(label, { address: ADDR.router, abi: routerAbi, functionName: "exactInput", args: [{ path: encodePacked(["address", "uint24", "address", "uint24", "address"], [tokenIn.address, r.feeIn, ADDR.usdc, r.feeOut, tokenOut.address]) as Hex, recipient: me, deadline, amountIn, amountOutMinimum: minOut }] });
      if (rc) {
        setAmount("");
        setTimeout(() => {
          void balIn.refetch();
          void balOut.refetch();
          void qc.invalidateQueries({ queryKey: ["tokens"] });
        }, 1500);
      }
    } catch (e) {
      logDebug("arcswap.error", e);
    } finally {
      setBusy(false);
    }
  };

  const noRoute = route.isError && debounced === amountIn;
  const canSwap = connected && !wrongChain && !!tokenOut && !same && amountIn > 0n && out > 0n && !insufficient && !busy;
  const cta = busy ? t("tx.confirming") : !connected ? t("common.connect") : wrongChain ? t(`wallet.switch.${NET}`) : !tokenOut ? t("swap.pickToken") : same ? t("swap.same") : insufficient && amountIn > 0n ? t("tools.insufficient") : noRoute ? t("tools.noRoute") : t("swap.cta");

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{t("swap.hint")}</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon-sm" title={t("token.settings")}><Settings2 /></Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="flex items-center justify-between text-xs">
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

        {/* pay */}
        <div className={cn("rounded-xl border bg-muted/40 p-3", insufficient && amountIn > 0n && "border-down")}>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("tools.pay")}</span>
            {connected && balIn.data !== undefined && (
              <button type="button" className="font-mono hover:text-foreground" onClick={() => setAmount(formatUnits(balIn.data!, tokenIn.decimals))}>
                {t("tools.balance")} {fmtAmt(balIn.data, tokenIn.decimals)} · {t("tools.max")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} disabled={busy} className="h-11 border-0 bg-transparent px-0 font-mono text-2xl shadow-none focus-visible:ring-0" />
            <TokenButton tok={tokenIn} onClick={() => setPicking("in")} />
          </div>
        </div>

        <div className="-my-1 flex justify-center">
          <Button variant="outline" size="icon-sm" className="rounded-full" onClick={flip} disabled={!tokenOut || busy} title={t("swap.flip")}><ArrowDownUp /></Button>
        </div>

        {/* receive */}
        <div className="rounded-xl border bg-muted/40 p-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("tools.receive")}</span>
            {connected && tokenOut && balOut.data !== undefined && <span className="font-mono">{t("tools.balance")} {fmtAmt(balOut.data, tokenOut.decimals)}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="h-11 flex-1 font-mono text-2xl leading-[2.75rem]">
              {amountIn > 0n && route.isFetching && !route.data ? <span className="text-base text-muted-foreground">{t("tools.quoting")}</span> : out > 0n && tokenOut ? fmtAmt(out, tokenOut.decimals) : "0.0"}
            </span>
            {tokenOut ? <TokenButton tok={tokenOut} onClick={() => setPicking("out")} /> : (
              <Button variant="glow" size="sm" onClick={() => setPicking("out")}>{t("swap.pickToken")} <ChevronDown /></Button>
            )}
          </div>
          {out > 0n && tokenOut && route.data && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>{t("token.rate")}</dt><dd className="text-right font-mono">1 {tokenIn.symbol} ≈ {fmtNum(rate, rate < 1 ? 8 : 4)} {tokenOut.symbol}</dd>
              <dt>{t("tools.minReceive")}</dt><dd className="text-right font-mono">{fmtAmt(minOut, tokenOut.decimals)} {tokenOut.symbol}</dd>
              <dt>{t("tools.route")}</dt>
              <dd className="text-right font-mono">
                {route.data.kind === "direct" ? `${tokenIn.symbol} → ${tokenOut.symbol} (${feeLabel(route.data.fee)})` : `${tokenIn.symbol} → USDC → ${tokenOut.symbol} (${feeLabel(route.data.feeIn)} / ${feeLabel(route.data.feeOut)})`}
              </dd>
              <dt>{t("common.slippage")}</dt><dd className="text-right font-mono">{slippage}%</dd>
            </dl>
          )}
          {noRoute && <div className="mt-2 text-xs text-down">{t("swap.noPool")}</div>}
        </div>

        <Button size="xl" variant={!connected || wrongChain ? "glow" : canSwap ? "glow" : "outline"} className="w-full" disabled={connected && !wrongChain && !canSwap} onClick={!connected || wrongChain ? toggleConnect : () => void confirm()}>
          {busy ? <Loader2 className="animate-spin" /> : !connected ? <Wallet /> : null} {cta}
        </Button>

        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("swap.disclaimer")}</p>
      </CardContent>

      <TokenPicker open={picking !== null} onClose={() => setPicking(null)} onPick={pick} />
    </Card>
  );
}

function TokenButton({ tok, onClick }: { tok: SwapToken; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-background px-2 py-1 font-mono text-sm font-semibold hover:bg-accent">
      {tok.tag === "usdc" ? <span className="size-4 rounded-full bg-[#2775ca]" /> : <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={16} className="rounded-sm" />}
      {tok.symbol}
      <ChevronDown className="size-3.5 text-muted-foreground" />
    </button>
  );
}

/** USDC · hot Arc tokens · our gen2 launches (by 24h volume) · any pasted ERC-20 address (symbol / decimals read on-chain). */
function TokenPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (t: SwapToken) => void }) {
  const { t } = useApp();
  const client = usePublicClient();
  const [q, setQ] = useState("");
  const ours = useTokens("volume24h", "all", "24h", 60);
  const list = useMemo<SwapToken[]>(() => {
    const mine = (ours.data ?? []).filter((x) => !x.hidden && !isLegacyFactory(x.factory)).map<SwapToken>((x) => ({ address: x.address as Address, symbol: x.symbol, decimals: 18, logo: x.logo, tag: "ark" }));
    return [USDC_TOKEN, ...HOT_TOKENS, ...mine];
  }, [ours.data]);
  const needle = q.trim().toLowerCase();
  const pasted = isAddress(q.trim()) && !list.some((x) => x.address.toLowerCase() === needle);
  const custom = useQuery({
    queryKey: ["arcswap", "meta", needle],
    enabled: pasted && !!client,
    retry: false,
    queryFn: async (): Promise<SwapToken> => {
      const a = q.trim() as Address;
      const [symbol, decimals] = await Promise.all([
        client!.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }),
        client!.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { address: a, symbol, decimals };
    },
  });
  const shown = needle ? list.filter((x) => x.symbol.toLowerCase().includes(needle) || x.address.toLowerCase() === needle) : list;

  const close = () => { setQ(""); onClose(); };
  const pickAndClose = (tok: SwapToken) => { setQ(""); onPick(tok); };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("swap.pickToken")}</DialogTitle></DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("swap.search")} spellCheck={false} className="pl-8 font-mono text-sm" autoFocus />
        </div>
        <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
          {pasted && (
            custom.isLoading ? <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("swap.reading")}</div>
            : custom.data ? <Row tok={custom.data} onPick={pickAndClose} />
            : <div className="px-2 py-3 text-sm text-down">{t("swap.notErc20")}</div>
          )}
          {shown.map((tok) => <Row key={tok.address} tok={tok} onPick={pickAndClose} />)}
          {!shown.length && !pasted && <div className="px-2 py-6 text-center text-sm text-muted-foreground">{t("swap.pasteHint")}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ tok, onPick }: { tok: SwapToken; onPick: (t: SwapToken) => void }) {
  const { t } = useApp();
  return (
    <button type="button" onClick={() => onPick(tok)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent">
      {tok.tag === "usdc" ? <span className="size-7 rounded-full bg-[#2775ca]" /> : <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={28} className="rounded-md" />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-semibold">
          {tok.symbol}
          {tok.tag === "hot" && <Badge variant="gold" className="h-4 gap-0.5 px-1 text-[10px]"><Flame className="size-2.5" /> {t("swap.hot")}</Badge>}
          {tok.tag === "ark" && <Badge variant="outline" className="h-4 px-1 text-[10px]">Arm</Badge>}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{tok.address}</span>
      </span>
    </button>
  );
}
