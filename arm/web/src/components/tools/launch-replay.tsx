"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Pause, Play, RotateCcw, Rocket } from "lucide-react";
import { useApp } from "@/components/providers";
import { Addr } from "@/components/shared";
import { useReplay, useReplayList, type ReplayDetail, type ReplayRole } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ROLES: ReplayRole[] = ["dev", "bundle", "bot", "smart", "retail"];
export const COLOR: Record<ReplayRole, string> = { dev: "#a855f7", bundle: "#f97316", bot: "#ef4444", smart: "#eab308", retail: "#38bdf8" };
const EMOJI: Record<ReplayRole, string> = { dev: "👨‍💻", bundle: "📦", bot: "🤖", smart: "🐋", retail: "🧑" };
const SPEEDS = [60_000, 30_000, 15_000];
const TICKS = [15, 60, 300, 900, 3600];

const money = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(1)}K` : `${s}$${a.toFixed(a < 10 ? 1 : 0)}`;
};
const times = (x: number) => (x >= 10 ? `${x.toFixed(1)}x` : `${x.toFixed(2)}x`);
function clock(sec: number, zh: boolean) {
  if (sec < 60) return zh ? `${sec.toFixed(sec < 10 ? 1 : 0)} 秒` : `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const tickLabel = (s: number, zh: boolean) => (s < 60 ? (zh ? `${s}秒` : `${s}s`) : s < 3600 ? (zh ? `${s / 60}分` : `${s / 60}m`) : zh ? "1小时" : "1h");

