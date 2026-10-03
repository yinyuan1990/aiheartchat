"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowBendUpLeft, ArrowLeft, ArrowsDownUp, Bell, ChartLine, CircleNotch, Copy, Crown, Eye, Globe, Lightning, Minus, PaperPlaneRight, Plant, Plus, ShareNetwork, SlidersHorizontal, Star, TelegramLogo, XLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { toast } from "sonner";
import { PriceChart, chartPrice, type Candle, type ChartMarker } from "@/components/token/price-chart";
import { TokenAvatar } from "@/components/shared";
import { fmtNum, fmtSmall, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/wallet/native";
import { iconUrl } from "@/lib/wallet/assets";
import { BottomSheet, ChainGlyph, Num, Pct, PrimaryButton, WalletFrame } from "./ui";

/**
 * The pump-style coin page shared by Solana (pump) coins, Arm coins and EVM DEX tokens: dark page; top bar with age /
 * viewers / star / share; avatar with chain badge, address and price; line + area chart with current price, my Avg
 * and trade bubbles; position card; tabs; + / − / ⚡ pinned at the bottom. Each page maps its own data into these.
 */

export const usd = (n: number) => (n >= 1 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${fmtSmall(n)}`);
export const compactUsd = (n: number) => `$${fmtNum(n, n >= 1000 ? 1 : 2)}`;

type ChainInfo = { name: string; color: string; glyph: string };

/** pump's palette inside the coin pages (mint green / coral red on black), whatever the wallet theme is */
const PUMP_VARS = { "--up": "#4ade80", "--down": "#f6465d" } as React.CSSProperties;

export function CoinFrame({ children }: { children: React.ReactNode }) {
  return (
    <WalletFrame theme="terminal" style={PUMP_VARS}>
      {children}
    </WalletFrame>
  );
}

/** "3 小时" / "16 天" — how long the coin has existed */
export function ageLabel(ts: number, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - ts) / 60_000));
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.floor(h / 24);
  return d < 365 ? `${d} 天` : `${Math.floor(d / 365)} 年`;
}

const squareBtn = "flex size-10 items-center justify-center rounded-xl bg-card ring-1 ring-border transition active:scale-90";

export function CoinTopBar({ back, symbol, createdAt, viewers, starred, onStar, onShare }: { back: string; symbol: string; createdAt?: number | null; viewers?: number | null; starred: boolean; onStar: () => void; onShare: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 bg-background/90 px-3 backdrop-blur-xl">
      <Link href={back} aria-label="返回" className="flex size-9 items-center justify-center rounded-full transition active:scale-90">
        <ArrowLeft size={20} weight="bold" />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[15px]">
        <span className="truncate font-semibold">{symbol}</span>
        {createdAt != null && (
          <>
            <span className="h-3.5 w-px shrink-0 bg-border" />
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <Plant size={14} weight="fill" />
              {ageLabel(createdAt)}
            </span>
          </>
        )}
        {viewers != null && viewers > 0 && (
          <>
            <span className="h-3.5 w-px shrink-0 bg-border" />
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <Eye size={14} weight="fill" />
              {viewers}
            </span>
          </>
        )}
      </div>
      <button type="button" aria-label={starred ? "取消收藏" : "收藏"} onClick={onStar} className={squareBtn}>
        <Star size={18} weight={starred ? "fill" : "regular"} className={starred ? "text-[#f5c542]" : ""} />
      </button>
      <button type="button" aria-label="分享" onClick={onShare} className={squareBtn}>
        <ShareNetwork size={18} />
      </button>
    </header>
  );
}

export function CoinHeader({
  image,
  seed,
  symbol,
  name,
  chain,
  address,
  twitter,
  priceUsd,
  change,
  holders,
  extra,
}: {
  image?: string | null;
  seed: string;
  symbol: string;
  name: string;
  chain: ChainInfo;
  address: string;
  twitter?: string | null;
  priceUsd: number | null;
  /** % change shown in the tag under the price */
  change: number | null;
  holders?: number | null;
  /** right side of the holders line (curve progress, "山丘之王", …) */
  extra?: React.ReactNode;
}) {
  return (
    <section className="px-4 pt-2">
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <TokenAvatar symbol={symbol} seed={seed} logo={iconUrl(image)} size={64} className="rounded-2xl ring-2 ring-up/70" />
          <span className="absolute -right-1.5 -bottom-1.5 rounded-full bg-background p-0.5">
            <ChainGlyph chain={chain} size={20} />
          </span>
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="truncate text-[19px] leading-tight font-semibold">{name}</div>
          <div className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
            <button type="button" onClick={async () => (await copyText(address)) && toast.success("合约地址已复制")} className="flex items-center gap-1 font-mono">
              {shortAddr(address, 4, 4)}
              <Copy size={13} />
            </button>
            {twitter && /^https?:\/\//.test(twitter) && (
              <a href={twitter} target="_blank" rel="noreferrer" aria-label="X">
                <XLogo size={14} />
              </a>
            )}
          </div>
        </div>
        <div className="shrink-0 pt-1 text-right">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-[12px] text-muted-foreground">价格</span>
            <Num value={priceUsd != null ? usd(priceUsd) : "—"} className="text-[17px] font-semibold" />
          </div>
          {change != null && <ChangeTag value={change} className="mt-1" />}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <span>{holders != null ? `${fmtNum(holders, 1)} 持有者` : "持有者数据暂缺"}</span>
        {extra}
      </div>
    </section>
  );
}

export function ChangeTag({ value, className }: { value: number; className?: string }) {
  const upward = value >= 0;
  return (
    <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[12px] font-semibold", upward ? "bg-up/15 text-up" : "bg-down/15 text-down", className)}>
      {upward ? "↑" : "↓"} {Math.abs(value) >= 1000 ? fmtNum(Math.abs(value), 0) : Math.abs(value).toFixed(1)}%
    </span>
  );
}

export const CHART_INTERVALS = [
  { key: "1m", label: "1m" },
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "1h", label: "1h" },
  { key: "all", label: "全部" },
];
/** "全部": the finest candle size whose 300 bars still cover the coin's whole life */
export function allInterval(createdAt?: number | null): string {
  const age = createdAt ? Date.now() - createdAt : Infinity;
  const H = 3_600_000;
  return age <= 5 * H ? "1m" : age <= 24 * H ? "5m" : age <= 72 * H ? "15m" : age <= 12 * 24 * H ? "1h" : age <= 50 * 24 * H ? "4h" : "1d";
}

type ChartPrefs = { mode: "area" | "candle"; markers: boolean; avg: boolean };
const PREFS_KEY = "arm.wallet.chartPrefs";
function readPrefs(): ChartPrefs {
  try {
    return { mode: "area", markers: true, avg: true, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ChartPrefs>) };
  } catch {
    return { mode: "area", markers: true, avg: true };
  }
}

/** Price alerts only fire while the coin page is open (no push from a web page). */
function useAlert(alertKey: string, price: number | null) {
  const [target, setTarget] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(`arm.wallet.alert.${alertKey}`));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (target == null || price == null) return;
    const p = prev.current;
    prev.current = price;
    if (p == null) return;
    if ((p < target && price >= target) || (p > target && price <= target)) {
      toast.success(`价格到了 ${chartPrice(target)}`, { duration: 10_000 });
      navigator.vibrate?.(200);
    }
  }, [price, target]);
  const save = (v: number | null) => {
    setTarget(v);
    try {
      if (v) localStorage.setItem(`arm.wallet.alert.${alertKey}`, String(v));
      else localStorage.removeItem(`arm.wallet.alert.${alertKey}`);
    } catch {}
  };
  return [target, save] as const;
}

export function CoinChartPanel({
  alertKey,
  candles,
  loading,
  interval,
  onInterval,
  priceUsd,
  avg,
  markers,
  onMarker,
}: {
  alertKey: string;
  candles: Candle[];
  loading: boolean;
  interval: string;
  onInterval: (k: string) => void;
  priceUsd: number | null;
  avg?: number | null;
  markers?: ChartMarker[];
  onMarker?: (m: ChartMarker) => void;
}) {
  const [prefs, setPrefs] = useState<ChartPrefs>(readPrefs);
  const [sheet, setSheet] = useState<"alert" | "settings" | null>(null);
  const [alert, setAlert] = useAlert(alertKey, priceUsd);
  const set = (p: Partial<ChartPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {}
  };
  return (
    <section className="mt-2">
      {candles.length > 1 ? (
        <PriceChart candles={candles} mode={prefs.mode} pumpStyle avg={prefs.avg ? avg : null} markers={prefs.markers ? markers : undefined} onMarker={onMarker} className="h-[320px]" />
      ) : (
        <div className="flex h-[320px] items-center justify-center text-[13px] text-muted-foreground">{loading ? <CircleNotch size={24} className="animate-spin" /> : "暂无成交"}</div>
      )}
      <div className="mt-1 flex items-center gap-0.5 px-2">
        {CHART_INTERVALS.map((r) => (
          <button key={r.key} type="button" onClick={() => onInterval(r.key)} className={cn("h-8 rounded-full px-2.5 text-[13px] font-medium transition", r.key === interval ? "bg-muted text-foreground" : "text-muted-foreground")}>
            {r.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <button type="button" onClick={() => setSheet("alert")} className={cn("flex h-8 items-center gap-1 rounded-full px-2 text-[13px]", alert ? "text-up" : "text-muted-foreground")}>
          <Bell size={15} weight={alert ? "fill" : "regular"} />
          警报
        </button>
        <span className="flex-1" />
        <button type="button" aria-label={prefs.mode === "area" ? "蜡烛图" : "折线图"} onClick={() => set({ mode: prefs.mode === "area" ? "candle" : "area" })} className="flex size-8 items-center justify-center rounded-full text-muted-foreground">
          {prefs.mode === "area" ? <CandleIcon /> : <ChartLine size={18} />}
        </button>
        <button type="button" aria-label="图表设置" onClick={() => setSheet("settings")} className="flex size-8 items-center justify-center rounded-full text-muted-foreground">
          <SlidersHorizontal size={18} />
        </button>
      </div>
      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)}>
        {sheet === "alert" && (
          <AlertForm
            key={String(alert)}
            price={priceUsd}
            target={alert}
            onSave={(v) => {
              setAlert(v);
              setSheet(null);
            }}
          />
        )}
        {sheet === "settings" && (
          <>
            <div className="mb-3 text-[16px] font-semibold">图表设置</div>
            <Toggle label="显示买卖气泡" hint="我的、创建者和大单的买卖标在 K 线上" on={prefs.markers} onChange={(v) => set({ markers: v })} />
            <Toggle label="显示我的均价线（Avg）" hint="按这个钱包的买入记录算" on={prefs.avg} onChange={(v) => set({ avg: v })} />
            <Toggle label="蜡烛图" hint="关掉是平滑折线" on={prefs.mode === "candle"} onChange={(v) => set({ mode: v ? "candle" : "area" })} />
          </>
        )}
      </BottomSheet>
    </section>
  );
}

function CandleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <rect x="3" y="5" width="4" height="7" rx="1" />
      <rect x="4.5" y="2" width="1" height="13" />
      <rect x="11" y="7" width="4" height="6" rx="1" />
      <rect x="12.5" y="4" width="1" height="12" />
    </svg>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 py-3 text-left">
      <span>
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-[12px] text-muted-foreground">{hint}</span>}
      </span>
      <span className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors", on ? "bg-up" : "bg-muted")}>
        <span className="absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left]" style={{ left: on ? 22 : 2 }} />
      </span>
    </button>
  );
}

function AlertForm({ price, target, onSave }: { price: number | null; target: number | null; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(target ? String(target) : price ? String(Number(price.toPrecision(4))) : "");
  const n = Number(v);
  return (
    <>
      <div className="text-[16px] font-semibold">价格警报</div>
      <p className="mt-1 text-[12px] text-muted-foreground">现价 {price != null ? chartPrice(price) : "—"}。只在这个页面开着时提醒（网页关掉后收不到）。</p>
      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-muted px-3">
        <span className="text-muted-foreground">$</span>
        <input value={v} onChange={(e) => setV(e.target.value.replace(/[^0-9.e-]/g, ""))} inputMode="decimal" className="h-12 flex-1 bg-transparent font-mono text-[18px] outline-none" />
      </div>
      {price != null && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {[-20, -10, 10, 50].map((p) => (
            <button key={p} type="button" onClick={() => setV(String(Number((price * (1 + p / 100)).toPrecision(4))))} className="h-9 rounded-xl bg-card text-[13px] font-semibold ring-1 ring-border">
              {p > 0 ? "+" : ""}
              {p}%
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <PrimaryButton tone="default" className="bg-muted text-foreground" onClick={() => onSave(null)}>
          {target ? "删除警报" : "取消"}
        </PrimaryButton>
        <PrimaryButton tone="up" disabled={!(n > 0)} onClick={() => onSave(n)}>
          保存
        </PrimaryButton>
      </div>
    </>
  );
}

/** pump's position card: value / PnL, amount + share of supply (tap ⇅ to see average entry and cost instead). */
export function PositionCard({ valueUsd, costUsd, amount, symbol, supply, avg, onShare }: { valueUsd: number; costUsd: number | null; amount: number; symbol: string; supply?: number | null; avg?: number | null; onShare?: () => void }) {
  const [alt, setAlt] = useState(false);
  const pnl = costUsd != null && costUsd > 0 ? valueUsd - costUsd : null;
  const pnlPct = pnl != null && costUsd ? (pnl / costUsd) * 100 : null;
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
      <div className="flex items-center justify-between text-[13px]">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="size-2 rounded-full bg-up" />
          持仓中
        </span>
        {onShare && (
          <button type="button" onClick={onShare} className="flex items-center gap-1 text-muted-foreground">
            <ShareNetwork size={14} />
            分享
          </button>
        )}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span className="font-mono text-[26px] leading-none font-semibold">{usd(valueUsd)}</span>
        <span className={cn("font-mono text-[22px] leading-none font-semibold", pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-up" : "text-down")}>{pnl == null ? "—" : `${pnl >= 0 ? "+" : "−"}${usd(Math.abs(pnl))}`}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
        <button type="button" onClick={() => setAlt(!alt)} className="flex min-w-0 items-center gap-1">
          <span className="truncate">
            {alt
              ? `均价 ${avg != null ? chartPrice(avg) : "—"} · 成本 ${costUsd != null ? usd(costUsd) : "—"}`
              : `${fmtNum(amount, 2)} ${symbol}${supply ? ` · ${((amount / supply) * 100).toFixed(amount / supply < 0.001 ? 4 : 2)}%` : ""}`}
          </span>
          <ArrowsDownUp size={13} className="shrink-0" />
        </button>
        {pnlPct != null && <ChangeTag value={pnlPct} />}
      </div>
      {costUsd == null && <p className="mt-2 text-[11px] text-muted-foreground">盈亏只算在这个钱包里成交的记录，之前从别处买的没有成本价</p>}
    </section>
  );
}

/** 4 change chips + key stats in one card */
export function StatsCard({ changes, stats }: { changes: { label: string; value: number | null }[]; stats: [string, string][] }) {
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-3 ring-1 ring-border">
      <div className="grid grid-cols-4 gap-2">
        {changes.map((c) => (
          <div key={c.label} className="rounded-xl bg-muted/60 py-1.5 text-center">
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            {c.value == null ? <div className="font-mono text-[13px] text-muted-foreground">—</div> : <Pct value={c.value} className="text-[13px] font-semibold" />}
          </div>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 px-1 text-[13px]">
        {stats.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------- trade bubbles ----------

export type MarkTrade = { id: string; at: number; side: "buy" | "sell"; priceUsd: number; usd: number; who: string; image?: string | null; tag?: string; mine?: boolean; href?: string };

/**
 * Which trades get a bubble: mine, tagged ones (creator / top holder) and the biggest few; one bubble per candle and
 * side. Returns the markers plus their trades for the detail sheet.
 */
export function buildMarkers(candles: Candle[], trades: MarkTrade[], bigCount = 12): { markers: ChartMarker[]; groups: Map<string, MarkTrade[]> } {
  const groups = new Map<string, MarkTrade[]>();
  if (candles.length < 2 || trades.length === 0) return { markers: [], groups };
  const first = candles[0].time;
  const big = new Set([...trades].sort((a, b) => b.usd - a.usd).slice(0, bigCount).filter((t) => t.usd >= 50).map((t) => t.id));
  const picked = trades.filter((t) => t.mine || t.tag || big.has(t.id));
  const times = candles.map((c) => c.time);
  for (const t of picked) {
    const s = Math.floor(t.at / 1000);
    if (s < first) continue;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const key = `${times[lo]}:${t.side}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const closeAt = new Map(candles.map((c) => [c.time, c.close]));
  // bubbles sit on the line (the candle's close), like pump's; trade prices from another feed can fall off the scale
  const markers: ChartMarker[] = [...groups.entries()].map(([key, g]) => {
    const time = Number(key.split(":")[0]);
    const faces = [...new Map(g.map((t) => [t.who, { seed: t.who, image: t.image }])).values()];
    return { key, time, price: closeAt.get(time) ?? g[0].priceUsd, side: g[0].side, count: g.length, faces, mine: g.some((t) => t.mine) };
  });
  return { markers, groups };
}

export function MarkerSheet({ trades, onClose }: { trades: MarkTrade[] | null; onClose: () => void }) {
  return (
    <BottomSheet open={!!trades} onClose={onClose}>
      {trades && (
        <>
          <div className="mb-2 text-[16px] font-semibold">
            {trades[0].side === "buy" ? "买入" : "卖出"} · {trades.length} 笔
          </div>
          <ul className="divide-y divide-border/50">
            {trades.map((t) => (
              <li key={t.id}>
                <a href={t.href} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2.5 text-[13px]">
                  <TokenAvatar symbol={t.who.slice(0, 2)} seed={t.who} logo={t.image ?? undefined} size={28} className="rounded-full" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate font-mono", t.mine && "font-semibold text-up")}>{t.mine ? "我" : shortAddr(t.who, 4, 4)}</span>
                    {t.tag && <span className="text-[11px] text-muted-foreground">{t.tag}</span>}
                  </span>
                  <span className="text-right">
                    <span className={cn("block font-mono font-semibold", t.side === "buy" ? "text-up" : "text-down")}>{compactUsd(t.usd)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {chartPrice(t.priceUsd)} · {timeAgo(t.at)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </BottomSheet>
  );
}

/** Shared "mark trades" glue for the pages: memoized markers + the sheet state. */
export function useMarkers(candles: Candle[], trades: MarkTrade[]) {
  const { markers, groups } = useMemo(() => buildMarkers(candles, trades), [candles, trades]);
  const [open, setOpen] = useState<MarkTrade[] | null>(null);
  return { markers, open, onMarker: (m: ChartMarker) => setOpen(groups.get(m.key) ?? null), close: () => setOpen(null) };
}

// ---------- lists ----------

export function CurveCard({ progress, complete, venue, lines }: { progress: number; complete: boolean; venue: string; lines: string[] }) {
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">{complete ? "已毕业" : "联合曲线进度"}</span>
        <span className={cn("font-mono text-[14px] font-semibold", complete ? "text-up" : "")}>{complete ? venue : `${progress.toFixed(1)}%`}</span>
      </div>
      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-up/70 to-up transition-[width] duration-500" style={{ width: `${complete ? 100 : Math.max(1.5, progress)}%` }} />
      </div>
      {lines.map((l) => (
        <p key={l} className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {l}
        </p>
      ))}
    </section>
  );
}

export function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[14px] font-semibold", className)}>{value}</div>
    </div>
  );
}

export type CoinTab = { key: string; label: string; count?: number; render: () => React.ReactNode };

export function CoinTabs({ tabs }: { tabs: CoinTab[] }) {
  const [on, setOn] = useState(tabs[0]?.key);
  const cur = tabs.find((t) => t.key === on) ?? tabs[0];
  return (
    <section className="mt-4">
      <div className="grid border-b border-border px-4" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setOn(t.key)} className={cn("-mb-px border-b-2 pb-2.5 text-[15px] font-semibold transition", t.key === cur?.key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground")}>
            {t.label}
            {t.count != null && <span className="ml-1 text-[12px] font-normal text-muted-foreground">{fmtNum(t.count)}</span>}
          </button>
        ))}
      </div>
      <div className="px-4 pt-1">{cur?.render()}</div>
    </section>
  );
}

export type CoinTradeItem = { id: string; side: "buy" | "sell"; who: string; amount: string; value: string; at: number; href?: string; mine?: boolean };

export function TradeRows({ items, loading, note }: { items: CoinTradeItem[]; loading?: boolean; note?: string }) {
  if (loading && items.length === 0) return <Spinner />;
  if (items.length === 0) return <Empty text="还没有成交" />;
  return (
    <>
      {note && <p className="pt-2 text-[11px] text-muted-foreground">{note}</p>}
      <ul className="divide-y divide-border/50">
        {items.map((t) => {
          const row = (
            <>
              <span className={cn("w-9 shrink-0 rounded-md py-0.5 text-center text-[11px] font-semibold", t.side === "buy" ? "bg-up/12 text-up" : "bg-down/12 text-down")}>{t.side === "buy" ? "买" : "卖"}</span>
              <span className={cn("w-24 shrink-0 truncate font-mono text-muted-foreground", t.mine && "font-semibold text-up")}>{t.mine ? "我" : shortAddr(t.who, 4, 4)}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-muted-foreground">{t.amount}</span>
              <span className="w-16 shrink-0 text-right font-mono font-medium">{t.value}</span>
              <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground">{timeAgo(t.at)}</span>
            </>
          );
          return (
            <li key={t.id}>
              {t.href ? (
                <a href={t.href} target="_blank" rel="noreferrer" className="flex items-center gap-2 py-2.5 text-[13px]">
                  {row}
                </a>
              ) : (
                <div className="flex items-center gap-2 py-2.5 text-[13px]">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export type CoinHolderItem = { address: string; pct: number; tags: string[]; href?: string; me?: boolean };

export function HolderRows({ items, loading, summary, empty }: { items: CoinHolderItem[]; loading?: boolean; summary?: string[]; empty?: React.ReactNode }) {
  if (loading && items.length === 0) return <Spinner />;
  return (
    <>
      {summary && summary.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2.5">
          {summary.map((s) => (
            <span key={s} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {s}
            </span>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        (empty ?? <Empty text="暂无持有人数据" />)
      ) : (
        <ol className="mt-1">
          {items.map((h, i) => (
            <li key={h.address}>
              <a href={h.href} target="_blank" rel="noreferrer" className="relative flex items-center gap-2 overflow-hidden rounded-lg px-1 py-2 text-[13px]">
                <span className="absolute inset-y-1 left-0 rounded-md bg-up/8" style={{ width: `${Math.min(100, h.pct)}%` }} />
                <span className="relative w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <span className={cn("relative font-mono", h.me && "font-semibold text-up")}>{shortAddr(h.address, 4, 4)}</span>
                {h.tags.map((t) => (
                  <span key={t} className="relative rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                    {t}
                  </span>
                ))}
                <span className="relative ml-auto font-mono font-medium">{h.pct < 0.01 ? "<0.01" : h.pct.toFixed(2)}%</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export type CoinCommentItem = { id: number; author: string; text: string; replyTo: number | null; at: number; isCreator?: boolean };

/** Thread like pump's: newest first, tap ↩ to reply (shows "#id"), posting needs the unlocked wallet. */
export function CommentBox({ items, loading, me, onPost, note }: { items: CoinCommentItem[]; loading?: boolean; me?: string; onPost: (text: string, replyTo: number | null) => Promise<void>; note?: string }) {
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onPost(body, replyTo);
      setText("");
      setReplyTo(null);
    } catch (e) {
      toast.error((e as Error).message || "发送失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mt-2.5 rounded-2xl bg-muted/60 p-2">
        {replyTo != null && (
          <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>回复 #{replyTo}</span>
            <button type="button" onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 280))} rows={text.length > 40 ? 3 : 1} placeholder={me ? "说点什么…" : "解锁钱包后可以发言"} disabled={!me} className="min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] outline-none" />
          <button type="button" aria-label="发送" disabled={!me || !text.trim() || busy} onClick={send} className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition active:scale-90 disabled:opacity-30">
            {busy ? <CircleNotch size={16} className="animate-spin" /> : <PaperPlaneRight size={16} weight="fill" />}
          </button>
        </div>
      </div>
      {note && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{note}</p>}
      {loading && items.length === 0 ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty text="还没人发言，来抢沙发" />
      ) : (
        <ul className="mt-2 divide-y divide-border/50">
          {items.map((c) => (
            <li key={c.id} className="py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <TokenAvatar symbol={c.author.slice(0, 2)} seed={c.author} size={18} className="rounded-full" />
                <span className={cn("font-mono", c.author === me && "font-semibold text-up")}>{shortAddr(c.author, 4, 4)}</span>
                {c.isCreator && <span className="rounded bg-up/12 px-1 text-[10px] font-semibold text-up">创建者</span>}
                <span>· {timeAgo(c.at)}</span>
                <span>#{c.id}</span>
                <button type="button" aria-label="回复" onClick={() => setReplyTo(c.id)} className="ml-auto p-1">
                  <ArrowBendUpLeft size={14} />
                </button>
              </div>
              <p className="mt-1 text-[14px] leading-relaxed break-words whitespace-pre-wrap">
                {c.replyTo != null && <span className="mr-1 text-[12px] text-up">#{c.replyTo}</span>}
                {c.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AboutCard({ description, socials, creator, createdAt, rows, flat }: { description?: string | null; socials?: { twitter?: string | null; telegram?: string | null; website?: string | null }; creator?: { address: string; name?: string | null; href?: string }; createdAt?: number; rows?: [string, React.ReactNode][]; flat?: boolean }) {
  const links = [
    { url: socials?.twitter, icon: XLogo, label: "X" },
    { url: socials?.telegram, icon: TelegramLogo, label: "Telegram" },
    { url: socials?.website, icon: Globe, label: "官网" },
  ].filter((l) => l.url && /^https?:\/\//.test(l.url));
  return (
    <section className={flat ? "pt-3" : "mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border"}>
      {!flat && <div className="text-[14px] font-semibold">简介</div>}
      {description ? <p className="mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{description}</p> : <p className="mt-2 text-[13px] text-muted-foreground">没有简介</p>}
      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((l) => (
            <a key={l.label} href={l.url!} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-[12px] font-medium">
              <l.icon size={14} />
              {l.label}
            </a>
          ))}
        </div>
      )}
      <dl className="mt-3 space-y-2 text-[13px]">
        {creator && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">创建者</dt>
            <dd className="truncate font-mono">
              {creator.href ? (
                <a href={creator.href} target="_blank" rel="noreferrer">
                  {creator.name || shortAddr(creator.address, 4, 4)}
                </a>
              ) : (
                creator.name || shortAddr(creator.address, 4, 4)
              )}
            </dd>
          </div>
        )}
        {createdAt != null && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">创建于</dt>
            <dd>{timeAgo(createdAt)}前</dd>
          </div>
        )}
        {rows?.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function KingBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#f5a524]/15 px-2.5 py-1 text-[11px] font-semibold text-[#f5c26b]">
      <Crown size={13} weight="fill" />
      山丘之王
    </span>
  );
}

/** pump's bottom bar: big green "+ SYM", red "− SYM", ⚡ quick buy. */
export function TradeBar({ symbol, onBuy, onSell, onQuick, sellDisabled, extra }: { symbol: string; onBuy: () => void; onSell: () => void; onQuick?: () => void; sellDisabled?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-[430px] bg-background/95 px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:absolute">
      {extra}
      <div className="flex gap-2">
        <button type="button" onClick={onBuy} className="flex h-14 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-up text-[17px] font-bold text-black transition active:scale-[0.98]">
          <Plus size={18} weight="bold" />
          <span className="truncate">{symbol}</span>
        </button>
        <button type="button" onClick={onSell} disabled={sellDisabled} className="flex h-14 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-down text-[17px] font-bold text-white transition active:scale-[0.98] disabled:opacity-35">
          <Minus size={18} weight="bold" />
          <span className="truncate">{symbol}</span>
        </button>
        {onQuick && (
          <button type="button" aria-label="快速买入" onClick={onQuick} className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-card text-up ring-1 ring-border transition active:scale-95">
            <Lightning size={24} weight="fill" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Amount used by ⚡ (per payment coin), editable in the trade sheet. */
export function quickAmount(coin: string, fallback: string): string {
  try {
    return localStorage.getItem(`arm.wallet.quick.${coin}`) || fallback;
  } catch {
    return fallback;
  }
}
export function setQuickAmount(coin: string, v: string) {
  try {
    localStorage.setItem(`arm.wallet.quick.${coin}`, v);
  } catch {}
}

function Spinner() {
  return (
    <div className="flex justify-center py-6">
      <CircleNotch size={22} className="animate-spin text-muted-foreground" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-[13px] text-muted-foreground">{text}</p>;
}
