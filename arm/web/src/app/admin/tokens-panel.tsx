"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { type Address } from "viem";
import { useSignMessage } from "wagmi";
import { toast } from "sonner";
import { hotspotAdminMessage, postAdminToken, usd, type AdminOverview, type AdminToken, type TokenFlags } from "@/lib/api";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { addrsFor, factoryAbi, lockerAbi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager, usePage } from "@/components/ui/pagination";
import { Addr, Empty, TimeAgo, TokenAvatar } from "@/components/shared";

type Sign = (args: { message: string }) => Promise<`0x${string}`>;
async function signedTokenFlags(sign: Sign, author: string, token: string, payload: TokenFlags) {
  const ts = Date.now();
  const signature = await sign({ message: hotspotAdminMessage(`token:${token.toLowerCase()}`, ts, payload) });
  return postAdminToken(token, { author, ts, signature, payload });
}

export function TokensPanel({ ov, canAct }: { ov: AdminOverview; canAct: boolean }) {
  const { t, address } = useApp();
  const { run, client } = useTx();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const pg = usePage(ov.tokens, 25);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });

  const distribute = async (tok: AdminToken) => {
    setBusy(tok.address + ":d");
    try {
      // same guard as the keeper: dry-run to learn the conversion output, demand 97% of it
      let minOut = 0n;
      const locker = addrsFor(tok.factory).locker;
      try {
        const sim = await client!.simulateContract({ address: locker, abi: lockerAbi, functionName: "distribute", args: [tok.address as Address, 0n] });
        minOut = (sim.result[1] * 97n) / 100n;
      } catch {}
      await run(`${t("admin.act.distribute")} $${tok.symbol}`, { address: locker, abi: lockerAbi, functionName: "distribute", args: [tok.address as Address, minOut] });
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const graduate = async (tok: AdminToken) => {
    setBusy(tok.address + ":g");
    try {
      await run(`${t("admin.act.graduate")} $${tok.symbol}`, { address: addrsFor(tok.factory).factory, abi: factoryAbi, functionName: "markGraduated", args: [tok.address as Address] });
      refresh();
    } finally {
      setBusy(null);
    }
  };

  // display flags only (indexer DB), signed by the owner wallet like the other admin actions — nothing on-chain
  const setFlags = async (tok: AdminToken, payload: TokenFlags, label: string) => {
    if (!address) return;
    setBusy(tok.address + ":f");
    try {
      await signedTokenFlags(signMessageAsync, address, tok.address, payload);
      toast.success(label);
      refresh();
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (ov.tokens.length === 0) return <Empty>{t("common.noData")}</Empty>;
  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("admin.col.token")}</TableHead>
            <TableHead className="hidden lg:table-cell">{t("admin.col.creator")}</TableHead>
            <TableHead className="text-right">{t("admin.col.mcap")}</TableHead>
            <TableHead className="hidden text-right md:table-cell">{t("admin.col.vol24")}</TableHead>
            <TableHead className="text-right">{t("admin.col.fees")}</TableHead>
            <TableHead className="hidden text-right xl:table-cell">{t("admin.col.pending")}</TableHead>
            <TableHead className="hidden text-right xl:table-cell">{t("admin.col.backlog")}</TableHead>
            <TableHead className="hidden text-right lg:table-cell">{t("admin.col.claimable")}</TableHead>
            <TableHead className="hidden text-right md:table-cell">{t("admin.col.lastDist")}</TableHead>
            <TableHead>{t("admin.col.status")}</TableHead>
            {canAct && <TableHead className="text-right">{t("admin.col.actions")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody className="text-xs">
          {pg.pageItems.map((tok) => {
            const paired = usd(tok.pairedUsdc);
            const thr = usd(tok.graduationThreshold) || 1;
            const canGraduate = !tok.graduated && paired >= thr;
            const isBusy = busy?.startsWith(tok.address) ?? false;
            return (
              <TableRow key={tok.address}>
                <TableCell>
                  <Link href={`/token/${tok.address}`} className="inline-flex items-center gap-2 hover:underline">
                    <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={22} className="rounded-md" />
                    <span className="font-mono font-semibold">${tok.symbol}</span>
                  </Link>
                  <div className="text-[10px] text-muted-foreground"><TimeAgo ts={tok.launchTs} /> ago · {shortAddr(tok.address, 6, 4)}</div>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div><Addr value={tok.deployer} /></div>
                  {tok.payout.toLowerCase() !== tok.deployer.toLowerCase() && <div className="text-[10px] text-gold">→ <Addr value={tok.payout} /></div>}
                </TableCell>
                <TableCell className="text-right font-mono tabular">{fmtUsd(tok.mcapUsd, { compact: true })}</TableCell>
                <TableCell className="hidden text-right font-mono tabular md:table-cell">{fmtUsd(usd(tok.volume24hUsdc), { compact: true })}</TableCell>
                <TableCell className="text-right font-mono tabular">{fmtUsd(usd(tok.feesUsdcTotal))} <span className="text-muted-foreground">({fmtUsd(usd(tok.feesCreatorUsdcTotal))})</span></TableCell>
                <TableCell className="hidden text-right font-mono tabular xl:table-cell">{fmtUsd(usd(tok.volumeSinceDistribute) / 100)}</TableCell>
                <TableCell className="hidden text-right font-mono tabular xl:table-cell">{Number(tok.unconvertedTokenFees) > 0 ? <span className="text-gold">{fmtNum(Number(tok.unconvertedTokenFees) / 1e18)}</span> : "—"}</TableCell>
                <TableCell className="hidden text-right font-mono tabular lg:table-cell">{Number(tok.claimableUsdc) > 0 ? <span className="text-gold">{fmtUsd(usd(tok.claimableUsdc))}</span> : "—"}</TableCell>
                <TableCell className="hidden text-right font-mono text-muted-foreground md:table-cell">{tok.lastDistributedAt ? <><TimeAgo ts={tok.lastDistributedAt} /> ago</> : "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {tok.graduated ? <Badge variant="gold">{t("common.graduated")}</Badge> : <Badge variant="secondary">{Math.min(100, Math.round((paired / thr) * 100))}%</Badge>}
                    {tok.pinned && <Badge>{t("common.pinned")}</Badge>}
                    {tok.hidden && <Badge variant="destructive">{t("admin.hidden")}</Badge>}
                  </div>
                </TableCell>
                {canAct && (
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void distribute(tok)}>{t("admin.act.distribute")}</Button>
                      {canGraduate && <Button size="sm" variant="gold" disabled={isBusy} onClick={() => void graduate(tok)}>{t("admin.act.graduate")}</Button>}
                      <Button size="sm" variant={tok.pinned ? "outline" : "ghost"} disabled={isBusy} onClick={() => void setFlags(tok, { pinned: !tok.pinned }, tok.pinned ? t("admin.act.unpin") : t("admin.act.pin"))}>{tok.pinned ? t("admin.act.unpin") : t("admin.act.pin")}</Button>
                      <Button size="sm" variant={tok.hidden ? "outline" : "ghost"} disabled={isBusy} onClick={() => void setFlags(tok, { hidden: !tok.hidden }, tok.hidden ? t("admin.act.show") : t("admin.act.hide"))}>{tok.hidden ? t("admin.act.show") : t("admin.act.hide")}</Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Pager page={pg.page} pageCount={pg.pageCount} onChange={pg.setPage} total={pg.total} pageSize={pg.pageSize} className="border-t px-4 py-2" />
    </Card>
  );
}
