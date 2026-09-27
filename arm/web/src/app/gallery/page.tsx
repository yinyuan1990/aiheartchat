"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RocketLaunch } from "@phosphor-icons/react";
import { useGallery, type GalleryItem } from "@/lib/api";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Same breakpoints as the token grid: 2 / sm 3 / lg 4 / xl 5 columns. 0 until measured, so SSR never flashes 2 columns. */
function useColumnCount() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const qs = [["(min-width: 1280px)", 5], ["(min-width: 1024px)", 4], ["(min-width: 640px)", 3]] as const;
    const mqs = qs.map(([q]) => window.matchMedia(q));
    const update = () => setN(qs.find((_, i) => mqs[i].matches)?.[1] ?? 2);
    update();
    mqs.forEach((m) => m.addEventListener("change", update));
    return () => mqs.forEach((m) => m.removeEventListener("change", update));
  }, []);
  return n;
}

/** Height per unit width; unknown sizes get a portrait 3:4 box. */
const ratio = (it: GalleryItem) => (it.w && it.h ? it.h / it.w : 4 / 3);

/** Each picture goes to the currently shortest column, so columns stay even while order still reads roughly row by row. */
function masonry(items: GalleryItem[], cols: number) {
  const out: GalleryItem[][] = Array.from({ length: cols }, () => []);
  const heights = new Array<number>(cols).fill(0);
  for (const it of items) {
    const c = heights.indexOf(Math.min(...heights));
    out[c].push(it);
    heights[c] += ratio(it);
  }
  return out;
}

/** The box is sized from the known ratio up front; the picture fades in over a skeleton instead of pushing the layout. */
function Tile({ it }: { it: GalleryItem }) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (img.current?.complete) setLoaded(true);
  }, []);
  return (
    <a
      href={it.url}
      target="_blank"
      rel="noreferrer"
      className="relative block overflow-hidden rounded-xl border bg-muted transition-colors hover:border-primary/50"
      style={{ aspectRatio: `1 / ${ratio(it)}` }}
    >
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element -- host-relative uploads, served as-is */}
      <img
        ref={img}
        src={it.url}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-500", loaded ? "opacity-100" : "opacity-0")}
      />
    </a>
  );
}

const SkeletonGrid = () => (
  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
    {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}
  </div>
);

/** Picture wall laid out like the token grid; pictures keep their own aspect ratio (no cropping, no text). */
export default function GalleryPage() {
  const { t } = useApp();
  const q = useGallery();
  const cols = useColumnCount();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && !isFetchingNextPage && fetchNextPage(), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("gallery.title")}</h1>
        <Button variant="glow" asChild>
          <Link href="/create">
            <RocketLaunch weight="fill" /> {t("gallery.launch")}
          </Link>
        </Button>
      </div>
      {q.isLoading || !cols ? (
        <SkeletonGrid />
      ) : (
        <div className="flex items-start gap-3">
          {masonry(items, cols).map((col, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col gap-3">
              {col.map((it) => <Tile key={it.url} it={it} />)}
            </div>
          ))}
        </div>
      )}
      {hasNextPage && (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {t("gallery.more")}
          </Button>
        </div>
      )}
    </div>
  );
}
