"use client";

import Link from "next/link";
import { ExternalLink, Languages, LogOut, Palette, Users, Wallet } from "lucide-react";
import { SocialLinks } from "@/components/layout/socials";
import { useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { progressOf, usd, useCreator, useWallet } from "@/lib/api";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { ADDR, NET, erc20Abi, txUrl } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, PctChange, SectionTitle, Stat, TimeAgo, TokenAvatar } from "@/components/shared";

/** Language / theme live here (not in the top bar) so the header stays clean on mobile. */
function SettingsCard() {
  const { t, locale, setLocale, theme, setTheme, connected, address, wrongChain, toggleConnect } = useApp();
  // live on-chain USDC balance (6dp) so the number shows the moment the wallet connects
  const bal = useReadContract({
    address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: address ? [address as Address] : undefined,
    query: { enabled: !!address && !wrongChain, refetchInterval: 8000 },
  });
  return (
    <Card size="sm">
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <div>
          <div className="label mb-1.5 flex items-center gap-1.5"><Languages size={12} /> {t("me.language")}</div>
          <Tabs value={locale} onValueChange={(v) => setLocale(v as typeof locale)}>
            <TabsList className="w-full"><TabsTrigger value="zh">中文</TabsTrigger><TabsTrigger value="en">English</TabsTrigger></TabsList>
          </Tabs>
        </div>
        <div>
          <div className="label mb-1.5 flex items-center gap-1.5"><Palette size={12} /> {t("me.theme")}</div>
          <Tabs value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
            <TabsList className="w-full"><TabsTrigger value="arc">{t("theme.arc")}</TabsTrigger><TabsTrigger value="terminal">{t("theme.terminal")}</TabsTrigger></TabsList>
          </Tabs>
        </div>
        <div>
          <div className="label mb-1.5 flex items-center gap-1.5"><Wallet size={12} /> {t("common.connect")}</div>
          <Button variant={wrongChain ? "gold" : connected ? "outline" : "glow"} size="lg" className="w-full font-mono" onClick={toggleConnect}>
            {wrongChain ? t(`wallet.switch.${NET}`) : connected && address ? <><LogOut /> {shortAddr(address, 6, 4)}</> : <><Wallet /> {t("common.connect")}</>}
          </Button>
          {connected && !wrongChain && (
            <div className="mt-2 flex items-center justify-between rounded-md bg-muted px-2.5 py-1.5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground"><span className="size-3 rounded-full bg-[#2775ca]" /> USDC {t("common.balance")}</span>
              <span className="font-mono font-semibold tabular">{bal.data !== undefined ? fmtUsd(Number(formatUnits(bal.data, 6))) : "…"}</span>
            </div>
          )}
        </div>
        <div className="sm:col-span-3">
          <div className="label mb-1.5 flex items-center gap-1.5"><Users size={12} /> {t("me.community")}</div>
          <SocialLinks row />
        </div>
      </CardContent>
    </Card>
  );
}

