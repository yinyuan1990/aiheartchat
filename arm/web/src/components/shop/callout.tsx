"use client";

import { useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { HEARTCHAT_DOWNLOAD, calloutChannel, fmtPrice, sendCardCall, type Product } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fill } from "./shared";

/**
 * 商品详情页的「喊单」：在心之音 App 的 DApp 浏览器里打开时，卡片经 App 的登录态发进这个卖家的店铺群
 * （lib/shop.ts sendCardCall）；在普通浏览器里点了去心之音下载页。
 */
export function CalloutButton({ product, className }: { product: Product; className?: string }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const click = () => {
    if (calloutChannel(false)) setOpen(true);
    else if (confirm(t("shop.calloutApp"))) window.open(HEARTCHAT_DOWNLOAD, "_blank", "noopener");
  };
  const send = async () => {
    setBusy(true);
    try {
      await sendCardCall({ kind: "shop", productId: product.id, note: note.trim() });
      setOpen(false);
      setNote("");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="xl" className={className} onClick={click}>
        <Megaphone /> {t("shop.callout")}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("shop.calloutTitle")}</DialogTitle>
            <DialogDescription>{t("shop.calloutHint")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-muted p-3 text-sm">
            <div className="line-clamp-1 font-medium">{product.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {fmtPrice(product.priceUsd6)} · {fill(t("shop.sold"), { n: product.sold })}
            </div>
          </div>
          <Input value={note} maxLength={200} placeholder={t("shop.calloutNote")} onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button className="w-full" disabled={busy} onClick={() => void send()}>
              <Megaphone /> {t("shop.calloutSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
