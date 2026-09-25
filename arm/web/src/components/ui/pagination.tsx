"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";

/**
 * One pager for every list in the app.
 *  - `usePage(items, pageSize)`      client-side slicing for lists that are already fully loaded
 *  - `<Pager page pageCount … />`    the control itself (prev / numbered / next + "x–y of n")
 * Server-paged lists (home tokens, token trades) drive `page` themselves and pass `total`.
 */

export function usePage<T>(items: readonly T[] | undefined, pageSize = 20) {
  const [page, setPage] = useState(1);
  const total = items?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(page, pageCount);
  const pageItems = useMemo(() => (items ?? []).slice((safe - 1) * pageSize, safe * pageSize), [items, safe, pageSize]);
  return { page: safe, setPage, pageItems, pageCount, total, pageSize };
}

/** Page numbers with ellipses: 1 … p-1 p p+1 … n */
function windowOf(page: number, count: number): (number | "…")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const set = new Set([1, 2, page - 1, page, page + 1, count - 1, count].filter((n) => n >= 1 && n <= count));
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of [...set].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

export function Pager({
  page,
  pageCount,
  onChange,
  total,
  pageSize,
  className,
  compact,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
  total?: number;
  pageSize?: number;
  className?: string;
  /** hide the numbered buttons (tight spaces like card footers) */
  compact?: boolean;
}) {
  const { t } = useApp();
  if (pageCount <= 1 && !total) return null;
  const from = total !== undefined && pageSize ? Math.min(total, (page - 1) * pageSize + 1) : null;
  const to = total !== undefined && pageSize ? Math.min(total, page * pageSize) : null;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground", className)}>
      <span className="font-mono tabular">
        {total !== undefined ? t("page.range").replace("{from}", String(from ?? 0)).replace("{to}", String(to ?? 0)).replace("{total}", String(total)) : t("page.of").replace("{page}", String(page)).replace("{count}", String(pageCount))}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={t("page.prev")}><ChevronLeft /></Button>
          {!compact &&
            windowOf(page, pageCount).map((n, i) =>
              n === "…" ? (
                <span key={`e${i}`} className="px-1">…</span>
              ) : (
                <Button key={n} size="icon-sm" variant={n === page ? "default" : "ghost"} className="font-mono" onClick={() => onChange(n)}>{n}</Button>
              ),
            )}
          {compact && <span className="px-1 font-mono">{page} / {pageCount}</span>}
          <Button size="icon-sm" variant="outline" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label={t("page.next")}><ChevronRight /></Button>
        </div>
      )}
    </div>
  );
}
