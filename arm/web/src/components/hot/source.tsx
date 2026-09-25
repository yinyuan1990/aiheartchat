"use client";

import type { Hotspot, HotspotPlatform, HotspotSourceType, MemeCategory } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type CatKey = "hot.cat.animal" | "hot.cat.food" | "hot.cat.quote" | "hot.cat.abstract" | "hot.cat.scene" | "hot.cat.trend" | "hot.cat.nickname" | "hot.cat.none";
const CATEGORY_KEY: Record<MemeCategory, CatKey> = { animal: "hot.cat.animal", food: "hot.cat.food", quote: "hot.cat.quote", abstract: "hot.cat.abstract", scene: "hot.cat.scene", trend: "hot.cat.trend", nickname: "hot.cat.nickname", none: "hot.cat.none" };
const CATEGORY_EMOJI: Record<MemeCategory, string> = { animal: "🐸", food: "🍜", quote: "💬", abstract: "🌀", scene: "🎬", trend: "✨", nickname: "🎭", none: "—" };

/** Content tag as a small badge (animal / food / catchphrase / abstract / viral moment / fun trend / nickname). */
export function CategoryBadge({ category, t, className }: { category: MemeCategory | null; t: (k: CatKey) => string; className?: string }) {
  if (!category || category === "none") return null;
  return <Badge variant="secondary" className={cn("gap-1 font-normal", className)}><span aria-hidden>{CATEGORY_EMOJI[category]}</span>{t(CATEGORY_KEY[category])}</Badge>;
}

/** Sina Weibo mark (Simple Icons, CC0), 24×24 viewBox. */
const WEIBO_PATH = "M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.737 5.439l-.002.004zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.622.263.82.972.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.18.601l.014-.028zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.57-.18-.405-.615.375-.977.42-1.804 0-2.404-.781-1.112-2.915-1.053-5.364-.03 0 0-.766.331-.571-.271.376-1.217.315-2.224-.27-2.809-1.338-1.337-4.869.045-7.888 3.08C1.309 10.87 0 13.273 0 15.348c0 3.981 5.099 6.395 10.086 6.395 6.536 0 10.888-3.801 10.888-6.82 0-1.822-1.547-2.854-2.915-3.284v.01zm1.908-5.092c-.766-.856-1.908-1.187-2.96-.962-.436.09-.706.511-.616.932.09.42.511.691.932.602.511-.105 1.067.044 1.442.465.376.421.466.977.316 1.473-.136.406.089.856.51.992.405.119.857-.105.992-.512.33-1.021.12-2.178-.646-3.035l.03.045zm2.418-2.195c-1.576-1.757-3.905-2.419-6.054-1.968-.496.104-.812.587-.706 1.081.104.496.586.813 1.082.707 1.532-.331 3.185.15 4.296 1.383 1.112 1.246 1.429 2.943.947 4.416-.165.48.106 1.007.586 1.157.479.165.991-.104 1.157-.586.675-2.088.241-4.478-1.338-6.235l.03.045z";

/** Platform glyphs: Weibo = its logo on the brand red tile; X = typographic mark. */
export function SourceIcon({ source, className }: { source: HotspotPlatform; className?: string }) {
  if (source === "weibo")
    return (
      <span className={cn("inline-flex size-4 items-center justify-center rounded-[3px] bg-[#e6162d] text-white", className)}>
        <svg viewBox="0 0 24 24" className="size-[75%]" fill="currentColor" aria-hidden><path d={WEIBO_PATH} /></svg>
      </span>
    );
  return <span className={cn("inline-flex size-4 items-center justify-center rounded-[3px] bg-foreground font-sans text-[10px] font-black leading-none text-background", className)}>X</span>;
}

/**
 * Boss 9.23: the radar is Weibo-only for now, so the platform label ("微博" icon + name) on cards / the launch page
 * and the 全部 · X · 微博 tabs + 筛选 drawer on /hot are hidden. Flip back on when X (or another source) returns.
 */
export const RADAR_FILTER_UI = false;
export const SHOW_PLATFORM_LABEL = false;

/** Platform name in the UI language (only Weibo actually differs). */
export const sourceLabel = (source: HotspotPlatform, locale: "zh" | "en") => (source === "weibo" ? (locale === "zh" ? "微博" : "Weibo") : "X");
export const PLATFORMS: HotspotPlatform[] = ["x", "weibo"];

