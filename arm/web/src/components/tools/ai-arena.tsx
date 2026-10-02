"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Brain, Loader2, Radio, RotateCcw, Swords } from "lucide-react";
import { useApp } from "@/components/providers";
import { useAiArena, useAiMarket, type ArenaAction, type ArenaDecision, type ArenaMarket, type ArenaTrader } from "@/lib/api";
import { signedPct, signedUsd, usdShort } from "@/app/card/card-format";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DecisionChart, type Bar, type DecisionMark, type PriceMark } from "./decision-chart";

const ACTION_ZH: Record<string, string> = {
  open_long: "开多", open_short: "开空", close_long: "平多", close_short: "平空", hold: "持有", wait: "观望",
};
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground");
const coinOf = (s: string) => s.replace(/USDT?$/, "");
const price = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 1 : v >= 1 ? 2 : 6 });
const kindOf = (a: string): DecisionMark["kind"] =>
  a === "open_long" ? "long" : a === "open_short" ? "short" : a.startsWith("close") ? "close" : a === "hold" ? "hold" : "wait";

const clock = {
  subscribe: (tick: () => void) => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  },
  get: () => Math.floor(Date.now() / 1000) * 1000,
  getServer: () => 0,
};
/** Wall clock that ticks every second, 0 on the server (keeps SSR and hydration identical). */
export const useNow = () => useSyncExternalStore(clock.subscribe, clock.get, clock.getServer);

export function Sparkline({ points, up }: { points: [number, number][]; up: boolean }) {
  if (points.length < 2) return <div className="h-10" />;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = points
    .map(([x, y], i) => `${i ? "L" : "M"}${(((x - x0) / (x1 - x0 || 1)) * 300).toFixed(1)},${(40 - ((y - y0) / (y1 - y0 || 1)) * 36 - 2).toFixed(1)}`)
    .join("");
  return (
    <svg viewBox="0 0 300 40" preserveAspectRatio="none" className={cn("h-10 w-full", up ? "text-up" : "text-down")}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** "Cycle 12 · next in 08:41" with a draining bar; flips to a pulsing "thinking…" once the next cycle is due. */
function ThinkingBar({ tr, now }: { tr: ArenaTrader; now: number }) {
  const { t } = useApp();
  const last = tr.decisions[0];
  if (!last || !now) return null;
  const period = tr.scanMinutes * 60_000;
  const left = Date.parse(last.time) + period - now;
  const due = left <= 0;
  const sec = Math.floor(Math.max(left, 0) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = Math.floor(sec / 3600);
  const mm = hh ? `${hh}:${pad(Math.floor(sec / 60) % 60)}` : pad(Math.floor(sec / 60));
  const ss = pad(sec % 60);
  return (
    <div className="space-y-1.5 rounded-xl bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="relative flex size-2">
            <span className={cn("absolute inline-flex size-full rounded-full opacity-75", tr.running ? "animate-ping bg-up" : "bg-muted-foreground")} />
            <span className={cn("relative inline-flex size-2 rounded-full", tr.running ? "bg-up" : "bg-muted-foreground")} />
          </span>
          {due ? (
            <span className="flex items-center gap-1 text-primary"><Brain className="size-3.5 animate-pulse" /> {t("arena.thinking")}</span>
          ) : (
            t("arena.watching")
          )}
        </span>
        {!due && (
          <span className="tabular-nums text-muted-foreground">
            {t("arena.next").replace("{n}", String(last.cycle))} <span className="font-mono font-semibold text-foreground">{mm}:{ss}</span>
          </span>
        )}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", due ? "w-full animate-pulse bg-primary" : "bg-primary/70")}
          style={due ? undefined : { width: `${Math.min(100, Math.max(0, (1 - left / period) * 100))}%` }}
        />
      </div>
    </div>
  );
}

function LivePrice({ value }: { value: number }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (!value || value === prev.current) return;
    setFlash(value > prev.current ? "up" : "down");
    prev.current = value;
    const id = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(id);
  }, [value]);
  return (
    <span className={cn("font-mono text-lg font-bold tabular-nums transition-colors duration-500", flash === "up" ? "text-up" : flash === "down" ? "text-down" : "")}>
      {value ? `$${price(value)}` : "—"}
    </span>
  );
}

function ConfidenceMeter({ value, line }: { value: number; line: number }) {
  const { t } = useApp();
  const pass = value >= line;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{t("arena.confidence")} <span className="font-mono font-semibold text-foreground">{value}</span></span>
        <span className={pass ? "font-medium text-up" : "text-muted-foreground"}>
          {pass ? t("arena.pass") : t("arena.gap").replace("{n}", String(line - value))}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-border">
        <div className={cn("h-full rounded-full transition-[width] duration-700", pass ? "bg-up" : "bg-primary/60")} style={{ width: `${value}%` }} />
        <div className="absolute -top-1 h-4 w-0.5 rounded bg-foreground" style={{ left: `${line}%` }} title={t("arena.threshold").replace("{n}", String(line))} />
      </div>
    </div>
  );
}

