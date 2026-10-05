"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { ArrowSquareOut, CircleNotch, Info, Lightning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { fmtNum, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { chainByKey, explorerToken, explorerTx, nativeIcon, publicClientFor, type WalletChain } from "@/lib/wallet/chains";
import { copyText, shareText } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
import { tokenIcon } from "@/lib/wallet/assets";
import { NATIVE, executeKyberSwap, isMarketChain, kyberDexes, kyberImpact, kyberQuote, MarketQuoteError, rememberToken, useMarketCandles, useMarketToken, useMarketTrades, type MarketStep, type MarketToken } from "@/lib/wallet/market";
import { costBasis, logFill, useFills, useStar, useViewers } from "@/lib/wallet/positions";
import { useVault } from "@/components/wallet/wallet-context";
import { AboutCard, CoinChartPanel, CoinFrame, CoinHeader, CoinTabs, CoinTopBar, groupWorthy, HolderRows, MarkerSheet, PositionCard, StatsCard, TradeBar, TradeRows, allInterval, compactUsd, quickAmount, setQuickAmount, usd, useMarkers, type MarkTrade } from "@/components/wallet/coin";
import { BottomSheet, PrimaryButton, TopBar } from "@/components/wallet/ui";

export default function MarketRoute() {
  return (
    <Suspense fallback={<CoinFrame>{null}</CoinFrame>}>
      <MarketRouteInner />
    </Suspense>
  );
}

function MarketRouteInner() {
  const sp = useSearchParams();
  const chain = sp.get("chain") ?? "";
  const address = (sp.get("address") ?? "").toLowerCase();
  if (!isMarketChain(chain) || !/^0x[0-9a-f]{40}$/.test(address)) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title={t("cw.coin.title")} />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{t("cw.market.badAddress")}</div>
      </CoinFrame>
    );
  }
  return <EvmCoin chainKey={chain} address={address} />;
}

/** what a buy keeps back for gas, per chain (native units) */
const GAS_RESERVE: Record<string, string> = { eth: "0.004", base: "0.0003", arb: "0.0003", bsc: "0.002", polygon: "0.5" };
const QUICK: Record<string, string[]> = { eth: ["0.005", "0.01", "0.05", "0.1"], base: ["0.002", "0.005", "0.01", "0.05"], arb: ["0.002", "0.005", "0.01", "0.05"], bsc: ["0.01", "0.05", "0.1", "0.5"], polygon: ["5", "10", "50", "100"] };

function useBalances(chain: WalletChain, token: string, me?: string) {
  return useQuery({
    queryKey: ["wallet", "mkt-balances", chain.key, token, me],
    enabled: !!me,
    refetchInterval: 10_000,
    queryFn: async () => {
      const pc = publicClientFor(chain);
      const addr = token as Address;
      const [native, bal, decimals, supply] = await Promise.all([
        pc.getBalance({ address: me as Address }),
        pc.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [me as Address] }),
        pc.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
        pc.readContract({ address: addr, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
      ]);
      return { native, bal, decimals, supply };
    },
  });
}

