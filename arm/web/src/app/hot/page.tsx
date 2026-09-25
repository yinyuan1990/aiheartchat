"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUp, ExternalLink, Layers, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useHotspots, useHotspotsNew, type Hotspot, type HotspotPlatform, type MemeCategory } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Empty, TimeAgo, TokenAvatar } from "@/components/shared";
import { CategoryBadge, RADAR_FILTER_UI, SHOW_PLATFORM_LABEL, SourceIcon, accountLabel, heatOf, localizeHotspot, originLabel, displayRegions, regionLabel, sourceLabel, typeKey } from "@/components/hot/source";

type Source = "all" | HotspotPlatform;
/** Everything the 筛选 drawer controls. Accounts are X-only, so a non-empty list implies source = x. */
type Filter = { source: Source; accounts: string[]; cats: MemeCategory[] };
const EMPTY_FILTER: Filter = { source: "all", accounts: [], cats: [] };
const SOURCES: Source[] = ["all", "x", "weibo"];
const TAGS: MemeCategory[] = ["animal", "quote", "food", "abstract", "scene", "trend", "nickname"];
const TAG_KEY = { animal: "hot.cat.animal", food: "hot.cat.food", quote: "hot.cat.quote", abstract: "hot.cat.abstract", scene: "hot.cat.scene", trend: "hot.cat.trend", nickname: "hot.cat.nickname", none: "hot.cat.none" } as const;

/**
 * Radar v2 list (boss spec 9.10): 全部 · X · 微博 with live counts, a "Live · updated · signals today" line, cards with
 * region / time / source link / related-signal count (no scores), "Load more" instead of pages, and a "N new signals"
 * banner. The X tab holds every X item (trend boards + key accounts + breakout posts).
 */
