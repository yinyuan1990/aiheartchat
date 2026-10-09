"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Lock, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContract } from "wagmi";
import { formatUnits, maxUint256, type Address, type PublicClient } from "viem";
import { toast } from "sonner";
import { afterBuyTax, type TokenView } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { quote } from "@/lib/wallet/arm-trade";
import { ADDR, NET, addrsFor, erc20Abi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import { defaultMethod, fmtPrice, payCall, payMinOut, placeOrder, usdcPayCall, type PayMethod, type Product, type Ship } from "@/lib/shop";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fill, useSiteSigner } from "./shared";

const SHIP_KEY = "arm.shop.ship";
const loadShip = (): Ship => {
  try {
    const saved = JSON.parse(localStorage.getItem(SHIP_KEY) ?? "{}") as Partial<Ship>;
    return { name: saved.name ?? "", phone: saved.phone ?? "", address: saved.address ?? "", note: "" };
  } catch {
    return { name: "", phone: "", address: "", note: "" };
  }
};

type Step = "approve" | "pay" | "sign" | "submit";

export function Checkout({ product, token, open, onOpenChange }: { product: Product; token: TokenView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, address, connected, wrongChain, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const client = usePublicClient();
  const { run } = useTx();
  const [ship, setShip] = useState<Ship>({ name: "", phone: "", address: "", note: "" });
  const [step, setStep] = useState<Step | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>(defaultMethod(product.pay));
  useEffect(() => {
    if (open) {
      setShip(loadShip());
      setDone(null);
      setMethod(defaultMethod(product.pay));
    }
  }, [open, product.pay]);
  const viaToken = method === "token";

  const price = BigInt(product.priceUsd6);
  const me = address as Address | undefined;
  const seller = product.seller as Address;
  const usdc = useReadContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, query: { enabled: !!me && open, refetchInterval: 8000 } });
  const q = useQuery({
    queryKey: ["shop", "quote", token.address, product.priceUsd6],
    enabled: open && !!client && product.pay.token,
    refetchInterval: 10_000,
    queryFn: () => quote(token, "buy", price, client as unknown as PublicClient),
  });
  const out = q.data ?? 0n;
  const net = token.buyTaxBps ? afterBuyTax(out, token.buyTaxBps) : out;
  const low = usdc.data != null && usdc.data < price;
  const formOk = !!ship.name.trim() && !!ship.phone.trim() && !!ship.address.trim();

  const pay = async () => {
    if (!me || !client || !signer || (viaToken && out === 0n)) return;
    localStorage.setItem(SHIP_KEY, JSON.stringify({ name: ship.name, phone: ship.phone, address: ship.address }));
    const label = `${product.title.slice(0, 18)} · ${fmtPrice(price)}`;
    try {
      let rc;
      if (viaToken) {
        const router = addrsFor(token.factory).router;
        const allowance = await client.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "allowance", args: [me, router] });
        if (allowance < price) {
          setStep("approve");
          const ok = await run(t("tx.approving"), { address: ADDR.usdc, abi: erc20Abi, functionName: "approve", args: [router, maxUint256] });
          if (!ok) return;
        }
        setStep("pay");
        const fresh = await quote(token, "buy", price, client as unknown as PublicClient);
        rc = await run(label, payCall(token, price, payMinOut(fresh), seller));
      } else {
        setStep("pay");
        rc = await run(label, usdcPayCall(price, seller));
      }
      if (!rc) return;
      setStep("sign");
      const clean = { name: ship.name.trim(), phone: ship.phone.trim(), address: ship.address.trim(), note: ship.note.trim() };
      const id = await placeOrder(signer, product.id, rc.transactionHash, clean, () => setStep("submit"));
      setDone(id);
      void usdc.refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setStep(null);
    }
  };

  const busy = step !== null;
  const field = (k: keyof Ship, label: string, area = false) => (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {area ? (
        <Textarea value={ship[k]} onChange={(e) => setShip({ ...ship, [k]: e.target.value })} rows={2} maxLength={k === "address" ? 300 : 200} disabled={busy} />
      ) : (
        <Input value={ship[k]} onChange={(e) => setShip({ ...ship, [k]: e.target.value })} maxLength={k === "phone" ? 30 : 40} disabled={busy} inputMode={k === "phone" ? "tel" : undefined} />
      )}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{done ? t("shop.success") : t("shop.checkout")}</DialogTitle>
          <DialogDescription className="line-clamp-1">{product.title}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto text-up" size={48} />
            <div className="text-sm text-secondary-foreground">#{done} · {fmtPrice(price)}</div>
            <Button className="w-full" asChild>
              <Link href="/shop/orders">{t("shop.orders")} →</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm font-medium">
                {t("shop.ship.title")}
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                  <Lock size={11} /> {t("shop.ship.privacy")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {field("name", t("shop.ship.name"))}
                {field("phone", t("shop.ship.phone"))}
              </div>
              {field("address", t("shop.ship.address"), true)}
              {field("note", t("shop.ship.note"))}
            </div>
            {product.pay.token && product.pay.usdc && (
              <div className="space-y-1.5">
                <div className="text-sm font-medium">{t("shop.method")}</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["token", "usdc"] as const).map((m) => (
                    <button key={m} type="button" disabled={busy} onClick={() => setMethod(m)} className={cn("rounded-lg border p-2.5 text-left text-xs transition", method === m ? "border-primary bg-primary/10" : "hover:border-ring")}>
                      <div className="font-semibold">{m === "token" ? fill(t("shop.method.token"), { sym: `$${token.symbol}` }) : t("shop.method.usdc")}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{m === "token" ? t("shop.method.tokenHint") : t("shop.method.usdcHint")}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5 rounded-lg bg-muted p-3 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("shop.youPay")}</span>
                <span className="font-mono font-semibold">{formatUnits(price, 6)} USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{viaToken ? t("shop.sellerGets") : t("shop.sellerGetsUsdc")}</span>
                <span className="font-mono">{!viaToken ? `${formatUnits(price, 6)} USDC` : q.isFetching && !q.data ? "…" : `${fmtNum(Number(formatUnits(net, 18)))} ${token.symbol}`}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("common.balance")}</span>
                <span className={low ? "font-mono text-down" : "font-mono"}>{usdc.data != null ? `${fmtNum(Number(formatUnits(usdc.data, 6)), 2)} USDC` : "—"}</span>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{viaToken ? fill(t("shop.howPayBody"), { price: formatUnits(price, 6), sym: `$${token.symbol}` }) : fill(t("shop.howPayUsdc"), { price: formatUnits(price, 6) })}</p>
            {!connected || wrongChain ? (
              <Button size="xl" variant="glow" className="w-full" onClick={toggleConnect}>
                {!connected ? t("common.connect") : t(`wallet.switch.${NET}`)}
              </Button>
            ) : (
              <Button size="xl" variant="up" className="w-full" disabled={busy || !formOk || low || (viaToken && out === 0n) || me?.toLowerCase() === seller.toLowerCase()} onClick={() => void pay()}>
                {busy ? (
                  <>
                    <RefreshCw className="animate-spin" /> {t(`shop.step.${step}`)}
                  </>
                ) : me?.toLowerCase() === seller.toLowerCase() ? (
                  t("shop.own")
                ) : low ? (
                  t("shop.balanceLow")
                ) : (
                  fill(t("shop.pay"), { price: fmtPrice(price) })
                )}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
