"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import { ArrowSquareOut, CircleNotch, Info, Lightning } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { Candle as ChartCandle } from "@/components/token/price-chart";
import { TokenAvatar } from "@/components/shared";
import { fmtNum, shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SOL_CHAIN, explorerAddr, explorerToken, explorerTx, rpcOf, useNodes } from "@/lib/wallet/chains";
import { SOL_LOGO, iconUrl, useAssets } from "@/lib/wallet/assets";
import { copyText, shareText } from "@/lib/wallet/native";
import { LAMPORTS, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_RENT, WSOL_MINT, isSolAddress } from "@/lib/wallet/sol";
import {
  PUMP_DECIMALS,
  QuoteError,
  changeOver,
  executeSolSwap,
  jupQuote,
  postSolComment,
  routeLabel,
  useSolComments,
  usePumpCandles,
  usePumpCoin,
  usePumpHolders,
  usePumpTrades,
  type PumpCoin,
  type SolSwapStep,
} from "@/lib/wallet/pump";
import { useVault } from "@/components/wallet/wallet-context";
import { costBasis, useStar, useViewers } from "@/lib/wallet/positions";
import { AboutCard, CoinChartPanel, CoinFrame, CoinHeader, CoinTabs, CoinTopBar, CommentBox, CurveCard, HolderRows, KingBadge, MarkerSheet, PositionCard, StatsCard, TradeBar, TradeRows, allInterval, compactUsd, quickAmount, setQuickAmount, usd, useMarkers, type MarkTrade } from "@/components/wallet/coin";
import { BottomSheet, PrimaryButton, TopBar } from "@/components/wallet/ui";

export default function CoinRoute() {
  return (
    <Suspense fallback={<CoinFrame>{null}</CoinFrame>}>
      <CoinRouteInner />
    </Suspense>
  );
}

function CoinRouteInner() {
  const mint = useSearchParams().get("mint") ?? "";
  if (!isSolAddress(mint)) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title="代币" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">代币地址不对</div>
      </CoinFrame>
    );
  }
  return <SolCoin mint={mint} />;
}

const VENUE: Record<PumpCoin["venue"], string> = { curve: "pump 曲线", pumpswap: "PumpSwap", raydium: "Raydium" };
const PUMP_SUPPLY = 1e9;