/** One square per cycle, oldest → newest: colour = the call, opacity = confidence. */
function DecisionStrip({ calls }: { calls: { time: string; a: ArenaAction }[] }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{t("arena.strip").replace("{n}", String(calls.length))}</div>
      <div className="flex gap-[3px]">
        {calls.map(({ time, a }, i) => {
          const k = kindOf(a.action);
          return (
            <span
              key={time + i}
              title={`${new Date(time).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })} ${zh ? ACTION_ZH[a.action] ?? a.action : a.action} · ${a.confidence}`}
              className={cn(
                "h-4 min-w-0 flex-1 rounded-[3px]",
                k === "long" ? "bg-up" : k === "short" ? "bg-down" : k === "close" ? "bg-primary" : "bg-muted-foreground",
                i === calls.length - 1 && "ring-2 ring-primary ring-offset-1 ring-offset-background",
              )}
              style={{ opacity: k === "wait" || k === "hold" ? 0.15 + (a.confidence / 100) * 0.5 : 1 }}
            />
          );
        })}
      </div>
    </div>
  );
}

function CoinPanel({ tr, coin, market }: { tr: ArenaTrader; coin: string; market?: ArenaMarket }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const m = market?.coins.find((c) => c.coin === coin);
  const series = tr.scanMinutes >= 60 ? m?.candlesH : m?.candles;
  const bars = useMemo<Bar[]>(
    () => (series ?? []).map(([ts, open, high, low, close]) => ({ time: Math.floor(ts / 1000), open, high, low, close })),
    [series],
  );
  const calls = useMemo(
    () =>
      tr.decisions
        .map((d) => ({ time: d.time, a: d.actions.find((x) => coinOf(x.symbol) === coin) }))
        .filter((x): x is { time: string; a: ArenaAction } => !!x.a)
        .reverse(),
    [tr.decisions, coin],
  );
  const marks = useMemo<DecisionMark[]>(
    () => calls.map(({ time, a }) => ({ time: Math.floor(Date.parse(time) / 1000), kind: kindOf(a.action), text: kindOf(a.action) === "wait" || kindOf(a.action) === "hold" ? "" : zh ? ACTION_ZH[a.action] ?? "" : a.action })),
    [calls, zh],
  );
  const pos = tr.positions.find((p) => coinOf(p.symbol) === coin);
  const lines = useMemo<PriceMark[]>(
    () => (pos ? [
      { price: pos.entry, color: "muted", title: t("arena.entry") },
      { price: pos.stopLoss, color: "down", title: t("arena.stop") },
      { price: pos.takeProfit, color: "up", title: t("arena.target") },
    ] : []),
    [pos, t],
  );
  const latest = calls.at(-1)?.a;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[11px] text-muted-foreground">{coin}-USD · {t("arena.price")}</div>
          <LivePrice value={m?.mid ?? 0} />
        </div>
        {latest && (
          <span className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold",
            kindOf(latest.action) === "long" ? "bg-up/15 text-up" : kindOf(latest.action) === "short" ? "bg-down/15 text-down" : "bg-muted text-muted-foreground",
          )}>
            {zh ? ACTION_ZH[latest.action] ?? latest.action : latest.action.replace("_", " ")}
          </span>
        )}
      </div>

      <div className="-mx-1 rounded-xl border bg-background/40">
        {bars.length ? (
          <DecisionChart bars={bars} live={m?.mid ?? 0} marks={marks} lines={lines} className="h-56 w-full" />
        ) : (
          <div className="flex h-56 items-center justify-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">{t("arena.chartHint")}</p>

      {pos && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5">
            <span className={cn("rounded px-1.5 py-0.5 font-semibold", pos.side.toLowerCase() === "long" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
              {pos.side.toLowerCase() === "long" ? (zh ? "多" : "Long") : (zh ? "空" : "Short")} {pos.leverage}x
            </span>
            <span className="text-muted-foreground tabular-nums">@ {price(pos.entry)}</span>
          </span>
          <span className={cn("font-medium tabular-nums", tone(pos.upnl))}>{signedUsd(pos.upnl)}</span>
        </div>
      )}

      {latest && (
        <div className="space-y-2">
          {latest.confidence > 0 && <ConfidenceMeter value={latest.confidence} line={tr.minConfidence} />}
          {latest.reasoning && <p className="text-xs leading-relaxed text-muted-foreground">{latest.reasoning}</p>}
        </div>
      )}
      {calls.length > 1 && <DecisionStrip calls={calls} />}
    </div>
  );
}

/** Replays the newest chain of thought as if it were being written right now. */
function ThoughtTyper({ decision }: { decision: ArenaDecision }) {
  const [run, setRun] = useState(0);
  if (!decision.thought) return null;
  return <Typer key={`${decision.time}-${run}`} decision={decision} onReplay={() => setRun((r) => r + 1)} />;
}

function Typer({ decision, onReplay }: { decision: ArenaDecision; onReplay: () => void }) {
  const { t, locale } = useApp();
  const text = decision.thought;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setShown((n) => Math.min(text.length, n + 3)), 25);
    return () => clearInterval(id);
  }, [text]);
  const typing = shown < text.length;
  return (
    <section className="space-y-1.5 rounded-xl border bg-muted/30 p-3">
      <h3 className="flex items-center justify-between text-xs font-semibold">
        <span className="flex items-center gap-1"><Brain className={cn("size-3.5 text-primary", typing && "animate-pulse")} /> {t("arena.thought")}</span>
        <span className="flex items-center gap-2 font-normal text-muted-foreground">
          {new Date(decision.time).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
          {!typing && (
            <button type="button" onClick={onReplay} className="flex items-center gap-0.5 hover:text-foreground">
              <RotateCcw className="size-3" /> {t("arena.replay")}
            </button>
          )}
        </span>
      </h3>
      <p className="max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {text.slice(0, shown)}
        {typing && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary align-middle" />}
      </p>
    </section>
  );
}

function TraderCard({ tr, rank, now, market }: { tr: ArenaTrader; rank: number; now: number; market?: ArenaMarket }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const coins = tr.coins;
  const cadence = tr.scanMinutes >= 60
    ? t("arena.everyH").replace("{n}", String(Math.round(tr.scanMinutes / 60)))
    : t("arena.everyM").replace("{n}", String(tr.scanMinutes));
  const [coin, setCoin] = useState<string | null>(null);
  const active = coin && coins.includes(coin) ? coin : coins[0];

  return (
    <Card>
      <CardContent className="space-y-4 p-4 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              <span className="text-muted-foreground">#{rank}</span>
              <span className="truncate">{tr.name}</span>
              {!tr.running && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t("arena.stopped")}</span>}
            </div>
            <div className="text-xs text-muted-foreground">{tr.model} · {coins.join(" / ")} · {cadence} · {t("arena.equity")} <span className="text-foreground tabular-nums">{usdShort(tr.equity)}</span></div>
          </div>
          <div className="text-right">
            <div className={cn("text-xl font-bold tabular-nums", tone(tr.pnl))}>{signedPct(tr.pnlPct / 100)}</div>
            <div className={cn("text-xs tabular-nums", tone(tr.pnl))}>{signedUsd(tr.pnl)}</div>
          </div>
        </div>
        <Sparkline points={tr.curve} up={tr.pnl >= 0} />

        <ThinkingBar tr={tr} now={now} />

        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {coins.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCoin(c)}
              className={cn("flex-1 rounded-md py-1.5 text-xs font-semibold transition", c === active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {c}
            </button>
          ))}
        </div>
        {active && <CoinPanel key={active} tr={tr} coin={active} market={market} />}

        {tr.decisions[0] && <ThoughtTyper decision={tr.decisions[0]} />}

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("arena.trades")}</h3>
          {tr.trades.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("arena.noTrades")}</p>
          ) : (
            tr.trades.slice(0, 6).map((x, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={x.side.toLowerCase() === "long" ? "text-up" : "text-down"}>{x.side.toLowerCase() === "long" ? (zh ? "多" : "L") : (zh ? "空" : "S")}</span>
                  <span className="font-medium">{coinOf(x.symbol)}</span>
                  <span className="truncate text-muted-foreground tabular-nums">{price(x.entry)} → {price(x.exit)}{x.hold ? ` · ${x.hold}` : ""}</span>
                </span>
                <span className={cn("shrink-0 font-medium tabular-nums", tone(x.pnl))}>{signedUsd(x.pnl)}</span>
              </div>
            ))
          )}
        </section>
      </CardContent>
    </Card>
  );
}

export function AiArena() {
  const { t } = useApp();
  const now = useNow();
  const { data, isLoading } = useAiArena();
  const market = useAiMarket();
  const traders = data?.traders ?? [];

  return (
    <section className="space-y-3">
      <Card className="border-primary/30">
        <CardContent className="space-y-2 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold">
            <Swords className="size-4 text-primary" /> {t("arena.title")}
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-down/15 px-2 py-0.5 text-[10px] font-semibold text-down">
              <Radio className="size-3" /> {t("arena.live")}
            </span>
          </h2>
          <p className="leading-relaxed text-muted-foreground">{t("arena.body")}</p>
          {isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : traders.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t("arena.pending")}</p>
          ) : (
            <>
              {traders.length > 1 && <p className="text-[11px] text-muted-foreground">{t("arena.shared")}</p>}
              <p className="text-[11px] text-muted-foreground">{t("arena.notAdvice")}</p>
            </>
          )}
        </CardContent>
      </Card>
      {traders.map((tr, i) => <TraderCard key={tr.id} tr={tr} rank={i + 1} now={now} market={market.data} />)}
    </section>
  );
}