export default function HotPage() {
  const { t, locale } = useApp();
  const qc = useQueryClient();
  const [filter, setFilterRaw] = useState<Filter>(EMPTY_FILTER);
  const [draft, setDraft] = useState<Filter>(EMPTY_FILTER);
  const [open, setOpen] = useState(false);
  const platform: Source = filter.accounts.length ? "x" : filter.source;
  const q = useHotspots({ platform, accounts: filter.accounts, tags: filter.cats });
  const first = q.data?.pages[0];
  const items = useMemo(() => {
    let list = q.data?.pages.flatMap((p) => p.items) ?? [];
    // several accounts → the server returned the whole X tab; narrow here
    if (filter.accounts.length > 1) list = list.filter((h) => h.account && filter.accounts.includes(h.account));
    return list;
  }, [q.data, filter.accounts]);

  // "N new signals": count what was published after this list was loaded; reset on refresh / filter change
  const [since, setSince] = useState<string>(() => new Date().toISOString());
  const fresh = useHotspotsNew(platform, since);
  const showNew = async () => {
    setSince(new Date().toISOString());
    await qc.invalidateQueries({ queryKey: ["hotspots"] });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const setFilter = (f: Filter) => {
    setFilterRaw(f);
    setDraft(f);
    setSince(new Date().toISOString());
  };
  const setTop = (v: Source) => setFilter({ ...filter, source: v, accounts: v === "x" ? filter.accounts : [] });
  const activeCount = (filter.source !== "all" ? 1 : 0) + filter.accounts.length + filter.cats.length;
  const sourceOff = !!first && (platform === "x" ? !first.sources.x : platform === "weibo" ? !first.sources.weibo : !first.sources.x && !first.sources.weibo);
  const offLabel = platform === "weibo" ? sourceLabel("weibo", locale) : "X";
  // boss (9.11): his named accounts lead the drawer, in his order; the rest follow in list order
  const pinned = first?.pinnedAccounts ?? [];
  const accounts = [...pinned, ...(first?.accounts ?? []).filter((a) => !pinned.includes(a))];

  // drawer helpers (operate on the draft; nothing applies until 应用筛选)
  const toggleAccount = (a: string) => {
    const on = draft.accounts.includes(a);
    const next = on ? draft.accounts.filter((x) => x !== a) : [...draft.accounts, a];
    setDraft({ ...draft, accounts: next, source: next.length && draft.source === "weibo" ? "x" : draft.source });
  };
  const toggleCat = (c: MemeCategory) => setDraft({ ...draft, cats: draft.cats.includes(c) ? draft.cats.filter((x) => x !== c) : [...draft.cats, c] });
  const apply = () => {
    setFilter(draft);
    setOpen(false);
  };
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="max-w-3xl">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-3xl"><Sparkles className="text-primary" /> {t("hot.title")}</h1>
        <p className="mt-1 text-sm text-secondary-foreground">{t("hot.subtitle")}</p>
      </div>

      {/* 全部 · X · 微博 · 筛选 (hidden while the radar is Weibo-only, boss 9.23) */}
      {RADAR_FILTER_UI && <div className="flex items-center gap-2">
        <Tabs value={platform} onValueChange={(v) => setTop(v as Source)} className="min-w-0 flex-1 sm:flex-none">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="all" className="px-4">{t("hot.all")}</TabsTrigger>
            <TabsTrigger value="x" className="gap-1.5 px-4"><SourceIcon source="x" />X</TabsTrigger>
            <TabsTrigger value="weibo" className="gap-1.5 px-4"><SourceIcon source="weibo" />{sourceLabel("weibo", locale)}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (v) setDraft(filter); }}>
          <Button variant={activeCount ? "default" : "outline"} size="sm" className="h-9 shrink-0 gap-1.5" onClick={() => setOpen(true)}>
            <SlidersHorizontal className="size-4" /> {t("hot.filter")}
            {activeCount > 0 && <span className="rounded-full bg-background/20 px-1.5 text-[10px] font-bold tabular">{activeCount}</span>}
          </Button>
          <SheetContent side="right" className="flex w-[22rem] max-w-full flex-col gap-0 p-0">
            <SheetHeader className="border-b px-5 py-4"><SheetTitle className="text-lg">{t("hot.filter")}</SheetTitle></SheetHeader>
            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <FilterGroup label={t("hot.filter.source")}>
                {SOURCES.filter((s) => s !== "weibo" || draft.accounts.length === 0).map((s) => (
                  <Pill key={s} active={draft.source === s} onClick={() => setDraft({ ...draft, source: s })}>
                    {s === "all" ? t("hot.all") : s === "x" ? "X" : sourceLabel("weibo", locale)}
                  </Pill>
                ))}
              </FilterGroup>
              {accounts.length > 0 && (
                <FilterGroup label={t("hot.filter.accounts")}>
                  {accounts.map((a) => <Pill key={a} active={draft.accounts.includes(a)} pinned={pinned.includes(a)} onClick={() => toggleAccount(a)} title={`@${a}`}>{accountLabel(a, locale)}</Pill>)}
                </FilterGroup>
              )}
              <FilterGroup label={t("hot.filter.tags")}>
                {TAGS.map((c) => <Pill key={c} active={draft.cats.includes(c)} onClick={() => toggleCat(c)}>{t(TAG_KEY[c])}</Pill>)}
              </FilterGroup>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t px-5 py-4">
              <Button variant="outline" onClick={() => setDraft(EMPTY_FILTER)}>{t("hot.filter.reset")}</Button>
              <Button onClick={apply}>{t("hot.filter.apply")}</Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>}

      {/* Live · Updated 3 min ago · 236 signals today */}
      {first && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-up" /></span>{t("hot.live")}</span>
          {first.updatedAt && <span>· {t("hot.updated").replace("{t}", "")}<TimeAgo ts={first.updatedAt} /></span>}
          <span>· {t("hot.signalsToday").replace("{n}", String(first.signalsToday))}</span>
          <span>· {t("hot.window").replace("{h}", String(first.windowHours))}</span>
        </div>
      )}

      {fresh.data && fresh.data.count > 0 && (
        <button type="button" onClick={() => void showNew()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/15">
          <ArrowUp className="size-4" /> {t("hot.newSignals").replace("{n}", String(fresh.data.count))}
        </button>
      )}

      {first && !first.enabled ? (
        <Empty>{t("hot.paused")}</Empty>
      ) : sourceOff && items.length === 0 ? (
        <Empty>{t("hot.sourceOff").replace("{s}", offLabel)}</Empty>
      ) : q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <Empty>{activeCount ? t("hot.filter.empty") : t("hot.empty")}</Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((h) => <HotCard key={h.id} h={h} />)}
          </div>
          <div className="flex justify-center">
            {q.hasNextPage ? (
              <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                <RefreshCw className={cn("size-4", q.isFetchingNextPage && "animate-spin")} /> {q.isFetchingNextPage ? t("hot.loading") : t("hot.loadMore")}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">{t("hot.allLoaded")}</span>
            )}
          </div>
        </>
      )}

      <p className="text-[11px] text-muted-foreground">{t("hot.disclaimer")}</p>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">{label}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