export default function MePage() {
  const { t, connected, address, toggleConnect } = useApp();
  const { data } = useWallet(address);
  const { data: creator } = useCreator(address);
  // hooks stay above the early return below
  const heldPg = usePage(data?.holdings, 20);
  const createdPg = usePage(creator?.tokens, 20);
  const tradesPg = usePage(data?.trades, 20);

  if (!connected || !address) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("me.title")}</h1>
        <SettingsCard />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary"><Wallet size={22} /></span>
            <p className="text-sm text-secondary-foreground">{t("common.connect")}</p>
            <Button variant="glow" onClick={toggleConnect}>{t("common.connect")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const holdings = data?.holdings ?? [];
  const value = holdings.reduce((s, h) => s + h.valueUsd, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("me.title")}</h1>

      <SettingsCard />

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("me.value")} value={data ? fmtUsd(value) : "…"} />
        <Stat label="USDC" value={data ? fmtUsd(usd(data.usdcBalance)) : "…"} sub={t("common.balance")} />
        <Stat label={t("creator.totalEarned")} value={creator ? fmtUsd(usd(creator.earnedUsdc)) : "…"} tone="up" sub={<Link href="/creator" className="hover:underline">{t("nav.creator")} →</Link>} />
      </section>

      <section>
        <Tabs defaultValue="held">
          <SectionTitle right={<TabsList><TabsTrigger value="held">{t("me.held")}</TabsTrigger><TabsTrigger value="created">{t("me.created")}</TabsTrigger></TabsList>}>
            {t("me.holdings")}
          </SectionTitle>

          <TabsContent value="held">
            {holdings.length === 0 ? (
              <Empty>{t("me.empty")}</Empty>
            ) : (
              <Card className="gap-0 py-0">
                <div className="divide-y">
                  {heldPg.pageItems.map((h) => (
                    <Link key={h.token.address} href={`/token/${h.token.address}`} className="flex items-center gap-3 p-3 hover:bg-accent">
                      <TokenAvatar logo={h.token.logo} symbol={h.token.symbol} seed={h.token.address} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><span className="truncate font-semibold">{h.token.name}</span><span className="font-mono text-xs text-muted-foreground">${h.token.symbol}</span></div>
                        <div className="font-mono text-xs text-muted-foreground tabular">{fmtNum(Number(h.balance) / 1e18)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm font-semibold tabular">{fmtUsd(h.valueUsd)}</div>
                        <PctChange value={h.token.change24h} className="text-xs" />
                      </div>
                    </Link>
                  ))}
                </div>
                <Pager page={heldPg.page} pageCount={heldPg.pageCount} onChange={heldPg.setPage} total={heldPg.total} pageSize={heldPg.pageSize} className="border-t px-3 py-2" />
              </Card>
            )}
          </TabsContent>

          <TabsContent value="created">
            {!creator || creator.tokens.length === 0 ? (
              <Empty>{t("creator.noTokens")}</Empty>
            ) : (
              <Card className="gap-0 py-0">
                <div className="divide-y">
                  {createdPg.pageItems.map((tok) => (
                    <Link key={tok.address} href={`/token/${tok.address}`} className="flex items-center gap-3 p-3 hover:bg-accent">
                      <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold">{tok.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">${tok.symbol}</span>
                          {tok.graduated && <Badge variant="gold">{t("common.graduated")}</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{t("token.feesEarned")} <span className="font-mono text-up tabular">{fmtUsd(usd(tok.feesCreatorUsdcTotal))}</span> · {progressOf(tok).toFixed(0)}%</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm tabular">{fmtUsd(tok.price)}</div>
                        <PctChange value={tok.change24h} className="text-xs" />
                      </div>
                    </Link>
                  ))}
                </div>
                <Pager page={createdPg.page} pageCount={createdPg.pageCount} onChange={createdPg.setPage} total={createdPg.total} pageSize={createdPg.pageSize} className="border-t px-3 py-2" />
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </section>

      <section>
        <SectionTitle>{t("me.history")}</SectionTitle>
        {!data || data.trades.length === 0 ? (
          <Empty>{t("common.noData")}</Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.time")}</TableHead>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("common.token")}</TableHead>
                  <TableHead className="text-right">USDC</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("common.tx")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs tabular">
                {tradesPg.pageItems.map((tr) => (
                  <TableRow key={tr.hash + tr.time}>
                    <TableCell className="text-muted-foreground"><TimeAgo ts={tr.time} /> ago</TableCell>
                    <TableCell className={tr.side === "buy" ? "text-up" : "text-down"}>{tr.side === "buy" ? t("common.buy") : t("common.sell")}</TableCell>
                    <TableCell><Link href={`/token/${tr.token}`} className="hover:underline">${tr.symbol}</Link></TableCell>
                    <TableCell className="text-right">{fmtUsd(usd(tr.usdc))}</TableCell>
                    <TableCell className="hidden text-right sm:table-cell">
                      <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={txUrl(tr.hash)} target="_blank" rel="noreferrer">{shortAddr(tr.hash, 6, 4)} <ExternalLink size={10} /></a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={tradesPg.page} pageCount={tradesPg.pageCount} onChange={tradesPg.setPage} total={tradesPg.total} pageSize={tradesPg.pageSize} className="border-t px-4 py-2" />
          </Card>
        )}
      </section>
    </div>
  );
}
