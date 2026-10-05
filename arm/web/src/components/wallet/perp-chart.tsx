"use client";

import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, HistogramSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi } from "lightweight-charts";
import { CircleNotch } from "@phosphor-icons/react";
import { useApp } from "@/components/providers";
import { storeRead, storeWrite } from "@/lib/wallet/native";
import { cn } from "@/lib/utils";
import { CANDLE_MS, candles, mids, type Candle, type CandleInterval } from "@/lib/wallet/hl";
import { t } from "@/lib/wallet/i18n";

/**
 * Perp K-line for 「AI 合约」. Hyperliquid's finest candle is 1 minute; the last bar still moves every second from the
 * relay's shared mid price, and the snapshot is re-read each minute to pick up the exchange's own high / low / volume.
 */

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const BARS = 200;
export type ChartLine = { price: number; color: string; title: string };

const cssVar = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();
const toBar = (c: Candle) => ({ time: (c.t / 1000) as never, open: c.o, high: c.h, low: c.l, close: c.c });

export function PerpChart({ coin, lines, onPrice, className }: { coin: string; lines?: ChartLine[]; onPrice?: (p: number) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [interval, setIntervalKey] = useState<CandleInterval>("15m");
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const { theme } = useApp();
  const chartRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram"> } | null>(null);
  const onPriceRef = useRef(onPrice);
  onPriceRef.current = onPrice;

  useEffect(() => {
    void storeRead("perp.interval").then((v) => v && (INTERVALS as string[]).includes(v) && setIntervalKey(v as CandleInterval));
  }, []);
  const pick = (k: CandleInterval) => {
    setIntervalKey(k);
    void storeWrite("perp.interval", k);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dead = false;
    const up = cssVar(el, "--up") || "#16a34a";
    const down = cssVar(el, "--down") || "#dc2626";
    const muted = cssVar(el, "--muted-foreground");
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: muted, fontFamily: cssVar(el, "--font-mono"), fontSize: 10, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar(el, "--border") } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScroll: { vertTouchDrag: false },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceLineStyle: LineStyle.Dashed });
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chartRef.current = { chart, series, vol };
    const ms = CANDLE_MS[interval];
    let last: Candle | null = null;
    const volBar = (c: Candle) => ({ time: (c.t / 1000) as never, value: c.v, color: c.c >= c.o ? `${up}55` : `${down}55` });

    const load = async (first: boolean) => {
      const cs = await candles(coin, interval, BARS);
      if (dead || !cs.length) return;
      if (first) {
        const px = cs.at(-1)!.c;
        const precision = Math.min(8, Math.max(1, -Math.floor(Math.log10(px)) + 4));
        series.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
        series.setData(cs.map(toBar));
        vol.setData(cs.map(volBar));
        chart.timeScale().scrollToRealTime();
        setState("ok");
      } else {
        for (const c of cs.filter((c) => !last || c.t >= last.t)) {
          series.update(toBar(c));
          vol.update(volBar(c));
        }
      }
      if (!last || cs.at(-1)!.t >= last.t) last = cs.at(-1)!;
    };
    const tick = async () => {
      if (dead || !last || document.hidden) return;
      const p = (await mids([coin]).catch(() => ({}) as Record<string, number>))[coin];
      if (dead || !p || !last) return;
      onPriceRef.current?.(p);
      const t = Math.floor(Date.now() / ms) * ms;
      last = t > last.t ? { t, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 } : { ...last, h: Math.max(last.h, p), l: Math.min(last.l, p), c: p };
      series.update(toBar(last));
      vol.update(volBar(last));
    };

    setState("loading");
    load(true).catch(() => !dead && setState("error"));
    const t1 = setInterval(() => void tick(), 1_000);
    const t2 = setInterval(() => void load(false).catch(() => {}), 60_000);
    return () => {
      dead = true;
      clearInterval(t1);
      clearInterval(t2);
      chart.remove();
      chartRef.current = null;
    };
  }, [coin, interval, theme]);

  // entry / liquidation / TP / SL of the current position
  const key = JSON.stringify(lines ?? []);
  useEffect(() => {
    const c = chartRef.current;
    if (!c || state !== "ok") return;
    const made: IPriceLine[] = (lines ?? []).filter((l) => l.price > 0).map((l) => c.series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    return () => {
      for (const p of made) {
        try {
          c.series.removePriceLine(p);
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state, coin, interval, theme]);

  return (
    <div className={className}>
      <div className="relative h-[260px]">
        <div ref={ref} className="absolute inset-0" />
        {state !== "ok" && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">{state === "loading" ? <CircleNotch size={22} className="animate-spin" /> : t("cw.perp.chartError")}</div>}
      </div>
      <div className="mt-1 flex gap-0.5">
        {INTERVALS.map((k) => (
          <button key={k} type="button" onClick={() => pick(k)} className={cn("h-7 rounded-full px-2.5 text-[12px] font-medium", k === interval ? "bg-muted text-foreground" : "text-muted-foreground")}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}
