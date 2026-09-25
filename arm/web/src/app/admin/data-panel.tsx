"use client";

import { ExternalLink } from "lucide-react";
import { useDomains, usd, type AdminOverview } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtNum, fmtUsd, shortAddr, fmtUsdExact } from "@/lib/format";
import { txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, SectionTitle, Stat, TimeAgo } from "@/components/shared";

export function DataPanel({ ov }: { ov: AdminOverview }) {
  const { t } = useApp();
  const T = ov.totals;
  const n = (k: keyof typeof T) => Number(T[k] ?? 0);
  const feesPg = usePage(ov.feeEvents, 25);
  const domains = useDomains().data;

  return (
    <div className="space-y-6">
      {/* multi-domain redundancy: which of our domains currently resolve */}
      {domains && domains.domains.length > 0 && (
        <Card size="sm">
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="label">{t("admin.domains")}</span>
            {domains.domains.map((d) => (
              <a key={d.host} href={`https://${d.host}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono hover:underline" title={d.ips.join(", ") || d.error}>
                <span className={cn("size-2 rounded-full", d.ok ? "bg-up" : "bg-down")} />
                {d.host}
                {d.host === domains.primary && <Badge variant="outline" className="text-[10px]">primary</Badge>}
                {!d.ok && <span className="text-down">{d.error ?? "offline"}</span>}
              </a>
            ))}
            <span className="basis-full text-[11px] text-muted-foreground">{t("admin.domains.hint")}</span>
          </CardContent>
        </Card>
      )}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("admin.kpi.tokens")} value={fmtNum(n("tokens"))} sub={`${t("admin.kpi.graduated")} ${n("graduated")} · 24h +${n("launched_24h")}`} tone="primary" />
        <Stat label={t("admin.kpi.volume")} value={fmtUsdExact(usd(T.volume_total))} sub={`24h ${fmtUsdExact(usd(T.volume_24h))} · ${t("admin.kpi.trades")} ${fmtNum(n("trades_total"))}`} />
        <Stat label={t("admin.kpi.fees")} value={fmtUsdExact(usd(T.fees_total))} sub={`${t("admin.kpi.creatorFees")} ${fmtUsdExact(usd(T.fees_creator))} · ${t("admin.kpi.protocolFees")} ${fmtUsdExact(usd(T.fees_protocol))}`} tone="up" />
        <Stat label={t("admin.kpi.treasury")} value={fmtUsdExact(usd(ov.params.treasury.usdcBalance))} sub={`${t("admin.kpi.creationFees")} ${fmtUsdExact(usd(T.creation_fees))}`} tone="gold" />
        <Stat label={t("admin.kpi.settled")} value={fmtUsdExact(usd(T.to_eco))} sub={`${t("admin.kpi.toBuyback")} ${fmtUsdExact(usd(T.to_buyback))} · ${t("admin.kpi.toDev")} ${fmtUsdExact(usd(T.to_dev))}`} tone="gold" />
        <Stat label={t("admin.kpi.burned")} value={fmtNum(Number(T.burned) / 1e18)} sub={t("admin.kpi.burnedHint")} tone="gold" />
        <Stat label={t("admin.kpi.traders")} value={fmtNum(n("traders"))} sub={`${t("admin.kpi.holders")} ${fmtNum(n("holders"))}`} />
        <Stat label={t("admin.kpi.fromToken")} value={fmtUsdExact(usd(T.fees_from_token))} sub={`${t("admin.kpi.parked")} ${n("payouts_parked")}`} />
      </section>

      {/* the 7-day settlement is the other "where is the money" question (dev / eco / buyback wallets look empty until it runs) */}
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed">
        <div className="mb-1 font-semibold">{t("settle.notice.title")}</div>
        <p className="text-secondary-foreground">
          {t("settle.notice.body")
            .replace("{pending}", fmtUsdExact(usd(ov.params.treasury.pendingRevenueUsdc)))
            .replace("{next}", ov.params.treasury.nextExecuteAt ? new Date(Number(ov.params.treasury.nextExecuteAt) * 1000).toLocaleString() : "—")
            .replace("{eco}", fmtUsdExact(usd(ov.params.treasury.pendingRevenueUsdc) * 0.76))
            .replace("{bb}", fmtUsdExact(usd(ov.params.treasury.pendingRevenueUsdc) * 0.2))
            .replace("{dev}", fmtUsdExact(usd(ov.params.treasury.pendingRevenueUsdc) * 0.04))}
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <Bars title={t("admin.daily.launches")} data={ov.daily.map((d) => ({ day: d.day, v: d.launches }))} fmt={(v) => String(v)} color="bg-primary" />
        <Bars title={t("admin.daily.volume")} data={ov.daily.map((d) => ({ day: d.day, v: usd(d.volume) }))} fmt={(v) => fmtUsd(v, { compact: true })} color="bg-up" />
        <Bars title={t("admin.daily.fees")} data={ov.daily.map((d) => ({ day: d.day, v: usd(d.fees) + usd(d.creationFees) }))} fmt={(v) => fmtUsd(v)} color="bg-gold" />
      </section>

      <section>
        <SectionTitle>{t("admin.feeEvents")}</SectionTitle>
        {ov.feeEvents.length === 0 ? (
          <Empty>{t("common.noData")}</Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.time")}</TableHead>
                  <TableHead>{t("admin.col.token")}</TableHead>
                  <TableHead className="text-right">{t("admin.kpi.creatorFees")}</TableHead>
                  <TableHead className="text-right">{t("admin.kpi.protocolFees")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("admin.kpi.fromToken")}</TableHead>
                  <TableHead className="text-right">{t("common.status")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("common.tx")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs tabular">
                {feesPg.pageItems.map((f) => (
                  <TableRow key={f.hash + f.token}>
                    <TableCell className="text-muted-foreground"><TimeAgo ts={f.time} /> ago</TableCell>
                    <TableCell>${f.symbol} <span className="text-muted-foreground">{shortAddr(f.payout, 4, 4)}</span></TableCell>
                    <TableCell className="text-right text-up">{fmtUsd(usd(f.quoteCreator))}</TableCell>
                    <TableCell className="text-right">{fmtUsd(usd(f.quoteProtocol))}</TableCell>
                    <TableCell className="hidden text-right md:table-cell">{Number(f.usdcFromToken) > 0 ? fmtUsd(usd(f.usdcFromToken)) : "—"}</TableCell>
                    <TableCell className="text-right">{f.creatorPaid ? <Badge variant="up">Paid</Badge> : <Badge variant="gold">{t("creator.claimable")}</Badge>}</TableCell>
                    <TableCell className="hidden text-right md:table-cell"><a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={txUrl(f.hash)} target="_blank" rel="noreferrer">{shortAddr(f.hash, 6, 4)} <ExternalLink size={10} /></a></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={feesPg.page} pageCount={feesPg.pageCount} onChange={feesPg.setPage} total={feesPg.total} pageSize={feesPg.pageSize} className="border-t px-4 py-2" />
          </Card>
        )}
      </section>
    </div>
  );
}

/** Tiny dependency-free 30-day bar chart. */
function Bars({ title, data, fmt, color }: { title: string; data: { day: string; v: number }[]; fmt: (v: number) => string; color: string }) {
  const max = Math.max(1e-9, ...data.map((d) => d.v));
  const total = data.reduce((a, d) => a + d.v, 0);
  const { t } = useApp();
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="label">{title} · {t("admin.daily")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-2 font-mono text-xl font-semibold tabular">{fmt(total)}</div>
        <div className="flex h-20 items-end gap-[3px]">
          {data.map((d) => (
            <div key={d.day} className="group relative flex-1">
              <div className={`${color} w-full rounded-t-sm opacity-80 transition-opacity group-hover:opacity-100`} style={{ height: `${Math.max(2, (d.v / max) * 80)}px` }} />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded bg-popover px-2 py-1 font-mono text-[10px] whitespace-nowrap shadow group-hover:block">
                {d.day.slice(5)} · {fmt(d.v)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>{data[0]?.day.slice(5)}</span>
          <span>{data[data.length - 1]?.day.slice(5)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