function SolCoin({ mint }: { mint: string }) {
  const { active, solKeypair } = useVault();
  const me = active?.sol;
  const qc = useQueryClient();
  const cq = usePumpCoin(mint);
  const coin = cq.data;
  const [iv, setIv] = useState("5m");
  const interval = iv === "all" ? allInterval(coin?.createdAt) : iv;
  const day = usePumpCandles(mint, "5m", 300);
  const candles = usePumpCandles(mint, interval, 300);
  const trades = usePumpTrades(mint);
  const mine = usePumpTrades(mint, !!me, me);
  const dev = usePumpTrades(mint, !!coin?.creator, coin?.creator);
  const holders = usePumpHolders(mint);
  const comments = useSolComments(mint);
  const { assets } = useAssets(SOL_CHAIN, me);
  const viewers = useViewers(`sol:${mint}`);
  const [starred, toggleStar] = useStar(`sol:${mint}`);
  const sol = assets.find((a) => a.id === "native");
  const held = assets.find((a) => a.mint === mint);
  const [sheet, setSheet] = useState<{ side: "buy" | "sell"; quick?: boolean } | null>(null);
  const chart = useMemo<ChartCandle[]>(() => candles.data ?? [], [candles.data]);
  const changes = useMemo(() => {
    const c = day.data ?? [];
    return [
      { label: "5分钟", value: changeOver(c, 300) },
      { label: "1小时", value: changeOver(c, 3600) },
      { label: "6小时", value: changeOver(c, 6 * 3600) },
      { label: "24小时", value: changeOver(c, 86_400) },
    ];
  }, [day.data]);
  const top10 = useMemo(() => new Set((holders.data ?? []).filter((h) => !h.isPool).slice(0, 10).map((h) => h.address)), [holders.data]);
  const markTrades = useMemo<MarkTrade[]>(() => {
    const all = new Map<string, MarkTrade>();
    for (const t of [...(trades.data ?? []), ...(dev.data ?? []), ...(mine.data ?? [])]) {
      all.set(t.sig, {
        id: t.sig,
        at: t.at,
        side: t.side,
        priceUsd: t.priceUsd,
        usd: t.usd,
        who: t.trader,
        mine: t.trader === me,
        tag: t.trader === coin?.creator ? "创建者" : top10.has(t.trader) ? "前十持有人" : undefined,
        href: explorerTx(SOL_CHAIN, t.sig),
      });
    }
    return [...all.values()];
  }, [trades.data, dev.data, mine.data, me, coin?.creator, top10]);
  const mk = useMarkers(chart, markTrades);
  const basis = useMemo(() => costBasis((mine.data ?? []).map((t) => ({ side: t.side, tokens: t.tokens, usd: t.usd, at: t.at }))), [mine.data]);

  if (!coin) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title="代币" />
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[14px] text-muted-foreground">{cq.isError ? (cq.error as Error).message || "加载失败" : <CircleNotch size={28} className="animate-spin" />}</div>
      </CoinFrame>
    );
  }

  const tokAmount = held?.amount ?? 0;
  const posValue = tokAmount * coin.priceUsd;
  // full history from pump, so the cost basis is exact unless tokens came in by transfer
  const cost = basis.qty > 0 ? basis.cost * Math.min(1, tokAmount / basis.qty) : null;
  const avg = cost != null && tokAmount > 0 ? cost / tokAmount : null;
  const share = () => void shareText(`${coin.name} ($${coin.symbol}) · https://pump.fun/coin/${mint}`);
  const lines = coin.complete
    ? [`已从联合曲线毕业，现在在 ${VENUE[coin.venue]} 交易，买卖经 Jupiter 聚合路由。`]
    : [
        `曲线里已有 ${coin.solInCurve.toFixed(2)} SOL${coin.toGraduateUsd != null ? `，再买入约 ${compactUsd(coin.toGraduateUsd)} 就毕业` : ""}。`,
        "毕业时剩余代币和曲线里的 SOL 会注入 PumpSwap 池子。",
      ];
  const hs = coin.holders;
  const summary = [
    hs ? `持有人 ${fmtNum(hs.total)}` : null,
    hs?.top10Pct != null ? `前十 ${hs.top10Pct.toFixed(1)}%` : null,
    hs?.devPct != null ? `创建者 ${hs.devPct.toFixed(2)}%` : null,
    hs?.snipersPct ? `狙击 ${hs.snipersPct.toFixed(1)}%` : null,
  ].filter((s): s is string => !!s);

  return (
    <CoinFrame>
      <CoinTopBar
        back="/wallet/token"
        symbol={coin.symbol}
        createdAt={coin.createdAt}
        viewers={viewers}
        starred={starred}
        onStar={toggleStar}
        onShare={share}
        callout={{ chain: "sol", address: mint, symbol: coin.symbol, name: coin.name, image: iconUrl(coin.image) ?? null, priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd }}
      />

      <div className="flex-1 pb-28">
        <CoinHeader
          image={coin.image}
          seed={mint}
          symbol={coin.symbol}
          name={coin.name}
          chain={SOL_CHAIN}
          address={mint}
          twitter={coin.socials.twitter}
          priceUsd={coin.priceUsd}
          change={changes[3].value ?? changes[2].value}
          holders={hs?.total}
          extra={coin.live ? <span className="shrink-0 rounded-full bg-down/12 px-2.5 py-1 text-[11px] font-semibold text-down">● 直播中</span> : !coin.complete && coin.kingAt ? <KingBadge /> : <span className="shrink-0 text-[12px]">{coin.complete ? `已毕业 · ${VENUE[coin.venue]}` : `曲线 ${coin.progress.toFixed(1)}%`}</span>}
        />
        <CoinChartPanel alertKey={`sol:${mint}`} candles={chart} loading={candles.isLoading} interval={iv} onInterval={setIv} priceUsd={coin.priceUsd} avg={avg} markers={mk.markers} onMarker={mk.onMarker} />
        {me && tokAmount > 0 && <PositionCard valueUsd={posValue} costUsd={cost} amount={tokAmount} symbol={coin.symbol} supply={PUMP_SUPPLY} avg={avg} onShare={share} />}
        <StatsCard
          changes={changes}
          stats={[
            ["市值", compactUsd(coin.mcapUsd)],
            ["历史最高", coin.athMcapUsd ? compactUsd(Math.max(coin.athMcapUsd, coin.mcapUsd)) : "—"],
            ["前十持有", hs?.top10Pct != null ? `${hs.top10Pct.toFixed(1)}%` : "—"],
            ["创建者持有", hs?.devPct != null ? `${hs.devPct.toFixed(2)}%` : "—"],
          ]}
        />
        <CurveCard progress={coin.progress} complete={coin.complete} venue={VENUE[coin.venue]} lines={lines} />

        <CoinTabs
          tabs={[
            {
              key: "thread",
              label: "讨论",
              count: comments.data?.length,
              render: () => (
                <CommentBox
                  items={(comments.data ?? []).map((c) => ({ id: c.id, author: c.author, text: c.text, replyTo: c.replyTo, at: new Date(c.time).getTime(), isCreator: c.author === coin.creator }))}
                  loading={comments.isLoading}
                  me={me}
                  note="用你的 Solana 钱包签名发言，不花钱、不上链"
                  onPost={async (text, replyTo) => {
                    await postSolComment(solKeypair(), mint, text, replyTo);
                    await qc.invalidateQueries({ queryKey: ["pump", "comments", mint] });
                  }}
                />
              ),
            },
            {
              key: "trades",
              label: "成交",
              render: () => (
                <TradeRows
                  loading={trades.isLoading}
                  items={(trades.data ?? []).map((t) => ({ id: t.sig, side: t.side, who: t.trader, mine: t.trader === me, amount: `${fmtNum(t.tokens, 1)} · ◎${t.sol < 0.01 ? t.sol.toFixed(4) : t.sol.toFixed(3)}`, value: compactUsd(t.usd), at: t.at, href: explorerTx(SOL_CHAIN, t.sig) }))}
                />
              ),
            },
            {
              key: "holders",
              label: "持有者",
              count: hs?.total,
              render: () => (
                <HolderRows
                  loading={holders.isLoading}
                  summary={summary}
                  items={(holders.data ?? []).map((h) => ({
                    address: h.address,
                    pct: h.pct,
                    me: h.address === me,
                    href: explorerAddr(SOL_CHAIN, h.address),
                    tags: [h.isPool ? (coin.complete ? "池子" : "联合曲线") : null, h.isDev ? "创建者" : null, h.isSniper ? "狙击" : null, h.isBundler ? "捆绑" : null, h.address === me ? "我" : null].filter((s): s is string => !!s),
                  }))}
                />
              ),
            },
            {
              key: "about",
              label: "简介",
              render: () => <PumpAbout coin={coin} mint={mint} />,
            },
          ]}
        />
      </div>

      <TradeBar
        symbol={coin.symbol}
        onBuy={() => setSheet({ side: "buy" })}
        onSell={() => setSheet({ side: "sell" })}
        onQuick={() => setSheet({ side: "buy", quick: true })}
        sellDisabled={!held || held.raw === 0n}
        extra={!me && <p className="mb-2 text-center text-[12px] text-muted-foreground">当前钱包没有 Solana 地址（私钥导入的钱包），换一个助记词钱包才能买卖</p>}
      />
      <MarkerSheet trades={mk.open} onClose={mk.close} />

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && me && (
          <SolTradeSheet
            key={`${sheet.side}${sheet.quick ? "q" : ""}`}
            coin={coin}
            side={sheet.side}
            quick={!!sheet.quick}
            onSide={(s) => setSheet({ side: s })}
            lamports={sol?.raw ?? 0n}
            tokRaw={held?.raw ?? 0n}
            decimals={held?.decimals ?? PUMP_DECIMALS}
            hasAccount={!!held}
            onDone={() => {
              setSheet(null);
              void qc.invalidateQueries({ queryKey: ["wallet"] });
              void qc.invalidateQueries({ queryKey: ["pump", "trades", mint] });
              void qc.invalidateQueries({ queryKey: ["pump", "holders", mint] });
            }}
          />
        )}
      </BottomSheet>
    </CoinFrame>
  );
}

