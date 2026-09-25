"use client";

import Link from "next/link";
import { toast } from "sonner";
import { Copy, ExternalLink, Megaphone } from "lucide-react";
import { usd, usePromoterStats, useReferralOf, useReferralTokens } from "@/lib/api";
import { refLink, referralTradePct } from "@/lib/referral";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, SectionTitle, Stat, TimeAgo, TokenAvatar } from "@/components/shared";

const copy = async (text: string, ok: string) => {
  await navigator.clipboard.writeText(text).catch(() => {});
  toast.success(ok);
};

/**
 * Promote page: my referral link, what it brought in, and every token whose creator shares fees with promoters.
 * Commission = the token's pool fee (1%) × creator share (78%) × referral share, on the volume of wallets I brought in.
 */
export default function PromotePage() {
  const { t, connected, address, toggleConnect } = useApp();
  const stats = usePromoterStats(connected ? address : undefined);
  const mine = useReferralOf(connected ? address : undefined);
  const tokens = useReferralTokens();
  const link = address ? refLink(address) : "";
  const s = stats.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Megaphone className="size-6" /> {t("promote.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("promote.subtitle")}</p>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <div className="label">{t("promote.myLink")}</div>
          {connected && address ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-sm">{link}</code>
              <Button onClick={() => copy(link, t("promote.copied"))}><Copy /> {t("promote.copy")}</Button>
            </div>
          ) : (
            <Button onClick={toggleConnect}>{t("promote.connectFirst")}</Button>
          )}
          <p className="text-xs text-muted-foreground">{t("promote.howItWorks")}</p>
          {mine.data && <p className="text-xs text-muted-foreground">{t("promote.myReferrer").replace("{ref}", shortAddr(mine.data.referrer, 6, 4))}</p>}
        </CardContent>
      </Card>

      {connected && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t("promote.invited")} value={fmtNum(s?.invited ?? 0)} />
          <Stat label={t("promote.volume")} value={fmtUsd(usd(s?.referredVolumeUsdc))} sub={`${fmtNum(s?.referredTrades ?? 0)} ${t("promote.trades")}`} />
          <Stat label={t("promote.paid")} value={fmtUsd(usd(s?.paidUsdc))} tone="up" />
          <Stat label={t("promote.pending")} value={fmtUsd(usd(s?.pendingEstimateUsdc))} sub={t("promote.pendingNote")} />
        </div>
      )}

      <div>
        <SectionTitle>{t("promote.tokens")}</SectionTitle>
        {tokens.data && tokens.data.length === 0 && <Empty>{t("promote.noTokens")}</Empty>}
        {!!tokens.data?.length && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("promote.col.token")}</TableHead>
                    <TableHead className="text-right">{t("promote.col.share")}</TableHead>
                    <TableHead className="text-right">{t("promote.col.perTrade")}</TableHead>
                    <TableHead className="text-right">{t("promote.col.link")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.data.map((tk) => (
                    <TableRow key={tk.address}>
                      <TableCell>
                        <Link href={`/token/${tk.address}`} className="flex items-center gap-2 hover:underline">
                          <TokenAvatar logo={tk.logo} symbol={tk.symbol} seed={tk.address} size={28} />
                          <span className="font-medium">{tk.symbol}</span>
                          <span className="hidden text-xs text-muted-foreground sm:inline">{tk.name}</span>
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono">{(tk.referral_bps / 100).toFixed(0)}%</TableCell>
                      <TableCell className="text-right font-mono">{referralTradePct(tk.referral_bps).toFixed(3)}%</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" disabled={!address} onClick={() => address && copy(refLink(address, `/token/${tk.address}`), t("promote.copied"))}>
                          <Copy /> {t("promote.copy")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {connected && !!s?.payouts.length && (
        <div>
          <SectionTitle>{t("promote.payouts")}</SectionTitle>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("promote.col.time")}</TableHead>
                    <TableHead>{t("promote.col.token")}</TableHead>
                    <TableHead className="text-right">{t("promote.col.volume")}</TableHead>
                    <TableHead className="text-right">{t("promote.col.amount")}</TableHead>
                    <TableHead className="text-right">Tx</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.payouts.map((p) => (
                    <TableRow key={`${p.tx_hash}-${p.token}`}>
                      <TableCell><TimeAgo ts={p.ts} /></TableCell>
                      <TableCell><Badge variant="secondary">{p.symbol}</Badge></TableCell>
                      <TableCell className="text-right font-mono">{fmtUsd(usd(p.volume))}</TableCell>
                      <TableCell className="text-right font-mono text-up">+{fmtUsd(usd(p.amount))}</TableCell>
                      <TableCell className="text-right">
                        <a href={txUrl(p.tx_hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                          {shortAddr(p.tx_hash, 6, 4)} <ExternalLink size={10} />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
