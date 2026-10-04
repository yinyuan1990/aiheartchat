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
import { USDC_LOGO, absUrl, iconUrl } from "@/lib/wallet/assets";
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
  { key: "arm", chain: "arc", label: "Arm", sub: "Arc 上的 Arm 发射币" },
  { key: "pump", chain: "sol", label: "pump", sub: "Solana 上的 pump.fun 币" },
  ...MARKET_CHAINS.map((k) => ({ key: k, chain: k, label: chainByKey(k).name, sub: "DEX 行情 · KyberSwap 成交" })),
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
        title="交易"
        right={
          <>
            <Link href="/wallet/perp" style={{ background: AI_GRADIENT }} className="flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold whitespace-nowrap text-white">
              AI 合约
            </Link>
            <ChainPill chain={{ ...chainByKey(info.chain), name: info.label }} onClick={() => setPicker(true)} />
          </>
        }
      />
      {cur === "pump" ? <PumpList /> : cur === "arm" ? <TokenList /> : <EvmList key={cur} chain={cur} />}
      <BottomNav />
      <BottomSheet open={picker} onClose={() => setPicker(false)}>
        <div className="mb-2 text-[16px] font-semibold">选择市场</div>
        <ul className="space-y-1">
          {MARKETS.map((m) => (
            <li key={m.key}>
              <button type="button" onClick={() => pick(m.key)} className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition active:bg-muted", cur === m.key && "bg-muted")}>
                <ChainGlyph chain={chainByKey(m.chain)} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold">{m.label}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{m.sub}</div>
                </div>
                {cur === m.key && <Check size={18} weight="bold" className="text-up" />}
              </button>
            </li>
          ))}
        </ul>
        <Link href="/wallet/perp" style={{ background: "linear-gradient(90deg, rgba(124,58,237,0.1), rgba(37,99,235,0.1))" }} className="mt-2 flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <span style={{ background: AI_GRADIENT }} className="flex size-[30px] items-center justify-center rounded-full text-[13px] font-bold text-white">AI</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">AI 合约</span>
            <span className="block truncate text-[12px] text-muted-foreground">Hyperliquid 永续合约，AI 帮你分析，你确认才下单</span>
          </span>
        </Link>
      </BottomSheet>
    </WalletFrame>
  );
}