function PumpAbout({ coin, mint }: { coin: PumpCoin; mint: string }) {
  return (
        <AboutCard
          flat
          description={coin.description}
          socials={coin.socials}
          creator={{ address: coin.creator, name: coin.creatorName, href: explorerAddr(SOL_CHAIN, coin.creator) }}
          createdAt={coin.createdAt}
          rows={[
            [
              "合约",
              <button key="ca" type="button" className="font-mono" onClick={async () => (await copyText(mint)) && toast.success("合约地址已复制")}>
                {shortAddr(mint, 6, 6)}
              </button>,
            ],
            ["代币标准", coin.tokenProgram === TOKEN_2022_PROGRAM ? "Token-2022" : "SPL Token"],
            [
              "浏览器",
              <span key="links" className="flex justify-end gap-3">
                <a href={explorerToken(SOL_CHAIN, mint)} target="_blank" rel="noreferrer" className="flex items-center gap-0.5">
                  Solscan <ArrowSquareOut size={12} />
                </a>
                <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer" className="flex items-center gap-0.5">
                  pump.fun <ArrowSquareOut size={12} />
                </a>
              </span>,
            ],
          ]}
        />
  );
}

const SLIPS = [2, 5, 10, 20] as const;
const QUICK_SOL = ["0.05", "0.1", "0.5", "1"];
const PRIORITY = [
  { key: "medium", label: "普通" },
  { key: "high", label: "快速" },
  { key: "veryHigh", label: "极速" },
] as const;
/** kept back on a buy: base + priority fee headroom (Jupiter caps priority at 0.002 SOL) */
const FEE_RESERVE = 3_000_000n;
const STEP_LABEL: Record<SolSwapStep, string> = { building: "生成交易…", confirming: "等待链上确认…" };

