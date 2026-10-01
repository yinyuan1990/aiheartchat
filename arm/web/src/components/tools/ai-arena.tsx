"use client";

import { Brain, ChevronDown, Loader2, Radio, Swords } from "lucide-react";
import { useApp } from "@/components/providers";
import { useAiArena, type ArenaTrader } from "@/lib/api";
import { signedPct, signedUsd, usdShort } from "@/app/card/card-format";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ACTION_ZH: Record<string, string> = {
  open_long: "开多", open_short: "开空", close_long: "平多", close_short: "平空", hold: "持有", wait: "观望",
};
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground");
const coin = (s: string) => s.replace(/USDT?$/, "");
const price = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 1 : v >= 1 ? 3 : 6 });

function Sparkline({ points, up }: { points: [number, number][]; up: boolean }) {
  if (points.length < 2) return <div className="h-14" />;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = points
    .map(([x, y], i) => `${i ? "L" : "M"}${(((x - x0) / (x1 - x0 || 1)) * 300).toFixed(1)},${(56 - ((y - y0) / (y1 - y0 || 1)) * 52 - 2).toFixed(1)}`)
    .join("");
  return (
    <svg viewBox="0 0 300 56" preserveAspectRatio="none" className={cn("h-14 w-full", up ? "text-up" : "text-down")}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TraderCard({ tr, rank }: { tr: ArenaTrader; rank: number }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const latest = tr.decisions[0];
  const when = (s: string | number) => new Date(s).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

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
            <div className="text-xs text-muted-foreground">{tr.model} · {tr.exchange}</div>
          </div>
          <div className="text-right">
            <div className={cn("text-xl font-bold tabular-nums", tone(tr.pnl))}>{signedPct(tr.pnlPct / 100)}</div>
            <div className={cn("text-xs tabular-nums", tone(tr.pnl))}>{signedUsd(tr.pnl)}</div>
          </div>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{t("arena.equity")}</span>
            <span className="font-medium text-foreground tabular-nums">{usdShort(tr.equity)}</span>
          </div>
          <Sparkline points={tr.curve} up={tr.pnl >= 0} />
        </div>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("arena.positions")}</h3>
          {tr.positions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("arena.noPositions")}</p>
          ) : (
            tr.positions.map((p) => (
              <div key={p.symbol + p.side} className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className={cn("rounded px-1.5 py-0.5 font-semibold", p.side.toLowerCase() === "long" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                    {p.side.toLowerCase() === "long" ? (zh ? "多" : "Long") : (zh ? "空" : "Short")} {p.leverage}x
                  </span>
                  <span className="font-medium">{coin(p.symbol)}</span>
                  <span className="text-muted-foreground tabular-nums">@ {price(p.entry)}</span>
                </span>
                <span className={cn("font-medium tabular-nums", tone(p.upnl))}>{signedUsd(p.upnl)}</span>
              </div>
            ))
          )}
        </section>

        {latest && (
          <section className="space-y-1.5">
            <h3 className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
              <span className="flex items-center gap-1"><Brain className="size-3.5" /> {t("arena.decision")}</span>
              <span className="font-normal">{when(latest.time)}</span>
            </h3>
            {latest.actions.map((a, i) => (
              <div key={i} className="rounded-lg border px-3 py-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  <span>{zh ? ACTION_ZH[a.action] ?? a.action : a.action.replace("_", " ")}</span>
                  {a.symbol && <span>{coin(a.symbol)}</span>}
                  {a.leverage > 0 && <span className="text-muted-foreground">{a.leverage}x</span>}
                  {a.confidence > 0 && <span className="ml-auto text-muted-foreground">{t("arena.confidence")} {a.confidence}</span>}
                </div>
                {a.reasoning && <p className="mt-1 leading-relaxed text-muted-foreground">{a.reasoning}</p>}
              </div>
            ))}
            {latest.thought && (
              <details className="group rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                  {t("arena.thought")} <ChevronDown className="size-3.5 transition group-open:rotate-180" />
                </summary>
                <p className="mt-2 leading-relaxed whitespace-pre-wrap text-muted-foreground">{latest.thought}</p>
              </details>
            )}
          </section>
        )}

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("arena.trades")}</h3>
          {tr.trades.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("arena.noTrades")}</p>
          ) : (
            tr.trades.slice(0, 6).map((x, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={x.side.toLowerCase() === "long" ? "text-up" : "text-down"}>{x.side.toLowerCase() === "long" ? (zh ? "多" : "L") : (zh ? "空" : "S")}</span>
                  <span className="font-medium">{coin(x.symbol)}</span>
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
  const { t, locale } = useApp();
  const { data, isLoading } = useAiArena();
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
            <p className="text-[11px] text-muted-foreground">
              {t("arena.updated")} {new Date(data!.updatedAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US")} · {t("arena.notAdvice")}
            </p>
          )}
        </CardContent>
      </Card>
      {traders.map((tr, i) => <TraderCard key={tr.id} tr={tr} rank={i + 1} />)}
    </section>
  );
}
