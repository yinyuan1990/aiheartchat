"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Activity, ExternalLink, Flame, Gauge, Loader2 } from "lucide-react";
import { useApp } from "@/components/providers";
import { useAiMarket, usePerpMarket, usePerpWhales, type PerpCoin, type Whale, type WhaleEvent, type WhalePosition } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNow } from "./ai-arena";
import { useCountUp } from "./scanner-motion";

const MAP_COINS = ["BTC", "ETH", "SOL"] as const;
const HEAT_N = 48;
const MAP_SPAN = 0.3;
const BUCKETS = 40;
const NEAR = 0.1;

const LiqMountains = dynamic(() => import("./liq-mountains"), {
  ssr: false,
  loading: () => <div className="flex h-72 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>,
});
let webglCache: boolean | null = null;
const hasWebGL = () => {
  if (webglCache === null) {
    try {
      webglCache = !!document.createElement("canvas").getContext("webgl2");
    } catch {
      webglCache = false;
    }
  }
  return webglCache;
};
const noSubscribe = () => () => {};

const big = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}K` : `${s}$${a.toFixed(0)}`;
};
const pct = (v: number, d = 1) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const price = (v: number) => (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground");

// -------------------------------------------------------------------------------- sentiment

function GreedGauge({ value }: { value: number }) {
  const { t } = useApp();
  const v = useCountUp(value, 1400);
  const band = value < 25 ? 0 : value < 45 ? 1 : value < 55 ? 2 : value < 75 ? 3 : 4;
  const a = ((v / 100) * 180 - 180) * (Math.PI / 180);
  return (
    <div className="relative mx-auto w-full max-w-60">
      <svg viewBox="0 0 200 112" className="w-full">
        <defs>
          <linearGradient id="greed" x1="0" x2="1">
            <stop offset="0" stopColor="var(--down)" />
            <stop offset="0.5" stopColor="#eab308" />
            <stop offset="1" stopColor="var(--up)" />
          </linearGradient>
        </defs>
        <path d="M 16 100 A 84 84 0 0 1 184 100" fill="none" stroke="url(#greed)" strokeWidth="14" strokeLinecap="round" opacity="0.85" />
        <line x1="100" y1="100" x2={100 + 70 * Math.cos(a)} y2={100 + 70 * Math.sin(a)} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="100" cy="100" r="6" fill="currentColor" />
      </svg>
      <div className="-mt-3 text-center">
        <div className="font-mono text-3xl font-bold tabular-nums">{Math.round(v)}</div>
        <div className={cn("text-xs font-semibold", band < 2 ? "text-down" : band > 2 ? "text-up" : "text-muted-foreground")}>{t(`perp.band.${band}` as "perp.band.0")}</div>
      </div>
    </div>
  );
}

type HeatMode = "change" | "funding" | "oi";
/** Hyperliquid's fixed interest leg (0.00125%/h); funding at this rate is neutral, so tiles are coloured around it. */
const BASE_FUNDING_APR = 0.0000125 * 24 * 365;
const metric = (c: PerpCoin, m: HeatMode) => (m === "change" ? c.change : m === "funding" ? c.fundingApr : c.oiChg1h ?? 0);
const heatOf = (c: PerpCoin, m: HeatMode) => (m === "funding" ? c.fundingApr - BASE_FUNDING_APR : metric(c, m));
const SCALE: Record<HeatMode, number> = { change: 0.08, funding: 0.3, oi: 0.05 };

function Tile({ c, mode }: { c: PerpCoin; mode: HeatMode }) {
  // remember the previous mark across polls (state adjusted during render, React's documented pattern)
  const [prev, setPrev] = useState({ mark: c.mark, dir: 0, n: 0 });
  if (prev.mark !== c.mark) setPrev({ mark: c.mark, dir: c.mark > prev.mark ? 1 : -1, n: prev.n + 1 });
  const v = metric(c, mode), h = heatOf(c, mode);
  const k = Math.min(1, Math.abs(h) / SCALE[mode]);
  const bg = `color-mix(in oklch, ${h >= 0 ? "var(--up)" : "var(--down)"} ${Math.round(4 + k * 56)}%, transparent)`;
  return (
    <div className="relative overflow-hidden rounded-md px-1.5 py-1 transition-colors duration-700" style={{ background: bg }}>
      {prev.n > 0 && <span key={prev.n} className={cn("pointer-events-none absolute inset-0 rounded-md", prev.dir > 0 ? "tick-up" : "tick-down")} />}
      <div className="truncate text-[11px] font-semibold">{c.coin}</div>
      <div className="font-mono text-[11px] font-bold tabular-nums">{mode === "oi" && c.oiChg1h === null ? "…" : pct(v, mode === "funding" ? 0 : 1)}</div>
      <div className="truncate font-mono text-[9px] text-muted-foreground tabular-nums">{price(c.mark)}</div>
    </div>
  );
}

function Sentiment() {
  const { t } = useApp();
  const { data, isLoading } = usePerpMarket();
  const [mode, setMode] = useState<HeatMode>("funding");
  if (isLoading || !data) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  const { greed, coins } = data;
  const liquid = coins.filter((c) => c.oiUsd >= 5_000_000);
  const crowdedLong = liquid.filter((c) => c.fundingApr > BASE_FUNDING_APR + 1e-4).sort((a, b) => b.fundingApr - a.fundingApr).slice(0, 5);
  const crowdedShort = liquid.filter((c) => c.fundingApr < BASE_FUNDING_APR - 1e-4).sort((a, b) => a.fundingApr - b.fundingApr).slice(0, 5);
  const surge = liquid.filter((c) => c.oiChg1h !== null).sort((a, b) => b.oiChg1h! - a.oiChg1h!).slice(0, 5);
  const rank = (list: PerpCoin[], val: (c: PerpCoin) => string, cls: (c: PerpCoin) => string) => (
    <ol className="space-y-0.5">
      {list.map((c, i) => (
        <li key={c.coin} className="flex justify-between gap-2 text-xs">
          <span className="truncate"><span className="text-muted-foreground">{i + 1}.</span> {c.coin}</span>
          <span className={cn("font-mono tabular-nums", cls(c))}>{val(c)}</span>
        </li>
      ))}
    </ol>
  );
  return (
    <div className="space-y-3">
      <Card className="border-primary/30">
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold"><Gauge className="size-4 text-primary" /> {t("perp.greed")}</h2>
          <GreedGauge value={greed.value} />
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {[
              [t("perp.wFunding"), pct(greed.fundingApr), tone(greed.fundingApr - BASE_FUNDING_APR)],
              [t("perp.breadth"), `${Math.round(greed.breadth * 100)}%`, ""],
              [t("perp.oi"), big(greed.oiUsd), ""],
              [t("perp.vol"), big(greed.volUsd), ""],
            ].map(([k, v, cls]) => (
              <div key={k} className="rounded-lg bg-muted/40 px-2.5 py-2">
                <div className="text-[10px] text-muted-foreground">{k}</div>
                <div className={cn("font-mono text-sm font-bold tabular-nums", cls)}>{v}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("perp.greedHow")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">{t("perp.heat").replace("{n}", String(HEAT_N))}</h3>
            <div className="flex gap-1 text-[11px]">
              {(["funding", "change", "oi"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={cn("rounded-md px-2 py-0.5", mode === m ? "bg-foreground text-background" : "border hover:bg-accent")}>
                  {t(`perp.mode.${m}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
            {coins.slice(0, HEAT_N).map((c) => <Tile key={c.coin} c={c} mode={mode} />)}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t(`perp.modeHint.${mode}`)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-4 p-4 text-sm sm:grid-cols-3">
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold text-down">{t("perp.crowdedLong")}</h3>
            {rank(crowdedLong, (c) => pct(c.fundingApr, 0), () => "text-down")}
          </div>
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold text-up">{t("perp.crowdedShort")}</h3>
            {rank(crowdedShort, (c) => pct(c.fundingApr, 0), () => "text-up")}
          </div>
          <div className="space-y-1.5">
            <h3 className="flex items-center gap-1 text-xs font-semibold text-primary"><Flame className="size-3.5" /> {t("perp.surge")}</h3>
            {surge.length ? rank(surge, (c) => pct(c.oiChg1h!), (c) => tone(c.oiChg1h!)) : <p className="text-xs text-muted-foreground">{t("perp.surgeWait")}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------------------- whales

type Pos = WhalePosition & { address: string; name: string };

function LiqMap({ coin, positions, mark, closes }: { coin: string; positions: Pos[]; mark: number; closes: number[] }) {
  const lo = mark * (1 - MAP_SPAN), hi = mark * (1 + MAP_SPAN);
  const step = (hi - lo) / BUCKETS;
  const buckets = useMemo(() => {
    const b = Array.from({ length: BUCKETS }, () => ({ long: 0, short: 0 }));
    for (const p of positions) {
      if (p.liqPx === null || p.liqPx < lo || p.liqPx >= hi) continue;
      b[Math.floor((p.liqPx - lo) / step)][p.side] += p.ntl;
    }
    return b;
  }, [positions, lo, hi, step]);
  const max = Math.max(1, ...buckets.map((b) => b.long + b.short));
  const W = 600, H = 340, split = 330, barW = W - split - 64;
  const Y = (px: number) => H - ((px - lo) / (hi - lo)) * H;
  const line = closes.length > 1
    ? closes.map((c, i) => `${i ? "L" : "M"}${((i / (closes.length - 1)) * (split - 20)).toFixed(1)},${Y(Math.min(hi, Math.max(lo, c))).toFixed(1)}`).join("")
    : "";
  const top = buckets.map((b, i) => ({ i, v: b.long + b.short })).sort((a, b) => b.v - a.v).slice(0, 3).filter((x) => x.v > 0);
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-foreground">
        {top.map(({ i, v }) => (
          <rect key={i} x={0} width={split} y={Y(lo + (i + 1) * step)} height={H / BUCKETS} fill="#eab308" opacity={0.1 + (v / max) * 0.25} />
        ))}
        {[-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((k) => (
          <g key={k}>
            <line x1={0} x2={W} y1={Y(mark * (1 + k))} y2={Y(mark * (1 + k))} stroke="currentColor" opacity={k ? 0.08 : 0} />
            {k !== 0 && <text x={split - 4} y={Y(mark * (1 + k)) - 3} textAnchor="end" fontSize="11" fill="currentColor" opacity={0.5}>{pct(k, 0)} · {price(mark * (1 + k))}</text>}
          </g>
        ))}
        {line && <path d={line} fill="none" stroke="currentColor" strokeWidth="2" className="reveal-x" opacity={0.85} />}
        <line x1={0} x2={W} y1={Y(mark)} y2={Y(mark)} stroke="var(--primary)" strokeDasharray="5 4" />
        <text x={6} y={Y(mark) - 5} fontSize="12" fill="var(--primary)" fontWeight="bold">{coin} {price(mark)}</text>
        {buckets.map((b, i) => {
          const y = Y(lo + (i + 1) * step), h = H / BUCKETS - 1.5;
          const lw = (b.long / max) * barW, sw = (b.short / max) * barW;
          const labelled = top.some((x) => x.i === i);
          return (
            <g key={`${coin}-${i}`}>
              {lw > 0 && <rect x={split} y={y} width={Math.max(2, lw)} height={h} rx={1.5} fill="var(--down)" opacity={0.85} className="grow-x" style={{ animationDelay: `${i * 15}ms` }} />}
              {sw > 0 && <rect x={split + lw} y={y} width={Math.max(2, sw)} height={h} rx={1.5} fill="var(--up)" opacity={0.85} className="grow-x" style={{ animationDelay: `${i * 15}ms` }} />}
              {labelled && <text x={split + lw + sw + 5} y={y + h - 1} fontSize="12" fontWeight="bold" fill="currentColor" className="fade-up">{big(b.long + b.short)}</text>}
            </g>
          );
        })}
        <line x1={split} x2={split} y1={0} y2={H} stroke="currentColor" opacity={0.15} />
      </svg>
      <NearCards positions={positions} mark={mark} />
    </div>
  );
}

function NearCards({ positions, mark }: { positions: Pos[]; mark: number }) {
  const { t } = useApp();
  const near = (dir: 1 | -1) => positions
    .filter((p) => p.liqPx !== null && (dir < 0 ? p.side === "long" && p.liqPx >= mark * (1 - NEAR) && p.liqPx < mark : p.side === "short" && p.liqPx <= mark * (1 + NEAR) && p.liqPx > mark))
    .reduce((s, p) => s + p.ntl, 0);
  return (
    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
      <div className="rounded-lg bg-down/10 px-2.5 py-1.5">
        {t("perp.liq.down").replace("{px}", price(mark * (1 - NEAR)))}
        <div className="font-mono text-sm font-bold text-down tabular-nums">{big(near(-1))}</div>
      </div>
      <div className="rounded-lg bg-up/10 px-2.5 py-1.5">
        {t("perp.liq.up").replace("{px}", price(mark * (1 + NEAR)))}
        <div className="font-mono text-sm font-bold text-up tabular-nums">{big(near(1))}</div>
      </div>
    </div>
  );
}

function EventRow({ e, now }: { e: WhaleEvent; now: number }) {
  const { t } = useApp();
  const s = Math.max(0, Math.floor((now - e.at) / 1000));
  const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  const verb = t(`perp.ev.${e.kind}.${e.side}` as "perp.ev.open.long");
  const good = (e.kind === "close" || e.kind === "cut") ? e.side === "short" : e.side === "long";
  return (
    <div className="fade-up flex items-center justify-between gap-2 text-xs">
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">{ago}</span>{" "}
        <a href={`https://hypurrscan.io/address/${e.address}`} target="_blank" rel="noreferrer" className="font-mono hover:underline">{e.name || short(e.address)}</a>{" "}
        <span className={good ? "text-up" : "text-down"}>{verb}</span> <span className="font-semibold">{e.coin}</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums">{big(e.ntl)}{e.px ? <span className="text-muted-foreground"> @{price(e.px)}</span> : null}</span>
    </div>
  );
}

function Whales() {
  const { t } = useApp();
  const now = useNow();
  const { data } = usePerpWhales();
  const market = useAiMarket();
  const [coin, setCoin] = useState<(typeof MAP_COINS)[number]>("BTC");
  const webgl = useSyncExternalStore(noSubscribe, hasWebGL, () => false);
  if (!data || data.status === "loading")
    return <p className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-3 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("perp.whales.loading")}</p>;

  const all: Pos[] = data.whales.flatMap((w) => w.positions.map((p) => ({ ...p, address: w.address, name: w.name })));
  const long = all.filter((p) => p.side === "long").reduce((s, p) => s + p.ntl, 0);
  const short_ = all.filter((p) => p.side === "short").reduce((s, p) => s + p.ntl, 0);
  const longShare = long + short_ ? long / (long + short_) : 0.5;
  const m = market.data?.coins.find((c) => c.coin === coin);
  const mark = m?.mid || data.mids[coin] || 0;
  const closes = (m?.candles ?? []).map((k) => k[4]);
  const coinPos = all.filter((p) => p.coin === coin);
  const rows = MAP_COINS.map((c) => ({
    coin: c,
    mark: market.data?.coins.find((x) => x.coin === c)?.mid || data.mids[c] || 0,
    positions: all.filter((p) => p.coin === c),
  })).filter((r) => r.mark > 0);
  const cl = coinPos.filter((p) => p.side === "long").reduce((s, p) => s + p.ntl, 0);
  const cs = coinPos.filter((p) => p.side === "short").reduce((s, p) => s + p.ntl, 0);
  const ranked = [...data.whales]
    .map((w) => ({ w, total: w.positions.reduce((s, p) => s + p.ntl, 0), main: [...w.positions].sort((a, b) => b.ntl - a.ntl)[0] as WhalePosition | undefined }))
    .filter((x) => x.main)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const dist = (p: WhalePosition) => {
    const mid = data.mids[p.coin];
    return p.liqPx && mid ? Math.abs(p.liqPx / mid - 1) : null;
  };

  return (
    <div className="space-y-3">
      <Card className="border-primary/30">
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold"><Activity className="size-4 text-primary" /> {t("perp.whales.title")}</h2>
          <p className="leading-relaxed text-muted-foreground">{t("perp.whales.body").replace("{n}", String(data.whales.length))}</p>
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] tabular-nums">
              <span className="text-up">{t("perp.long")} {big(long)} · {Math.round(longShare * 100)}%</span>
              <span className="text-down">{Math.round((1 - longShare) * 100)}% · {big(short_)} {t("perp.short")}</span>
            </div>
            <div className="flex h-3 overflow-hidden rounded-full bg-down/70">
              <div className="h-full bg-up/80 transition-[width] duration-1000" style={{ width: `${longShare * 100}%` }} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">{t("perp.liq.title")}</h3>
            <div className="flex gap-1 text-[11px]">
              {MAP_COINS.map((c) => (
                <button key={c} type="button" onClick={() => setCoin(c)}
                  className={cn("rounded-md px-2 py-0.5 font-mono", coin === c ? "bg-foreground text-background" : "border hover:bg-accent")}>{c}</button>
              ))}
            </div>
          </div>
          {!mark ? (
            <div className="h-40" />
          ) : webgl ? (
            <>
              <LiqMountains rows={rows} active={coin} onPick={(c) => setCoin(c as (typeof MAP_COINS)[number])} />
              <NearCards positions={coinPos} mark={mark} />
            </>
          ) : (
            <LiqMap key={coin} coin={coin} positions={coinPos} mark={mark} closes={closes} />
          )}
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {t("perp.liq.whalesOn").replace("{coin}", coin).replace("{n}", String(coinPos.length))} <span className="text-up">{t("perp.long")} {big(cl)}</span> · <span className="text-down">{t("perp.short")} {big(cs)}</span>
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t(webgl ? "perp.liq.hint3d" : "perp.liq.hint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-75" /><span className="relative inline-flex size-2 rounded-full bg-up" /></span>
            {t("perp.feed")}
          </h3>
          {data.events.length ? (
            <div className="max-h-72 space-y-1.5 overflow-y-auto">{data.events.slice(0, 30).map((e) => <EventRow key={`${e.at}-${e.address}-${e.coin}`} e={e} now={now} />)}</div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("perp.feedWait")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("perp.top")}</h3>
          <div className="space-y-1.5">
            {ranked.map(({ w, total, main }, i) => <WhaleRow key={w.address} w={w} rank={i + 1} total={total} main={main!} dist={dist(main!)} />)}
          </div>
        </CardContent>
      </Card>
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("perp.note")}</p>
    </div>
  );
}

