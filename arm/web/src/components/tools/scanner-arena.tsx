"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Radar, ScanSearch, Zap } from "lucide-react";
import { useApp } from "@/components/providers";
import { Addr } from "@/components/shared";
import { useScanner, type RadarItem, type ScanBot, type ScanBotId, type ScanState } from "@/lib/api";
import { signedPct } from "@/app/card/card-format";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNow } from "./ai-arena";
import { QuickBuy } from "./quick-buy";
import { DrawSparkline, RadarScope, ScanTicker, useCountUp } from "./scanner-motion";

type Ready = Extract<ScanState, { status: "ready" }>;

const EMOJI: Record<ScanBotId, string> = { sniper: "🎯", filter: "🛡️", smart: "🐋", random: "🎲" };
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground");
const signedU = (v: number) => `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(2)}u`;
const times = (x: number) => (x >= 100 ? `${x.toFixed(0)}x` : x >= 10 ? `${x.toFixed(1)}x` : `${x.toFixed(2)}x`);
const vol = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));

function ago(ms: number, zh: boolean) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  if (s < 3600) return zh ? `${Math.floor(s / 60)} 分钟` : `${Math.floor(s / 60)}m`;
  return zh ? `${Math.floor(s / 3600)} 小时` : `${Math.floor(s / 3600)}h`;
}

