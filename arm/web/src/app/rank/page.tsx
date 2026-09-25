"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usd, useTokens } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, PctChange, TokenAvatar } from "@/components/shared";

type Metric = "volume" | "gain" | "holders" | "creator";

export default function RankPage() {
  const { t } = useApp();
  const [metric, setMetric] = useState<Metric>("volume");
  const { data, isLoading } = useTokens("volume", "all", "24h", 200);

  const rows = useMemo(() => {
    const xs = [...(data ?? [])];
    switch (metric) {
      case "gain": return xs.sort((a, b) => (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity));
      case "holders": return xs.sort((a, b) => (b.holders ?? 0) - (a.holders ?? 0));
      case "creator": return xs.sort((a, b) => usd(b.feesCreatorUsdcTotal) - usd(a.feesCreatorUsdcTotal));
      default: return xs.sort((a, b) => usd(b.volume24hUsdc) - usd(a.volume24hUsdc));
    }
  }, [data, metric]);
  const pg = usePage(rows, 25);
  const base = (pg.page - 1) * pg.pageSize;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("rank.title")}</h1>
        <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
          <TabsList>
            <TabsTrigger value="volume">{t("rank.byVolume")}</TabsTrigger>
            <TabsTrigger value="gain">{t("rank.byGain")}</TabsTrigger>
            <TabsTrigger value="holders">{t("rank.byHolders")}</TabsTrigger>
            <TabsTrigger value="creator">{t("rank.byCreator")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!isLoading && rows.length === 0 && <Empty>{t("common.noData")}</Empty>}

      {rows.length > 0 && (
        <Card className="hidden py-0 md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>{t("common.token")}</TableHead>
                <TableHead className="text-right">{t("common.price")}</TableHead>
                <TableHead className="text-right">{t("common.change24h")}</TableHead>
                <TableHead className="text-right">{t("common.mcap")}</TableHead>
                <TableHead className="text-right">{t("common.volume24h")}</TableHead>
                <TableHead className="text-right">{t("common.holders")}</TableHead>
                <TableHead className="text-right">{t("rank.byCreator")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pg.pageItems.map((tok, i) => (
                <TableRow key={tok.address}>
                  <TableCell className="font-mono text-muted-foreground">{base + i + 1}</TableCell>
                  <TableCell>
                    <Link href={`/token/${tok.address}`} className="flex items-center gap-3">
                      <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={32} />
                      <div>
                        <div className="flex items-center gap-2 font-semibold">{tok.name}{tok.graduated && <Badge variant="gold">{t("common.graduated")}</Badge>}</div>
                        <div className="font-mono text-xs text-muted-foreground">${tok.symbol}</div>
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtUsd(tok.price)}</TableCell>
                  <TableCell className="text-right"><PctChange value={tok.change24h} /></TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtUsd(tok.mcapUsd, { compact: true })}</TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtUsd(usd(tok.volume24hUsdc), { compact: true })}</TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtNum(tok.holders ?? 0)}</TableCell>
                  <TableCell className="text-right font-mono text-up tabular">{fmtUsd(usd(tok.feesCreatorUsdcTotal))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <div className="space-y-2 md:hidden">
        {pg.pageItems.map((tok, i) => (
          <Link key={tok.address} href={`/token/${tok.address}`} className="block">
            <Card size="sm">
              <CardContent className="flex items-center gap-3">
                <span className={cn("w-5 font-mono text-sm", base + i < 3 ? "text-gold" : "text-muted-foreground")}>{base + i + 1}</span>
                <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="truncate font-semibold">{tok.name}</span><span className="font-mono text-xs text-muted-foreground">${tok.symbol}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {metric === "creator" ? `${t("rank.byCreator")} ${fmtUsd(usd(tok.feesCreatorUsdcTotal))}` : metric === "holders" ? `${fmtNum(tok.holders ?? 0)} ${t("common.holders")}` : `${t("common.volume24h")} ${fmtUsd(usd(tok.volume24hUsdc), { compact: true })}`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm tabular">{fmtUsd(tok.price)}</div>
                  <PctChange value={tok.change24h} className="text-xs" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <Pager page={pg.page} pageCount={pg.pageCount} onChange={pg.setPage} total={pg.total} pageSize={pg.pageSize} />
    </div>
  );
}