function SolTradeSheet({ coin, side, quick, onSide, lamports, tokRaw, decimals, hasAccount, onDone }: { coin: PumpCoin; side: "buy" | "sell"; quick: boolean; onSide: (s: "buy" | "sell") => void; lamports: bigint; tokRaw: bigint; decimals: number; hasAccount: boolean; onDone: () => void }) {
  useNodes();
  const { solKeypair } = useVault();
  const buy = side === "buy";
  const [amount, setAmount] = useState(buy ? (quick ? quickAmount("sol", "0.1") : "0.1") : "");
  const [slip, setSlip] = useState<(typeof SLIPS)[number]>(coin.complete ? 5 : 10);
  const [priority, setPriority] = useState<(typeof PRIORITY)[number]["key"]>("high");
  const [step, setStep] = useState<SolSwapStep | null>(null);
  const [err, setErr] = useState("");

  let amountIn = 0n;
  try {
    amountIn = amount && Number(amount) > 0 ? parseUnits(amount, buy ? 9 : decimals) : 0n;
  } catch {
    amountIn = 0n;
  }
  const [debounced, setDebounced] = useState(0n);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(amountIn), 300);
    return () => clearTimeout(id);
  }, [amountIn]);

  const [inMint, outMint] = buy ? [WSOL_MINT, coin.mint] : [coin.mint, WSOL_MINT];
  const q = useQuery({
    queryKey: ["pump", "quote", inMint, outMint, debounced.toString(), slip],
    enabled: debounced > 0n,
    refetchInterval: 8_000,
    retry: false,
    queryFn: () => jupQuote(inMint, outMint, debounced, slip * 100),
  });
  const view = q.data && debounced === amountIn ? q.data : null;
  // a first buy also opens the token account (rent, refunded if you close it later)
  const reserve = FEE_RESERVE + (buy && !hasAccount ? BigInt(TOKEN_ACCOUNT_RENT) : 0n);
  const insufficient = buy ? amountIn + reserve > lamports : amountIn > tokRaw || lamports < 10_000n;
  const maxBuy = lamports > reserve ? lamports - reserve : 0n;

  const outDec = buy ? decimals : 9;
  const outLabel = view ? `${fmtNum(Number(formatUnits(BigInt(view.outAmount), outDec)), buy ? 2 : 4)} ${buy ? coin.symbol : "SOL"}` : q.isFetching ? "报价中…" : "—";
  const minLabel = view ? `${fmtNum(Number(formatUnits(BigInt(view.otherAmountThreshold), outDec)), buy ? 2 : 4)} ${buy ? coin.symbol : "SOL"}` : "—";
  const impact = view ? Number(view.priceImpactPct) * 100 : null;
  const usdIn = buy ? (Number(amountIn) / LAMPORTS) * coin.solPrice : Number(formatUnits(amountIn, decimals)) * coin.priceUsd;

  const go = async () => {
    if (!view) return;
    setErr("");
    try {
      if (quick && buy) setQuickAmount("sol", amount);
      const sig = await executeSolSwap(solKeypair(), view, rpcOf(SOL_CHAIN), priority, setStep);
      toast.success(`${buy ? "买入" : "卖出"} ${coin.symbol} 成功`, { action: { label: "查看", onClick: () => window.open(explorerTx(SOL_CHAIN, sig), "_blank") } });
      onDone();
    } catch (e) {
      setErr(((e as Error).message || "交易失败").split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" disabled={!!step} onClick={() => onSide(s)} className={cn("h-10 rounded-xl text-[15px] font-semibold transition", side === s ? (s === "buy" ? "bg-up text-black shadow" : "bg-down text-white shadow") : "text-muted-foreground")}>
            {s === "buy" ? "买入" : "卖出"}
          </button>
        ))}
      </div>
      {quick && buy && <p className="mt-2 text-center text-[12px] text-up">⚡ 快速买入：金额会记住，作为下次的默认值</p>}

      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>{buy ? "支付" : "卖出数量"}</span>
          <span className="font-mono">余额 {buy ? `${(Number(lamports) / LAMPORTS).toFixed(4)} SOL` : `${fmtNum(Number(formatUnits(tokRaw, decimals)), 2)} ${coin.symbol}`}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0" className={cn("w-0 flex-1 bg-transparent font-mono text-[32px] font-semibold tracking-tight outline-none", insufficient && amountIn > 0n && "text-down")} />
          <span className="flex items-center gap-1.5 text-[15px] font-semibold">
            <TokenAvatar symbol={buy ? "SOL" : coin.symbol} seed={buy ? "sol-native" : coin.mint} logo={buy ? SOL_LOGO : iconUrl(coin.image)} size={22} className="rounded-full" />
            {buy ? "SOL" : coin.symbol}
          </span>
        </div>
        <div className="text-[12px] text-muted-foreground">{amountIn > 0n ? `≈ ${usd(usdIn)}` : " "}</div>
        <div className="mt-3 grid grid-cols-5 gap-2">
          {(buy
            ? [...QUICK_SOL.map((v) => ({ v, l: v })), { v: formatUnits(maxBuy, 9), l: "最大" }]
            : [10, 25, 50, 75, 100].map((p) => ({ v: formatUnits((tokRaw * BigInt(p)) / 100n, decimals), l: p === 100 ? "全部" : `${p}%` }))
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
          <dd className="font-mono font-semibold">{outLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">最少得到</dt>
          <dd className="font-mono">{minLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">价格影响</dt>
          <dd className={cn("font-mono", impact != null && impact > 5 ? "text-down" : "")}>{impact != null ? `${impact.toFixed(2)}%` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">路线</dt>
          <dd className="truncate pl-4 text-right">{view ? routeLabel(view) : "—"}</dd>
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
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">速度</dt>
          <dd className="flex gap-1">
            {PRIORITY.map((p) => (
              <button key={p.key} type="button" onClick={() => setPriority(p.key)} className={cn("h-7 rounded-lg px-2 text-[12px]", priority === p.key ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>
                {p.label}
              </button>
            ))}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">网络费</dt>
          <dd className="text-right font-mono text-[12px] text-muted-foreground">
            ≈0.0001–0.002 SOL{buy && !hasAccount ? ` · 首次开户 ${(TOKEN_ACCOUNT_RENT / LAMPORTS).toFixed(4)} SOL` : ""}
          </dd>
        </div>
      </dl>

      {q.isError && (
        <p className="mt-2 text-[12px] text-down">
          {q.error instanceof QuoteError && q.error.code === "not_tradable" ? (
            q.errorUpdatedAt - coin.createdAt < 10 * 60_000 ? (
              "这个币刚创建，聚合器还没收录，过一两分钟再试"
            ) : (
              <>
                聚合器不支持这个币的交易方式，暂时只能去{" "}
                <a href={`https://pump.fun/coin/${coin.mint}`} target="_blank" rel="noreferrer" className="underline">
                  pump.fun
                </a>{" "}
                交易
              </>
            )
          ) : (
            (q.error as Error).message || "报价失败，稍后再试"
          )}
        </p>
      )}
      {err && <p className="mt-2 text-[12px] break-words text-down">{err}</p>}

      {insufficient && amountIn > 0n ? (
        <Link href="/wallet/receive" className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold">
          {buy ? "SOL 不够（要留网络费），去充值" : lamports < 10_000n ? "SOL 不够付网络费，去充值" : "余额不足"}
        </Link>
      ) : (
        <PrimaryButton tone={buy ? "up" : "down"} className="mt-4" disabled={!view || !!step} onClick={go}>
          <span className="flex items-center justify-center gap-1.5">
            {step ? <CircleNotch size={18} className="animate-spin" /> : <Lightning size={18} weight="fill" />}
            {step ? STEP_LABEL[step] : buy ? `买入 ${coin.symbol}` : `卖出 ${coin.symbol}`}
          </span>
        </PrimaryButton>
      )}
      <p className="mt-2 text-center text-[11px] text-muted-foreground">在你的钱包里签名，直接在链上成交，不经过平台托管</p>
    </>
  );
}
