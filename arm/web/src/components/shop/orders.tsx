"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, ExternalLink, Truck } from "lucide-react";
import { toast } from "sonner";
import { fmtNum, shortAddr } from "@/lib/format";
import { txUrl } from "@/lib/web3";
import { fmtPrice, type Order } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TimeAgo } from "@/components/shared";
import { Cover, StatusBadge } from "./shared";

const copy = async (s: string, msg: string) => {
  await navigator.clipboard.writeText(s).catch(() => {});
  toast.success(msg);
};

export function OrderCard({ o, role, onShip, onDone, onReview }: { o: Order; role: "buyer" | "seller"; onShip?: (o: Order) => void; onDone?: (o: Order) => void; onReview?: (o: Order) => void }) {
  const { t } = useApp();
  const shipText = o.ship ? `${o.ship.name} ${o.ship.phone}\n${o.ship.address}${o.ship.note ? `\n${o.ship.note}` : ""}` : "";
  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex gap-3">
          <Link href={`/shop/${o.productId}`} className="size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
            <Cover src={o.image} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <Link href={`/shop/${o.productId}`} className="line-clamp-2 text-sm font-medium hover:underline">{o.title}</Link>
              <StatusBadge s={o.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>#{o.id}</span>
              <span><TimeAgo ts={o.createdAt} /> ago</span>
              <span className="font-mono text-foreground">{fmtPrice(o.paidUsd6)}</span>
              <span>{o.payMethod === "usdc" ? t("shop.paidUsdc") : t("shop.paidToken")}</span>
              {o.payMethod !== "usdc" && <span className="font-mono">{fmtNum(Number(o.tokens) / 1e18)} {o.symbol ?? ""}</span>}
              <a href={txUrl(o.tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground">{t("shop.viewTx")} <ExternalLink size={10} /></a>
            </div>
          </div>
        </div>
        {role === "seller" && o.ship && (
          <div className="rounded-lg bg-muted p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("shop.ship.title")} · {t("shop.buyer")} {shortAddr(o.buyer, 4, 4)}</span>
              <Button variant="ghost" size="xs" onClick={() => void copy(shipText, t("shop.copied"))}><Copy /></Button>
            </div>
            <div className="mt-1 whitespace-pre-wrap text-foreground">{shipText}</div>
          </div>
        )}
        {(o.tracking || o.shipNote) && (
          <div className="flex items-start gap-2 rounded-lg border border-dashed p-2.5 text-xs">
            <Truck size={14} className="mt-0.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              {o.tracking && (
                <div className="flex items-center gap-1">
                  {o.carrier && <span>{o.carrier}</span>}
                  <span className="font-mono">{o.tracking}</span>
                  <button type="button" onClick={() => void copy(o.tracking, t("shop.copied"))} className="text-muted-foreground hover:text-foreground"><Copy size={11} /></button>
                </div>
              )}
              {o.shipNote && <div className="text-secondary-foreground">{o.shipNote}</div>}
            </div>
          </div>
        )}
        {role === "seller" && o.status !== "done" && onShip && (
          <Button size="sm" className="w-full" variant={o.status === "paid" ? "default" : "outline"} onClick={() => onShip(o)}>
            <Truck /> {t("shop.ship")}
          </Button>
        )}
        {role === "buyer" && o.status !== "paid" && (
          <div className="flex gap-2">
            {o.status === "shipped" && onDone && <Button size="sm" variant="outline" className="flex-1" onClick={() => onDone(o)}>{t("shop.confirmReceived")}</Button>}
            {onReview && (o.reviewed ? <Button size="sm" variant="ghost" className="flex-1" disabled>{t("shop.reviewed")}</Button> : <Button size="sm" className="flex-1" onClick={() => onReview(o)}>{t("shop.review")}</Button>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ShipDialog({ order, onClose, onSubmit }: { order: Order | null; onClose: () => void; onSubmit: (o: Order, v: { carrier: string; tracking: string; note: string }) => Promise<void> }) {
  const { t } = useApp();
  const [v, setV] = useState({ carrier: "", tracking: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  if (order && last !== order.id) {
    setLast(order.id);
    setV({ carrier: order.carrier, tracking: order.tracking, note: order.shipNote });
  }
  return (
    <Dialog open={!!order} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shop.shipTitle")} · #{order?.id}</DialogTitle>
          <DialogDescription>{t("shop.shipHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input placeholder={t("shop.carrier")} value={v.carrier} maxLength={40} onChange={(e) => setV({ ...v, carrier: e.target.value })} />
          <Input placeholder={t("shop.tracking")} value={v.tracking} maxLength={80} onChange={(e) => setV({ ...v, tracking: e.target.value })} className="font-mono" />
          <Input placeholder={t("shop.shipNote")} value={v.note} maxLength={200} onChange={(e) => setV({ ...v, note: e.target.value })} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button
            disabled={busy || (!v.tracking.trim() && !v.note.trim())}
            onClick={async () => {
              if (!order) return;
              setBusy(true);
              try {
                await onSubmit(order, { carrier: v.carrier.trim(), tracking: v.tracking.trim(), note: v.note.trim() });
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("shop.ship")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
