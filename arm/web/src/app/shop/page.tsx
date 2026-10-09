"use client";

import Link from "next/link";
import { Package, Store } from "lucide-react";
import { useShopProducts } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty } from "@/components/shared";
import { ProductGrid } from "@/components/shop/shared";

export default function ShopIndex() {
  const { t } = useApp();
  const q = useShopProducts({ limit: 120 });
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("shop.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-secondary-foreground">{t("shop.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/shop/orders"><Package /> {t("shop.orders")}</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/creator/shop"><Store /> {t("shop.manage")}</Link>
          </Button>
        </div>
      </div>
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}
        </div>
      ) : !q.data?.length ? (
        <Empty>{t("shop.empty")}</Empty>
      ) : (
        <ProductGrid items={q.data} />
      )}
    </div>
  );
}
