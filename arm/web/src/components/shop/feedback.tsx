"use client";

import { useState } from "react";
import { ImagePlus, Share2, Star, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { imgSrc, postReview, postShopComment, productUrl, uploadPicture, useComments, useReviews, type Order, type Product } from "@/lib/shop";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Addr, errMsg, TimeAgo } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Cover, fill, useSiteSigner } from "./shared";

export function Stars({ value, size = 14, onPick }: { value: number; size?: number; onPick?: (n: number) => void }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onPick} onClick={() => onPick?.(n)} className={cn(onPick ? "cursor-pointer" : "cursor-default")}>
          <Star size={size} className={n <= Math.round(value) ? "fill-gold text-gold" : "text-muted-foreground/40"} />
        </button>
      ))}
    </span>
  );
}

/** picked pictures (uploaded right away) with remove buttons + an add tile */
export function PicPicker({ value, onChange, max }: { value: string[]; onChange: (v: string[]) => void; max: number }) {
  const { t } = useApp();
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
        toast.error(errMsg(e));
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {value.map((u, i) => (
        <div key={u + i} className="relative size-16 overflow-hidden rounded-lg bg-muted">
          <Cover src={u} />
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"><X size={11} /></button>
        </div>
      ))}
      {value.length < max && (
        <label className="flex size-16 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed text-[10px] text-muted-foreground hover:border-ring">
          <ImagePlus size={16} />
          {busy ? t("shop.uploading") : t("shop.addPic")}
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
        <a key={u + i} href={imgSrc(u)} target="_blank" rel="noreferrer" className="size-20 overflow-hidden rounded-lg bg-muted">
          <Cover src={u} />
        </a>
      ))}
    </div>
  );
}

export function ReviewList({ product }: { product: Product }) {
  const { t } = useApp();
  const q = useReviews(product.id);
  const list = q.data ?? [];
  return (
    <div className="space-y-3">
      {product.rating != null && (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-2xl font-bold">{product.rating.toFixed(1)}</span>
          <Stars value={product.rating} size={16} />
          <span className="text-muted-foreground">{fill(t("shop.reviewCount"), { n: product.reviews })}</span>
        </div>
      )}
      {list.length === 0 && !q.isLoading && <div className="py-6 text-center text-sm text-muted-foreground">{t("shop.noReviews")}</div>}
      {list.map((r) => (
        <div key={r.id} className="border-b pb-3 last:border-0">
          <div className="flex items-center gap-2 text-xs">
            <Addr value={r.buyer} />
            <Stars value={r.rating} size={12} />
            <span className="ml-auto text-muted-foreground"><TimeAgo ts={r.time} /> ago</span>
          </div>
          {r.text && <p className="mt-1.5 text-sm whitespace-pre-wrap">{r.text}</p>}
          <Pics images={r.images} />
        </div>
      ))}
    </div>
  );
}

export function CommentBox({ product }: { product: Product }) {
  const { t, connected, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const qc = useQueryClient();
  const q = useComments(product.id);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const list = q.data ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const send = async () => {
    if (!signer) return;
    setBusy(true);
    try {
      await postShopComment(signer, product.id, { text: text.trim(), images, replyTo });
      setText("");
      setImages([]);
      setReplyTo(null);
      void qc.invalidateQueries({ queryKey: ["shop", "comments", product.id] });
      void qc.invalidateQueries({ queryKey: ["shop", "product", product.id] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {list.length === 0 && !q.isLoading && <div className="py-4 text-center text-sm text-muted-foreground">{t("shop.noComments")}</div>}
      {list.map((c) => (
        <div key={c.id} className="border-b pb-3 last:border-0">
          <div className="flex items-center gap-2 text-xs">
            <Addr value={c.author} />
            {c.isSeller && <Badge variant="gold">{t("shop.seller")}</Badge>}
            <span className="ml-auto text-muted-foreground"><TimeAgo ts={c.time} /> ago</span>
          </div>
          {c.replyTo != null && byId.get(c.replyTo) && <div className="mt-1 line-clamp-1 rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">↩ {byId.get(c.replyTo)!.text || "🖼"}</div>}
          {c.text && <p className="mt-1.5 text-sm whitespace-pre-wrap">{c.text}</p>}
          <Pics images={c.images} />
          <button type="button" onClick={() => setReplyTo(c.id)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">{t("shop.reply")}</button>
        </div>
      ))}
      {!connected ? (
        <Button variant="outline" className="w-full" onClick={toggleConnect}>{t("common.connect")}</Button>
      ) : (
        <div className="space-y-2 rounded-lg border p-3">
          {replyTo != null && (
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="line-clamp-1">↩ {byId.get(replyTo)?.text}</span>
              <button type="button" onClick={() => setReplyTo(null)}><X size={12} /></button>
            </div>
          )}
          <Textarea value={text} maxLength={300} rows={2} placeholder={t("shop.commentPlaceholder")} onChange={(e) => setText(e.target.value)} />
          <div className="flex items-end justify-between gap-2">
            <PicPicker value={images} onChange={setImages} max={3} />
            <Button size="sm" disabled={busy || (!text.trim() && !images.length)} onClick={() => void send()}>{t("shop.send")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReviewDialog({ order, onClose, onDone }: { order: Order | null; onClose: () => void; onDone: () => void }) {
  const { t } = useApp();
  const signer = useSiteSigner();
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!order || !signer) return;
    setBusy(true);
    try {
      await postReview(signer, order.id, { rating, text: text.trim(), images });
      setText("");
      setImages([]);
      setRating(5);
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!order} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("shop.review")} · {order?.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Stars value={rating} size={28} onPick={setRating} />
          <Textarea value={text} maxLength={500} rows={3} placeholder={t("shop.reviewPlaceholder")} onChange={(e) => setText(e.target.value)} />
          <PicPicker value={images} onChange={setImages} max={6} />
        </div>
        <DialogFooter>
          <Button className="w-full" disabled={busy} onClick={() => void submit()}>{t("shop.reviewSubmit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShareButton({ product, className }: { product: Product; className?: string }) {
  const { t } = useApp();
  const share = async () => {
    const url = productUrl(product.id);
    const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (nav.share) {
      await nav.share({ title: product.title, url }).catch(() => {});
      return;
    }
    await navigator.clipboard.writeText(`${product.title} ${url}`).catch(() => {});
    toast.success(t("shop.linkCopied"));
  };
  return (
    <Button variant="outline" size="icon-lg" className={className} title={t("token.share")} onClick={() => void share()}>
      <Share2 />
    </Button>
  );
}
