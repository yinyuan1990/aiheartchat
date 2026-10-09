"use client";

import Link from "next/link";
import { fmtPrice, imgSrc, type Product } from "@/lib/shop";
import { t } from "@/lib/wallet/i18n";

/** Two-column picture grid of shop items inside the wallet (token page tab, item page "more from this shop"). */
export function ItemGrid({ items }: { items: Product[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {items.map((p) => (
        <Link key={p.id} href={`/wallet/shop?id=${p.id}`} className="overflow-hidden rounded-[18px] bg-card ring-1 ring-border transition active:scale-[0.98]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgSrc(p.images[0])} alt="" loading="lazy" className="aspect-square w-full bg-muted object-cover" />
          <div className="p-2.5">
            <div className="line-clamp-2 min-h-[2.6em] text-[13px] leading-tight font-medium">{p.title}</div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[15px] font-semibold text-up">{fmtPrice(p.priceUsd6)}</span>
              {p.sold > 0 && <span className="text-[11px] text-muted-foreground">{t("cw.shop.sold", { n: p.sold })}</span>}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
