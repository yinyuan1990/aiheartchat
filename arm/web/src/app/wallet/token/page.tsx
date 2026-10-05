"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { ArrowSquareOut, Check, CircleNotch, Info, Lightning, LockSimple, MagnifyingGlass, Megaphone, SealCheck, Warning } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { Candle as ChartCandle } from "@/components/token/price-chart";
import { TokenAvatar } from "@/components/shared";
import { commentMessage, isTaxToken, postComment, progressOf, useCandles, useComments, useHolders, useToken, useTokens, useTrades, useWallet, type TokenView } from "@/lib/api";
import { fmtNum, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR } from "@/lib/web3";
import { useBoatInfo } from "@/lib/boat";
import { chainByKey, explorerAddr, explorerTx, publicClientFor } from "@/lib/wallet/chains";
import { executeTrade, quote, sellableOf, shapeQuote, type Side, type TradeStep } from "@/lib/wallet/arm-trade";
import { shareText } from "@/lib/wallet/native";
import { t } from "@/lib/wallet/i18n";
import { USDC_LOGO, absUrl, iconUrl, tokenIcon } from "@/lib/wallet/assets";
import { isSolAddress } from "@/lib/wallet/sol";
import { changeOver, usePumpList, type PumpTab } from "@/lib/wallet/pump";
import { useVault } from "@/components/wallet/wallet-context";
import { AboutCard, CoinChartPanel, CoinFrame, CoinHeader, CoinTabs, CoinTopBar, CommentBox, groupWorthy, CurveCard, HolderRows, MarkerSheet, PositionCard, StatsCard, TradeBar, TradeRows, allInterval, compactUsd, quickAmount, setQuickAmount, usd, useMarkers, type MarkTrade } from "@/components/wallet/coin";
import { costBasis, useStar, useViewers } from "@/lib/wallet/positions";
import { BottomNav, BottomSheet, ChainGlyph, ChainPill, Num, Pct, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";

const AI_GRADIENT = "linear-gradient(90deg, #7c3aed, #2563eb)";
import { MARKET_CHAINS, isMarketChain, useMarketList, type MarketChainKey, type MarketTab } from "@/lib/wallet/market";

export default function TokenRoute() {
  return (
    <Suspense fallback={<WalletFrame>{null}</WalletFrame>}>
      <TokenRouteInner />
    </Suspense>
  );
}

function TokenRouteInner() {
  const address = useSearchParams().get("address");
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? <TokenDetail address={address.toLowerCase()} /> : <Markets />;
}

/* ───────────── list ───────────── */

type Market = "arm" | "pump" | MarketChainKey;
const MARKET_KEY = "arm.wallet.market";
const MARKETS: { key: Market; chain: string; label: string; sub: string }[] = [
  { key: "arm", chain: "arc", label: "Arm", sub: "cw.token.marketArmSub" },
  { key: "pump", chain: "sol", label: "pump", sub: "cw.token.marketPumpSub" },
  ...MARKET_CHAINS.map((k) => ({ key: k, chain: k, label: chainByKey(k).name, sub: "cw.token.marketDexSub" })),
];
const isMarket = (m: string | null): m is Market => !!m && MARKETS.some((x) => x.key === m);
const marketOfChain = (chainKey: string): Market => (chainKey === "sol" ? "pump" : isMarketChain(chainKey) ? chainKey : "arm");

/** "交易" tab: Arm coins on Arc, pump.fun coins on Solana, or DEX tokens on the EVM chains (defaults to the wallet's chain). */
function Markets() {
  const { chain } = useVault();
  // rendered client-side only (inside the useSearchParams Suspense boundary), so sessionStorage is safe here
  const [market, setMarket] = useState<Market | null>(() => {
    try {
      const m = sessionStorage.getItem(MARKET_KEY);
      return isMarket(m) ? m : null;
    } catch {
      return null;
    }
  });
  const [picker, setPicker] = useState(false);
  const cur: Market = market ?? marketOfChain(chain.key);
  const info = MARKETS.find((m) => m.key === cur)!;
  const pick = (m: Market) => {
    setMarket(m);
    setPicker(false);
    try {
      sessionStorage.setItem(MARKET_KEY, m);
    } catch {}
  };
  return (
    <WalletFrame>
      <TopBar
        title={t("cw.token.title")}
        right={
          <>
            <Link href="/wallet/perp" style={{ background: AI_GRADIENT }} className="flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold whitespace-nowrap text-white">
              {t("cw.token.aiPerps")}
            </Link>
            <ChainPill chain={{ ...chainByKey(info.chain), name: info.label }} onClick={() => setPicker(true)} />
          </>
        }
      />
      {cur === "pump" ? <PumpList /> : cur === "arm" ? <TokenList /> : <EvmList key={cur} chain={cur} />}
      <BottomNav />
      <BottomSheet open={picker} onClose={() => setPicker(false)}>
        <div className="mb-2 text-[16px] font-semibold">{t("cw.token.chooseMarket")}</div>
        <ul className="space-y-1">
          {MARKETS.map((m) => (
            <li key={m.key}>
              <button type="button" onClick={() => pick(m.key)} className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition active:bg-muted", cur === m.key && "bg-muted")}>
                <ChainGlyph chain={chainByKey(m.chain)} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold">{m.label}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{t(m.sub)}</div>
                </div>
                {cur === m.key && <Check size={18} weight="bold" className="text-up" />}
              </button>
            </li>
          ))}
        </ul>
        <Link href="/wallet/perp" style={{ background: "linear-gradient(90deg, rgba(124,58,237,0.1), rgba(37,99,235,0.1))" }} className="mt-2 flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <span style={{ background: AI_GRADIENT }} className="flex size-[30px] items-center justify-center rounded-full text-[13px] font-bold text-white">AI</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">{t("cw.token.aiPerps")}</span>
            <span className="block truncate text-[12px] text-muted-foreground">{t("cw.token.aiPerpsSub")}</span>
          </span>
        </Link>
      </BottomSheet>
    </WalletFrame>
  );
}

const EVM_TABS: { key: MarketTab; label: string }[] = [
  { key: "hot", label: "cw.coin.hot" },
  { key: "new", label: "cw.coin.new" },
  { key: "gainers", label: "cw.token.gainers" },
];

function EvmList({ chain }: { chain: MarketChainKey }) {
  const [tab, setTab] = useState<MarketTab>("hot");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);
  const list = useMarketList(chain, tab, term);
  const rows = list.data ?? [];
  const c = chainByKey(chain);
  return (
    <>
      <div className="px-4">
        <div className="flex h-11 items-center gap-2 rounded-2xl bg-card px-3 ring-1 ring-border/60">
          <MagnifyingGlass size={18} className="text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.token.searchChain", { chain: c.name })} className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        {!term && (
          <div className="mt-3 flex gap-1">
            {EVM_TABS.map((s) => (
              <button key={s.key} type="button" onClick={() => setTab(s.key)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium transition", tab === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
                {t(s.label)}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul className="mt-2 flex-1 divide-y divide-border/50 px-4">
        {list.isLoading &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <span className="size-[42px] animate-pulse rounded-full bg-muted" />
              <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
            </li>
          ))}
        {rows.map((r) => (
          <li key={r.address}>
            <Link href={`/wallet/market?chain=${chain}&address=${r.address}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol={r.symbol} seed={r.address} logo={tokenIcon(chain, r.address, r.image)} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[15px] font-semibold">{r.symbol}</span>
                  <span className="truncate text-[12px] text-muted-foreground">{r.name}</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {t("cw.coin.mcapValue", { v: r.mcapUsd != null ? compactUsd(r.mcapUsd) : "—" })} · {tab === "new" && !term && r.createdAt ? timeAgo(r.createdAt) : t("cw.coin.volValue", { v: r.volume24hUsd != null ? compactUsd(r.volume24hUsd) : "—" })}
                </div>
              </div>
              <div className="text-right">
                <Num value={r.priceUsd != null ? usd(r.priceUsd) : "—"} className="text-[14px] font-medium" />
                <div>{r.change24h != null ? <Pct value={r.change24h} className="text-[12px]" /> : <span className="text-[12px] text-muted-foreground">—</span>}</div>
              </div>
            </Link>
          </li>
        ))}
        {list.isError && <li className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.token.marketUnavailable")}</li>}
        {!list.isLoading && !list.isError && rows.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.coin.notFound")}</li>}
      </ul>
    </>
  );
}

const PUMP_TABS: { key: PumpTab; label: string }[] = [
  { key: "hot", label: "cw.coin.hot" },
  { key: "new", label: "cw.coin.new" },
  { key: "graduating", label: "cw.token.graduating" },
  { key: "graduated", label: "cw.coin.graduated" },
];

function PumpList() {
  const [tab, setTab] = useState<PumpTab>("hot");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);
  const router = useRouter();
  const direct = isSolAddress(term) ? term : null;
  const list = usePumpList(tab, direct ? "" : term);
  const rows = list.data ?? [];
  return (
    <>
      <div className="px-4">
        <div className="flex h-11 items-center gap-2 rounded-2xl bg-card px-3 ring-1 ring-border/60">
          <MagnifyingGlass size={18} className="text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.token.searchPump")} className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        {!term && (
          <div className="mt-3 flex gap-1 overflow-x-auto">
            {PUMP_TABS.map((s) => (
              <button key={s.key} type="button" onClick={() => setTab(s.key)} className={cn("h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition", tab === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
                {t(s.label)}
              </button>
            ))}
            <Link href="/wallet/callouts" className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-up/12 px-3.5 text-[13px] font-semibold text-up">
              <Megaphone size={14} weight="fill" />
              {t("cw.coin.callouts")}
            </Link>
          </div>
        )}
      </div>
      <ul className="mt-2 flex-1 divide-y divide-border/50 px-4">
        {direct && (
          <li>
            <button type="button" onClick={() => router.push(`/wallet/coin?mint=${direct}`)} className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-2xl px-2 py-3 text-left transition active:bg-muted">
              <span className="flex size-[42px] items-center justify-center rounded-full bg-muted font-mono text-[12px]">CA</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold">{t("cw.token.openContract")}</div>
                <div className="truncate font-mono text-[12px] text-muted-foreground">{direct}</div>
              </div>
            </button>
          </li>
        )}
        {!direct && list.isLoading &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <span className="size-[42px] animate-pulse rounded-full bg-muted" />
              <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
            </li>
          ))}
        {!direct &&
          rows.map((c) => (
            <li key={c.mint}>
              <Link href={`/wallet/coin?mint=${c.mint}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
                <TokenAvatar symbol={c.symbol} seed={c.mint} logo={iconUrl(c.image)} size={42} className="rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold">{c.symbol}</span>
                    {c.live && <span className="shrink-0 rounded bg-down/12 px-1 text-[10px] font-semibold text-down">{t("cw.coin.live")}</span>}
                    <span className="truncate text-[12px] text-muted-foreground">{c.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                      <span className={cn("block h-full rounded-full", c.complete ? "bg-[#9945FF]" : "bg-up")} style={{ width: `${c.complete ? 100 : Math.max(3, c.progress)}%` }} />
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{c.complete ? t("cw.coin.graduated") : `${Math.floor(c.progress)}%`} · {timeAgo(c.createdAt)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-muted-foreground">{t("cw.coin.mcap")}</div>
                  <Num value={compactUsd(c.mcapUsd)} className="text-[14px] font-medium" />
                </div>
              </Link>
            </li>
          ))}
        {!direct && list.isError && <li className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.token.pumpUnavailable")}</li>}
        {!direct && !list.isLoading && !list.isError && rows.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.coin.notFound")}</li>}
      </ul>
    </>
  );
}

const SORTS = [
  { key: "volume", label: "cw.coin.hot" },
  { key: "new", label: "cw.coin.new" },
  { key: "mcap", label: "cw.coin.mcap" },
] as const;

function TokenList() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("volume");
  const [q, setQ] = useState("");
  const list = useTokens(sort, "all", "24h", 100);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list.data ?? []).filter((r) => !s || r.symbol.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || r.address.toLowerCase() === s);
  }, [list.data, q]);
  const boat = useBoatInfo();
  const s = q.trim().toLowerCase();
  const showBoat = sort === "volume" && boat.data?.enabled && !!boat.data.boat && (!s || "boat speedboat".includes(s) || boat.data.boat.toLowerCase() === s);

  return (
    <>
      <div className="px-4">
        <div className="flex h-11 items-center gap-2 rounded-2xl bg-card px-3 ring-1 ring-border/60">
          <MagnifyingGlass size={18} className="text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cw.token.searchArm")} className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        <div className="mt-3 flex gap-1">
          {SORTS.map((s) => (
            <button key={s.key} type="button" onClick={() => setSort(s.key)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium transition", sort === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-2 flex-1 divide-y divide-border/50 px-4">
        {showBoat && boat.data && (
          <li>
            <Link href="/wallet/boat" className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol="BOAT" seed={boat.data.boat!} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[15px] font-semibold">BOAT</span>
                  <span className="rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">{t("cw.token.boatGame")}</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{t("cw.coin.mcapValue", { v: boat.data.mcapUsdc != null ? compactUsd(boat.data.mcapUsdc) : "—" })} · Uniswap V4</div>
              </div>
              <div className="text-right">
                <Num value={boat.data.priceUsdc ? usd(boat.data.priceUsdc) : "—"} className="text-[14px] font-medium" />
              </div>
            </Link>
          </li>
        )}
        {list.isLoading &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <span className="size-[42px] animate-pulse rounded-full bg-muted" />
              <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
            </li>
          ))}
        {rows.map((r) => (
          <li key={r.address}>
            <Link href={`/wallet/token?address=${r.address}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol={r.symbol} seed={r.address} logo={absUrl(r.logo)} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold">{r.symbol}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {t("cw.coin.mcapValue", { v: compactUsd(r.mcapUsd) })} · {sort === "new" ? timeAgo(new Date(r.launchTs).getTime()) : t("cw.coin.volValue", { v: compactUsd(Number(r.volume24hUsdc ?? r.volumeUsdc ?? 0) / 1e6) })}
                </div>
              </div>
              <div className="text-right">
                <Num value={usd(r.price)} className="text-[14px] font-medium" />
                <div>{r.change24h != null ? <Pct value={r.change24h} className="text-[12px]" /> : <span className="text-[12px] text-muted-foreground">—</span>}</div>
              </div>
            </Link>
          </li>
        ))}
        {!list.isLoading && rows.length === 0 && !showBoat && <li className="py-10 text-center text-[13px] text-muted-foreground">{t("cw.coin.notFound")}</li>}
      </ul>
    </>
  );
}

/* ───────────── detail ───────────── */

const ARM_SUPPLY = 1e9;

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
  const { active, account } = useVault();
  const me = active?.address;
  const qc = useQueryClient();
  const tq = useToken(address);
  const token = tq.data;
  const [iv, setIv] = useState("15m");
  const range = iv === "all" ? allInterval(token ? new Date(token.launchTs).getTime() : null) : iv;
  const candles = useCandles(address, range);
  const minute = useCandles(address, "1m");
  const quarter = useCandles(address, "15m");
  const trades = useTrades(address, 1, 30);
  const holders = useHolders(address, 50);
  const comments = useComments(address, me);
  const bal = useBalances(token, me);
  const wallet = useWallet(me);
  const [sheet, setSheet] = useState<{ side: Side; quick?: boolean } | null>(null);
  const viewers = useViewers(`arc:${address}`);
  const [starred, toggleStar] = useStar(`arc:${address}`);
  const chart = useMemo<ChartCandle[]>(() => (candles.data ?? []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volumeUsdc) / 1e6 })), [candles.data]);
  const arc = chainByKey("arc");
  const mine = useMemo(() => (wallet.data?.trades ?? []).filter((t) => t.token.toLowerCase() === address), [wallet.data?.trades, address]);
  const top10 = useMemo(() => new Set((holders.data ?? []).slice(0, 10).map((h) => h.wallet.toLowerCase())), [holders.data]);
  const markTrades = useMemo<MarkTrade[]>(() => {
    const deployer = token?.deployer.toLowerCase();
    const me_ = me?.toLowerCase();
    const all = new Map<string, MarkTrade>();
    const add = (hash: string, time: string, side: "buy" | "sell", who: string, usdc: string, tokens: string) => {
      const u = Number(usdc) / 1e6;
      const n = Number(tokens) / 1e18;
      const w = who.toLowerCase();
      all.set(hash, { id: hash, at: new Date(time).getTime(), side, priceUsd: n > 0 ? u / n : 0, usd: u, who, mine: w === me_, tag: w === deployer ? t("cw.coin.creator") : top10.has(w) ? t("cw.coin.top10Holder") : undefined, href: explorerTx(arc, hash) });
    };
    for (const x of trades.data?.items ?? []) add(x.hash, x.time, x.side, x.wallet, x.usdc, x.tokens);
    for (const x of mine) if (me) add(x.hash, x.time, x.side, me, x.usdc, x.tokens);
    return [...all.values()];
  }, [trades.data, mine, me, token?.deployer, top10, arc]);
  const mk = useMarkers(chart, markTrades);
  const changes = useMemo(() => {
    const m = minute.data ?? [];
    const q = quarter.data ?? [];
    return [
      { label: t("cw.coin.change5m"), value: changeOver(m, 300) },
      { label: t("cw.coin.change1h"), value: changeOver(q, 3600) ?? changeOver(m, 3600) },
      { label: t("cw.coin.change6h"), value: changeOver(q, 6 * 3600) },
      { label: t("cw.coin.change24h"), value: token?.change24h ?? changeOver(q, 86_400) },
    ];
  }, [minute.data, quarter.data, token?.change24h]);

  if (!token) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title={t("cw.coin.title")} />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{tq.isError ? t("cw.token.notFound") : <CircleNotch size={28} className="animate-spin" />}</div>
      </CoinFrame>
    );
  }

  const tokBal = bal.data ? Number(formatUnits(bal.data.tok, 18)) : 0;
  const posValue = tokBal * token.price;
  const basis = costBasis(mine.map((t) => ({ side: t.side, tokens: Number(t.tokens) / 1e18, usd: Number(t.usdc) / 1e6, at: new Date(t.time).getTime() })));
  const cost = basis.qty > 0 ? basis.cost * Math.min(1, tokBal / basis.qty) : null;
  const avg = cost != null && tokBal > 0 ? cost / tokBal : null;
  const taxed = isTaxToken(token);
  const progress = progressOf(token);
  const paired = Number(token.pairedUsdc) / 1e6;
  const threshold = Number(token.graduationThreshold) / 1e6;
  const share = () => void shareText(`${token.name} ($${token.symbol}) · https://arm.yyheart.com/token/${token.address}`);

  return (
    <CoinFrame>
      <CoinTopBar
        back="/wallet/token"
        symbol={token.symbol}
        createdAt={new Date(token.launchTs).getTime()}
        viewers={viewers}
        starred={starred}
        onStar={toggleStar}
        onShare={share}
        callout={{ chain: "arc", address: token.address, symbol: token.symbol, name: token.name, image: absUrl(token.logo) ?? null, priceUsd: token.price, mcapUsd: token.mcapUsd }}
        group={groupWorthy({ arm: true })}
      />

      <div className="flex-1 pb-28">
        <CoinHeader
          image={absUrl(token.logo)}
          seed={token.address}
          symbol={token.symbol}
          name={token.name}
          chain={arc}
          address={token.address}
          twitter={token.socials.twitter}
          priceUsd={token.price}
          change={changes[3].value}
          holders={token.holders}
          extra={<span className="shrink-0 text-[12px]">{token.graduated ? `${t("cw.coin.graduated")} · Uniswap V4` : t("cw.token.gradProgress", { n: progress.toFixed(1) })}</span>}
        />
        <CoinChartPanel alertKey={`arc:${address}`} candles={chart} loading={candles.isLoading} interval={iv} onInterval={setIv} priceUsd={token.price} avg={avg} markers={mk.markers} onMarker={mk.onMarker} />
        {tokBal > 0 && <PositionCard valueUsd={posValue} costUsd={cost} amount={tokBal} symbol={token.symbol} supply={ARM_SUPPLY} avg={avg} onShare={share} />}
        <StatsCard
          changes={changes}
          stats={[
            [t("cw.coin.mcap"), compactUsd(token.mcapUsd)],
            [t("cw.coin.vol24h"), compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6)],
            [t("cw.coin.holders"), fmtNum(token.holders ?? 0)],
            [t("cw.token.buySellTax"), taxed ? `${token.buyTaxBps / 100}% / ${token.sellTaxBps / 100}%` : "0%"],
          ]}
        />
        <CurveCard
          progress={progress}
          complete={token.graduated}
          venue="Uniswap V4"
          lines={
            token.graduated
              ? [t("cw.token.curveGraduated", { v: compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6) })]
              : [t("cw.token.curvePool", { paired: fmtNum(paired, 0), target: fmtNum(threshold, 0), left: compactUsd(Math.max(0, threshold - paired)) }), t("cw.token.curveVol", { v: compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6) })]
          }
        />

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold">{t("cw.token.contractCheck")}</span>
            <span className="flex items-center gap-1 text-[12px] text-up">
              <SealCheck size={15} weight="fill" />
              {t("cw.token.armLaunch")}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip ok icon={LockSimple} label={t("cw.token.lpLocked")} />
            <Chip ok label={t("cw.token.noMint")} />
            <Chip ok={!taxed} label={taxed ? t("cw.token.taxChip", { buy: token.buyTaxBps / 100, sell: token.sellTaxBps / 100 }) : t("cw.token.noTax")} />
          </div>
        </section>

        <CoinTabs
          tabs={[
            {
              key: "thread",
              label: t("cw.coin.thread"),
              count: comments.data?.length,
              render: () => (
                <CommentBox
                  items={[...(comments.data ?? [])].reverse().map((c) => ({ id: c.id, author: c.author, text: c.text, replyTo: c.replyTo, at: new Date(c.time).getTime(), isCreator: c.isCreator }))}
                  loading={comments.isLoading}
                  me={me}
                  note={t("cw.token.commentNote")}
                  onPost={async (text, replyTo) => {
                    const acct = account();
                    const ts = Date.now();
                    const signature = await acct.signMessage({ message: commentMessage(token.address, text, ts, replyTo) });
                    await postComment(token.address, { author: acct.address, text, replyTo, ts, signature });
                    await qc.invalidateQueries({ queryKey: ["comments", address] });
                  }}
                />
              ),
            },
            {
              key: "trades",
              label: t("cw.coin.trades"),
              render: () => (
                <TradeRows
                  loading={trades.isLoading}
                  items={(trades.data?.items ?? []).map((x) => ({ id: x.hash, side: x.side, who: x.wallet, mine: !!me && x.wallet.toLowerCase() === me.toLowerCase(), amount: fmtNum(Number(x.tokens) / 1e18, 1), value: `$${(Number(x.usdc) / 1e6).toFixed(2)}`, at: new Date(x.time).getTime(), href: explorerTx(arc, x.hash) }))}
                />
              ),
            },
            {
              key: "holders",
              label: t("cw.coin.holders"),
              count: token.holders,
              render: () => (
                <HolderRows
                  loading={holders.isLoading}
                  items={(holders.data ?? []).map((h) => ({
                    address: h.wallet,
                    pct: h.pct,
                    me: !!me && h.wallet.toLowerCase() === me.toLowerCase(),
                    href: explorerAddr(arc, h.wallet),
                    tags: [h.label ?? null, h.wallet.toLowerCase() === token.deployer.toLowerCase() ? t("cw.coin.creator") : null].filter((s): s is string => !!s),
                  }))}
                />
              ),
            },
            {
              key: "about",
              label: t("bot.desc"),
              render: () => (
                <AboutCard
                  flat
                  description={token.description}
                  socials={token.socials}
                  creator={{ address: token.deployer, href: explorerAddr(arc, token.deployer) }}
                  createdAt={new Date(token.launchTs).getTime()}
                  rows={[
                    [
                      t("cw.token.webApp"),
                      <a key="web" href={`https://arm.yyheart.com/token/${token.address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5">
                        arm.yyheart.com <ArrowSquareOut size={12} />
                      </a>,
                    ],
                  ]}
                />
              ),
            },
          ]}
        />
      </div>

      <TradeBar symbol={token.symbol} onBuy={() => setSheet({ side: "buy" })} onSell={() => setSheet({ side: "sell" })} onQuick={() => setSheet({ side: "buy", quick: true })} sellDisabled={!bal.data || bal.data.tok === 0n} />
      <MarkerSheet trades={mk.open} onClose={mk.close} />

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet && <TradeSheet key={`${sheet.side}${sheet.quick ? "q" : ""}`} token={token} side={sheet.side} quick={!!sheet.quick} onSide={(s) => setSheet({ side: s })} usdc={bal.data?.usdc ?? 0n} tok={bal.data?.tok ?? 0n} onDone={() => setSheet(null)} />}
      </BottomSheet>
    </CoinFrame>
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

const SLIPS = [2, 5, 10] as const;
const QUICK_BUY = ["1", "5", "10", "50"];
const STEP_LABEL: Record<TradeStep, string> = { approving: "cw.coin.stepApproveFirst", swapping: "cw.coin.stepSwapping", confirming: "cw.coin.stepConfirming" };

function TradeSheet({ token, side, quick, onSide, usdc, tok, onDone }: { token: TokenView; side: Side; quick: boolean; onSide: (s: Side) => void; usdc: bigint; tok: bigint; onDone: () => void }) {
  const { account } = useVault();
  const qc = useQueryClient();
  const buy = side === "buy";
  const [amount, setAmount] = useState(buy ? (quick ? quickAmount("arc", "5") : "5") : "");
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
      if (quick && buy) setQuickAmount("arc", amount);
      const rc = await executeTrade(account(), token, side, amountIn, view.minOut, setStep);
      toast.success(buy ? t("cw.coin.bought", { sym: token.symbol }) : t("cw.coin.sold", { sym: token.symbol }), { action: { label: t("cw.coin.view"), onClick: () => window.open(explorerTx(chainByKey("arc"), rc.transactionHash), "_blank") } });
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

  const outLabel = view ? (buy ? `${fmtNum(Number(formatUnits(view.outNet, 18)), 2)} ${token.symbol}` : `${Number(formatUnits(view.out, 6)).toFixed(4)} USDC`) : q.isFetching ? t("cw.coin.quoting") : "—";
  const minLabel = view ? (buy ? `${fmtNum(Number(formatUnits(view.minOutNet, 18)), 2)} ${token.symbol}` : `${Number(formatUnits(view.minOut, 6)).toFixed(4)} USDC`) : "—";

  return (
    <>
      <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" disabled={!!step} onClick={() => onSide(s)} className={cn("h-10 rounded-xl text-[15px] font-semibold transition", side === s ? (s === "buy" ? "bg-up text-white shadow" : "bg-down text-white shadow") : "text-muted-foreground")}>
            {s === "buy" ? t("cw.coin.buy") : t("cw.coin.sell")}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-[20px] bg-muted/60 p-4">
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>{buy ? t("cw.coin.pay") : t("cw.coin.sellAmount")}</span>
          <span className="font-mono">{t("cw.coin.balanceValue", { v: buy ? `${Number(formatUnits(usdc, 6)).toFixed(2)} USDC` : `${fmtNum(Number(formatUnits(tok, 18)), 2)} ${token.symbol}` })}</span>
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
            : [25, 50, 75, 100].map((p) => ({ v: formatUnits((sellable * BigInt(p)) / 100n, 18), l: p === 100 ? t("transfer.all") : `${p}%` }))
          ).map(({ v, l }) => (
            <button key={l} type="button" onClick={() => setAmount(v)} className={cn("h-9 rounded-xl text-[13px] font-semibold transition active:scale-95", amount === v ? "bg-foreground text-background" : "bg-card ring-1 ring-border")}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-2 px-1 text-[13px]">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{buy && token.buyTaxBps ? t("cw.coin.estOutAfterTax") : t("cw.coin.estOut")}</dt>
          <dd className="font-mono font-semibold">{outLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.coin.minOut")}</dt>
          <dd className="font-mono">{minLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.coin.impact")}</dt>
          <dd className={cn("font-mono", view && view.impact > 5 ? "text-down" : "")}>{view ? `${view.impact.toFixed(2)}%` : "—"}</dd>
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
        {!!(token.buyTaxBps || token.sellTaxBps) && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">{t("cw.token.tokenTax")}</dt>
            <dd className="font-mono text-[#b77700] dark:text-[#f5c26b]">{t("cw.token.taxValue", { buy: token.buyTaxBps / 100, sell: token.sellTaxBps / 100 })}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("cw.token.fees")}</dt>
          <dd className="font-mono text-muted-foreground">{t("cw.token.feesValue")}</dd>
        </div>
      </dl>

      {q.isError && <p className="mt-2 text-[12px] text-down">{t("cw.coin.quoteFailed")}</p>}
      {err && <p className="mt-2 text-[12px] break-words text-down">{err}</p>}

      {insufficient && amountIn > 0n ? (
        <Link href="/wallet/receive?deposit=1" className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-muted text-[16px] font-semibold">
          {t("cw.coin.lowBalanceDeposit")}
        </Link>
      ) : (
        <PrimaryButton tone={buy ? "up" : "down"} className="mt-4" disabled={!view || !!step} onClick={go}>
          <span className="flex items-center justify-center gap-1.5">
            {step ? <CircleNotch size={18} className="animate-spin" /> : <Lightning size={18} weight="fill" />}
            {step ? t(STEP_LABEL[step]) : buy ? t("cw.coin.buySym", { sym: token.symbol }) : t("cw.coin.sellSym", { sym: token.symbol })}
          </span>
        </PrimaryButton>
      )}
      <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
        {t("cw.token.uniswapNote")}
        <a href={`https://arm.yyheart.com/token/${token.address}`} target="_blank" rel="noreferrer">
          <ArrowSquareOut size={12} />
        </a>
      </p>
    </>
  );
}
