"use client";

import { useEffect, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, HistogramSeries, LastPriceAnimationMode, LineStyle, LineType, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type SeriesType } from "lightweight-charts";
import { useApp } from "@/components/providers";
import { TokenAvatar } from "@/components/shared";
import { fmtSmall } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** Trades drawn on the chart as one bubble per candle and side: count + up to two faces. */
export type ChartMarker = { key: string; time: number; price: number; side: "buy" | "sell"; count: number; faces: { seed: string; image?: string | null }[]; mine?: boolean };

const AVG_COLOR = "#3b82f6";

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** "$0.0₅333" style: the zero run after the point as a subscript, ~3–4 significant digits. */
export const chartPrice = (p: number) => {
  if (!Number.isFinite(p)) return "";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p <= 0) return "$0.00";
  return `$${fmtSmall(p)}`;
};

export function PriceChart({
  candles,
  className,
  mode = "candle",
  pumpStyle = false,
  avg,
  markers,
  onMarker,
}: {
  candles: Candle[];
  className?: string;
  mode?: "candle" | "area";
  /** wallet coin page look: dotted background, no grid, subscript price scale, colored dashed last-price line */
  pumpStyle?: boolean;
  /** my average entry: blue dashed line tagged "Avg" */
  avg?: number | null;
  markers?: ChartMarker[];
  onMarker?: (m: ChartMarker) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const [ver, setVer] = useState(0);
  const { theme } = useApp();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const up = cssVar(el, "--up");
    const down = cssVar(el, "--down");
    const muted = cssVar(el, "--muted-foreground");
    const line = cssVar(el, "--border");
    const labelBg = cssVar(el, "--accent");
    const mono = cssVar(el, "--font-mono");

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: muted, fontFamily: mono, fontSize: 11, attributionLogo: !pumpStyle },
      grid: pumpStyle ? { vertLines: { visible: false }, horzLines: { visible: false } } : { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderVisible: false, scaleMargins: pumpStyle ? { top: 0.12, bottom: 0.08 } : { top: 0.1, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: pumpStyle ? 6 : 0 },
      crosshair: { vertLine: { color: muted, labelBackgroundColor: labelBg }, horzLine: { color: muted, labelBackgroundColor: labelBg } },
      handleScroll: { vertTouchDrag: false },
      localization: pumpStyle ? { priceFormatter: chartPrice } : undefined,
    });
    chartRef.current = chart;

    // ~4 significant digits regardless of price magnitude (meme prices are often 1e-6..1e-3).
    const last = candles.at(-1)?.close ?? 1;
    const precision = Math.min(12, Math.max(2, -Math.floor(Math.log10(last)) + 3));
    const priceFormat = { type: "price" as const, precision, minMove: Math.pow(10, -precision) };

    if (mode === "area") {
      const rising = (candles.at(-1)?.close ?? 0) >= (candles[0]?.open ?? 0);
      const color = rising ? up : down;
      const series = chart.addSeries(AreaSeries, {
        lineColor: color,
        lineWidth: 2,
        lineType: LineType.Curved,
        topColor: `${color}55`,
        bottomColor: `${color}00`,
        priceLineStyle: LineStyle.Dashed,
        priceLineColor: color,
        lastPriceAnimation: LastPriceAnimationMode.Continuous,
        crosshairMarkerRadius: 4,
        priceFormat,
      });
      series.setData(candles.map((c) => ({ time: c.time as never, value: c.close })));
      seriesRef.current = series as ISeriesApi<SeriesType>;
    } else {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderVisible: false,
        wickUpColor: up,
        wickDownColor: down,
        priceLineStyle: pumpStyle ? LineStyle.Dashed : LineStyle.Dotted,
        priceFormat,
      });
      series.setData(candles.map((c) => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close })));
      seriesRef.current = series as ISeriesApi<SeriesType>;

      const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(candles.map((c) => ({ time: c.time as never, value: c.volume, color: c.close >= c.open ? `${up}55` : `${down}55` })));
    }

    chart.timeScale().fitContent();
    setVer((v) => v + 1);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [candles, theme, mode, pumpStyle]);

  // Avg price line + overlay positions (markers, "Avg" tag) follow the chart's pan / zoom / resize
  const [overlay, setOverlay] = useState<{ avgY: number | null; bubbles: { m: ChartMarker; x: number; y: number }[] }>({ avgY: null, bubbles: [] });
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const el = ref.current;
    if (!chart || !series || !el) return;
    let avgLine: IPriceLine | null = null;
    if (avg != null && avg > 0) avgLine = series.createPriceLine({ price: avg, color: AVG_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: AVG_COLOR, axisLabelTextColor: "#ffffff", title: "" });

    const times = candles.map((c) => c.time);
    const layout = () => {
      const ts = chart.timeScale();
      const h = el.clientHeight;
      const bubbles: { m: ChartMarker; x: number; y: number }[] = [];
      for (const m of markers ?? []) {
        if (times.length && m.time < times[0]) continue;
        const x = ts.timeToCoordinate(m.time as never);
        const y = series.priceToCoordinate(m.price);
        if (x == null || y == null || x < 0 || x > el.clientWidth - 50) continue;
        bubbles.push({ m, x, y: Math.max(12, Math.min(h - 40, y + (m.side === "buy" ? -11 : 11))) });
      }
      const avgY = avg != null && avg > 0 ? series.priceToCoordinate(avg) : null;
      setOverlay({ avgY: avgY != null && avgY > 0 && avgY < h - 24 ? avgY : null, bubbles });
    };
    layout();
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(layout);
    const ro = new ResizeObserver(() => requestAnimationFrame(layout));
    ro.observe(el);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(layout);
      ro.disconnect();
      if (avgLine) {
        try {
          series.removePriceLine(avgLine);
        } catch {}
      }
    };
  }, [ver, avg, markers, candles]);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        className="absolute inset-0"
        style={pumpStyle ? { backgroundImage: "radial-gradient(rgba(140,140,140,0.28) 1px, transparent 1.2px)", backgroundSize: "14px 14px" } : undefined}
      />
      {overlay.avgY != null && (
        <span className="pointer-events-none absolute left-1 rounded px-1 text-[10px] font-semibold" style={{ top: overlay.avgY, color: AVG_COLOR, transform: "translateY(-120%)" }}>
          Avg
        </span>
      )}
      {overlay.bubbles.map(({ m, x, y }) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onMarker?.(m)}
          className={cn("absolute flex h-[18px] items-center rounded-full border border-black/60 pr-px text-[10px] leading-none font-bold text-black shadow transition active:scale-90", m.count > 1 ? "pl-1" : "pl-px", m.side === "buy" ? "bg-up" : "bg-down", m.mine && "border-2 border-[#3b82f6]")}
          style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}
        >
          {m.count > 1 && <span className="pr-0.5">{m.count}</span>}
          {m.faces.slice(0, 2).map((f, i) => (
            <TokenAvatar key={f.seed} symbol="" seed={f.seed} logo={f.image ?? undefined} size={14} className={cn("rounded-full border border-black/50", i > 0 && "-ml-1")} />
          ))}
        </button>
      ))}
    </div>
  );
}
