"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowLeftRight, CheckCircle2, ExternalLink, Loader2, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { formatUnits, isAddress, parseUnits, type Address, type EIP1193Provider } from "viem";
import { useApp } from "@/components/providers";
import { useSite } from "@/lib/api";
import { erc20Abi } from "@/lib/web3";
import { fmtUsd, shortAddr } from "@/lib/format";
import {
  allowanceOf, balanceOf, dirSides, ensureChain, getQuote, getStatus, LifiError, NATIVE, pendingStore, publicClientFor, tokenPriceUsd,
  walletClientFor, BSC_RECV, type BscRecv, type Direction, type Pending, type Quote,
} from "@/lib/lifi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errMsg } from "@/components/shared";
import { ArcSwap } from "@/components/tools/arc-swap";

type Tool = "swap" | "bridge";

type Step = "switch" | "approve" | "send";

/** Human amount from base units: up to 6 decimals, trailing zeros trimmed. */
function fmtAmt(raw: string | bigint | undefined, decimals: number): string {
  if (raw === undefined) return "…";
  const n = Number(formatUnits(BigInt(raw), decimals));
  if (!Number.isFinite(n)) return "…";
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
}

function parseAmt(s: string, decimals: number): bigint {
  try {
    return s.trim() ? parseUnits(s.trim(), decimals) : 0n;
  } catch {
    return 0n;
  }
}

const fmtEta = (s: number | undefined) => (s === undefined ? "…" : s < 90 ? `~${Math.max(10, Math.round(s / 10) * 10)}s` : `~${Math.round(s / 60)} min`);

/** LI.FI error → user text. 1011 = chain not supported (Arc routes open 9.16), 1002 = no route for this pair/amount. */
function quoteErr(e: unknown, t: (k: "tools.notOpen" | "tools.noRoute") => string): string {
  if (e instanceof LifiError) {
    if (e.code === 1011 || /not supported/i.test(e.message)) return t("tools.notOpen");
    if (e.code === 1002 || /no available quotes/i.test(e.message)) return t("tools.noRoute");
  }
  return errMsg(e);
}

