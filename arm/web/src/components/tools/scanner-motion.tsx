"use client";

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/providers";
import type { RadarItem } from "@/lib/api";
import { cn } from "@/lib/utils";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases from the previously shown value to `target` whenever it changes (first render counts up from 0). */
export function useCountUp(target: number, ms = 1200) {
  const [v, setV] = useState(0);
  const shown = useRef(0);
  useEffect(() => {
    if (reduced()) {
      const raf = requestAnimationFrame(() => { shown.current = target; setV(target); });
      return () => cancelAnimationFrame(raf);
    }
    const from = shown.current, start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      shown.current = from + (target - from) * (1 - (1 - k) ** 3);
      setV(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** Sweep angle in degrees, clockwise from 12 o'clock. */
function useSweep(period: number) {
  const [a, setA] = useState(0);
  useEffect(() => {
    if (reduced()) return;
    let raf = 0;
    const step = (t: number) => {
      setA(((t % period) / period) * 360);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [period]);
  return a;
}

const SWEEP_MS = 4000;

/** Radar scope: one blip per pool (bearing from its address, newest nearest the centre), lit as the beam passes. */
export function RadarScope({ items, className }: { items: RadarItem[]; className?: string }) {
  const { t } = useApp();
  const angle = useSweep(SWEEP_MS);
  const live = !reduced();
  return (
    <div className={cn("relative aspect-square overflow-hidden rounded-full border border-up/25 bg-[radial-gradient(circle,color-mix(in_oklch,var(--up)_10%,transparent),transparent_70%)]", className)}>
      {[0.33, 0.66].map((s) => (
        <div key={s} className="absolute rounded-full border border-up/15" style={{ inset: `${(1 - s) * 50}%` }} />
      ))}
      <div className="absolute inset-x-0 top-1/2 h-px bg-up/15" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-up/15" />
      {live && (
        <div className="absolute inset-0 rounded-full"
          style={{ background: `conic-gradient(from ${angle - 70}deg, transparent 0deg, color-mix(in oklch, var(--up) 45%, transparent) 70deg, transparent 70.5deg)` }} />
      )}
      {[...items].sort((a, b) => b.bornAt - a.bornAt).map((r, i, all) => {
        const bearing = parseInt(r.pool.slice(2, 10), 16) % 360;
        const dist = (0.12 + (0.8 * i) / Math.max(1, all.length - 1)) * 50;
        const since = (angle - bearing + 360) % 360;
        const glow = live ? Math.max(0.3, 1 - since / 280) : 0.9;
        const color = r.dead ? "text-down" : r.verdict === "buy" ? "text-up" : r.verdict === "pending" ? "text-primary" : "text-muted-foreground";
        const rad = (bearing * Math.PI) / 180;
        return (
          <span key={r.pool} title={`${r.symbol || "?"} · ${t(`scan.verdict.${r.verdict}`)}`}
            className={cn("absolute size-1.5 rounded-full bg-current", color, r.buyers >= 3 && "size-2")}
            style={{ left: `${50 + dist * Math.sin(rad)}%`, top: `${50 - dist * Math.cos(rad)}%`, opacity: glow, transform: `translate(-50%,-50%) scale(${1 + Math.max(0, 0.6 - since / 60)})`, boxShadow: since < 40 && live ? "0 0 8px currentColor" : undefined }} />
        );
      })}
      <span className="absolute bottom-[14%] left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-up/70">
        24h · {items.length}
      </span>
    </div>
  );
}

/** Terminal line typing out the newest pools one after another. */
export function ScanTicker({ items }: { items: RadarItem[] }) {
  const { t } = useApp();
  const texts = [...items].sort((a, b) => b.bornAt - a.bornAt).slice(0, 8).map((r) =>
    t("scan.ticker").replace("{sym}", r.symbol || "?").replace("{n}", String(r.buyers)).replace("{v}", t(`scan.verdict.${r.verdict}`)));
  const key = texts.join("|");
  const [s, setS] = useState({ i: 0, n: 0 });
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (!list.length) return;
    const id = setInterval(() => setS((p) => {
      const len = list[p.i % list.length].length;
      return p.n < len + 40 ? { i: p.i, n: p.n + 1 } : { i: p.i + 1, n: 0 };
    }), 45);
    return () => clearInterval(id);
  }, [key]);
  if (!texts.length) return null;
  const text = texts[s.i % texts.length];
  return (
    <div className="truncate rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-up">
      <span className="text-muted-foreground">{t("scan.sweep")} ▸ </span>
      {text.slice(0, s.n)}
      <span className="blink">▍</span>
    </div>
  );
}

/** Sparkline that draws itself in on mount, with a pulsing head. */
export function DrawSparkline({ points, up }: { points: [number, number][]; up: boolean }) {
  if (points.length < 2) return <div className="h-10" />;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const px = (x: number) => ((x - x0) / (x1 - x0 || 1)) * 300;
  const py = (y: number) => 40 - ((y - y0) / (y1 - y0 || 1)) * 36 - 2;
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join("");
  const [lx, ly] = points[points.length - 1];
  return (
    <div className={cn("relative h-10", up ? "text-up" : "text-down")}>
      <svg viewBox="0 0 300 40" preserveAspectRatio="none" className="reveal-x size-full">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute flex size-2 -translate-x-1/2 -translate-y-1/2 fade-up [animation-delay:1.5s]"
        style={{ left: `${(px(lx) / 300) * 100}%`, top: `${(py(ly) / 40) * 100}%` }}>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-current" />
      </span>
    </div>
  );
}