function WhaleRow({ w, rank, total, main, dist }: { w: Whale; rank: number; total: number; main: WhalePosition; dist: number | null }) {
  const { t } = useApp();
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
      <span className="min-w-0">
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground">#{rank}</span>
          <a href={`https://hypurrscan.io/address/${w.address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 truncate font-mono hover:underline">
            {w.name || short(w.address)} <ExternalLink className="size-3 shrink-0" />
          </a>
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{t("perp.acct")} {big(w.accountValue)} · {t("perp.pos")} {big(total)}</span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className={main.side === "long" ? "text-up" : "text-down"}>{main.coin} {t(main.side === "long" ? "perp.long" : "perp.short")} {main.lev ? `${main.lev}x` : ""}</span>{" "}
        <span className="font-mono">{big(main.ntl)}</span>
        <span className="block text-[10px]">
          <span className={tone(main.upnl)}>{big(main.upnl)}</span>
          {dist !== null && <span className={cn("ml-1.5", dist < 0.1 ? "text-down" : "text-muted-foreground")}>{t("perp.liqDist").replace("{p}", (dist * 100).toFixed(0))}</span>}
        </span>
      </span>
    </div>
  );
}

export function PerpRadar() {
  const { t } = useApp();
  const [view, setView] = useState<"sentiment" | "whales">("sentiment");
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1 text-sm">
        {(["sentiment", "whales"] as const).map((v) => (
          <button key={v} type="button" onClick={() => setView(v)}
            className={cn("rounded-md py-1.5 font-medium", view === v ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {t(`perp.view.${v}`)}
          </button>
        ))}
      </div>
      {view === "sentiment" ? <Sentiment /> : <Whales />}
    </section>
  );
}