const EVM_TABS: { key: MarketTab; label: string }[] = [
  { key: "hot", label: "热门" },
  { key: "new", label: "新币" },
  { key: "gainers", label: "涨幅" },
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`搜索 ${c.name} 代币 / 粘贴合约地址`} className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        {!term && (
          <div className="mt-3 flex gap-1">
            {EVM_TABS.map((s) => (
              <button key={s.key} type="button" onClick={() => setTab(s.key)} className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium transition", tab === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
                {s.label}
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
        {rows.map((t) => (
          <li key={t.address}>
            <Link href={`/wallet/market?chain=${chain}&address=${t.address}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol={t.symbol} seed={t.address} logo={iconUrl(t.image)} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[15px] font-semibold">{t.symbol}</span>
                  <span className="truncate text-[12px] text-muted-foreground">{t.name}</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  市值 {t.mcapUsd != null ? compactUsd(t.mcapUsd) : "—"} · {tab === "new" && !term && t.createdAt ? timeAgo(t.createdAt) : `成交 ${t.volume24hUsd != null ? compactUsd(t.volume24hUsd) : "—"}`}
                </div>
              </div>
              <div className="text-right">
                <Num value={t.priceUsd != null ? usd(t.priceUsd) : "—"} className="text-[14px] font-medium" />
                <div>{t.change24h != null ? <Pct value={t.change24h} className="text-[12px]" /> : <span className="text-[12px] text-muted-foreground">—</span>}</div>
              </div>
            </Link>
          </li>
        ))}
        {list.isError && <li className="py-10 text-center text-[13px] text-muted-foreground">行情数据暂时拿不到，稍后再试</li>}
        {!list.isLoading && !list.isError && rows.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">没有找到</li>}
      </ul>
    </>
  );
}

const PUMP_TABS: { key: PumpTab; label: string }[] = [
  { key: "hot", label: "热门" },
  { key: "new", label: "新币" },
  { key: "graduating", label: "即将毕业" },
  { key: "graduated", label: "已毕业" },
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 pump 代币 / 粘贴合约地址" className="flex-1 bg-transparent text-[15px] outline-none" />
        </div>
        {!term && (
          <div className="mt-3 flex gap-1 overflow-x-auto">
            {PUMP_TABS.map((s) => (
              <button key={s.key} type="button" onClick={() => setTab(s.key)} className={cn("h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition", tab === s.key ? "bg-foreground text-background" : "text-muted-foreground")}>
                {s.label}
              </button>
            ))}
            <Link href="/wallet/callouts" className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-up/12 px-3.5 text-[13px] font-semibold text-up">
              <Megaphone size={14} weight="fill" />
              喊单
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
                <div className="text-[15px] font-semibold">打开这个合约</div>
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
                    {c.live && <span className="shrink-0 rounded bg-down/12 px-1 text-[10px] font-semibold text-down">直播</span>}
                    <span className="truncate text-[12px] text-muted-foreground">{c.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                      <span className={cn("block h-full rounded-full", c.complete ? "bg-[#9945FF]" : "bg-up")} style={{ width: `${c.complete ? 100 : Math.max(3, c.progress)}%` }} />
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{c.complete ? "已毕业" : `${Math.floor(c.progress)}%`} · {timeAgo(c.createdAt)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-muted-foreground">市值</div>
                  <Num value={compactUsd(c.mcapUsd)} className="text-[14px] font-medium" />
                </div>
              </Link>
            </li>
          ))}
        {!direct && list.isError && <li className="py-10 text-center text-[13px] text-muted-foreground">pump 数据暂时拿不到，稍后再试</li>}
        {!direct && !list.isLoading && !list.isError && rows.length === 0 && <li className="py-10 text-center text-[13px] text-muted-foreground">没有找到</li>}
      </ul>
    </>
  );
}

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
  const boat = useBoatInfo();
  const s = q.trim().toLowerCase();
  const showBoat = sort === "volume" && boat.data?.enabled && !!boat.data.boat && (!s || "boat speedboat".includes(s) || boat.data.boat.toLowerCase() === s);

  return (
    <>
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
        {showBoat && boat.data && (
          <li>
            <Link href="/wallet/boat" className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition active:bg-muted">
              <TokenAvatar symbol="BOAT" seed={boat.data.boat!} size={42} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[15px] font-semibold">BOAT</span>
                  <span className="rounded-md bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">快艇游戏</span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">市值 {boat.data.mcapUsdc != null ? compactUsd(boat.data.mcapUsdc) : "—"} · Uniswap V4</div>
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
        {!list.isLoading && rows.length === 0 && !showBoat && <li className="py-10 text-center text-[13px] text-muted-foreground">没有找到</li>}
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
      all.set(hash, { id: hash, at: new Date(time).getTime(), side, priceUsd: n > 0 ? u / n : 0, usd: u, who, mine: w === me_, tag: w === deployer ? "创建者" : top10.has(w) ? "前十持有人" : undefined, href: explorerTx(arc, hash) });
    };
    for (const t of trades.data?.items ?? []) add(t.hash, t.time, t.side, t.wallet, t.usdc, t.tokens);
    for (const t of mine) if (me) add(t.hash, t.time, t.side, me, t.usdc, t.tokens);
    return [...all.values()];
  }, [trades.data, mine, me, token?.deployer, top10, arc]);
  const mk = useMarkers(chart, markTrades);
  const changes = useMemo(() => {
    const m = minute.data ?? [];
    const q = quarter.data ?? [];
    return [
      { label: "5分钟", value: changeOver(m, 300) },
      { label: "1小时", value: changeOver(q, 3600) ?? changeOver(m, 3600) },
      { label: "6小时", value: changeOver(q, 6 * 3600) },
      { label: "24小时", value: token?.change24h ?? changeOver(q, 86_400) },
    ];
  }, [minute.data, quarter.data, token?.change24h]);

  if (!token) {
    return (
      <CoinFrame>
        <TopBar back="/wallet/token" title="代币" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{tq.isError ? "没找到这个代币" : <CircleNotch size={28} className="animate-spin" />}</div>
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
          extra={<span className="shrink-0 text-[12px]">{token.graduated ? "已毕业 · Uniswap V4" : `毕业进度 ${progress.toFixed(1)}%`}</span>}
        />
        <CoinChartPanel alertKey={`arc:${address}`} candles={chart} loading={candles.isLoading} interval={iv} onInterval={setIv} priceUsd={token.price} avg={avg} markers={mk.markers} onMarker={mk.onMarker} />
        {tokBal > 0 && <PositionCard valueUsd={posValue} costUsd={cost} amount={tokBal} symbol={token.symbol} supply={ARM_SUPPLY} avg={avg} onShare={share} />}
        <StatsCard
          changes={changes}
          stats={[
            ["市值", compactUsd(token.mcapUsd)],
            ["24h 成交", compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6)],
            ["持有者", fmtNum(token.holders ?? 0)],
            ["买卖税", taxed ? `${token.buyTaxBps / 100}% / ${token.sellTaxBps / 100}%` : "0%"],
          ]}
        />
        <CurveCard
          progress={progress}
          complete={token.graduated}
          venue="Uniswap V4"
          lines={
            token.graduated
              ? [`已毕业，流动性永久锁在 Uniswap V4 池子里。24h 成交 ${compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6)}。`]
              : [`池子里已有 ${fmtNum(paired, 0)} USDC，到 ${fmtNum(threshold, 0)} USDC 毕业（还差 ${compactUsd(Math.max(0, threshold - paired))}）。`, `24h 成交 ${compactUsd(Number(token.volume24hUsdc ?? 0) / 1e6)}。`]
          }
        />

        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
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

        <CoinTabs
          tabs={[
            {
              key: "thread",
              label: "讨论",
              count: comments.data?.length,
              render: () => (
                <CommentBox
                  items={[...(comments.data ?? [])].reverse().map((c) => ({ id: c.id, author: c.author, text: c.text, replyTo: c.replyTo, at: new Date(c.time).getTime(), isCreator: c.isCreator }))}
                  loading={comments.isLoading}
                  me={me}
                  note="用你的钱包签名发言，不花钱、不上链；和 Arm 网页版的讨论区是同一个"
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
              label: "成交",
              render: () => (
                <TradeRows
                  loading={trades.isLoading}
                  items={(trades.data?.items ?? []).map((t) => ({ id: t.hash, side: t.side, who: t.wallet, mine: !!me && t.wallet.toLowerCase() === me.toLowerCase(), amount: fmtNum(Number(t.tokens) / 1e18, 1), value: `$${(Number(t.usdc) / 1e6).toFixed(2)}`, at: new Date(t.time).getTime(), href: explorerTx(arc, t.hash) }))}
                />
              ),
            },
            {
              key: "holders",
              label: "持有者",
              count: token.holders,
              render: () => (
                <HolderRows
                  loading={holders.isLoading}
                  items={(holders.data ?? []).map((h) => ({
                    address: h.wallet,
                    pct: h.pct,
                    me: !!me && h.wallet.toLowerCase() === me.toLowerCase(),
                    href: explorerAddr(arc, h.wallet),
                    tags: [h.label ?? null, h.wallet.toLowerCase() === token.deployer.toLowerCase() ? "创建者" : null].filter((s): s is string => !!s),
                  }))}
                />
              ),
            },
            {
              key: "about",
              label: "简介",
              render: () => (
                <AboutCard
                  flat
                  description={token.description}
                  socials={token.socials}
                  creator={{ address: token.deployer, href: explorerAddr(arc, token.deployer) }}
                  createdAt={new Date(token.launchTs).getTime()}
                  rows={[
                    [
                      "网页版",
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
const STEP_LABEL: Record<TradeStep, string> = { approving: "首次交易，正在授权…", swapping: "签名发送中…", confirming: "等待链上确认…" };

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