function EvmCoin({ chainKey, address }: { chainKey: string; address: string }) {
  const chain = chainByKey(chainKey);
  const { active } = useVault();
  const me = active?.address;
  const tq = useMarketToken(chainKey, address);
  const tk = tq.data;
  const [iv, setIv] = useState("15m");
  const interval = iv === "all" ? allInterval(tk?.pairCreatedAt) : iv;
  const candles = useMarketCandles(chainKey, tk?.pool, interval, address);
  const trades = useMarketTrades(chainKey, tk?.pool, address);
  const bal = useBalances(chain, address, me);
  const fills = useFills(chainKey, address, me);
  const viewers = useViewers(`${chainKey}:${address}`);
  const [starred, toggleStar] = useStar(`${chainKey}:${address}`);
  const [sheet, setSheet] = useState<{ side: "buy" | "sell"; quick?: boolean } | null>(null);

  const chart = candles.data ?? [];
  const markTrades = useMemo<MarkTrade[]>(() => {
    const mine = me?.toLowerCase();
    const feed = (trades.data ?? []).map((x) => ({ id: x.hash, at: x.at, side: x.side, priceUsd: x.priceUsd, usd: x.usd, who: x.trader, mine: x.trader.toLowerCase() === mine, href: explorerTx(chain, x.hash) }));
    const seen = new Set(feed.map((x) => x.id));
    const local = fills.filter((f) => f.hash && !seen.has(f.hash) && f.tokens > 0).map((f) => ({ id: f.hash!, at: f.at, side: f.side, priceUsd: f.usd / f.tokens, usd: f.usd, who: me ?? "me", mine: true, href: explorerTx(chain, f.hash!) }));
    return [...feed, ...local];
  }, [trades.data, fills, me, chain]);
  const mk = useMarkers(chart, markTrades);

  if (!tk) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title={t("cw.coin.title")} />
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[14px] text-muted-foreground">{tq.isError ? (tq.error as Error).message || t("common.loadFailed") : <CircleNotch size={28} className="animate-spin" />}</div>
      </CoinFrame>
    );
  }

  const decimals = bal.data?.decimals ?? 18;
  const amount = bal.data ? Number(formatUnits(bal.data.bal, decimals)) : 0;
  const supply = bal.data?.supply ? Number(formatUnits(bal.data.supply, decimals)) : null;
  const price = tk.priceUsd ?? chart.at(-1)?.close ?? null;
  const basis = costBasis(fills);
  // the log only knows trades made here; if the wallet holds more than that, the cost basis is incomplete
  const knownCost = basis.qty > 0 && amount <= basis.qty * 1.02 ? basis.cost * Math.min(1, amount / basis.qty) : null;
  const share = () => void shareText(`${tk.name} ($${tk.symbol}) · ${chain.name} · https://dexscreener.com/${chainKey === "polygon" ? "polygon" : chainKey === "arb" ? "arbitrum" : chainKey === "eth" ? "ethereum" : chainKey}/${tk.pool}`);

  return (
    <CoinFrame>
      <CoinTopBar
        back="/wallet/token"
        symbol={tk.symbol}
        createdAt={tk.pairCreatedAt}
        viewers={viewers}
        starred={starred}
        onStar={toggleStar}
        onShare={share}
        callout={{ chain: chainKey, address: tk.address, symbol: tk.symbol, name: tk.name, image: tokenIcon(chainKey, tk.address, tk.image) ?? null, priceUsd: tk.priceUsd, mcapUsd: tk.mcapUsd }}
        group={groupWorthy({ mcapUsd: tk.mcapUsd ?? tk.fdvUsd })}
      />
      <div className="flex-1 pb-28">
        <CoinHeader image={tokenIcon(chainKey, tk.address, tk.image)} seed={address} symbol={tk.symbol} name={tk.name} chain={chain} address={address} twitter={tk.socials.twitter} priceUsd={price} change={tk.changes.h24} holders={tk.holders} extra={<span className="truncate text-[12px]">{tk.dex}{tk.dexLabel ? ` ${tk.dexLabel}` : ""} · {tk.symbol}/{tk.quote.symbol}</span>} />
        <CoinChartPanel alertKey={`${chainKey}:${address}`} candles={chart} loading={candles.isLoading} interval={iv} onInterval={setIv} priceUsd={price} avg={knownCost != null && amount > 0 ? knownCost / amount : null} markers={mk.markers} onMarker={mk.onMarker} />
        {me && amount > 0 && price != null && <PositionCard valueUsd={amount * price} costUsd={knownCost} amount={amount} symbol={tk.symbol} supply={supply} avg={knownCost != null ? knownCost / amount : null} onShare={share} />}
        <StatsCard
          changes={[
            { label: t("cw.coin.change5m"), value: tk.changes.m5 },
            { label: t("cw.coin.change1h"), value: tk.changes.h1 },
            { label: t("cw.coin.change6h"), value: tk.changes.h6 },
            { label: t("cw.coin.change24h"), value: tk.changes.h24 },
          ]}
          stats={[
            [t("cw.coin.mcap"), tk.mcapUsd != null ? compactUsd(tk.mcapUsd) : "—"],
            [t("cw.market.liquidity"), tk.liquidityUsd != null ? compactUsd(tk.liquidityUsd) : "—"],
            [t("cw.coin.vol24h"), tk.volume.h24 != null ? compactUsd(tk.volume.h24) : "—"],
            [t("cw.market.txns24h"), tk.txns24h ? `${fmtNum(tk.txns24h.buys)} / ${fmtNum(tk.txns24h.sells)}` : "—"],
          ]}
        />
        <CoinTabs
          tabs={[
            {
              key: "trades",
              label: t("cw.coin.trades"),
              render: () => (
                <TradeRows
                  loading={trades.isLoading}
                  note={trades.isError ? t("cw.market.tradesUnavailable") : undefined}
                  items={(trades.data ?? []).map((x) => ({ id: x.hash + x.at, side: x.side, who: x.trader, mine: x.trader.toLowerCase() === me?.toLowerCase(), amount: fmtNum(x.tokens, 1), value: compactUsd(x.usd), at: x.at, href: explorerTx(chain, x.hash) }))}
                />
              ),
            },
            {
              key: "holders",
              label: t("cw.coin.holders"),
              count: tk.holders ?? undefined,
              render: () => (
                <HolderRows
                  items={[]}
                  summary={[tk.holders != null ? t("cw.coin.holdersN", { n: fmtNum(tk.holders) }) : null, tk.top10Pct != null ? t("cw.coin.top10Pct", { p: tk.top10Pct.toFixed(1) }) : null].filter((s): s is string => !!s)}
                  empty={
                    <p className="py-6 text-center text-[13px] text-muted-foreground">
                      {t("cw.market.holdersUnavailable", { chain: chain.name })}
                      <a href={`${explorerToken(chain, address)}#balances`} target="_blank" rel="noreferrer" className="text-foreground underline">
                        {t("cw.market.viewOnExplorer")}
                      </a>
                    </p>
                  }
                />
              ),
            },
            {
              key: "about",
              label: t("bot.desc"),
              render: () => (
                <AboutCard
                  flat
                  description={tk.description}
                  socials={tk.socials}
                  createdAt={tk.pairCreatedAt ?? undefined}
                  rows={[
                    [
                      t("cw.coin.contract"),
                      <button key="ca" type="button" className="font-mono" onClick={async () => (await copyText(address)) && toast.success(t("cw.coin.caCopied"))}>
                        {shortAddr(address, 6, 6)}
                      </button>,
                    ],
                    [t("cw.market.pool"), `${tk.dex}${tk.dexLabel ? ` ${tk.dexLabel}` : ""} · ${tk.symbol}/${tk.quote.symbol}`],
                    [t("cw.market.totalSupply"), supply ? fmtNum(supply, 0) : "—"],
                    [
                      t("cw.coin.explorer"),
                      <a key="ex" href={explorerToken(chain, address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5">
                        {chain.explorer.replace(/^https:\/\//, "")} <ArrowSquareOut size={12} />
                      </a>,
                    ],
                  ]}
                />
              ),
            },
          ]}
        />
      </div>

      <TradeBar symbol={tk.symbol} onBuy={() => setSheet({ side: "buy" })} onSell={() => setSheet({ side: "sell" })} onQuick={() => setSheet({ side: "buy", quick: true })} sellDisabled={!bal.data || bal.data.bal === 0n} extra={!me && <p className="mb-2 text-center text-[12px] text-muted-foreground">{t("cw.market.unlockToTrade")}</p>} />
      <MarkerSheet trades={mk.open} onClose={mk.close} />
      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && me && (
          <EvmTradeSheet
            key={`${sheet.side}${sheet.quick ? "q" : ""}`}
            chain={chain}
            token={tk}
            side={sheet.side}
            quick={!!sheet.quick}
            onSide={(s) => setSheet({ side: s })}
            native={bal.data?.native ?? 0n}
            tokRaw={bal.data?.bal ?? 0n}
            decimals={decimals}
            onDone={() => setSheet(null)}
          />
        )}
      </BottomSheet>
    </CoinFrame>
  );
}

const SLIPS = [1, 3, 5, 10] as const;
const STEP_LABEL: Record<MarketStep, string> = { approving: "cw.market.stepApproveSell", building: "cw.coin.stepBuilding", swapping: "cw.coin.stepSwapping", confirming: "cw.coin.stepConfirming" };

function EvmTradeSheet({ chain, token, side, quick, onSide, native, tokRaw, decimals, onDone }: { chain: WalletChain; token: MarketToken; side: "buy" | "sell"; quick: boolean; onSide: (s: "buy" | "sell") => void; native: bigint; tokRaw: bigint; decimals: number; onDone: () => void }) {
  const { account, active } = useVault();
  const qc = useQueryClient();
  const buy = side === "buy";
  const nc = chain.chain.nativeCurrency;
  const presets = QUICK[chain.key] ?? QUICK.eth;
  const [amount, setAmount] = useState(buy ? (quick ? quickAmount(chain.key, presets[1]) : presets[1]) : "");
  const [slip, setSlip] = useState<(typeof SLIPS)[number]>(5);
  const [step, setStep] = useState<MarketStep | null>(null);
  const [err, setErr] = useState("");

  let amountIn = 0n;
  try {
    amountIn = amount && Number(amount) > 0 ? parseUnits(amount, buy ? nc.decimals : decimals) : 0n;
  } catch {
    amountIn = 0n;
  }
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 300);
    return () => clearTimeout(id);
  }, [amountIn]);

  const [tin, tout] = buy ? [NATIVE, token.address] : [token.address, NATIVE];
  const q = useQuery({
    queryKey: ["mkt", "quote", chain.key, tin, tout, debounced.toString()],
    enabled: debounced > 0n,
    refetchInterval: 10_000,
    retry: false,
    queryFn: () => kyberQuote(chain.key, tin, tout, debounced),
  });
  const view = q.data && debounced === amountIn ? q.data : null;
  const reserve = parseUnits(GAS_RESERVE[chain.key] ?? "0.001", nc.decimals);
  const insufficient = buy ? amountIn + reserve > native : amountIn > tokRaw;
  const maxBuy = native > reserve ? native - reserve : 0n;

  const outDec = buy ? decimals : nc.decimals;
  const outSym = buy ? token.symbol : nc.symbol;
  const out = view ? BigInt(view.routeSummary.amountOut) : null;
  const minOut = out != null ? (out * BigInt(10_000 - slip * 100)) / 10_000n : null;
  const impact = view ? kyberImpact(view) : null;

  const go = async () => {
    if (!view || !active) return;
    setErr("");
    try {
      if (quick && buy) setQuickAmount(chain.key, amount);
      const hash = await executeKyberSwap(account(), chain, view, slip * 100, setStep);
      const tokens = Number(formatUnits(buy ? BigInt(view.routeSummary.amountOut) : amountIn, decimals));
      const usdValue = Number(buy ? view.routeSummary.amountInUsd : view.routeSummary.amountOutUsd);
      logFill(chain.key, token.address, active.address, { side, tokens, usd: usdValue, at: Date.now(), hash });
      rememberToken(chain.key, { address: token.address, symbol: token.symbol, name: token.name, image: token.image, decimals });
      toast.success(buy ? t("cw.coin.bought", { sym: token.symbol }) : t("cw.coin.sold", { sym: token.symbol }), { action: { label: t("cw.coin.view"), onClick: () => window.open(explorerTx(chain, hash), "_blank") } });
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      void qc.invalidateQueries({ queryKey: ["mkt", chain.key, "trades"] });
      onDone();
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? t("cw.coin.tradeFailed")).split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" disabled={!!step} onClick={() => onSide(s)} className={cn("h-10 rounded-xl text-[15px] font-semibold transition", side === s ? (s === "buy" ? "bg-up text-black shadow" : "bg-down text-white shadow") : "text-muted-foreground")}>
            {s === "buy" ? t("cw.coin.buy") : t("cw.coin.sell")}
          </button>
        ))}
      </div>
      {quick && buy && <p className="mt-2 text-center text-[12px] text-up">⚡ {t("cw.market.quickHint")}</p>}

      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>{buy ? t("cw.coin.pay") : t("cw.coin.sellAmount")}</span>
          <span className="font-mono">{t("cw.coin.balanceValue", { v: buy ? `${Number(formatUnits(native, nc.decimals)).toFixed(4)} ${nc.symbol}` : `${fmtNum(Number(formatUnits(tokRaw, decimals)), 2)} ${token.symbol}` })}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className={cn("w-0 flex-1 bg-transparent font-mono text-[32px] font-semibold tracking-tight outline-none", insufficient && amountIn > 0n && "text-down")} />
          <span className="flex items-center gap-1.5 text-[15px] font-semibold">
            <TokenAvatar symbol={buy ? nc.symbol : token.symbol} seed={buy ? `${chain.key}-native` : token.address} logo={buy ? nativeIcon(chain) : tokenIcon(chain.key, token.address, token.image)} size={22} className="rounded-full" />
            {buy ? nc.symbol : token.symbol}
          </span>
        </div>
        <div className="text-[12px] text-muted-foreground">{view ? `≈ ${usd(Number(view.routeSummary.amountInUsd))}` : " "}</div>
        <div className="mt-3 grid grid-cols-5 gap-2">
          {(buy
            ? [...presets.map((v) => ({ v, l: v })), { v: formatUnits(maxBuy, nc.decimals), l: t("cw.coin.max") }]
            : [10, 25, 50, 75, 100].map((p) => ({ v: formatUnits((tokRaw * BigInt(p)) / 100n, decimals), l: p === 100 ? t("transfer.all") : `${p}%` }))
          ).map(({ v, l }) => (
            <button key={l} type="button" onClick={() => setAmount(v)} className={cn("h-9 rounded-xl text-[13px] font-semibold transition active:scale-95", amount === v ? "bg-foreground text-background" : "bg-card ring-1 ring-border")}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-2 px-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.coin.estOut")}</dt>
          <dd className="font-mono font-semibold">{out != null ? `${fmtNum(Number(formatUnits(out, outDec)), buy ? 2 : 5)} ${outSym}` : q.isFetching ? t("cw.coin.quoting") : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.coin.minOut")}</dt>
          <dd className="font-mono">{minOut != null ? `${fmtNum(Number(formatUnits(minOut, outDec)), buy ? 2 : 5)} ${outSym}` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.market.impactWithFee")}</dt>
          <dd className={cn("font-mono", impact != null && impact > 5 ? "text-down" : "")}>{impact != null ? `${impact.toFixed(2)}%` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.coin.route")}</dt>
          <dd className="truncate pl-4 text-right">{view ? kyberDexes(view) : "—"}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="flex items-center gap-1 text-muted-foreground">
            {t("cw.coin.slippage")}
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
          <dt className="text-muted-foreground">{t("cw.coin.networkFee")}</dt>
          <dd className="font-mono text-[12px] text-muted-foreground">{view?.routeSummary.gasUsd ? `≈ ${usd(Number(view.routeSummary.gasUsd))}` : "—"}{!buy ? ` · ${t("cw.market.sellNeedsApprove")}` : ""}</dd>
        </div>
      </dl>

      {q.isError && <p className="mt-2 text-[12px] text-down">{q.error instanceof MarketQuoteError ? q.error.message : t("cw.coin.quoteFailed")}</p>}
      {err && <p className="mt-2 text-[12px] break-words text-down">{err}</p>}

      {insufficient && amountIn > 0n ? (
        <Link href="/wallet/receive" className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold">
          {buy ? t("cw.coin.lowNativeDeposit", { sym: nc.symbol }) : t("transfer.insufficient")}
        </Link>
      ) : (
        <PrimaryButton tone={buy ? "up" : "down"} className={cn("mt-4", buy && "text-black")} disabled={!view || !!step} onClick={go}>
          <span className="flex items-center justify-center gap-1.5">
            {step ? <CircleNotch size={18} className="animate-spin" /> : <Lightning size={18} weight="fill" />}
            {step ? t(STEP_LABEL[step]) : buy ? t("cw.coin.buySym", { sym: token.symbol }) : t("cw.coin.sellSym", { sym: token.symbol })}
          </span>
        </PrimaryButton>
      )}
      <p className="mt-2 text-center text-[11px] text-muted-foreground">{t("cw.market.kyberNote")}</p>
    </>
  );
}