function Stat({ label, value, suffix = "", sub, className }: { label: string; value: number; suffix?: string; sub?: string; className?: string }) {
  const v = useCountUp(value);
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-base font-bold tabular-nums", className)}>{Math.round(v)}{suffix}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function BotRow({ bot, rank, rules, smartWallets, open, onToggle }: {
  bot: ScanBot; rank: number; rules: Ready["rules"]; smartWallets: number; open: boolean; onToggle: () => void;
}) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const pnl = useCountUp(bot.pnl, 1600);
  const roi = useCountUp(bot.roi, 1600);
  const rule = t(`scan.rule.${bot.id}`)
    .replace("{buyers}", String(rules.filter.buyers)).replace("{vol}", String(rules.filter.volume))
    .replace("{top3}", String(Math.round(rules.filter.top3 * 100))).replace("{n}", String(smartWallets));
  return (
    <div className="rounded-xl border bg-background/40">
      <button type="button" onClick={onToggle} className="w-full space-y-2 p-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-semibold">
              <span className="text-muted-foreground">#{rank}</span>
              <span>{EMOJI[bot.id]}</span>
              <span>{t(`scan.bot.${bot.id}`)}</span>
              <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{rule}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className={cn("font-mono text-lg font-bold tabular-nums", tone(bot.pnl))}>{signedU(pnl)}</div>
            <div className={cn("text-[11px] tabular-nums", tone(bot.roi))}>{signedPct(roi)}</div>
          </div>
        </div>
        <DrawSparkline points={bot.curve} up={bot.pnl >= 0} />
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          <span>{t("scan.trades").replace("{n}", bot.trades.toLocaleString("en-US"))}</span>
          <span>{t("scan.win")} {bot.trades ? Math.round((bot.wins / bot.trades) * 100) : 0}%</span>
          {bot.best > 0 && <span>{t("scan.best").replace("{x}", times(bot.best))}</span>}
          {bot.open > 0 && <span>{t("scan.open").replace("{n}", String(bot.open))}</span>}
        </div>
      </button>
      {open && bot.recent.length > 0 && (
        <div className="space-y-1 border-t px-3 py-2">
          <div className="text-[11px] font-semibold text-muted-foreground">{t("scan.recent")}</div>
          {bot.recent.map((x) => (
            <div key={`${x.pool}-${x.entryAt}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{x.symbol || "?"}</span>
                <span className="shrink-0 text-muted-foreground">
                  {new Date(x.entryAt).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className={cn("shrink-0 rounded px-1 text-[10px]", x.exit === "tp" ? "bg-up/15 text-up" : x.exit === "sl" ? "bg-down/15 text-down" : "bg-muted text-muted-foreground")}>
                  {t(`scan.exit.${x.exit}`)}
                </span>
              </span>
              <span className={cn("shrink-0 font-mono tabular-nums", tone(x.pnl))}>{times(x.x)} · {signedU(x.pnl)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RadarRow({ r, now, delay }: { r: RadarItem; now: number; delay: number }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const [buying, setBuying] = useState(false);
  const [enterDelay] = useState(delay);
  const fresh = now - r.bornAt < 600_000;
  const verdictCls = r.verdict === "buy" ? "bg-up/15 text-up" : r.verdict === "skip" ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary";
  return (
    <div style={{ animationDelay: `${enterDelay}ms` }} className="fade-up">
    <div className={cn("space-y-1.5 rounded-lg border px-3 py-2", fresh && "border-up/40 bg-up/5", r.dead && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {fresh && (
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-up" />
            </span>
          )}
          <span className="truncate text-sm font-semibold">{r.symbol || "?"}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{now ? t("scan.age").replace("{t}", ago(now - r.bornAt, zh)) : ""}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {r.bots.map((b) => <span key={b} title={t(`scan.bot.${b}`)} className="text-xs">{EMOJI[b]}</span>)}
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", verdictCls)}>
            {r.verdict === "pending" && <Loader2 className="mr-0.5 inline size-2.5 animate-spin" />}
            {t(`scan.verdict.${r.verdict}`)}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <Addr value={r.token} head={6} tail={4} className="text-[10px]" />
        <span className="text-muted-foreground tabular-nums">{t("scan.buyers").replace("{n}", String(r.buyers))} · {t("scan.vol").replace("{v}", vol(r.volume))}</span>
        {r.score !== null && <span className="rounded bg-muted px-1 tabular-nums">{t("scan.score")} <span className="font-mono">{r.score}</span></span>}
        {r.reasons.map((k) => (
          <span key={k} className={cn("rounded px-1", k === "pass" || k === "smart" ? "bg-up/10 text-up" : "bg-down/10 text-down")}>{t(`scan.reason.${k}`)}</span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="text-muted-foreground">
          {t("scan.since")} <span className={cn("font-mono font-semibold", tone(r.nowX - 1))}>{r.nowX ? times(r.nowX) : "—"}</span>
          {r.peakX > 1.05 && <> · {t("scan.peak").replace("{x}", times(r.peakX))}</>}
          {r.dead && <span className="ml-1.5 rounded bg-muted px-1 text-[10px]">{t("scan.dead")}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <a href={`/tools?tab=holders&token=${r.token}`} className="text-muted-foreground hover:text-foreground hover:underline">{t("scan.holders")}</a>
          <button type="button" onClick={() => setBuying(true)}
            className={cn("inline-flex items-center gap-0.5 rounded-md px-2 py-0.5 font-semibold", r.verdict === "buy" && !r.dead ? "bg-primary text-primary-foreground" : "border text-foreground hover:bg-accent")}>
            <Zap className="size-3" /> {t("scan.buy.button")}
          </button>
        </span>
      </div>
      {buying && <QuickBuy item={r} open={buying} onClose={() => setBuying(false)} />}
    </div>
    </div>
  );
}

export function ScannerArena() {
  const { t } = useApp();
  const now = useNow();
  const { data, isLoading } = useScanner();
  const [openBot, setOpenBot] = useState<ScanBotId | null>(null);
  const [busyOnly, setBusyOnly] = useState(true);

  if (isLoading || !data) return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  if (data.status === "syncing")
    return <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t("scan.syncing").replace("{p}", String(Math.round(data.progress * 100)))}</p>;

  const { stats, rules, bots, radar } = data;
  const fill = (s: string) => s.replace("{start}", String(rules.start)).replace("{stake}", String(rules.stake))
    .replace("{cost}", String(Math.round(rules.cost * 100))).replace("{tp}", String(rules.tp)).replace("{hold}", String(rules.holdHours));
  const rows = busyOnly ? radar.filter((r) => r.buyers >= 3 || (r.buyers >= 2 && now - r.bornAt < 600_000)) : radar;
  const deadRate = stats.skipped ? stats.skippedDead / stats.skipped : 0;

  return (
    <section className="space-y-3">
      <Card className="border-primary/30">
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold">
            <ScanSearch className="size-4 text-primary" /> {t("scan.title")}
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-down/15 px-2 py-0.5 text-[10px] font-semibold text-down">
              <Radar className="size-3 animate-pulse" /> {t("arena.live")}
            </span>
          </h2>
          <p className="leading-relaxed text-muted-foreground">{fill(t("scan.body"))}</p>
          <div className="flex items-center gap-3">
            <RadarScope items={radar} className="w-28 shrink-0 sm:w-36" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <ScanTicker items={radar} />
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <Stat label={t("scan.scanned")} value={stats.scanned} />
                <Stat label={t("scan.passed")} value={stats.passed} className="text-up" />
                <Stat label={t("scan.deadRate")} value={Math.round(deadRate * 100)} suffix="%" sub={`${stats.skippedDead}/${stats.skipped}`} className="text-down" />
                <Stat label={t("scan.alive")} value={stats.alive} />
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{fill(t("scan.paper"))}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("scan.board").replace("{days}", String(rules.days))}</h3>
          {bots.map((b, i) => (
            <BotRow key={b.id} bot={b} rank={i + 1} rules={rules} smartWallets={stats.smartWallets}
              open={openBot === b.id} onToggle={() => setOpenBot(openBot === b.id ? null : b.id)} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Radar className="size-3.5 text-primary" /> {t("scan.radar")}</h3>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={busyOnly} onChange={(e) => setBusyOnly(e.target.checked)} className="accent-[var(--primary)]" />
              {t("scan.onlyBusy")}
            </label>
          </div>
          {!!stats.devOnly && <p className="text-[11px] text-muted-foreground">{t("scan.devOnly").replace("{n}", String(stats.devOnly))}</p>}
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("scan.empty")}</p>
          ) : (
            <div className="max-h-[36rem] space-y-1.5 overflow-y-auto pr-0.5">
              {rows.map((r, i) => <RadarRow key={r.pool} r={r} now={now} delay={Math.min(i, 12) * 60} />)}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