/** Drawer choice pill: filled primary when selected, soft grey otherwise (matches the boss's mock); `pinned` gets a primary outline. */
function Pill({ active, pinned, onClick, title, children }: { active: boolean; pinned?: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-muted/70",
        pinned && !active && "ring-1 ring-inset ring-primary/40",
      )}
    >
      {children}
    </button>
  );
}

/** Card: platform / origin / type, regions, title, optional pre-generated token preview, time · source · related. */
function HotCard({ h }: { h: Hotspot }) {
  const { t, locale } = useApp();
  const L = localizeHotspot(h, locale);
  const heat = heatOf(h, t);
  const all = displayRegions(h.regions);
  const regions = all.filter((r) => r !== "WW" || all.length === 1);
  return (
    <Card className="group relative transition-shadow hover:shadow-[0_8px_24px_rgba(17,17,17,0.08)]">
      <CardContent className="flex h-full flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {SHOW_PLATFORM_LABEL && <span className="inline-flex items-center gap-1 font-medium text-foreground"><SourceIcon source={h.platform} /> {originLabel(h, locale)}</span>}
            <span className="rounded bg-muted px-1 py-px text-[10px]">{t(typeKey(h.sourceType))}</span>
            {h.rising && <span className="inline-flex items-center gap-0.5 text-[10px] text-up"><ArrowUp size={10} /> {t("hot.rising")}</span>}
            {heat && <span className="text-[10px]">{heat}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CategoryBadge category={h.category} t={t} />
            {h.launches > 0 && <Badge variant="gold">{t("hot.launchedN").replace("{n}", String(h.launches))}</Badge>}
          </div>
        </div>

        <div>
          <div className="line-clamp-2 text-base font-semibold leading-snug">{L.title}</div>
          {L.title !== h.title && <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{h.title}</div>}
        </div>

        {regions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {regions.slice(0, 6).map((r) => <span key={r} className="rounded-md border px-1.5 py-px text-[10px] text-muted-foreground">{regionLabel(r, t)}</span>)}
            {regions.length > 6 && <span className="px-1 text-[10px] text-muted-foreground">+{regions.length - 6}</span>}
          </div>
        )}

        {/* pre-generated token preview (top of the list only); everything else is drafted on click */}
        {h.prepared && h.name && (
          <div className="flex items-center gap-3 rounded-lg bg-muted/60 p-2.5">
            <TokenAvatar logo={h.logo ?? ""} symbol={h.symbol ?? "?"} seed={`hot:${h.id}`} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="truncate font-semibold">{L.name}</span><span className="font-mono text-xs text-muted-foreground">${h.symbol}</span></div>
              <div className="line-clamp-1 text-[11px] leading-snug text-secondary-foreground">{L.description}</div>
            </div>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span><TimeAgo ts={h.firstSeen} /></span>
            {h.url && <a href={h.url} target="_blank" rel="noreferrer nofollow" className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"><ExternalLink size={10} /> {t("hot.viewSource")}</a>}
            {h.related > 0 && <span className="inline-flex items-center gap-0.5" title={t("hot.relatedSignals")}><Layers size={10} /> {t("hot.related").replace("{n}", String(h.related))}</span>}
          </div>
          <Button size="sm" variant="glow" asChild className="shrink-0">
            <Link href={`/hot/${h.id}`}>{t("hot.launch")} <ArrowRight /></Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
