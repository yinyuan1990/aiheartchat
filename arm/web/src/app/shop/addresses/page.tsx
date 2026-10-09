"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, MapPin, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { deleteAddress, fetchAddresses, pickAddress, pickedAddress, saveAddress, storedSession, type AddressInput, type SavedAddress } from "@/lib/shop";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSiteSigner } from "@/components/shop/shared";

export default function AddressesRoute() {
  return (
    <Suspense fallback={null}>
      <Addresses />
    </Suspense>
  );
}

/** Shipping address book. `?back=` (from checkout): tapping an address picks it for that order and goes back. */
function Addresses() {
  const { t, connected, address, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const router = useRouter();
  const back = useSearchParams().get("back");
  const safeBack = back && back.startsWith("/") && !back.startsWith("//") ? back : null;
  const [signedIn, setSignedIn] = useState(() => !!storedSession(address));
  const [edit, setEdit] = useState<AddressInput | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["shop", "addresses", address], enabled: !!signer && signedIn, queryFn: () => fetchAddresses(signer!) });
  const list = q.data ?? [];
  const current = pickedAddress(list);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await q.refetch();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const choose = (a: SavedAddress) => {
    pickAddress(a.id);
    if (safeBack) router.push(safeBack);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        {safeBack && (
          <Link href={safeBack} className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={12} /> {t("shop.checkout")}</Link>
        )}
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><MapPin /> {t("shop.addr.title")}</h1>
        <p className="mt-1 text-sm text-secondary-foreground">{t("shop.addr.hint")}</p>
      </div>
      {!connected || !signer ? (
        <Card><CardContent className="flex justify-center py-10"><Button variant="glow" onClick={toggleConnect}><Wallet /> {t("common.connect")}</Button></CardContent></Card>
      ) : !signedIn ? (
        <Card>
          <CardContent className="flex justify-center py-10">
            <Button disabled={busy} onClick={() => void run(async () => { await fetchAddresses(signer); setSignedIn(true); })}>{t("shop.addr.signIn")}</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {list.length === 0 && !q.isLoading && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{t("shop.addr.empty")}</CardContent></Card>}
          <div className="space-y-2">
            {list.map((a) => {
              const on = safeBack && current?.id === a.id;
              return (
                <Card key={a.id} size="sm" className={on ? "border-primary" : undefined}>
                  <CardContent className="flex items-start gap-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => choose(a)}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-semibold">{a.name}</span>
                        <span className="text-muted-foreground">{a.phone}</span>
                        {a.isDefault && <Badge variant="accent">{t("shop.addr.default")}</Badge>}
                      </div>
                      <div className="mt-1 text-xs whitespace-pre-wrap text-secondary-foreground">{a.address}</div>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      {safeBack && (
                        <Button size="sm" variant={on ? "default" : "outline"} onClick={() => choose(a)}>{on ? <Check /> : null}{t("shop.addr.use")}</Button>
                      )}
                      <Button size="icon" variant="ghost" title={t("shop.addr.edit")} onClick={() => setEdit({ id: a.id, name: a.name, phone: a.phone, address: a.address, isDefault: a.isDefault })}><Pencil /></Button>
                      <Button size="icon" variant="ghost" title={t("shop.delete")} disabled={busy} onClick={() => confirm(t("shop.addr.deleteConfirm")) && void run(() => deleteAddress(signer, a.id))}><Trash2 /></Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <Button variant="outline" className="w-full" disabled={list.length >= 20} onClick={() => setEdit({ name: "", phone: "", address: "", isDefault: list.length === 0 })}>
            <Plus /> {t("shop.addr.add")}
          </Button>
        </>
      )}

      <Dialog open={!!edit} onOpenChange={(o) => !o && !busy && setEdit(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{edit?.id ? t("shop.addr.edit") : t("shop.addr.add")}</DialogTitle></DialogHeader>
          {edit && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t("shop.ship.name")} value={edit.name} maxLength={40} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <Input placeholder={t("shop.ship.phone")} value={edit.phone} maxLength={30} inputMode="tel" onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
              </div>
              <Textarea placeholder={t("shop.ship.address")} value={edit.address} maxLength={300} rows={3} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> {t("shop.addr.setDefault")}
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setEdit(null)}>{t("common.cancel")}</Button>
            <Button
              disabled={busy || !edit?.name.trim() || !edit?.phone.trim() || !edit?.address.trim()}
              onClick={() => edit && signer && void run(async () => {
                const saved = await saveAddress(signer, { ...edit, name: edit.name.trim(), phone: edit.phone.trim(), address: edit.address.trim() });
                setEdit(null);
                if (safeBack && !edit.id) pickAddress(saved.id);
              })}
            >
              {t("shop.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
