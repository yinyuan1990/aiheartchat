"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight, ArrowUpDown, Crown, LayoutGrid, Rows3, Sparkles, Star } from "lucide-react";
import { progressOf, usd, useTokens, useTokensPage, type TokenWindow } from "@/lib/api";
import { useWatchlist } from "@/lib/watchlist";
import { fmtUsd } from "@/lib/format";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pager, usePage } from "@/components/ui/pagination";
import { Empty, PctChange, SectionTitle, TokenAvatar } from "@/components/shared";
import { TokenCard } from "@/components/token/token-card";
import { BurnCard } from "@/components/token/burn-card";
import { PulseView } from "@/components/token/pulse-view";

/** One font rule for both hero CTAs (they are the same width, so the same cqw = the same px). 10cqw keeps the long
 *  English "Launch a Token →" inside the button on md+; phones use the short label and can go bigger. */
const HERO_CTA_TEXT = "inline-flex items-center gap-[0.4em] text-[length:clamp(9px,14cqw,17px)] md:text-[length:clamp(9px,10cqw,17px)]";

type Filter = "trending" | "new" | "graduating" | "graduated" | "watchlist";
type Sort = "volume" | "mcap" | "created" | "oldest" | "progress";
type View = "grid" | "pulse";

export default function ExplorePage() {
  const { t } = useApp();
  const [filter, setFilter] = useState<Filter>("trending");
  const [sort, setSort] = useState<Sort>("volume");
  const [window, setWindow] = useState<TokenWindow>("24h");
  const [view, setView] = useState<View>("grid");
  const watch = useWatchlist();

  const apiSort = filter === "new" ? "new" : filter === "graduating" ? "progress" : sort === "created" ? "new" : sort;
  const apiFilter = filter === "graduating" ? "graduating" : filter === "graduated" ? "graduated" : "all";
  // Server-side pages for the grid. The watchlist tab is a client-side filter over the (small) whole set.
  const PAGE = 24;
  const [page, setPage] = useState(1);
  const pageKey = `${filter}|${apiSort}|${window}`;
  const [seenKey, setSeenKey] = useState(pageKey);
  if (seenKey !== pageKey) {
    setSeenKey(pageKey);
    setPage(1);
  }
  const pagedQ = useTokensPage(apiSort, apiFilter, window, page, PAGE);
  const allQ = useTokens("volume", "all", window, 200);
  const all = useMemo(() => allQ.data ?? [], [allQ.data]);
  const watchAll = useMemo(() => all.filter((x) => watch.has(x.address)), [all, watch]);
  const watchPg = usePage(watchAll, PAGE);
  const isWatch = filter === "watchlist";
  const isLoading = isWatch ? allQ.isLoading : pagedQ.isLoading;
  const list = isWatch ? watchPg.pageItems : pagedQ.data?.items;
  const total = isWatch ? watchPg.total : pagedQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));

  const king = useMemo(() => [...all].filter((x) => !x.graduated).sort((a, b) => progressOf(b) - progressOf(a))[0], [all]);

  const sortLabel: Record<Sort, string> = {
    volume: t("explore.sort.volume"),
    mcap: t("explore.sort.mcap"),
    created: t("explore.sort.created"),
    oldest: t("explore.sort.oldest"),
    progress: t("explore.sort.progress"),
  };
  const windowLabel: Record<TokenWindow, string> = { "24h": t("explore.window.24h"), "7d": t("explore.window.7d"), all: t("explore.window.all") };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Hero */}
      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Hero banner (boss, 9.10): ONE picture for both themes and both languages, always shown whole. It is a real
            <img> at 100% width, so the box always has the picture's own aspect and nothing is ever cropped or
            re-centred — on a phone it simply scales down (the rocket stays where it is). The two CTAs sit under the
            baked copy in plain percentages of the picture (copy left edge = 4.3%, copy bottom = 57.5%). */}
        <Card className="relative gap-0 py-0 lg:self-start">
          <h1 className="sr-only">Arm — community launchpad on the Arc network</h1>
          <div className="relative [container-type:inline-size]">
            <Image src="/brand/hero.jpg" alt="" width={1600} height={506} priority sizes="(min-width: 1024px) 60vw, 100vw" className="block h-auto w-full select-none" draggable={false} />
            {/* Both CTAs are the SAME width (boss, 9.10: 18% of the picture on phones, 15% from sm) with a fixed 1% gap,
                and share one font-size rule. Each button is its own inline-size container, so the size is derived
                from the (identical) button width — a longer label (English) renders smaller instead of widening the
                button. Phones get taller buttons (24% vs 16%). */}
            <Link
              href="/create"
              className="absolute top-[63%] left-[4.3%] flex h-[24%] w-[18%] items-center justify-center overflow-hidden rounded-[0.7em] font-sans bg-[linear-gradient(90deg,#8b5cf6,#6d28d9)] font-semibold whitespace-nowrap text-white shadow-[0_4px_14px_rgba(109,40,217,0.35)] transition [container-type:inline-size] hover:brightness-110 active:brightness-95 sm:top-[66%] sm:h-[16%] sm:w-[15%]"
            >
              <span className={HERO_CTA_TEXT}>
                <span className="md:hidden">{t("hero.launchShort")}</span>
                <span className="hidden md:inline">{t("hero.launch")}</span>
                <ArrowRight className="size-[1.1em] shrink-0" />
              </span>
            </Link>
            <Link
              href="/hot"
              className="absolute top-[63%] left-[23.3%] flex h-[24%] w-[18%] items-center justify-center overflow-hidden rounded-[0.7em] font-sans bg-white font-semibold whitespace-nowrap text-[#1a1a1a] shadow-[0_4px_14px_rgba(17,17,17,0.12)] transition [container-type:inline-size] hover:bg-[#f3f3f3] active:bg-[#e9e9e9] sm:top-[66%] sm:left-[20.3%] sm:h-[16%] sm:w-[15%]"
            >
              <span className={HERO_CTA_TEXT}>
                <Sparkles className="size-[1.1em] shrink-0" /> {t("hero.hot")}
              </span>
            </Link>
          </div>
        </Card>

        {/* King of the hill */}
        {king ? (
          <Link href={`/token/${king.address}`} className="block">
            <Card className="relative h-full ring-gold/40 transition-all hover:ring-gold/70">
              <div className="pointer-events-none absolute -bottom-20 -left-16 size-56 rounded-full bg-gold/15 blur-3xl" />
              <CardContent className="relative">
                <div className="mb-3 flex items-center gap-2 text-xs text-gold">
                  <Crown size={14} /> <span className="label text-gold!">{t("explore.king")}</span>
                  <span className="text-muted-foreground">· {t("explore.kingDesc")}</span>
                </div>
                <div className="flex items-center gap-3">
                  <TokenAvatar logo={king.logo} symbol={king.symbol} seed={king.address} size={56} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-lg font-semibold">{king.name}</div>
                      <span className="font-mono text-xs text-muted-foreground">${king.symbol}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="font-mono tabular">{fmtUsd(king.price)}</span>
                      <PctChange value={king.change24h} />
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                    <span>{t("common.progress")}</span>
                    <span className="font-mono text-foreground tabular">
                      {fmtUsd(usd(king.pairedUsdc), { compact: true })} / {fmtUsd(usd(king.graduationThreshold), { compact: true })}
                    </span>
                  </div>
                  <Progress value={progressOf(king)} className="h-2.5" indicatorClassName="bg-gold" shimmer />
                </div>
              </CardContent>
            </Card>
          </Link>
        ) : (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-sm text-muted-foreground">{isLoading ? t("common.loading") : t("common.noData")}</CardContent>
          </Card>
        )}
      </section>

      {/* Public "next burn" strip (9.23): one wide row between the hero and the list; off by default, switch in /admin */}
      <BurnCard where="home" />

      {/* List */}
      <section>
        <SectionTitle
          right={
            <div className="flex flex-wrap items-center gap-2">
              {view === "grid" && (
                <>
                  <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                    <TabsList>
                      <TabsTrigger value="trending">{t("common.trending")}</TabsTrigger>
                      <TabsTrigger value="new">{t("common.new")}</TabsTrigger>
                      <TabsTrigger value="graduating">{t("common.graduating")}</TabsTrigger>
                      <TabsTrigger value="graduated">{t("common.graduated")}</TabsTrigger>
                      <TabsTrigger value="watchlist" title={t("explore.watchlist")}><Star size={13} className={watch.list.length ? "fill-gold text-gold" : undefined} /><span className="hidden sm:inline">{t("explore.watchlist")}</span></TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Tabs value={window} onValueChange={(v) => setWindow(v as TokenWindow)}>
                    <TabsList>
                      {(Object.keys(windowLabel) as TokenWindow[]).map((w) => (
                        <TabsTrigger key={w} value={w} className="font-mono text-xs">{windowLabel[w]}</TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <ArrowUpDown /> {t("explore.sort")}: {sortLabel[sort]}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {(Object.keys(sortLabel) as Sort[]).map((k) => (
                        <DropdownMenuItem key={k} onClick={() => setSort(k)}>
                          {sortLabel[k]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              <Tabs value={view} onValueChange={(v) => setView(v as View)}>
                <TabsList>
                  <TabsTrigger value="grid" title={t("explore.view.grid")}>
                    <LayoutGrid />
                  </TabsTrigger>
                  <TabsTrigger value="pulse" title={t("explore.view.pulse")}>
                    <Rows3 /> <span className="hidden sm:inline">Pulse</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          }
        >
          {t("common.token")}
        </SectionTitle>
        {view === "grid" ? (
          isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[3/4.4] rounded-2xl" />
              ))}
            </div>
          ) : !list || list.length === 0 ? (
            <Empty>{filter === "watchlist" ? t("explore.watchlistEmpty") : t("common.noData")}</Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {list.map((tok, i) => (
                  <TokenCard key={tok.address} token={tok} window={window} rank={((isWatch ? watchPg.page : page) - 1) * PAGE + i + 1} trending={filter === "trending" && sort === "volume"} />
                ))}
              </div>
              <Pager
                page={isWatch ? watchPg.page : page}
                pageCount={pageCount}
                onChange={isWatch ? watchPg.setPage : setPage}
                total={total}
                pageSize={PAGE}
                className="mt-4"
              />
            </>
          )
        ) : (
          <PulseView tokens={all} />
        )}
      </section>
    </div>
  );
}
