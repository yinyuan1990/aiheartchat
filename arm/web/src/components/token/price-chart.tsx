"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi } from "lightweight-charts";
import { useApp } from "@/components/providers";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function PriceChart({ candles, className }: { candles: Candle[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { theme } = useApp();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const up = cssVar("--up");
    const down = cssVar("--down");
    const muted = cssVar("--muted-foreground");
    const line = cssVar("--border");
    const labelBg = cssVar("--accent");
    const mono = cssVar("--font-mono");

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: muted, fontFamily: mono, fontSize: 11 },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: muted, labelBackgroundColor: labelBg }, horzLine: { color: muted, labelBackgroundColor: labelBg } },
      handleScroll: { vertTouchDrag: false },
    });
    chartRef.current = chart;

    // ~4 significant digits regardless of price magnitude (meme prices are often 1e-6..1e-3).
    const last = candles.at(-1)?.close ?? 1;
    const precision = Math.min(12, Math.max(2, -Math.floor(Math.log10(last)) + 3));

    const series = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: "price", precision, minMove: Math.pow(10, -precision) },
    });
    series.setData(candles.map((c) => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close })));

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(
      candles.map((c) => ({
        time: c.time as never,
        value: c.volume,
        color: c.close >= c.open ? `${up}55` : `${down}55`,
      })),
    );

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, theme]);

  return <div ref={ref} className={className} />;
}
