"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time,
} from "lightweight-charts";
import { useApp } from "@/components/providers";

export type Bar = { time: number; open: number; high: number; low: number; close: number };
export type DecisionMark = { time: number; kind: "wait" | "long" | "short" | "close" | "hold"; text: string };
export type PriceMark = { price: number; color: "up" | "down" | "muted"; title: string };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 5m candles with the AI's decision of every cycle pinned to its bar, plus entry / stop / target lines. */
export function DecisionChart({ bars, live, marks, lines, className }: {
  bars: Bar[]; live: number; marks: DecisionMark[]; lines: PriceMark[]; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastRef = useRef<Bar | null>(null);
  const { theme } = useApp();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: cssVar("--muted-foreground"), fontFamily: cssVar("--font-mono"), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--border") } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      crosshair: { vertLine: { labelBackgroundColor: cssVar("--accent") }, horzLine: { labelBackgroundColor: cssVar("--accent") } },
      handleScroll: { vertTouchDrag: false },
      localization: { locale: "en-US" },
    });
    const up = cssVar("--up"), down = cssVar("--down");
    seriesRef.current = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
    markersRef.current = createSeriesMarkers(seriesRef.current, []);
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = seriesRef.current = markersRef.current = null;
      linesRef.current = [];
      lastRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !bars.length) return;
    const offset = -new Date().getTimezoneOffset() * 60;
    s.setData(bars.map((b) => ({ ...b, time: (b.time + offset) as Time })));
    lastRef.current = { ...bars[bars.length - 1], time: bars[bars.length - 1].time + offset };
    chartRef.current?.timeScale().scrollToRealTime();
  }, [bars, theme]);

  useEffect(() => {
    const s = seriesRef.current, last = lastRef.current;
    if (!s || !last || !live) return;
    const bar = { ...last, close: live, high: Math.max(last.high, live), low: Math.min(last.low, live) };
    lastRef.current = bar;
    s.update({ ...bar, time: bar.time as Time });
  }, [live]);

  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    const offset = -new Date().getTimezoneOffset() * 60;
    const up = cssVar("--up"), down = cssVar("--down"), muted = cssVar("--muted-foreground");
    const list: SeriesMarker<Time>[] = marks
      .filter((d) => bars.length && d.time >= bars[0].time)
      .map((d) => ({
        time: (Math.floor(d.time / 300) * 300 + offset) as Time,
        position: (d.kind === "short" ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
        shape: (d.kind === "long" ? "arrowUp" : d.kind === "short" ? "arrowDown" : d.kind === "close" ? "square" : "circle") as "arrowUp" | "arrowDown" | "square" | "circle",
        color: d.kind === "long" ? up : d.kind === "short" ? down : d.kind === "close" ? cssVar("--primary") : `${muted}88`,
        size: d.kind === "wait" || d.kind === "hold" ? 0.6 : 1.4,
        text: d.text,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    m.setMarkers(list);
  }, [marks, bars, theme]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    linesRef.current.forEach((l) => s.removePriceLine(l));
    const color = { up: cssVar("--up"), down: cssVar("--down"), muted: cssVar("--muted-foreground") };
    linesRef.current = lines
      .filter((l) => l.price > 0)
      .map((l) => s.createPriceLine({ price: l.price, color: color[l.color], lineWidth: 1, lineStyle: l.color === "muted" ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
  }, [lines, theme]);

  return <div ref={ref} className={className} />;
}
