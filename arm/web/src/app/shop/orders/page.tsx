"use client";

import { useEffect, useState } from "react";
import { Package, RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { confirmReceived, fetchOrders, pendingOrders, signSession, storedSession, submitPending, type Order, type Pending } from "@/lib/shop";
import { ReviewDialog } from "@/components/shop/feedback";
import { useApp } from "@/components/providers";
import { errMsg, Empty } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrderCard } from "@/components/shop/orders";
import { useSiteSigner } from "@/components/shop/shared";

export default function MyOrders() {
  const { t, connected, address, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const qc = useQueryClient();
  const [session, setSession] = useState(() => storedSession(address));
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<Order | null>(null);
  useEffect(() => {
    setSession(storedSession(address));
    setPending(pendingOrders(address));
  }, [address]);

  const q = useQuery({
    queryKey: ["shop", "orders", "buyer", address],
    enabled: !!address && !!session,
    queryFn: () => fetchOrders(address!, session!, "buyer"),
    refetchInterval: 30_000,
  });

  if (!connected || !address || !signer) {
    return (
      <Gate title={t("shop.orders")}>
        <Button variant="glow" onClick={toggleConnect}><Wallet /> {t("common.connect")}</Button>
      </Gate>
    );
  }
  if (!session) {
    return (
      <Gate title={t("shop.orders")}>
        <p className="text-sm text-secondary-foreground">{t("shop.ordersSign")}</p>
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

  const retry = async (p: Pending) => {
    setBusy(true);
    try {
      await submitPending(p, signer);
      toast.success(t("shop.success"));
      void qc.invalidateQueries({ queryKey: ["shop", "orders"] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setPending(pendingOrders(address));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Package /> {t("shop.orders")}</h1>
      {pending.map((p) => (
        <Card key={p.tx} size="sm" className="border-gold/50">
          <CardContent className="flex items-center justify-between gap-3 text-xs">
            <span>{t("shop.pendingTitle")} · <span className="font-mono">{p.tx.slice(0, 12)}…</span></span>
            <Button size="sm" disabled={busy} onClick={() => void retry(p)}><RefreshCw /> {t("shop.retry")}</Button>
          </CardContent>
        </Card>
      ))}
      {q.isLoading ? null : !q.data?.length ? (
        <Empty>{t("common.noData")}</Empty>
      ) : (
        <div className="space-y-3">
          {q.data.map((o) => (
            <OrderCard key={o.id} o={o} role="buyer" onReview={setReviewing} onDone={async (x) => {
              try {
                await confirmReceived(signer, x.id);
                void q.refetch();
              } catch (e) {
                toast.error(errMsg(e));
              }
            }} />
          ))}
        </div>
      )}
      <ReviewDialog order={reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); void q.refetch(); }} />
    </div>
  );
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">{title}</h1>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">{children}</CardContent>
      </Card>
    </div>
  );
}
