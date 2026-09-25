"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Copy, ExternalLink, Globe, Hash, LineChart, Lock, MessageCircle, Percent, Send, Share2, Star, X } from "lucide-react";
import { toast } from "sonner";
import { isTaxToken, progressOf, usd, useCandles, useHolders, useSite, useToken, useTrades, type TokenView } from "@/lib/api";
import { useWatchlist } from "@/lib/watchlist";
import { fmtNum, fmtUsd, shortAddr } from "@/lib/format";
import { addrUrl, txUrl, SUPPLY_TOKENS } from "@/lib/web3";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pager, usePage } from "@/components/ui/pagination";
import { Addr, Empty, PctChange, SocialIcons, TimeAgo, TokenAvatar } from "@/components/shared";
import { PriceChart } from "@/components/token/price-chart";
import { TradePanel } from "@/components/token/trade-panel";
import { GraduationRing } from "@/components/token/graduation-ring";
import { Thread } from "@/components/token/thread";
import { BurnCard } from "@/components/token/burn-card";
import { TokenReferral } from "@/components/token/token-referral";

const TFS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

export default function TokenPage() {
  const { address } = useParams<{ address: string }>();
  const { t } = useApp();
  const [sheet, setSheet] = useState(false);
  const [tf, setTf] = useState<(typeof TFS)[number]>("1m");

  const { data: token, isLoading, isError } = useToken(address);
  const candlesQ = useCandles(address, tf);
  const [tradePage, setTradePage] = useState(1);
  const TRADE_PAGE = 20;
  const tradesQ = useTrades(address, tradePage, TRADE_PAGE);
  const holdersQ = useHolders(address);
  const holdersPg = usePage(holdersQ.data, 20);
  const watch = useWatchlist();
  const site = useSite();

  const candles = useMemo(
    () => (candlesQ.data ?? []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: usd(c.volumeUsdc) })),
    [candlesQ.data],
  );

  if (isLoading) return <div className="mx-auto max-w-7xl space-y-4"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-[420px] rounded-xl" /></div>;
  if (isError || !token) return <Empty>Token not found</Empty>;

  const progress = progressOf(token);
  const trades = tradesQ.data?.items ?? [];
  const tradesTotal = tradesQ.data?.total ?? 0;
  const holders = holdersPg.pageItems;
  const watching = watch.has(token.address);
  const burned = Number(token.burnedTokens ?? 0) / 1e18;

  return (
    // extra bottom padding on mobile so the fixed buy / sell bar never covers content
    <div className="mx-auto max-w-7xl pb-20 xl:pb-0">
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {/* Header */}
          <Card>
            <CardContent>
              <div className="flex flex-wrap items-start gap-3">
                <TokenAvatar logo={token.logo} symbol={token.symbol} seed={token.address} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-xl font-bold md:text-2xl">{token.name}</h1>
                    <span className="font-mono text-sm text-muted-foreground">${token.symbol}</span>
                    {token.graduated ? <Badge variant="gold">{t("common.graduated")}</Badge> : <Badge variant="accent">{t("common.graduating")}</Badge>}
                    <Badge variant="secondary"><Lock /> {t("token.lpLocked")}</Badge>
                    {token.protectionActive && <Badge variant="gold">🛡 {t("token.protectionActive").split("：")[0].split(":")[0]}</Badge>}
                    {isTaxToken(token) && <Badge variant="gold" title={t("tax.immutable")}><Percent /> {t("tax.badge").replace("{b}", String(token.buyTaxBps / 100)).replace("{s}", String(token.sellTaxBps / 100))}</Badge>}
                    {token.quote && token.quoteSymbol && <Badge variant="accent" title={t("token.quoteHint").replace(/\{q\}/g, token.quoteSymbol)}><LineChart /> {t("token.quoteBadge").replace("{q}", token.quoteSymbol)}</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("common.created")} <TimeAgo ts={token.launchTs} /> ago</span>
                    <span>{t("common.creator")} <Addr value={token.deployer} /></span>
                    <span>{t("token.contract")} <Addr value={token.address} /></span>
                  </div>
                  {/* creator-supplied links live next to the identity (boss 9.16), not only under the Info tab */}
                  <SocialIcons socials={token.socials} className="mt-2" />
                </div>
                <div className="text-right">
                  <div className="font-mono text-2xl font-semibold tabular md:text-3xl">{fmtUsd(token.price)}</div>
                  <PctChange value={token.change24h} className="text-sm" />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={async () => { await navigator.clipboard.writeText(token.address).catch(() => {}); toast.success(t("common.copied"), { description: token.address }); }}>
                  <Copy /> CA
                </Button>
                <Button variant="outline" size="sm" onClick={async () => { await navigator.clipboard.writeText(window.location.href).catch(() => {}); toast.success(t("common.copied")); }}>
                  <Share2 /> {t("token.share")}
                </Button>
                <Button variant={watching ? "gold" : "outline"} size="sm" onClick={() => watch.toggle(token.address)}>
                  <Star fill={watching ? "currentColor" : "none"} /> {watching ? t("token.watching") : t("token.watch")}
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={addrUrl(token.address)} target="_blank" rel="noreferrer"><ExternalLink /> {t("token.explorer")}</a>
                </Button>
                <TokenReferral token={token} />
                {/* Telegram buy bot (9.17): deep link adds the bot to a group and binds this token in one step */}
                {site.data?.tgBot && (
                  <Button variant="outline" size="sm" asChild title={t("token.tgBotHint")}>
                    <a href={`https://t.me/${site.data.tgBot}?startgroup=${token.address}`} target="_blank" rel="noreferrer"><Send /> {t("token.tgBot")}</a>
                  </Button>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <Kv label={burned > 0 ? t("token.circulating") : t("common.mcap")} value={fmtUsd(token.circulatingMcapUsd ?? token.mcapUsd, { compact: true })} />
                <Kv label={t("token.fdv")} value={fmtUsd(token.fdvUsd ?? token.mcapUsd, { compact: true })} />
                <Kv label={t("token.liquidity")} value={fmtUsd(token.liquidityUsd ?? usd(token.poolUsdc ?? token.pairedUsdc), { compact: true })} title={t("token.liquidityHint")} />
                <Kv label={t("common.volume24h")} value={fmtUsd(usd(token.volume24hUsdc), { compact: true })} />
                <Kv label={t("token.paired")} value={fmtUsd(usd(token.poolUsdc ?? token.pairedUsdc), { compact: true })} />
                <Kv label={t("common.holders")} value={fmtNum(token.holders ?? 0)} />
              </div>
            </CardContent>
          </Card>

          {/* Public "next burn" countdown (9.23) — renders only on the token being burned, switchable in /admin */}
          <BurnCard where="token" tokenAddress={token.address} />

          {/* Chart */}
          <Card className="gap-0 py-0">
            <div className="flex items-center justify-between border-b px-4 py-2 text-xs">
              <Tabs value={tf} onValueChange={(v) => setTf(v as typeof tf)}>
                <TabsList variant="line" className="h-7">
                  {TFS.map((x) => (
                    <TabsTrigger key={x} value={x} className="px-2 font-mono text-xs">{x}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <span className="font-mono text-muted-foreground">{token.symbol}/USDC · Uniswap V3 · 1%</span>
            </div>
            {candles.length === 0 ? (
              <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground md:h-[420px]">{candlesQ.isLoading ? t("common.loading") : t("common.noData")}</div>
            ) : (
              <PriceChart candles={candles} className="h-[320px] w-full md:h-[420px]" />
            )}
          </Card>

          {/* Tabs */}
          <Card className="gap-0 py-0">
            <Tabs defaultValue="trades">
              <div className="border-b p-2">
                <TabsList>
                  <TabsTrigger value="trades">{t("token.trades")}</TabsTrigger>
                  <TabsTrigger value="holders">{t("token.holders")}</TabsTrigger>
                  <TabsTrigger value="thread">{t("token.thread")}</TabsTrigger>
                  <TabsTrigger value="info">{t("token.info")}</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="trades">
                {trades.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">{t("common.noData")}</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("common.time")}</TableHead>
                        <TableHead>{t("common.type")}</TableHead>
                        <TableHead className="text-right">USDC</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">{token.symbol}</TableHead>
                        <TableHead className="hidden text-right md:table-cell">{t("common.price")}</TableHead>
                        <TableHead className="text-right">{t("common.wallet")}</TableHead>
                        <TableHead className="hidden text-right md:table-cell">{t("common.tx")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="font-mono text-xs tabular">
                      {trades.map((tr) => (
                        <TableRow key={tr.hash + tr.time}>
                          <TableCell className="text-muted-foreground"><TimeAgo ts={tr.time} /></TableCell>
                          <TableCell className={tr.side === "buy" ? "text-up" : "text-down"}>{tr.side === "buy" ? t("common.buy") : t("common.sell")}</TableCell>
                          <TableCell className="text-right">{fmtUsd(usd(tr.usdc))}</TableCell>
                          <TableCell className="hidden text-right sm:table-cell">{fmtNum(Number(tr.tokens) / 1e18)}</TableCell>
                          <TableCell className="hidden text-right md:table-cell">{fmtUsd(tr.price)}</TableCell>
                          <TableCell className="text-right text-secondary-foreground">
                            <a href={addrUrl(tr.wallet)} target="_blank" rel="noreferrer" className="hover:underline">{shortAddr(tr.wallet, 4, 4)}</a>
                          </TableCell>
                          <TableCell className="hidden text-right md:table-cell">
                            <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={txUrl(tr.hash)} target="_blank" rel="noreferrer">
                              {shortAddr(tr.hash, 4, 4)} <ExternalLink size={10} />
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <Pager page={tradePage} pageCount={Math.max(1, Math.ceil(tradesTotal / TRADE_PAGE))} onChange={setTradePage} total={tradesTotal} pageSize={TRADE_PAGE} className="border-t px-4 py-2" />
              </TabsContent>

              <TabsContent value="holders">
                <div className="divide-y">
                  {holders.map((h, i) => (
                    <div key={h.wallet} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                      <span className="w-5 font-mono text-muted-foreground">{(holdersPg.page - 1) * holdersPg.pageSize + i + 1}</span>
                      <a href={addrUrl(h.wallet)} target="_blank" rel="noreferrer" className="font-mono hover:underline">{shortAddr(h.wallet, 6, 4)}</a>
                      {h.label && <Badge variant={h.label.startsWith("Pool") ? "accent" : h.label === "Creator" ? "gold" : "secondary"} className={h.label === "Burned" ? "text-burn" : undefined}>{h.label}</Badge>}
                      <div className="ml-auto flex items-center gap-3">
                        <Progress value={h.pct} className="hidden w-32 sm:flex" indicatorClassName={h.label ? undefined : "bg-up"} />
                        <span className="w-14 text-right font-mono tabular">{h.pct.toFixed(2)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
                <Pager page={holdersPg.page} pageCount={holdersPg.pageCount} onChange={holdersPg.setPage} total={holdersPg.total} pageSize={holdersPg.pageSize} className="border-t px-4 py-2" />
              </TabsContent>

              <TabsContent value="thread"><Thread token={token} /></TabsContent>

              <TabsContent value="info">
                <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
                  <div>
                    <div className="label mb-1">{t("token.about")}</div>
                    <p className="text-secondary-foreground">{token.description || "—"}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {token.socials.website && <SocialLink href={token.socials.website} icon={<Globe />} label="Website" />}
                      {token.socials.twitter && <SocialLink href={token.socials.twitter} icon={<X />} label="X" />}
                      {token.socials.telegram && <SocialLink href={token.socials.telegram} icon={<Send />} label="Telegram" />}
                      {token.socials.discord && <SocialLink href={token.socials.discord} icon={<MessageCircle />} label="Discord" />}
                      {token.socials.farcaster && <SocialLink href={token.socials.farcaster} icon={<Hash />} label="Farcaster" />}
                    </div>
                  </div>
                  <div className="space-y-2 text-xs">
                    <InfoRow k={t("token.supply")} v={`${fmtNum(SUPPLY_TOKENS)} ${token.symbol}`} />
                    <InfoRow k={t("token.contract")} v={<Addr value={token.address} head={10} tail={6} />} />
                    <InfoRow k={t("token.pool")} v={<Addr value={token.pool} head={10} tail={6} />} />
                    <InfoRow k={t("token.poolFee")} v="1%" />
                    {token.quote && token.quoteSymbol && (
                      <>
                        <InfoRow k={t("token.quoteAsset")} v={<span className="inline-flex items-center gap-1 text-primary"><LineChart size={12} /> {token.quoteSymbol} <Addr value={token.quote} head={6} tail={4} className="text-muted-foreground" /></span>} />
                        {token.quotePriceUsdc && <InfoRow k={t("token.quotePrice")} v={`1 ${token.quoteSymbol} = ${fmtUsd(usd(token.quotePriceUsdc))}`} />}
                        {token.quotePriceUsdcLaunch && <InfoRow k={t("token.quotePriceLaunch")} v={`1 ${token.quoteSymbol} = ${fmtUsd(usd(token.quotePriceUsdcLaunch))}`} />}
                        {token.graduationThresholdQuote && <InfoRow k={t("token.thresholdQuote")} v={`${fmtNum(Number(token.graduationThresholdQuote) / 10 ** (token.quoteDecimals ?? 18), 2)} ${token.quoteSymbol}`} />}
                      </>
                    )}
                    <InfoRow k={t("token.creatorFee")} v={`${token.creatorShareBps / 100}%`} />
                    <InfoRow k={t("token.protocolFee")} v={`${100 - token.creatorShareBps / 100}%`} />
                    <InfoRow k={t("token.payoutAddr")} v={<span className={cn("inline-flex items-center gap-1", token.payout.toLowerCase() !== token.deployer.toLowerCase() && "text-gold")}><Addr value={token.payout} head={10} tail={6} className="text-inherit" /></span>} />
                    <InfoRow k={t("token.feesEarned")} v={fmtUsd(usd(token.feesUsdcTotal))} />
                    <InfoRow k={t("tax.mode")} v={isTaxToken(token) ? <span className="text-gold">{t("tax.taxed")} · {t("tax.badge").replace("{b}", String(token.buyTaxBps / 100)).replace("{s}", String(token.sellTaxBps / 100))}</span> : t("tax.standard")} />
                    {isTaxToken(token) && (
                      <>
                        <InfoRow k={`${t("tax.marketing")} ${token.taxMarketingBps / 100}%`} v={<Addr value={token.taxMarketingWallet} head={10} tail={6} />} />
                        <InfoRow k={`${t("tax.team")} ${(10000 - token.taxMarketingBps) / 100}%`} v={<Addr value={token.taxTeamWallet} head={10} tail={6} />} />
                        <InfoRow k={t("tax.earned")} v={fmtUsd(usd(token.taxUsdcTotal))} />
                      </>
                    )}
                    {burned > 0 && <InfoRow k={t("token.burned")} v={`${fmtNum(burned)} ${token.symbol} (${((burned / SUPPLY_TOKENS) * 100).toFixed(2)}%)`} />}
                    <InfoRow k="Launch tx" v={<a href={txUrl(token.launchTx)} target="_blank" rel="noreferrer" className="hover:underline">{shortAddr(token.launchTx, 8, 6)}</a>} />
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        <aside className="hidden space-y-4 xl:block">
          <TradePanel token={token} />
          <GraduationCard progress={progress} token={token} />
        </aside>
      </div>

      <div className="mt-4 xl:hidden"><GraduationCard progress={progress} token={token} /></div>
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t bg-background/90 p-3 backdrop-blur xl:hidden">
        <Button variant="up" size="xl" className="flex-1" onClick={() => setSheet(true)}>{t("common.buy")}</Button>
        <Button variant="down" size="xl" className="flex-1" onClick={() => setSheet(true)}>{t("common.sell")}</Button>
      </div>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="safe-bottom rounded-t-xl p-4 pt-3" showCloseButton={false}>
          <SheetTitle className="sr-only">{t("common.buy")} / {t("common.sell")} {token.symbol}</SheetTitle>
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-input" />
          <TradePanel token={token} bare />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Kv({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold tabular">{value}</div>
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b py-1.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono tabular">{v}</span>
    </div>
  );
}

function SocialLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noreferrer">{icon} {label}</a>
    </Button>
  );
}

function GraduationCard({ progress, token }: { progress: number; token: TokenView }) {
  const { t } = useApp();
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex items-center gap-4">
          <GraduationRing progress={progress} graduated={token.graduated} />
          <div className="min-w-0 flex-1 text-xs">
            <div className="label">{t("common.progress")}</div>
            <div className="mt-1 font-mono text-base font-semibold tabular">
              {fmtUsd(usd(token.poolUsdc ?? token.pairedUsdc), { compact: true })} <span className="text-muted-foreground">/ {fmtUsd(usd(token.graduationThreshold), { compact: true })}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {token.graduated && token.graduatedAt ? <>{t("token.graduatedAt")} <TimeAgo ts={token.graduatedAt} /> ago</> : <>{t("token.paired")} · {t("token.threshold")} {fmtUsd(usd(token.graduationThreshold), { compact: true })}</>}
            </div>
          </div>
        </div>
        <div className={cn("mt-3 rounded-lg bg-muted p-3 text-[11px] text-secondary-foreground")}>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t("token.creatorFee")}</span>
            <span className="font-mono text-up">{token.creatorShareBps / 100}%</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted-foreground">{t("token.feesEarned")}</span>
            <span className="font-mono tabular">{fmtUsd(usd(token.feesUsdcTotal))}</span>
          </div>
          <div className="mt-2 text-muted-foreground">{t("creator.forever")}</div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("token.graduationExplain")}</p>
        <Button variant="link" size="sm" className="mt-2 w-full" asChild>
          <Link href="/create">{t("create.title")} →</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
