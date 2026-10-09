"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ShoppingBag, Store } from "lucide-react";
import { useToken } from "@/lib/api";
import { fmtUsd } from "@/lib/format";
import { fmtPrice, imgSrc, useProduct, useShopProducts, usd6 } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Addr, Empty, SectionTitle, TokenAvatar } from "@/components/shared";
import { Checkout } from "@/components/shop/checkout";
import { Gallery, ProductGrid, fill, payWays } from "@/components/shop/shared";
import { CalloutButton } from "@/components/shop/callout";
import { CommentBox, ReviewList, ShareButton, Stars } from "@/components/shop/feedback";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { t, address } = useApp();
  const pq = useProduct(Number(id));
  const p = pq.data;
  const tq = useToken(p?.token?.address ?? "");
  const more = useShopProducts({ seller: p?.seller, limit: 9 }, !!p);
  const [open, setOpen] = useState(false);
  // back from the address page (?buy=1): reopen the checkout once the token for it is loaded
  const ready = !!tq.data;
  useEffect(() => {
    if (!ready || new URLSearchParams(window.location.search).get("buy") !== "1") return;
    setOpen(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, [ready]);

  if (pq.isLoading) return <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-2"><Skeleton className="aspect-square rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>;
  if (!p) return <Empty>{t("shop.empty")}</Empty>;

  const token = tq.data;
  const soldOut = p.stock != null && p.sold >= p.stock;
  const own = !!address && address.toLowerCase() === p.seller.toLowerCase();
  const approx = token && token.price > 0 ? usd6(p.priceUsd6) / token.price : 0;
  const others = (more.data ?? []).filter((x) => x.id !== p.id).slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-24 md:pb-0">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Gallery images={p.images} />
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <h1 className="flex-1 text-xl leading-snug font-bold md:text-2xl">{p.title}</h1>
            <ShareButton product={p} className="shrink-0" />
          </div>
          {p.rating != null && (
            <a href="#feedback" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Stars value={p.rating} /> <span className="font-mono text-foreground">{p.rating.toFixed(1)}</span> {fill(t("shop.reviewCount"), { n: p.reviews })}
            </a>
          )}
          <Card size="sm">
            <CardContent className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-3xl font-bold text-up tabular">{fmtPrice(p.priceUsd6)}</span>
                <span className="text-xs text-muted-foreground">
                  {p.sold > 0 && fill(t("shop.sold"), { n: p.sold })}
                  {p.stock != null && !soldOut && ` · ${fill(t("shop.stockLeft"), { n: p.stock - p.sold })}`}
                </span>
              </div>
              {p.token && (
                <Link href={`/token/${p.token.address}`} className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs hover:bg-accent">
                  <TokenAvatar logo={imgSrc(p.token.logo)} symbol={p.token.symbol} seed={p.token.address} size={20} />
                  <span className="font-medium">{fill(t("shop.payIn"), { sym: payWays(p) })}</span>
                  {approx > 0 && <span className="ml-auto font-mono text-muted-foreground">{fill(t("shop.approx"), { n: approx >= 1000 ? Math.round(approx).toLocaleString() : approx.toPrecision(4), sym: p.token.symbol })} · {fmtUsd(token!.price)}</span>}
                </Link>
              )}
            </CardContent>
          </Card>
          <div className="hidden gap-2 md:flex">
            <Button size="xl" variant="up" className="flex-1" disabled={soldOut || !token || own} onClick={() => setOpen(true)}>
              <ShoppingBag /> {soldOut ? t("shop.soldOut") : own ? t("shop.own") : t("shop.buy")}
            </Button>
            <CalloutButton product={p} />
          </div>
          <div className="space-y-1 rounded-lg border border-dashed p-3 text-xs leading-relaxed text-secondary-foreground">
            <div className="font-semibold text-foreground">{t("shop.howPay")}</div>
            {p.pay.token && <p>{fill(t("shop.howPayBody"), { price: usd6(p.priceUsd6).toFixed(2), sym: p.token ? `$${p.token.symbol}` : "" })}</p>}
            {p.pay.usdc && <p>{fill(t("shop.howPayUsdc"), { price: usd6(p.priceUsd6).toFixed(2) })}</p>}
          </div>
          <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-xs">
            <span className="text-muted-foreground">{t("shop.seller")} <Addr value={p.seller} className="text-foreground" /></span>
            <Button variant="link" size="sm" className="h-auto p-0" asChild>
              <Link href={`/shop/store/${p.seller}`}><Store size={12} /> {t("shop.visitShop")}</Link>
            </Button>
          </div>
          {p.body && (
            <div>
              <div className="label mb-1.5">{t("shop.details")}</div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-secondary-foreground">{p.body}</p>
            </div>
          )}
        </div>
      </div>

      <Card id="feedback" className="gap-0 py-0">
        <Tabs defaultValue="reviews">
          <div className="border-b p-2">
            <TabsList>
              <TabsTrigger value="reviews">{t("shop.reviews")} · {p.reviews}</TabsTrigger>
              <TabsTrigger value="comments">{t("shop.comments")} · {p.comments}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="reviews" className="p-4"><ReviewList product={p} /></TabsContent>
          <TabsContent value="comments" className="p-4"><CommentBox product={p} /></TabsContent>
        </Tabs>
      </Card>

      {others.length > 0 && (
        <section>
          <SectionTitle>{t("shop.visitShop")}</SectionTitle>
          <ProductGrid items={others} />
        </section>
      )}

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t bg-background/90 p-3 backdrop-blur md:hidden">
        <CalloutButton product={p} className="shrink-0" />
        <Button size="xl" variant="up" className="flex-1" disabled={soldOut || !token || own} onClick={() => setOpen(true)}>
          <ShoppingBag /> {soldOut ? t("shop.soldOut") : own ? t("shop.own") : `${t("shop.buy")} · ${fmtPrice(p.priceUsd6)}`}
        </Button>
      </div>
      {token && <Checkout product={p} token={token} open={open} onOpenChange={setOpen} />}
    </div>
  );
}
