"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RocketLaunch } from "@phosphor-icons/react";
import { useGallery } from "@/lib/api";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Same breakpoints as the token grid: 2 / sm 3 / lg 4 / xl 5 columns. */
function useColumnCount() {
  const [n, setN] = useState(2);
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

/**
 * Picture wall laid out like the token grid; pictures keep their own aspect ratio (no cropping, no text).
 * Items are dealt round-robin into columns so the order reads left to right, row by row.
 */
export default function GalleryPage() {
  const { t } = useApp();
  const q = useGallery();
  const cols = useColumnCount();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const columns = Array.from({ length: cols }, (_, c) => items.filter((_, i) => i % cols === c));

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
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {columns.map((col, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col gap-3">
              {col.map((src) => (
                <a key={src} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/50">
                  {/* eslint-disable-next-line @next/next/no-img-element -- host-relative uploads, served as-is */}
                  <img src={src} alt="" loading="lazy" className="block h-auto w-full" />
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {t("gallery.more")}
          </Button>
        </div>
      )}
    </div>
  );
}
