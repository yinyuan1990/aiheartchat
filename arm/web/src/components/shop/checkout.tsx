"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronRight, Lock, MapPin, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContract } from "wagmi";
import { formatUnits, maxUint256, type Address, type PublicClient } from "viem";
import { toast } from "sonner";
import { afterBuyTax, type TokenView } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { quote } from "@/lib/wallet/arm-trade";
import { ADDR, NET, addrsFor, erc20Abi } from "@/lib/web3";
import { useTx } from "@/lib/tx";
import {
  defaultMethod, fetchAddresses, fmtPrice, payCall, payMinOut, pickedAddress, placeOrder, sellerFeeShare, storedSession, usdcPayCall,
  type PayMethod, type Product,
} from "@/lib/shop";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { errMsg } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fill, useSiteSigner } from "./shared";

type Step = "approve" | "pay" | "sign" | "submit";

/** the address page sends the buyer back here (?buy=1 reopens this dialog) */
export const addressPageFor = (productId: number) => `/shop/addresses?back=${encodeURIComponent(`/shop/${productId}?buy=1`)}`;

export function Checkout({ product, token, open, onOpenChange }: { product: Product; token: TokenView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, address, connected, wrongChain, toggleConnect } = useApp();
  const signer = useSiteSigner();
  const client = usePublicClient();
  const { run } = useTx();
  const [note, setNote] = useState("");
  const [step, setStep] = useState<Step | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>(defaultMethod(product.pay));
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (open) {
      setNote("");
      setDone(null);
      setMethod(defaultMethod(product.pay));
      setSignedIn(!!storedSession(address));
    }
  }, [open, product.pay, address]);
  const viaToken = method === "token";
  const virtual = product.kind === "virtual";

  const addrs = useQuery({
    queryKey: ["shop", "addresses", address],
    enabled: open && !!signer && signedIn && !virtual,
    queryFn: () => fetchAddresses(signer!),
  });
  const ship = addrs.data ? pickedAddress(addrs.data) : null;
  const shipReady = virtual || !!ship;

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
  const own = me?.toLowerCase() === seller.toLowerCase();

  const signIn = async () => {
    if (!signer) return;
    try {
      await fetchAddresses(signer);
      setSignedIn(true);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const pay = async () => {
    if (!me || !client || !signer || !shipReady || (viaToken && out === 0n)) return;
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
        rc = await run(label, payCall(token, price, payMinOut(fresh), me));
      } else {
        setStep("pay");
        rc = await run(label, usdcPayCall(price, seller));
      }
      if (!rc) return;
      setStep("sign");
      const to = virtual || !ship ? { name: "", phone: "", address: "" } : { name: ship.name, phone: ship.phone, address: ship.address };
      const id = await placeOrder(signer, product.id, rc.transactionHash, { ...to, note: note.trim() }, () => setStep("submit"));
      setDone(id);
      void usdc.refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setStep(null);
    }
  };

  const busy = step !== null;

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
            {virtual && product.delivery === "auto" && <div className="text-sm font-medium text-up">{t("shop.deliveredAuto")}</div>}
            <Button className="w-full" asChild>
              <Link href="/shop/orders">{t("shop.orders")} →</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {virtual ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">{t("shop.virtualNoAddr")}</div>
                <Input value={note} maxLength={200} placeholder={t("shop.contact")} onChange={(e) => setNote(e.target.value)} disabled={busy} />
              </div>
            ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm font-medium">
                {t("shop.ship.title")}
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                  <Lock size={11} /> {t("shop.ship.privacy")}
                </span>
              </div>
              {!connected ? null : !signedIn ? (
                <Button variant="outline" className="w-full" onClick={() => void signIn()}>
                  <MapPin /> {t("shop.addr.signIn")}
                </Button>
              ) : ship ? (
                <Link href={addressPageFor(product.id)} className="flex items-center gap-3 rounded-lg border p-3 text-sm hover:border-ring">
                  <MapPin size={18} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{ship.name}</span> <span className="text-muted-foreground">{ship.phone}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-secondary-foreground">{ship.address}</span>
                  </span>
                  <span className="flex shrink-0 items-center text-xs text-muted-foreground">{t("shop.addr.change")} <ChevronRight size={14} /></span>
                </Link>
              ) : (
                <Button variant="outline" className="w-full" asChild disabled={addrs.isLoading}>
                  <Link href={addressPageFor(product.id)}>
                    <MapPin /> {addrs.isLoading ? "…" : t("shop.addr.add")}
                  </Link>
                </Button>
              )}
              <Input value={note} maxLength={200} placeholder={t("shop.ship.note")} onChange={(e) => setNote(e.target.value)} disabled={busy} />
            </div>
            )}
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
              {viaToken ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("shop.youGet")}</span>
                    <span className="font-mono">{q.isFetching && !q.data ? "…" : `${fmtNum(Number(formatUnits(net, 18)))} ${token.symbol}`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("shop.sellerFee")}</span>
                    <span className="font-mono">≈ ${Number(formatUnits(sellerFeeShare(price), 6)).toFixed(4)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("shop.sellerGetsUsdc")}</span>
                  <span className="font-mono">{formatUnits(price, 6)} USDC</span>
                </div>
              )}
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
              <Button size="xl" variant="up" className="w-full" disabled={busy || !shipReady || low || (viaToken && out === 0n) || own} onClick={() => void pay()}>
                {busy ? (
                  <>
                    <RefreshCw className="animate-spin" /> {t(`shop.step.${step}`)}
                  </>
                ) : own ? (
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
