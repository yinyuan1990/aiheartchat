"use client";

import Link from "next/link";
import { Store } from "lucide-react";
import { useShopProducts } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { Card } from "@/components/ui/card";
import { ProductCard, fill } from "./shared";

/** Token page: items that are paid in this token (renders nothing when there are none). */
export function TokenShopStrip({ token, symbol }: { token: string; symbol: string }) {
  const { t } = useApp();
  const q = useShopProducts({ token, limit: 12 });
  const items = q.data ?? [];
  if (!items.length) return null;
  const seller = items[0].seller;
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold"><Store size={16} className="text-primary" /> {fill(t("shop.tokenItems"), { sym: `$${symbol}` })}</span>
        <Link href={`/shop/store/${seller}`} className="text-xs text-muted-foreground hover:text-foreground">{t("shop.visitShop")} →</Link>
      </div>
      <div className="flex gap-3 overflow-x-auto p-3">
        {items.map((p) => (
          <div key={p.id} className="w-40 shrink-0">
            <ProductCard p={p} />
          </div>
        ))}
      </div>
    </Card>
  );
}
