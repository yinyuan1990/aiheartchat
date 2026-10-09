"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useSignMessage } from "wagmi";
import { awaitWallet } from "@/lib/wallet-wait";
import { fmtPrice, imgSrc, type OrderStatus, type Product, type Signer } from "@/lib/shop";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { TokenAvatar } from "@/components/shared";

export const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** "USDC / $EGIRL" — the ways this shop takes payment */
export const payWays = (p: Pick<Product, "pay" | "token">) => [p.pay.usdc ? "USDC" : null, p.pay.token && p.token ? `$${p.token.symbol}` : null].filter(Boolean).join(" / ");

/** wagmi-backed signer for the shop's signed messages (null until a wallet is connected) */
export function useSiteSigner(): Signer | null {
  const { address } = useApp();
  const { signMessageAsync } = useSignMessage();
  const sign = useCallback((message: string) => awaitWallet(signMessageAsync({ message })), [signMessageAsync]);
  return address ? { address, sign } : null;
}

export function Cover({ src, className }: { src?: string | null; className?: string }) {
  const url = imgSrc(src);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" loading="lazy" className={cn("size-full object-cover", className)} />
  ) : (
    <span className={cn("flex size-full items-center justify-center bg-muted text-muted-foreground", className)}>
      <ImageOff size={20} />
    </span>
  );
}

export function ProductCard({ p, href }: { p: Product; href?: string }) {
  const { t } = useApp();
  const soldOut = p.stock != null && p.sold >= p.stock;
  return (
    <Link href={href ?? `/shop/${p.id}`} className="group block overflow-hidden rounded-xl border bg-card transition hover:border-ring">
      <div className="relative aspect-square overflow-hidden bg-muted">
        <Cover src={p.images[0]} className="transition duration-300 group-hover:scale-[1.03]" />
        {p.images.length > 1 && <span className="absolute right-2 bottom-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] text-white">1/{p.images.length}</span>}
        {soldOut && <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-semibold text-white">{t("shop.soldOut")}</span>}
        {p.status === "off" && <Badge variant="secondary" className="absolute top-2 left-2">{t("shop.form.off")}</Badge>}
      </div>
      <div className="space-y-1.5 p-3">
        <div className="line-clamp-2 min-h-[2.5em] text-sm leading-tight font-medium">{p.title}</div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-base font-semibold text-up tabular">{fmtPrice(p.priceUsd6)}</span>
          {p.token && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <TokenAvatar logo={imgSrc(p.token.logo)} symbol={p.token.symbol} seed={p.token.address} size={14} />
              <span className="truncate font-mono">{fill(t("shop.payIn"), { sym: payWays(p) })}</span>
            </span>
          )}
        </div>
        {p.sold > 0 && <div className="text-[11px] text-muted-foreground">{fill(t("shop.sold"), { n: p.sold })}</div>}
      </div>
    </Link>
  );
}

export function ProductGrid({ items, className }: { items: Product[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", className)}>
      {items.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </div>
  );
}

/** Pictures first: a square main image with arrows + a thumbnail strip. */
export function Gallery({ images }: { images: string[] }) {
  const [i, setI] = useState(0);
  const n = images.length;
  const go = (d: number) => setI((x) => (x + d + n) % n);
  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-xl bg-muted">
        <Cover src={images[i]} className="object-contain" />
        {n > 1 && (
          <>
            <button type="button" aria-label="prev" onClick={() => go(-1)} className="absolute top-1/2 left-2 flex size-9 -mt-4.5 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60">
              <ChevronLeft size={18} />
            </button>
            <button type="button" aria-label="next" onClick={() => go(1)} className="absolute top-1/2 right-2 flex size-9 -mt-4.5 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60">
              <ChevronRight size={18} />
            </button>
            <span className="absolute right-3 bottom-3 rounded-full bg-black/55 px-2 py-0.5 font-mono text-xs text-white">
              {i + 1}/{n}
            </span>
          </>
        )}
      </div>
      {n > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {images.map((u, k) => (
            <button key={u + k} type="button" onClick={() => setI(k)} className={cn("size-16 shrink-0 overflow-hidden rounded-lg border-2", k === i ? "border-primary" : "border-transparent opacity-70 hover:opacity-100")}>
              <Cover src={u} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function StatusBadge({ s }: { s: OrderStatus }) {
  const { t } = useApp();
  return <Badge variant={s === "paid" ? "gold" : s === "shipped" ? "accent" : "up"}>{t(`shop.status.${s}`)}</Badge>;
}
