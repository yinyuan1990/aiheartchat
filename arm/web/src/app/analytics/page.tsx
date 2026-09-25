"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { usd, useAnalytics } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/format";
import { addrUrl } from "@/lib/web3";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Window = "day" | "all";

/** pons-style protocol analytics: one KPI strip with a 24h / all-time toggle and two daily charts. */
export default function AnalyticsPage() {
  const { t } = useApp();
  const { data, isLoading } = useAnalytics();
  const [win, setWin] = useState<Window>("day");

  const scope = data ? (win === "day" ? data.day : data.allTime) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Card>
        <CardContent className="md:px-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("analytics.title")}</h1>
              <p className="mt-1 text-sm text-secondary-foreground">{t("analytics.subtitle")}</p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-up" /> {t("analytics.live")}
                {data && <span className="font-mono">· {t("analytics.latestDay")} {data.latestDay}</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Tabs value={win} onValueChange={(v) => setWin(v as Window)}>
                <TabsList>
                  <TabsTrigger value="day" className="font-mono text-xs">{t("analytics.window.day")}</TabsTrigger>
                  <TabsTrigger value="all" className="font-mono text-xs">{t("analytics.window.all")}</TabsTrigger>
                </TabsList>
              </Tabs>
              {data && (
                <Button variant="outline" size="sm" asChild>
                  <a href={addrUrl(data.source.factory)} target="_blank" rel="noreferrer"><ExternalLink /> {t("analytics.viewOnchain")}</a>
                </Button>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {isLoading || !scope ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <Kpi label={t("analytics.volume")} value={fmtUsd(usd(scope.volumeUsdc), { compact: true })} sub={`${fmtNum(scope.trades)} ${t("analytics.trades")} · ${fmtNum(scope.traders)} ${t("analytics.traders")}`} tone="up" />
                <Kpi label={t("analytics.launches")} value={fmtNum(scope.launches)} sub={win === "all" && data ? `${t("analytics.graduated")} ${fmtNum(data.allTime.graduated)}` : undefined} tone="primary" />
                <Kpi label={t("analytics.fees")} value={fmtUsd(usd(scope.feesUsdc))} sub={win === "all" && data ? `${t("analytics.creatorPaid")} ${fmtUsd(usd(data.allTime.feesCreatorUsdc))}` : undefined} tone="gold" />
              </>
            )}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">{t("analytics.footnote")} <Link href="/docs#integration" className="hover:text-foreground hover:underline">{t("nav.docs")} →</Link></p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </>
        ) : (
          <>
            <DailyChart
              title={t("analytics.volume")}
              headline={fmtUsd(usd(win === "day" ? data.day.volumeUsdc : data.allTime.volumeUsdc), { compact: true })}
              data={data.daily.map((d) => ({ day: d.day, v: usd(d.volumeUsdc) }))}
              latestDay={data.latestDay}
              fmt={(v) => fmtUsd(v, { compact: true })}
              color="bg-up"
              hint={t("analytics.chartHint")}
            />
            <DailyChart
              title={t("analytics.launches")}
              headline={fmtNum(win === "day" ? data.day.launches : data.allTime.launches)}
              data={data.daily.map((d) => ({ day: d.day, v: d.launches }))}
              latestDay={data.latestDay}
              fmt={(v) => String(v)}
              color="bg-primary"
              hint={t("analytics.chartHint")}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "up" | "primary" | "gold" }) {
  const accent = { up: "bg-up", primary: "bg-primary", gold: "bg-gold" }[tone];
  return (
    <div className="relative rounded-xl bg-muted p-4">
      <span className={cn("absolute top-4 bottom-4 left-0 w-0.5 rounded-r-full", accent)} />
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tracking-tight tabular md:text-3xl">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** 30-day daily bars; the latest completed UTC day is highlighted, today (partial) is dimmed. */
function DailyChart({ title, headline, data, latestDay, fmt, color, hint }: { title: string; headline: string; data: { day: string; v: number }[]; latestDay: string; fmt: (v: number) => string; color: string; hint: string }) {
  const max = Math.max(1e-9, ...data.map((d) => d.v));
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <div className="font-mono text-xl font-semibold tabular">{headline}</div>
      </CardHeader>
      <CardContent>
        <div className="flex h-40 items-end gap-[3px]">
          {data.map((d) => {
            const isLatest = d.day === latestDay;
            const isToday = d.day > latestDay;
            return (
              <div key={d.day} className="group relative flex-1">
                <div
                  className={cn("w-full rounded-t-sm transition-opacity", color, isLatest ? "opacity-100 ring-2 ring-foreground/40" : isToday ? "opacity-30" : "opacity-60 group-hover:opacity-90")}
                  style={{ height: `${Math.max(2, (d.v / max) * 156)}px` }}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded bg-popover px-2 py-1 font-mono text-[10px] whitespace-nowrap shadow group-hover:block">
                  {d.day.slice(5)} · {fmt(d.v)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>{data[0]?.day.slice(5)}</span>
          <span className="text-foreground">{latestDay.slice(5)}</span>
          <span>{data[data.length - 1]?.day.slice(5)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
