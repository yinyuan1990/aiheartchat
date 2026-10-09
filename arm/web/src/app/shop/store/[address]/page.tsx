"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Store } from "lucide-react";
import { flatPages, imgSrc, useProductPages, useShopFront } from "@/lib/shop";
import { fmtUsd } from "@/lib/format";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Addr, Empty, TokenAvatar } from "@/components/shared";
import { LoadMore, ProductGrid, fill } from "@/components/shop/shared";

export default function StorePage() {
  const { address: seller } = useParams<{ address: string }>();
  const { t, address } = useApp();
  const q = useShopFront(seller);
  const own = !!address && address.toLowerCase() === seller.toLowerCase();
  const pages = useProductPages({ seller });
  const items = flatPages(pages.data);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4">
          <span className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary"><Store size={26} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold">{t("shop.title")}</div>
            <div className="text-xs text-muted-foreground">{t("shop.seller")} <Addr value={seller} head={8} tail={6} className="text-foreground" /></div>
          </div>
          {q.data?.token && (
            <Link href={`/token/${q.data.token.address}`} className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs hover:bg-accent">
              <TokenAvatar logo={imgSrc(q.data.token.logo)} symbol={q.data.token.symbol} seed={q.data.token.address} size={24} />
              <div>
                <div className="font-medium">{fill(t("shop.payIn"), { sym: `$${q.data.token.symbol}` })}</div>
                <div className="font-mono text-muted-foreground">{fmtUsd(q.data.token.price)}</div>
              </div>
            </Link>
          )}
          {own && (
            <Button size="sm" asChild>
              <Link href="/creator/shop">{t("shop.manage")}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
      {q.isLoading || pages.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}</div>
      ) : !q.data?.token ? (
        <Empty>{t("shop.noShop")}</Empty>
      ) : items.length === 0 ? (
        <Empty>{t("shop.empty")}</Empty>
      ) : (
        <>
          <ProductGrid items={items} />
          <LoadMore q={pages} />
        </>
      )}
    </div>
  );
}
