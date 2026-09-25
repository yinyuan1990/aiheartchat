"use client";

import { ExternalLink } from "lucide-react";
import { usd, type AdminOverview } from "@/lib/api";
import { fmtUsd, shortAddr } from "@/lib/format";
import { addrUrl, txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, SectionTitle, Stat, TimeAgo } from "@/components/shared";

export function KeeperPanel({ ov }: { ov: AdminOverview }) {
  const { t } = useApp();
  const K = ov.keeper;
  const S = ov.sync;
  const lag = S.head !== null && S.lastBlock !== null ? S.head - S.lastBlock : null;
  // keeper balance is native USDC (18 decimals on Arc)
  const gas = K.balance ? Number(K.balance) / 1e18 : null;
  const gasLow = gas !== null && gas < 1;
  const logPg = usePage(K.entries, 25);

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("admin.keeper.title")} value={K.enabled ? "ON" : "OFF"} tone={K.enabled ? "up" : "down"} sub={K.enabled ? `${t("admin.keeper.interval")} ${K.intervalMs / 1000}s` : t("admin.keeper.disabled")} />
        <Stat label={t("admin.keeper.gas")} value={gas === null ? "—" : `${gas.toFixed(3)} USDC`} tone={gasLow ? "down" : undefined} sub={K.address ? <a className="font-mono hover:underline" href={addrUrl(K.address)} target="_blank" rel="noreferrer">{shortAddr(K.address, 8, 6)}</a> : undefined} />
        <Stat label={t("admin.keeper.lastTick")} value={K.lastTick ? <><TimeAgo ts={K.lastTick} /> ago</> : "—"} sub={`${t("admin.keeper.threshold")} ${fmtUsd(usd(K.feeThresholdUsdc))} / ${Math.round(K.maxAgeMs / 60000)}m`} />
        <Stat label={t("admin.sync.title")} value={lag === null ? "—" : lag <= 2 ? "OK" : `${t("admin.sync.lag")} ${lag}`} tone={lag === null ? undefined : lag <= 2 ? "up" : "down"} sub={`${t("admin.sync.lastBlock")} ${S.lastBlock ?? "—"} · ${t("admin.sync.head")} ${S.head ?? "—"}`} />
      </section>
      {gasLow && <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">{t("admin.gasLow")} → {K.address}</p>}
      {/* same explanation creators see on /creator — handy when answering "my money hasn't arrived" */}
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed">
        <div className="mb-1 font-semibold">{t("payout.notice.title")}</div>
        <p className="text-secondary-foreground">{t("payout.notice.body")}</p>
      </div>

      <section>
        <SectionTitle>{t("admin.keeper.log")}</SectionTitle>
        {K.entries.length === 0 ? (
          <Empty>{t("admin.keeper.noLog")}</Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.time")}</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="hidden md:table-cell">{t("admin.col.token")}</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">{t("common.status")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("common.tx")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs">
                {logPg.pageItems.map((e, i) => (
                  <TableRow key={e.ts + i}>
                    <TableCell className="text-muted-foreground"><TimeAgo ts={e.ts} /> ago</TableCell>
                    <TableCell>{e.action}</TableCell>
                    <TableCell className="hidden md:table-cell">{e.token ? shortAddr(e.token, 6, 4) : "—"}</TableCell>
                    <TableCell className="max-w-[320px] truncate" title={e.detail}>{e.detail}</TableCell>
                    <TableCell className="text-right">{e.ok ? <Badge variant="up">ok</Badge> : <Badge variant="down">fail</Badge>}</TableCell>
                    <TableCell className="hidden text-right md:table-cell">{e.hash ? <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={txUrl(e.hash)} target="_blank" rel="noreferrer">{shortAddr(e.hash, 6, 4)} <ExternalLink size={10} /></a> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={logPg.page} pageCount={logPg.pageCount} onChange={logPg.setPage} total={logPg.total} pageSize={logPg.pageSize} className="border-t px-4 py-2" />
          </Card>
        )}
      </section>

      <section>
        <SectionTitle>{t("admin.contracts")}</SectionTitle>
        <Card className="py-0">
          <Table>
            <TableBody className="font-mono text-xs">
              {Object.entries(ov.addresses).filter(([, v]) => typeof v === "string" && v.startsWith("0x")).map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="text-muted-foreground">{k}</TableCell>
                  <TableCell><a className="hover:underline" href={addrUrl(String(v))} target="_blank" rel="noreferrer">{String(v)}</a></TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="text-muted-foreground">{t("admin.sync.start")}</TableCell>
                <TableCell>{S.startBlock}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">RPC</TableCell>
                <TableCell>{S.rpc}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}