/** Status card for the swap sent last (polls LI.FI every 5s until DONE/FAILED; survives reloads via localStorage). */
function PendingCard({ p }: { p: Pending }) {
  const { t } = useApp();
  const { from, to } = dirSides(p.dir, p.recv);
  const q = useQuery({
    queryKey: ["tools", "status", p.txHash],
    queryFn: () => getStatus({ txHash: p.txHash, fromChain: p.fromChain, toChain: p.toChain, bridge: p.bridge }),
    refetchInterval: (query) => (query.state.data?.status === "DONE" || query.state.data?.status === "FAILED" ? false : 5000),
    retry: false,
  });
  const st = q.data?.status;
  const done = st === "DONE";
  const failed = st === "FAILED";
  const srcLink = q.data?.sending?.txLink ?? `${from.explorer}/tx/${p.txHash}`;
  const dstHash = q.data?.receiving?.txHash;
  const dstLink = q.data?.receiving?.txLink ?? (dstHash ? `${to.explorer}/tx/${dstHash}` : undefined);
  return (
    <Card size="sm" className={done ? "border-up/40" : failed ? "border-down/40" : "border-gold/40"}>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 font-semibold">
            {done ? <CheckCircle2 className="size-4 text-up" /> : failed ? <XCircle className="size-4 text-down" /> : <Loader2 className="size-4 animate-spin text-gold" />}
            {done ? t("tools.pending.done") : t("tools.pending.title")}
          </span>
          <Button variant="ghost" size="sm" onClick={() => pendingStore.set(null)}>{t("tools.pending.clear")}</Button>
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {fmtAmt(p.fromAmount, from.decimals)} {from.symbol} → {to.symbol}
          {q.data?.receiving?.amount && done ? ` · ${fmtAmt(q.data.receiving.amount, to.decimals)} ${to.symbol}` : ""} · {shortAddr(p.toAddress)}
        </div>
        {failed && <div className="text-xs text-down">{q.data?.substatusMessage || t("tools.pending.failed")}</div>}
        {!done && !failed && q.data?.substatusMessage && <div className="text-xs text-muted-foreground">{q.data.substatusMessage}</div>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a href={srcLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{t("tools.pending.src")} <ExternalLink className="size-3" /></a>
          {dstLink && <a href={dstLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{t("tools.pending.dst")} <ExternalLink className="size-3" /></a>}
          <a href={q.data?.lifiExplorerLink ?? `https://scan.li.fi/tx/${p.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{t("tools.pending.explorer")} <ExternalLink className="size-3" /></a>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ToolsPage() {
  const { t } = useApp();
  // `?tab=bridge` deep-links the cross-chain tool; default is the on-chain swap (9.18)
  const [tool, setTool] = useState<Tool>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "bridge" ? "bridge" : "swap"));
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><ArrowLeftRight className="size-5 text-primary" /> {t("tools.page")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tool === "swap" ? t("swap.subtitle") : t("tools.subtitle")}</p>
        </div>
        <Tabs value={tool} onValueChange={(v) => setTool(v as Tool)}>
          <TabsList>
            <TabsTrigger value="swap">{t("tools.tab.swap")}</TabsTrigger>
            <TabsTrigger value="bridge">{t("tools.tab.bridge")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tool === "swap" ? <ArcSwap /> : <Bridge />}
    </div>
  );
}

function Bridge() {
  const { t, connected, address, toggleConnect } = useApp();
  const { connector } = useAccount();
  const qc = useQueryClient();
  const site = useSite();
  const maxUsd = site.data?.swapMaxUsd ?? 10;
  const enabled = site.data?.swapEnabled ?? true;

  const [dir, setDir] = useState<Direction>("bnb2usdc");
  const [recv, setRecv] = useState<BscRecv>("BNB");
  const [amount, setAmount] = useState("");
  const [recipientInput, setRecipientInput] = useState<string | null>(null); // null = follow the connected wallet
  const [step, setStep] = useState<Step | null>(null);
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.get, pendingStore.getServer);

  const { from, to } = dirSides(dir, recv);
  const recipient = recipientInput ?? address ?? "";
  const recipientOk = isAddress(recipient);
  const amountWei = parseAmt(amount, from.decimals);
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountWei), 450);
    return () => clearTimeout(id);
  }, [amountWei]);

  const balQ = useQuery({ queryKey: ["tools", "bal", from.chain.id, from.token, address], queryFn: () => balanceOf(from, address as Address), enabled: !!address, refetchInterval: 12_000 });
  const priceQ = useQuery({ queryKey: ["tools", "price", from.chain.id, from.token], queryFn: () => tokenPriceUsd(from), staleTime: 60_000 });
  const quoteQ = useQuery({
    queryKey: ["tools", "quote", dir, recv, debounced.toString(), address, recipient],
    queryFn: () => getQuote({ dir, recv, fromAmount: debounced, fromAddress: address as Address, toAddress: recipient as Address }),
    enabled: enabled && !!address && debounced > 0n && recipientOk && !step,
    refetchInterval: step ? false : 30_000,
    retry: false,
    staleTime: 20_000,
  });
  const quote = debounced === amountWei ? quoteQ.data : undefined;

  const amountNum = Number(formatUnits(amountWei, from.decimals));
  const usdIn = Number(quote?.estimate.fromAmountUSD) || (priceQ.data ? amountNum * priceQ.data : NaN);
  const overCap = Number.isFinite(usdIn) && usdIn > maxUsd * 1.005; // 0.5% grace for price wobble between hint and quote
  const insufficient = balQ.data !== undefined && amountWei > balQ.data;
  const maxIn = priceQ.data ? maxUsd / priceQ.data : undefined;
  // LI.FI fee + relayer fees; "included" ones are already deducted from toAmount, still worth showing
  const feesUsd = (quote?.estimate.feeCosts ?? []).reduce((s, f) => s + (Number(f.amountUSD) || 0), 0);
  const gasUsd = (quote?.estimate.gasCosts ?? []).reduce((s, g) => s + (Number(g.amountUSD) || 0), 0);

  const setMax = () => {
    const bal = balQ.data;
    if (bal === undefined) return;
    let v = Number(formatUnits(bal, from.decimals));
    if (maxIn !== undefined) v = Math.min(v, maxIn * 0.995);
    if (from.token === NATIVE) v = Math.max(0, v - 0.0005); // leave gas on BSC
    setAmount(v > 0 ? v.toFixed(from.decimals === 6 ? 2 : 5).replace(/\.?0+$/, "") : "");
  };

  const run = async () => {
    if (!address || !connector || !quote) return;
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      setStep("switch");
      await ensureChain(provider, from);
      const wc = walletClientFor(provider, from, address);
      const pc = publicClientFor(from);
      // fresh quote right before signing (routes/prices move; the displayed one may be up to 30s old)
      const q: Quote = await getQuote({ dir, recv, fromAmount: amountWei, fromAddress: address, toAddress: recipient as Address });
      const usd = Number(q.estimate.fromAmountUSD);
      if (Number.isFinite(usd) && usd > maxUsd * 1.005) throw new Error(t("tools.overCap").replace("{n}", String(maxUsd)));
      if (!q.transactionRequest) throw new Error(t("tools.noRoute"));
      if (from.token !== NATIVE && q.estimate.approvalAddress) {
        const have = await allowanceOf(from, address, q.estimate.approvalAddress);
        if (have < amountWei) {
          setStep("approve");
          const h = await wc.writeContract({ address: from.token, abi: erc20Abi, functionName: "approve", args: [q.estimate.approvalAddress, amountWei] });
          await pc.waitForTransactionReceipt({ hash: h });
        }
      }
      setStep("send");
      const tx = q.transactionRequest;
      const hash = await wc.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined });
      pendingStore.set({ txHash: hash, dir, recv, fromChain: from.chain.id, toChain: to.chain.id, bridge: q.tool, fromAmount: amountWei.toString(), toAddress: recipient as Address });
      setAmount("");
      toast.success(t("tools.step.wait").replace("{tool}", q.toolDetails?.name ?? q.tool));
      void qc.invalidateQueries({ queryKey: ["tools", "bal"] });
    } catch (e) {
      toast.error(quoteErr(e, t));
    } finally {
      setStep(null);
    }
  };

  const blocker = !enabled ? t("tools.disabled") : !recipientOk && recipient ? t("tools.badRecipient") : overCap ? t("tools.overCap").replace("{n}", String(maxUsd)) : insufficient ? t("tools.insufficient") : null;
  const quoteError = quoteQ.isError && debounced === amountWei ? quoteErr(quoteQ.error, t) : null;
  const canSwap = connected && !!quote?.transactionRequest && !blocker && !step && amountWei > 0n && recipientOk;
  const stepLabel = step === "switch" ? t("tools.step.switch").replace("{chain}", from.chain.name) : step === "approve" ? t("tools.step.approve").replace("{sym}", from.symbol) : step === "send" ? t("tools.step.send") : null;

  // BSC-side asset picker; sits in the pay box (BSC → Arc) or the receive box (Arc → BSC)
  const tokenPicker = (
    <span className="inline-flex gap-1">
      {BSC_RECV.map((r) => (
        <button key={r} type="button" disabled={!!step} onClick={() => { setRecv(r); if (dir === "bnb2usdc") setAmount(""); }} className={`rounded-md px-2 py-0.5 font-mono ${recv === r ? "bg-foreground text-background" : "bg-background hover:text-foreground"}`}>{r}</button>
      ))}
    </span>
  );

  return (
    <div className="space-y-4">
      {pending && <PendingCard p={pending} />}

      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <Tabs value={dir} onValueChange={(v) => { setDir(v as Direction); setAmount(""); }}>
              <TabsList>
                <TabsTrigger value="bnb2usdc">{t("tools.dir.bnb2usdc")}</TabsTrigger>
                <TabsTrigger value="usdc2bnb">{t("tools.dir.usdc2bsc")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Badge variant="gold" className="font-mono">{t("tools.cap")} {fmtUsd(maxUsd)}</Badge>
          </div>

          {/* pay */}
          <div className="rounded-xl border bg-muted/40 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("tools.pay")} · {from.chain.name}</span>
              <span className="inline-flex items-center gap-2">
                {dir === "bnb2usdc" && tokenPicker}
                {connected && (
                  <button type="button" className="font-mono hover:text-foreground" onClick={setMax}>
                    {t("tools.balance")} {fmtAmt(balQ.data, from.decimals)} · {t("tools.max")}
                  </button>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} disabled={!!step} className="h-11 border-0 bg-transparent px-0 font-mono text-2xl shadow-none focus-visible:ring-0" />
              <span className="shrink-0 rounded-md bg-background px-2.5 py-1 font-mono text-sm font-semibold">{from.symbol}</span>
            </div>
            <div className="mt-1 flex justify-between font-mono text-xs text-muted-foreground">
              <span>{Number.isFinite(usdIn) && amountWei > 0n ? `≈ ${fmtUsd(usdIn)}` : ""}</span>
              <span>{maxIn !== undefined ? `${t("tools.max")} ≈ ${maxIn.toLocaleString("en-US", { maximumFractionDigits: from.decimals === 6 ? 2 : 5 })} ${from.symbol}` : ""}</span>
            </div>
          </div>

          <div className="flex justify-center -my-1"><ArrowDown className="size-4 text-muted-foreground" /></div>

          {/* receive */}
          <div className="rounded-xl border bg-muted/40 p-3">
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("tools.receive")} · {to.chain.name}</span>
              {dir === "usdc2bnb" && tokenPicker}
            </div>
            <div className="flex items-center gap-2">
              <span className="h-11 flex-1 font-mono text-2xl leading-[2.75rem]">
                {quoteQ.isFetching && !quote ? <span className="text-base text-muted-foreground">{t("tools.quoting")}</span> : quote ? fmtAmt(quote.estimate.toAmount, to.decimals) : "0.0"}
              </span>
              <span className="shrink-0 rounded-md bg-background px-2.5 py-1 font-mono text-sm font-semibold">{to.symbol}</span>
            </div>
            {quote && (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>{t("tools.minReceive")}</dt><dd className="text-right font-mono">{fmtAmt(quote.estimate.toAmountMin, to.decimals)} {to.symbol}</dd>
                <dt>{t("tools.fees")}</dt><dd className="text-right font-mono">{fmtUsd(feesUsd)}</dd>
                <dt>{t("tools.gas")}</dt><dd className="text-right font-mono">{fmtUsd(gasUsd)}</dd>
                <dt>{t("tools.eta")}</dt><dd className="text-right font-mono">{fmtEta(quote.estimate.executionDuration)}</dd>
                <dt>{t("tools.route")}</dt><dd className="text-right font-mono">{quote.toolDetails?.name ?? quote.tool}</dd>
              </dl>
            )}
            {quoteError && (
              <div className="mt-2 text-xs text-down">
                {quoteError}
                {dir === "usdc2bnb" && recv === "BNB" && quoteError === t("tools.noRoute") && <span className="block text-muted-foreground">{t("tools.tryStable")}</span>}
              </div>
            )}
          </div>

          {/* recipient */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">{t("tools.recipient")}</div>
            <Input value={recipient} onChange={(e) => setRecipientInput(e.target.value.trim())} placeholder="0x…" spellCheck={false} disabled={!!step} className={`font-mono text-sm ${recipient && !recipientOk ? "border-down" : ""}`} />
            <div className="mt-1 text-[11px] text-muted-foreground">{t("tools.recipientHint")}</div>
          </div>

          <Button size="xl" variant={!connected ? "glow" : canSwap ? "glow" : "outline"} className="w-full" disabled={connected && !canSwap} onClick={!connected ? toggleConnect : () => void run()}>
            {!connected ? <><Wallet /> {t("common.connect")}</> : stepLabel ? <><Loader2 className="animate-spin" /> {stepLabel}</> : blocker ?? (amountWei > 0n && !quote && quoteQ.isFetching ? t("tools.quoting") : t("tools.swap"))}
          </Button>

          <div className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <p className="flex gap-1.5"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-up" /> {t("tools.disclaimer")}</p>
            <p>{t("tools.gasHint")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