/** Followed X accounts → display label [zh, en]; unknown handles show as @handle. */
const ACCOUNT_LABEL: Record<string, [string, string]> = {
  elonmusk: ["马斯克", "Musk"],
  cz_binance: ["CZ", "CZ"],
  cathiedwood: ["木头姐", "Cathie Wood"],
  saylor: ["塞勒", "Saylor"],
  billackman: ["阿克曼", "Ackman"],
  realdonaldtrump: ["特朗普", "Trump"],
  nasdaq: ["纳斯达克", "Nasdaq"],
  vitalikbuterin: ["V 神", "Vitalik"],
  sama: ["Sam Altman", "Sam Altman"],
  popbase: ["PopBase", "PopBase"],
  popcrave: ["PopCrave", "PopCrave"],
  dexerto: ["Dexerto", "Dexerto"],
  dailyloud: ["DailyLoud", "DailyLoud"],
  tmz: ["TMZ", "TMZ"],
  discussingfilm: ["DiscussingFilm", "DiscussingFilm"],
  culturecrave: ["CultureCrave", "CultureCrave"],
  filmupdates: ["FilmUpdates", "FilmUpdates"],
  thepophive: ["ThePopHive", "ThePopHive"],
  koreaboo: ["Koreaboo", "Koreaboo"],
  hotnewhiphop: ["HotNewHipHop", "HotNewHipHop"],
  marionawfal: ["Mario Nawfal", "Mario Nawfal"],
};
export const accountLabel = (handle: string, locale: "zh" | "en") => ACCOUNT_LABEL[handle.toLowerCase()]?.[locale === "zh" ? 0 : 1] ?? `@${handle}`;
/** Where a hotspot came from, for the card / detail header: "X" / "微博" / "@elonmusk". */
export const originLabel = (h: Pick<Hotspot, "platform" | "account" | "sourceType">, locale: "zh" | "en") => (h.platform === "x" && h.account && h.sourceType !== "trend" ? `@${h.account}` : sourceLabel(h.platform, locale));

export type TypeKey = "hot.type.trend" | "hot.type.key_account" | "hot.type.community";
export const typeKey = (st: HotspotSourceType): TypeKey => `hot.type.${st}` as TypeKey;

export type RegionKey = "hot.region.WW" | "hot.region.US" | "hot.region.GB" | "hot.region.JP" | "hot.region.KR" | "hot.region.IN" | "hot.region.ID" | "hot.region.BR" | "hot.region.CN";
const REGIONS = ["WW", "US", "GB", "JP", "KR", "IN", "ID", "BR", "CN"];
/** Region code → label in the UI language; unknown codes are shown as-is. Boss 9.11: Weibo's CN board reads "Global". */
/** Region chips to show: CN folded into WW, duplicates removed. */
export const displayRegions = (regions: string[]) => [...new Set(regions.map((r) => (r === "CN" ? "WW" : r)))];
export const regionLabel = (code: string, t: (k: RegionKey) => string) => {
  const c = code === "CN" ? "WW" : code;
  return REGIONS.includes(c) ? t(`hot.region.${c}` as RegionKey) : c;
};

/** Raw popularity figure as the platform reports it (posts on a board, likes on a post, Weibo heat) — not a score. */
export function heatOf(h: Hotspot, t: (k: "hot.posts" | "hot.heatIdx" | "hot.likes") => string) {
  const m = h.metrics;
  if (h.sourceType !== "trend" && Number(m.likes) > 0) return `${fmtNum(Number(m.likes))} ${t("hot.likes")}`;
  if (h.platform === "x" && Number(m.posts) > 0) return `${fmtNum(Number(m.posts))} ${t("hot.posts")}`;
  if (h.platform === "weibo" && Number(m.heat) > 0) return `${fmtNum(Number(m.heat))} ${t("hot.heatIdx")}`;
  return null;
}

/** Pick the copy for the UI language, falling back to whatever the source / AI produced. */
export function localizeHotspot(h: Hotspot, locale: "zh" | "en") {
  const zh = locale === "zh";
  return {
    title: (zh ? h.titleZh : h.titleEn) ?? h.title,
    name: (zh ? h.nameZh : h.name) ?? h.name,
    description: (zh ? h.descriptionZh : h.description) ?? h.description,
    /** true when both languages exist, so the user can choose which one goes on-chain */
    bilingual: !!h.nameZh && !!h.name,
  };
}