/** Canvas chart + HUD for one launch; progress `u` runs 0→1 and maps to time as t = u²·window (the first seconds get room). */
function Player({ d }: { d: ReplayDetail }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const [u, setU] = useState(0);
  const uRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const T = d.window || 1;
  const now = u * u * T;
  const shown = useMemo(() => {
    let lo = 0, hi = d.events.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (d.events[m].t <= now) lo = m + 1; else hi = m; }
    return lo;
  }, [d.events, now]);

  // y range on log price multiples, fixed per launch so the chart doesn't rescale while playing
  const range = useMemo(() => {
    const ms = d.events.filter((e) => e.px !== null).map((e) => e.px! / d.p0);
    const lo = Math.min(0.5, ...ms) * 0.9, hi = Math.max(2, ...ms) * 1.15;
    return { lo: Math.log(lo), hi: Math.log(hi) };
  }, [d]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (ts: number) => {
      uRef.current = Math.min(1, uRef.current + (ts - last) / SPEEDS[speed]);
      last = ts;
      setU(uRef.current);
      if (uRef.current >= 1) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = size.w, H = size.h, padL = 34, padB = 18, padT = 8;
    const fg = getComputedStyle(c).color;
    const X = (sec: number) => padL + Math.sqrt(Math.max(0, sec) / T) * (W - padL - 6);
    const Y = (m: number) => padT + (1 - (Math.log(m) - range.lo) / (range.hi - range.lo)) * (H - padT - padB);
    g.clearRect(0, 0, W, H);

    g.font = "10px ui-monospace, monospace";
    g.fillStyle = fg;
    g.strokeStyle = fg;
    for (const m of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
      const y = Y(m);
      if (y < padT || y > H - padB) continue;
      g.globalAlpha = m === 1 ? 0.35 : 0.12;
      g.setLineDash(m === 1 ? [4, 4] : []);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W, y); g.stroke();
      g.globalAlpha = 0.55;
      g.fillText(`${m}x`, 2, y + 3);
    }
    g.setLineDash([]);
    for (const s of TICKS) {
      if (s > T) continue;
      const x = X(s);
      g.globalAlpha = 0.1;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke();
      g.globalAlpha = 0.55;
      g.fillText(tickLabel(s, zh), x - 10, H - 4);
    }

    // price path up to the playhead
    g.globalAlpha = 0.9;
    g.lineWidth = 1.5;
    g.beginPath();
    let started = false;
    for (let i = 0; i < shown; i++) {
      const e = d.events[i];
      if (e.px === null) continue;
      const x = X(e.t), y = Y(e.px / d.p0);
      if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
    }
    g.stroke();

    // bubbles: fill = buy, ring = sell; colour = who; fresh ones pop
    for (let i = 0; i < shown; i++) {
      const e = d.events[i];
      const px = e.px ?? (i ? d.events[i - 1].px : d.p0) ?? d.p0;
      const x = X(e.t), y = Y(px / d.p0);
      const r = Math.max(2, Math.min(14, 1.5 + Math.sqrt(e.usdc) * 0.7));
      const fresh = Math.max(0, 1 - (u - Math.sqrt(e.t / T)) / 0.02);
      g.globalAlpha = 0.75;
      g.fillStyle = g.strokeStyle = COLOR[e.role];
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      if (e.side === 1) g.fill(); else { g.lineWidth = 1.5; g.stroke(); }
      if (fresh > 0) {
        g.globalAlpha = fresh * 0.8;
        g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, r + (1 - fresh) * 14, 0, Math.PI * 2); g.stroke();
      }
    }

    // playhead
    g.globalAlpha = 0.5;
    g.strokeStyle = fg;
    g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X(now), padT); g.lineTo(X(now), H - padB); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }, [d, shown, now, u, T, range, size, zh]);

  const live = useMemo(() => {
    const stat = Object.fromEntries(ROLES.map((r) => [r, { wallets: new Set<number>(), in: 0 }])) as Record<ReplayRole, { wallets: Set<number>; in: number }>;
    for (let i = 0; i < shown; i++) {
      const e = d.events[i];
      stat[e.role].wallets.add(e.w);
      if (e.side === 1) stat[e.role].in += e.usdc;
    }
    return stat;
  }, [d.events, shown]);
  const lastEv = shown ? d.events[shown - 1] : null;
  const lastPx = useMemo(() => {
    for (let i = shown - 1; i >= 0; i--) if (d.events[i].px !== null) return d.events[i].px!;
    return d.p0;
  }, [d.events, d.p0, shown]);
  const fr = d.firstRetail;
  const retailIn = !!fr && now >= fr.t;
  const done = u >= 1;
  const seek = (v: number) => { uRef.current = v; setU(v); };
  const restart = () => { seek(0); setPlaying(true); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0">
          <div className="font-mono text-lg font-bold tabular-nums">
            {t("replay.clock").replace("{t}", clock(now, zh))}
            <span className={cn("ml-2 text-sm", lastPx >= d.p0 ? "text-up" : "text-down")}>{times(lastPx / d.p0)}</span>
          </div>
          <div className="h-4 truncate text-muted-foreground">
            {lastEv && (
              <span key={shown} className="fade-up inline-block">
                {EMOJI[lastEv.role]} {t(`replay.role.${lastEv.role}`)} #{lastEv.w + 1} {lastEv.side === 1 ? t("replay.bought") : t("replay.sold")} {money(lastEv.usdc)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => (done ? restart() : setPlaying(!playing))} className="rounded-md border p-1.5 hover:bg-accent" aria-label="play">
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <button type="button" onClick={restart} className="rounded-md border p-1.5 hover:bg-accent" aria-label="replay"><RotateCcw className="size-3.5" /></button>
          {[0, 1, 2].map((k) => (
            <button key={k} type="button" onClick={() => setSpeed(k)}
              className={cn("rounded-md px-1.5 py-1 text-[11px]", speed === k ? "bg-foreground text-background" : "border hover:bg-accent")}>
              {t(`replay.speed.${k}` as "replay.speed.0")}
            </button>
          ))}
        </div>
      </div>

      <div ref={boxRef} className="relative h-64 w-full text-foreground sm:h-72">
        <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      </div>

      <div className="min-h-[3.25rem]">
        {retailIn && fr && (
          <div className="fade-up rounded-lg border border-[#38bdf8]/40 bg-[#38bdf8]/5 px-2.5 py-1.5 text-[11px] leading-snug">
            <span className="font-semibold text-[#38bdf8]">🧑 {t("replay.firstRetail.title")}</span>
            <br />
            {t("replay.firstRetail.body").replace("{t}", clock(fr.t, zh)).replace("{rank}", String(fr.rank)).replace("{n}", String(d.aheadOfRetail)).replace("{x}", times(fr.x))}
          </div>
        )}
      </div>

      <input type="range" min={0} max={1000} value={Math.round(u * 1000)} aria-label="timeline"
        onChange={(e) => { setPlaying(false); seek(Number(e.target.value) / 1000); }} className="w-full accent-[var(--primary)]" />

      <div className="grid grid-cols-5 gap-1 text-center">
        {ROLES.map((r) => (
          <div key={r} className="rounded-lg bg-muted/40 px-1 py-1.5">
            <div className="text-[10px] text-muted-foreground"><span style={{ color: COLOR[r] }}>●</span> {t(`replay.role.${r}`)}</div>
            <div className="font-mono text-sm font-bold tabular-nums">{live[r].wallets.size}</div>
            <div className="font-mono text-[10px] text-muted-foreground tabular-nums">{money(live[r].in)}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">{t("replay.legend")}</p>

      {done && <Verdict d={d} />}
    </div>
  );
}

function Verdict({ d }: { d: ReplayDetail }) {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const [view, setView] = useState<"now" | "hour">("now");
  const stats = view === "now" ? d.rolesNow : d.roles;
  const max = Math.max(1, ...ROLES.map((r) => Math.abs(stats[r].pnl)));
  const insiders = (["dev", "bundle", "bot"] as const).reduce((s, r) => s + stats[r].pnl, 0);
  return (
    <div className="fade-up space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("replay.verdict")}</h3>
        <div className="flex gap-1 text-[11px]">
          {(["now", "hour"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setView(k)}
              className={cn("rounded-md px-2 py-0.5", view === k ? "bg-foreground text-background" : "border hover:bg-accent")}>
              {t(`replay.view.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <ul className="space-y-1 text-xs leading-relaxed">
        {d.firstRetail && (
          <li>{t("replay.v.first").replace("{t}", clock(d.firstRetail.t, zh)).replace("{n}", String(d.aheadOfRetail)).replace("{x}", times(d.firstRetail.x))}</li>
        )}
        {d.retailAvgX !== null && <li>{t("replay.v.avg").replace("{x}", times(d.retailAvgX))}</li>}
        <li>{t("replay.v.peak").replace("{peak}", times(d.peakPx / d.p0)).replace("{now}", times(d.nowPx / d.p0))}</li>
      </ul>
      <div className="space-y-1">
        {ROLES.filter((r) => stats[r].wallets > 0).map((r) => {
          const s = stats[r];
          return (
            <div key={r} className="flex items-center gap-2 text-[11px]">
              <span className="w-20 shrink-0 truncate">{EMOJI[r]} {t(`replay.role.${r}`)}</span>
              <div className="relative h-3 flex-1 overflow-hidden rounded bg-muted/50">
                <div className={cn("grow-x absolute inset-y-0 left-0 rounded", s.pnl >= 0 ? "bg-up/70" : "bg-down/70")} style={{ width: `${(Math.abs(s.pnl) / max) * 100}%` }} />
              </div>
              <span className={cn("w-16 shrink-0 text-right font-mono tabular-nums", s.pnl >= 0 ? "text-up" : "text-down")}>{s.pnl >= 0 ? "+" : ""}{money(s.pnl)}</span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t(view === "now" ? "replay.v.nowNote" : "replay.v.hourNote")}
        {" "}
        {t("replay.v.insiders").replace("{v}", `${insiders >= 0 ? "+" : ""}${money(insiders)}`).replace("{r}", `${stats.retail.pnl >= 0 ? "+" : ""}${money(stats.retail.pnl)}`)}
      </p>
    </div>
  );
}

export function LaunchReplay() {
  const { t, locale } = useApp();
  const zh = locale === "zh";
  const list = useReplayList();
  const [picked, setPicked] = useState<string | null>(null);
  const launches = list.data?.status === "ready" ? list.data.launches : [];
  const pool = picked ?? launches[0]?.pool;
  const detail = useReplay(pool);
  const cur = launches.find((l) => l.pool === pool);

  return (
    <section className="space-y-3">
      <Card className="border-primary/30">
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 font-semibold"><Rocket className="size-4 text-primary" /> {t("replay.title")}</h2>
          <p className="leading-relaxed text-muted-foreground">{t("replay.body")}</p>
          {list.isLoading ? (
            <div className="flex justify-center py-4"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : list.data?.status === "syncing" ? (
            <p className="text-xs text-muted-foreground">{t("scan.syncing").replace("{p}", String(Math.round(list.data.progress * 100)))}</p>
          ) : (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
              {launches.map((l) => (
                <button key={l.pool} type="button" onClick={() => setPicked(l.pool)}
                  className={cn("shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-xs", l.pool === pool ? "border-primary bg-primary/10" : "hover:bg-accent")}>
                  <div className="max-w-28 truncate font-semibold">{l.symbol || "?"}</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {t("scan.buyers").replace("{n}", String(l.buyers))} · {new Date(l.bornAt).toLocaleDateString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pool && (
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            {cur && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="font-semibold">{cur.symbol || "?"}</span>
                  <Addr value={cur.token} head={6} tail={4} className="text-[10px]" />
                </span>
                <span className="flex items-center gap-2.5 text-muted-foreground">
                  <a href={`/tools?tab=holders&token=${cur.token}`} className="hover:text-foreground hover:underline">{t("scan.holders")}</a>
                  <a href={`https://www.geckoterminal.com/arc/pools/${cur.pool}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline">
                    GeckoTerminal <ExternalLink className="size-3" />
                  </a>
                </span>
              </div>
            )}
            {detail.isLoading || !detail.data ? (
              <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <Player key={pool} d={detail.data} />
                {detail.data.truncated && (
                  <p className="text-[10px] text-muted-foreground">{t("replay.truncated").replace("{n}", String(detail.data.events.length)).replace("{t}", clock(detail.data.window, zh))}</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("replay.note")}</p>
    </section>
  );
}
