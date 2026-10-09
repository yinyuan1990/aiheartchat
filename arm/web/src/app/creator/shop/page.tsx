"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ImagePlus, Pencil, Plus, Store, Trash2, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  createProduct, deleteProduct, flatPages, fmtPrice, imgSrc, setPayModes, setShopToken, shipOrder, signSession, storedSession, updateProduct, uploadPicture, useProductPages, useShopFront,
  type ItemStatus, type Order, type PayModes, type Product, type ProductInput,
} from "@/lib/shop";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errMsg, TokenAvatar } from "@/components/shared";
import { Cover, KindBadge, LoadMore, fill, useSiteSigner } from "@/components/shop/shared";
import { OrderCard, OrderList, ShipDialog } from "@/components/shop/orders";

const EMPTY: ProductInput = { title: "", body: "", images: [], priceUsd6: "1000000", stock: null, status: "on", kind: "physical", delivery: "manual", autoContent: "" };

export default function ManageShop() {
  const { t, connected, address, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const [session, setSession] = useState(() => storedSession(address));
  const [busy, setBusy] = useState(false);
  useEffect(() => setSession(storedSession(address)), [address]);
  const front = useShopFront(address, session ? address : undefined);
  const qc = useQueryClient();
  const [itemStatus, setItemStatus] = useState<ItemStatus>("all");
  const items = useProductPages({ seller: address, viewer: session ? address : undefined, status: itemStatus }, 23, !!address && !!session);
  const [edit, setEdit] = useState<{ id?: number; v: ProductInput } | null>(null);
  const [shipping, setShipping] = useState<Order | null>(null);

  if (!connected || !address || !signer) {
    return (
      <Gate>
        <Button variant="glow" onClick={toggleConnect}><Wallet /> {t("common.connect")}</Button>
      </Gate>
    );
  }
  if (!session) {
    return (
      <Gate>
        <p className="text-sm text-secondary-foreground">{t("shop.signInSeller")}</p>
        <Button disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            setSession(await signSession(signer));
          } catch (e) {
            toast.error(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}>{t("shop.signIn")}</Button>
      </Gate>
    );
  }

  const data = front.data;
  const act = async (fn: () => Promise<unknown>, ok = t("shop.saved")) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await front.refetch();
      void qc.invalidateQueries({ queryKey: ["shop", "products"] });
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/creator" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={12} /> {t("creator.title")}</Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-3xl"><Store /> {t("shop.manage")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-secondary-foreground">{t("shop.manageHint")}</p>
        </div>
        {data?.token && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/shop/store/${address}`}>{t("shop.visitShop")} →</Link>
          </Button>
        )}
      </div>

      <Card size="sm">
        <CardContent>
          <div className="label mb-2">{t("shop.payToken")}</div>
          {!data ? null : !data.eligible?.length ? (
            <div className="text-sm text-secondary-foreground">
              {t("shop.noToken")} <Link href="/create" className="text-primary hover:underline">{t("create.title")} →</Link>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.eligible.map((tok) => {
                const on = data.token?.address.toLowerCase() === tok.address.toLowerCase();
                return (
                  <button
                    key={tok.address}
                    type="button"
                    disabled={busy || on}
                    onClick={() => void act(() => setShopToken(signer, tok.address))}
                    className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition", on ? "border-primary bg-primary/10" : "hover:border-ring")}
                  >
                    <TokenAvatar logo={imgSrc(tok.logo)} symbol={tok.symbol} seed={tok.address} size={20} />
                    <span className="font-mono font-medium">${tok.symbol}</span>
                    {on ? <Badge variant="up">✓</Badge> : <span className="text-muted-foreground">{t("shop.setToken")}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {data?.token && (
        <Card size="sm">
          <CardContent>
            <div className="label mb-1">{t("shop.payModes")}</div>
            <p className="mb-3 text-xs text-muted-foreground">{t("shop.payModesHint")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["token", "usdc"] as const).map((m) => {
                const on = data.pay[m];
                const next: PayModes = { ...data.pay, [m]: !on };
                return (
                  <label key={m} className={cn("flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm", on && "border-primary/60 bg-primary/5")}>
                    <span>
                      <span className="font-medium">{m === "token" ? fill(t("shop.method.token"), { sym: `$${data.token!.symbol}` }) : t("shop.method.usdc")}</span>
                      <span className="block text-[11px] text-muted-foreground">{m === "token" ? t("shop.method.tokenHint") : t("shop.method.usdcHint")}</span>
                    </span>
                    <Switch checked={on} disabled={busy || (on && !next.token && !next.usdc)} onCheckedChange={() => void act(() => setPayModes(signer, next))} />
                  </label>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {data?.token && (
        <Tabs defaultValue={data.openOrders ? "orders" : "items"}>
          <TabsList>
            <TabsTrigger value="items">{t("shop.items")} · {data.items.on + (data.items.off ?? 0)}</TabsTrigger>
            <TabsTrigger value="orders">{t("shop.sellerOrders")}{data.openOrders ? ` · ${data.openOrders}` : ""}</TabsTrigger>
          </TabsList>
          <TabsContent value="items" className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              {(["all", "on", "off"] as const).map((s) => {
                const n = s === "all" ? data.items.on + (data.items.off ?? 0) : s === "on" ? data.items.on : (data.items.off ?? 0);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setItemStatus(s)}
                    className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition", itemStatus === s ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:border-ring hover:text-foreground")}
                  >
                    {s === "all" ? t("common.all") : t(`shop.form.${s}`)}
                    {n ? <span className="ml-1 font-mono">{n}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <button type="button" onClick={() => setEdit({ v: EMPTY })} className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm text-muted-foreground hover:border-ring hover:text-foreground">
                <Plus size={28} /> {t("shop.addItem")}
              </button>
              {items.isLoading
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)
                : flatPages(items.data).map((p) => (
                    <ItemTile key={p.id} p={p} onEdit={() => setEdit({ id: p.id, v: { title: p.title, body: p.body, images: p.images, priceUsd6: p.priceUsd6, stock: p.stock, status: p.status, kind: p.kind, delivery: p.delivery, autoContent: p.autoContent ?? "" } })} />
                  ))}
            </div>
            <LoadMore q={items} />
          </TabsContent>
          <TabsContent value="orders" className="mt-3">
            <OrderList address={address} session={session} role="seller" initial={data.openOrders ? "paid" : "all"} card={(o) => <OrderCard o={o} role="seller" onShip={setShipping} />} />
          </TabsContent>
        </Tabs>
      )}

      <ProductForm
        state={edit}
        busy={busy}
        onClose={() => setEdit(null)}
        onSave={async (v) => {
          const ok = await act(() => (edit?.id ? updateProduct(signer, edit.id, v) : createProduct(signer, v)));
          if (ok) setEdit(null);
        }}
        onDelete={edit?.id ? async () => {
          if (!confirm(t("shop.deleteConfirm"))) return;
          const ok = await act(() => deleteProduct(signer, edit.id!));
          if (ok) setEdit(null);
        } : undefined}
      />
      <ShipDialog
        order={shipping}
        onClose={() => setShipping(null)}
        onSubmit={async (o, v) => {
          try {
            await shipOrder(signer, o.id, v);
            toast.success(t("shop.saved"));
            void qc.invalidateQueries({ queryKey: ["shop", "orders"] });
            void front.refetch();
          } catch (e) {
            toast.error(errMsg(e));
            throw e;
          }
        }}
      />
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { t } = useApp();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 flex items-center gap-2 text-2xl font-bold tracking-tight"><Store /> {t("shop.manage")}</h1>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="max-w-md text-xs text-muted-foreground">{t("shop.manageHint")}</p>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function ItemTile({ p, onEdit }: { p: Product; onEdit: () => void }) {
  const { t } = useApp();
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Link href={`/shop/${p.id}`} className="relative block aspect-square bg-muted">
        <Cover src={p.images[0]} />
        {p.status === "off" && <Badge variant="secondary" className="absolute top-2 left-2">{t("shop.form.off")}</Badge>}
        <KindBadge p={p} className="absolute top-2 right-2" />
      </Link>
      <div className="space-y-1 p-3">
        <div className="line-clamp-1 text-sm font-medium">{p.title}</div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm font-semibold text-up">{fmtPrice(p.priceUsd6)}</span>
          <span className="text-[11px] text-muted-foreground">{fill(t("shop.sold"), { n: p.sold })}{p.stock != null ? ` / ${p.stock}` : ""}</span>
        </div>
        <Button size="sm" variant="outline" className="mt-1 w-full" onClick={onEdit}><Pencil /> {t("shop.editItem")}</Button>
      </div>
    </div>
  );
}

function ProductForm({ state, busy, onClose, onSave, onDelete }: { state: { id?: number; v: ProductInput } | null; busy: boolean; onClose: () => void; onSave: (v: ProductInput) => Promise<void>; onDelete?: () => Promise<void> }) {
  const { t } = useApp();
  const [v, setV] = useState<ProductInput>(EMPTY);
  const [price, setPrice] = useState("1");
  const [stock, setStock] = useState("");
  const [uploading, setUploading] = useState(0);
  const [key, setKey] = useState<string | null>(null);
  const k = state ? String(state.id ?? "new") : null;
  if (k !== key) {
    setKey(k);
    if (state) {
      setV(state.v);
      setPrice(String(Number(state.v.priceUsd6) / 1e6));
      setStock(state.v.stock == null ? "" : String(state.v.stock));
    }
  }

  const pick = async (files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, 9 - v.images.length);
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const url = await uploadPicture(f);
        setV((x) => ({ ...x, images: [...x.images, url].slice(0, 9) }));
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const move = (i: number, d: number) => setV((x) => {
    const a = [...x.images];
    const j = i + d;
    if (j < 0 || j >= a.length) return x;
    [a[i], a[j]] = [a[j], a[i]];
    return { ...x, images: a };
  });
  const priceUsd6 = Math.round(Number(price) * 1e6);
  const auto = v.kind === "virtual" && v.delivery === "auto";
  const valid = v.title.trim() && v.images.length > 0 && priceUsd6 >= 10_000 && priceUsd6 <= 10_000_000_000 && uploading === 0 && (!auto || v.autoContent.trim());

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{state?.id ? t("shop.editItem") : t("shop.addItem")}</DialogTitle>
          <DialogDescription>{t("shop.form.images")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {v.images.map((u, i) => (
            <div key={u + i} className={cn("group relative aspect-square overflow-hidden rounded-lg bg-muted", i === 0 && "ring-2 ring-primary")}>
              <Cover src={u} />
              <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-90">
                <button type="button" onClick={() => move(i, -1)} className="flex size-6 items-center justify-center rounded bg-black/55 text-white"><ArrowLeft size={12} /></button>
                <button type="button" onClick={() => move(i, 1)} className="flex size-6 items-center justify-center rounded bg-black/55 text-white"><ArrowRight size={12} /></button>
              </div>
              <button type="button" onClick={() => setV((x) => ({ ...x, images: x.images.filter((_, j) => j !== i) }))} className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-black/55 text-white"><X size={12} /></button>
            </div>
          ))}
          {v.images.length < 9 && (
            <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-[11px] text-muted-foreground hover:border-ring">
              <ImagePlus size={20} />
              {uploading ? t("shop.uploading") : t("shop.addPic")}
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
            </label>
          )}
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("shop.kind.title")}</span>
            <div className="grid grid-cols-2 gap-2">
              {(["physical", "virtual"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setV({ ...v, kind: k })} className={cn("rounded-lg border p-2.5 text-left text-xs transition", v.kind === k ? "border-primary bg-primary/10" : "hover:border-ring")}>
                  <div className="font-semibold">{t(`shop.kind.${k}`)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{t(`shop.kind.${k}Hint`)}</div>
                </button>
              ))}
            </div>
          </div>
          {v.kind === "virtual" && (
            <div className="space-y-2 rounded-lg bg-muted/60 p-2.5">
              <span className="text-xs text-muted-foreground">{t("shop.delivery.title")}</span>
              <div className="grid grid-cols-2 gap-2">
                {(["manual", "auto"] as const).map((d) => (
                  <button key={d} type="button" onClick={() => setV({ ...v, delivery: d })} className={cn("rounded-lg border bg-background p-2.5 text-left text-xs transition", v.delivery === d ? "border-primary bg-primary/10" : "hover:border-ring")}>
                    <div className="font-semibold">{t(`shop.delivery.${d}`)}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{t(`shop.delivery.${d}Hint`)}</div>
                  </button>
                ))}
              </div>
              {auto && (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{t("shop.delivery.autoContent")}</span>
                  <Textarea value={v.autoContent} maxLength={2000} rows={3} onChange={(e) => setV({ ...v, autoContent: e.target.value })} className="font-mono text-xs" />
                </label>
              )}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("shop.form.title")}</span>
            <Input value={v.title} maxLength={60} onChange={(e) => setV({ ...v, title: e.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("shop.form.body")}</span>
            <Textarea value={v.body} maxLength={2000} rows={4} onChange={(e) => setV({ ...v, body: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("shop.form.price")}</span>
              <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} className="font-mono" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("shop.form.stock")}</span>
              <Input value={stock} inputMode="numeric" onChange={(e) => setStock(e.target.value.replace(/\D/g, ""))} className="font-mono" />
            </label>
          </div>
          <div className="flex gap-2">
            {(["on", "off"] as const).map((s) => (
              <Button key={s} type="button" size="sm" variant={v.status === s ? "default" : "outline"} onClick={() => setV({ ...v, status: s })}>{t(`shop.form.${s}`)}</Button>
            ))}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {onDelete && <Button variant="ghost" className="mr-auto text-down" disabled={busy} onClick={() => void onDelete()}><Trash2 /> {t("shop.delete")}</Button>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button disabled={busy || !valid} onClick={() => void onSave({ ...v, title: v.title.trim(), body: v.body.trim(), priceUsd6: String(priceUsd6), stock: stock === "" ? null : Number(stock), autoContent: auto ? v.autoContent.trim() : "" })}>{t("shop.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
