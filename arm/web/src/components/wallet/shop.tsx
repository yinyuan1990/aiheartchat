"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ImageSquare, Star, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtPrice, imgSrc, postReview, postShopComment, uploadPicture, useComments, useReviews, type Order, type Product, type Signer } from "@/lib/shop";
import { t } from "@/lib/wallet/i18n";
import { PrimaryButton } from "./ui";

/** Two-column picture grid of shop items inside the wallet (market, token page tab, "more from this shop"). */
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

export function StarRow({ value, size = 14, onPick }: { value: number; size?: number; onPick?: (n: number) => void }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onPick} onClick={() => onPick?.(n)}>
          <Star size={size} weight={n <= Math.round(value) ? "fill" : "regular"} className={n <= Math.round(value) ? "text-[#f5a524]" : "text-muted-foreground/40"} />
        </button>
      ))}
    </span>
  );
}

function PicPicker({ value, onChange, max }: { value: string[]; onChange: (v: string[]) => void; max: number }) {
  const [busy, setBusy] = useState(0);
  const pick = async (files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, max - value.length);
    setBusy((n) => n + list.length);
    let next = value;
    for (const f of list) {
      try {
        next = [...next, await uploadPicture(f)].slice(0, max);
        onChange(next);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {value.map((u, i) => (
        <div key={u + i} className="relative size-16 overflow-hidden rounded-xl bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgSrc(u)} alt="" className="size-full object-cover" />
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"><X size={11} /></button>
        </div>
      ))}
      {value.length < max && (
        <label className="flex size-16 flex-col items-center justify-center rounded-xl bg-muted text-[10px] text-muted-foreground">
          <ImageSquare size={18} />
          {busy ? "…" : t("cw.shop.addPic")}
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
        </label>
      )}
    </div>
  );
}

function Pics({ images }: { images: string[] }) {
  if (!images.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {images.map((u, i) => (
        <a key={u + i} href={imgSrc(u)} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgSrc(u)} alt="" className="size-20 rounded-xl bg-muted object-cover" />
        </a>
      ))}
    </div>
  );
}

/** item page: reviews + comments with a composer (signs with the wallet's own key) */
export function ItemFeedback({ p, signer }: { p: Product; signer: Signer | null }) {
  const [tab, setTab] = useState<"reviews" | "comments">("reviews");
  const reviews = useReviews(p.id);
  const comments = useComments(p.id);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = new Map((comments.data ?? []).map((c) => [c.id, c]));
  const send = async () => {
    if (!signer) return;
    setBusy(true);
    try {
      await postShopComment(signer, p.id, { text: text.trim(), images, replyTo });
      setText("");
      setImages([]);
      setReplyTo(null);
      void qc.invalidateQueries({ queryKey: ["shop", "comments", p.id] });
      void qc.invalidateQueries({ queryKey: ["shop", "product", p.id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
      <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
        {(["reviews", "comments"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("rounded-xl py-2 text-[14px] font-semibold", tab === k ? "bg-background shadow-sm" : "text-muted-foreground")}>
            {k === "reviews" ? `${t("cw.shop.reviews")} ${p.reviews}` : `${t("cw.shop.comments")} ${p.comments}`}
          </button>
        ))}
      </div>
      {tab === "reviews" ? (
        <div className="mt-3 space-y-3">
          {p.rating != null && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[24px] font-bold">{p.rating.toFixed(1)}</span>
              <StarRow value={p.rating} size={16} />
            </div>
          )}
          {!reviews.isLoading && !(reviews.data ?? []).length && <div className="py-6 text-center text-[13px] text-muted-foreground">{t("cw.shop.noReviews")}</div>}
          {(reviews.data ?? []).map((r) => (
            <div key={r.id} className="border-b border-border/60 pb-3 last:border-0">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-mono">{shortAddr(r.buyer, 4, 4)}</span>
                <StarRow value={r.rating} size={12} />
                <span className="ml-auto">{timeAgo(new Date(r.time).getTime())}</span>
              </div>
              {r.text && <p className="mt-1.5 text-[14px] whitespace-pre-wrap">{r.text}</p>}
              <Pics images={r.images} />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {!comments.isLoading && !(comments.data ?? []).length && <div className="py-4 text-center text-[13px] text-muted-foreground">{t("cw.shop.noComments")}</div>}
          {(comments.data ?? []).map((c) => (
            <div key={c.id} className="border-b border-border/60 pb-3 last:border-0">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-mono">{shortAddr(c.author, 4, 4)}</span>
                {c.isSeller && <span className="rounded-md bg-[#f5a524]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#b77700]">{t("cw.shop.seller")}</span>}
                <span className="ml-auto">{timeAgo(new Date(c.time).getTime())}</span>
              </div>
              {c.replyTo != null && byId.get(c.replyTo) && <div className="mt-1 line-clamp-1 rounded-lg bg-muted px-2 py-1 text-[11px] text-muted-foreground">↩ {byId.get(c.replyTo)!.text || "🖼"}</div>}
              {c.text && <p className="mt-1.5 text-[14px] whitespace-pre-wrap">{c.text}</p>}
              <Pics images={c.images} />
              <button type="button" onClick={() => setReplyTo(c.id)} className="mt-1 text-[12px] text-muted-foreground">{t("cw.shop.reply")}</button>
            </div>
          ))}
          {signer && (
            <div className="space-y-2">
              {replyTo != null && (
                <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                  <span className="line-clamp-1">↩ {byId.get(replyTo)?.text}</span>
                  <button type="button" onClick={() => setReplyTo(null)}><X size={13} /></button>
                </div>
              )}
              <textarea value={text} maxLength={300} rows={2} placeholder={t("cw.shop.commentPlaceholder")} onChange={(e) => setText(e.target.value)} className="w-full resize-none rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none" />
              <div className="flex items-end justify-between gap-2">
                <PicPicker value={images} onChange={setImages} max={3} />
                <button type="button" disabled={busy || (!text.trim() && !images.length)} onClick={() => void send()} className="h-10 shrink-0 rounded-2xl bg-foreground px-5 text-[14px] font-semibold text-background disabled:opacity-40">
                  {t("cw.shop.send")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** orders page: stars + words + up to 6 pictures for one order */
export function ReviewSheetBody({ order, signer, onDone }: { order: Order; signer: Signer; onDone: () => void }) {
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await postReview(signer, order.id, { rating, text: text.trim(), images });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="line-clamp-1 text-[17px] font-semibold">{t("cw.shop.review")} · {order.title}</div>
      <div className="mt-3"><StarRow value={rating} size={30} onPick={setRating} /></div>
      <textarea value={text} maxLength={500} rows={3} placeholder={t("cw.shop.reviewPlaceholder")} onChange={(e) => setText(e.target.value)} className="mt-3 w-full resize-none rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none" />
      <div className="mt-2"><PicPicker value={images} onChange={setImages} max={6} /></div>
      <PrimaryButton className="mt-4" disabled={busy} onClick={() => void submit()}>{t("cw.shop.reviewSubmit")}</PrimaryButton>
    </>
  );
}
