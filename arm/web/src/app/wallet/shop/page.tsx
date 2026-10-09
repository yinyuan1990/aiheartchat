"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type Address } from "viem";
import { ArrowSquareOut, CheckCircle, CircleNotch, Copy, LockSimple, Megaphone, Package, Storefront, Truck } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { afterBuyTax, useToken } from "@/lib/api";
import { fmtNum, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR } from "@/lib/web3";
import { chainByKey, explorerTx, publicClientFor } from "@/lib/wallet/chains";
import { executeTrade, quote, transferUsdc, type TradeStep } from "@/lib/wallet/arm-trade";
import { t } from "@/lib/wallet/i18n";
import { hasFeature, nativeBridge } from "@/lib/wallet/native";
import {
  HEARTCHAT_DOWNLOAD, confirmReceived, defaultMethod, fetchOrders, fmtPrice, imgSrc, payMinOut, pendingOrders, placeOrder, sendCardCall, signSession, submitPending, useProduct, useShopProducts, usd6,
  type Order, type PayMethod, type Pending, type Product, type Ship, type Signer,
} from "@/lib/shop";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";
import { ItemGrid } from "@/components/wallet/shop";

export default function WalletShopRoute() {
  return (
    <Suspense fallback={<WalletFrame>{null}</WalletFrame>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const id = Number(useSearchParams().get("id"));
  return Number.isSafeInteger(id) && id > 0 ? <ItemPage id={id} /> : <OrdersPage />;
}

function useSigner(): Signer | null {
  const { active, account } = useVault();
  return useMemo(() => (active ? { address: active.address, sign: (message: string) => account().signMessage({ message }) } : null), [active, account]);
}

/* ───────────── item ───────────── */

function Pics({ images }: { images: string[] }) {
  const [i, setI] = useState(0);
  return (
    <div className="relative">
      <div
        className="flex aspect-square snap-x snap-mandatory overflow-x-auto bg-muted [scrollbar-width:none]"
        onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
      >
        {images.map((u, k) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={u + k} src={imgSrc(u)} alt="" className="size-full shrink-0 snap-center object-contain" />
        ))}
      </div>
      {images.length > 1 && (
        <span className="absolute right-3 bottom-3 rounded-full bg-black/55 px-2.5 py-0.5 font-mono text-[12px] text-white">
          {i + 1}/{images.length}
        </span>
      )}
    </div>
  );
}

function ItemPage({ id }: { id: number }) {
  const { active } = useVault();
  const pq = useProduct(id);
  const p = pq.data;
  const more = useShopProducts({ seller: p?.seller, limit: 9 }, !!p);
  const [sheet, setSheet] = useState(false);
  const [callout, setCallout] = useState(false);
  if (!p) {
    return (
      <WalletFrame>
        <TopBar back="/wallet/token" title={t("cw.shop.title")} />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{pq.isError ? t("cw.shop.notFound") : <CircleNotch size={28} className="animate-spin" />}</div>
      </WalletFrame>
    );
  }
  const soldOut = p.stock != null && p.sold >= p.stock;
  const own = !!active && active.address.toLowerCase() === p.seller.toLowerCase();
  const others = (more.data ?? []).filter((x) => x.id !== p.id);
  return (
    <WalletFrame>
      <TopBar back={p.token ? `/wallet/token?address=${p.token.address}` : "/wallet/token"} title={t("cw.shop.title")} right={<Link href="/wallet/shop" className="flex size-10 items-center justify-center rounded-full hover:bg-muted"><Package size={20} /></Link>} />
      <div className="flex-1 pb-28">
        <Pics images={p.images} />
        <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[30px] font-bold text-up">{fmtPrice(p.priceUsd6)}</span>
            <span className="text-[12px] text-muted-foreground">
              {p.sold > 0 && t("cw.shop.sold", { n: p.sold })}
              {p.stock != null && !soldOut && ` · ${t("cw.shop.left", { n: p.stock - p.sold })}`}
            </span>
          </div>
          <h1 className="mt-1 text-[17px] leading-snug font-semibold">{p.title}</h1>
          {p.token && (
            <Link href={`/wallet/token?address=${p.token.address}`} className="mt-3 flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-[13px]">
              <TokenAvatar logo={imgSrc(p.token.logo)} symbol={p.token.symbol} seed={p.token.address} size={20} className="rounded-full" />
              <span className="font-medium">{t("cw.shop.payIn", { sym: payWaysOf(p) })}</span>
            </Link>
          )}
          {p.pay.token && <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{t("cw.shop.howPay", { price: usd6(p.priceUsd6).toFixed(2), sym: p.token ? `$${p.token.symbol}` : "" })}</p>}
          {p.pay.usdc && <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{t("cw.shop.howPayUsdc", { price: usd6(p.priceUsd6).toFixed(2) })}</p>}
        </section>
        {p.body && (
          <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
            <div className="text-[14px] font-semibold">{t("cw.shop.details")}</div>
            <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap text-secondary-foreground">{p.body}</p>
          </section>
        )}
        {others.length > 0 && (
          <section className="mx-4 mt-3">
            <div className="mb-2 text-[14px] font-semibold">{t("cw.shop.more")}</div>
            <ItemGrid items={others} />
          </section>
        )}
      </div>
      <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[430px] gap-2 bg-background/90 px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-xl sm:absolute">
        <button type="button" onClick={() => setCallout(true)} className="flex h-[52px] shrink-0 items-center gap-1.5 rounded-2xl bg-muted px-4 text-[15px] font-semibold active:scale-95">
          <Megaphone size={19} weight="fill" /> {t("cw.shop.callout")}
        </button>
        <PrimaryButton tone="up" className="flex-1" disabled={soldOut || own || !p.token} onClick={() => setSheet(true)}>
          {soldOut ? t("cw.shop.soldOut") : own ? t("cw.shop.own") : `${t("cw.shop.buy")} · ${fmtPrice(p.priceUsd6)}`}
        </PrimaryButton>
      </div>
      <BottomSheet open={sheet} onClose={() => setSheet(false)}>{sheet && p.token && <BuySheet p={p} onDone={() => setSheet(false)} />}</BottomSheet>
      <BottomSheet open={callout} onClose={() => setCallout(false)}>{callout && <CalloutSheet p={p} onDone={() => setCallout(false)} />}</BottomSheet>
    </WalletFrame>
  );
}

const payWaysOf = (p: Product) => [p.pay.usdc ? "USDC" : null, p.pay.token && p.token ? `$${p.token.symbol}` : null].filter(Boolean).join(" / ");

/** 喊单：通用卡片经 App 的登录态发进卖家的店铺群（原生 perpCall 原样转给心之音后端），外壳随后打开那个群 */
function CalloutSheet({ p, onDone }: { p: Product; onDone: () => void }) {
  const bridge = nativeBridge();
  const ok = hasFeature("perpcall") && !!bridge?.perpCall;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await sendCardCall({ kind: "shop", productId: p.id, note: note.trim() }, (b) => bridge!.perpCall!(b));
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex items-center gap-2 text-[17px] font-semibold"><Megaphone size={20} weight="fill" /> {t("cw.shop.calloutTitle")}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t("cw.shop.calloutHint")}</p>
      <div className="mt-3 flex items-center gap-3 rounded-2xl bg-muted p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imgSrc(p.images[0])} alt="" className="size-12 rounded-xl object-cover" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-[14px] font-medium">{p.title}</div>
          <div className="text-[12px] text-muted-foreground">{fmtPrice(p.priceUsd6)} · {t("cw.shop.sold", { n: p.sold })}</div>
        </div>
      </div>
      {ok ? (
        <>
          <input value={note} maxLength={200} placeholder={t("cw.shop.calloutNote")} onChange={(e) => setNote(e.target.value)} className="mt-3 w-full rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none" />
          <PrimaryButton className="mt-4" disabled={busy} onClick={() => void send()}>
            {busy ? <CircleNotch size={18} className="mx-auto animate-spin" /> : t("cw.shop.calloutSend")}
          </PrimaryButton>
        </>
      ) : (
        <a href={HEARTCHAT_DOWNLOAD} target="_blank" rel="noreferrer" className="mt-4 block">
          <PrimaryButton>{t("cw.shop.calloutApp")}</PrimaryButton>
        </a>
      )}
    </>
  );
}

const SHIP_KEY = "arm.shop.ship";
const STEP: Record<TradeStep | "submit", string> = { approving: "cw.shop.stepApproving", swapping: "cw.shop.stepSwapping", confirming: "cw.shop.stepConfirming", submit: "cw.shop.stepSubmit" };

function BuySheet({ p, onDone }: { p: Product; onDone: () => void }) {
  const { active, account } = useVault();
  const signer = useSigner();
  const qc = useQueryClient();
  const tq = useToken(p.token!.address);
  const token = tq.data;
  const price = BigInt(p.priceUsd6);
  const [ship, setShip] = useState<Ship>({ name: "", phone: "", address: "", note: "" });
  const [step, setStep] = useState<TradeStep | "submit" | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>(defaultMethod(p.pay));
  const viaToken = method === "token";
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SHIP_KEY) ?? "{}") as Partial<Ship>;
      setShip({ name: s.name ?? "", phone: s.phone ?? "", address: s.address ?? "", note: "" });
    } catch {}
  }, []);
  const me = active?.address as Address | undefined;
  const bal = useQuery({
    queryKey: ["wallet", "usdc", me],
    enabled: !!me,
    refetchInterval: 8_000,
    queryFn: () => publicClientFor(chainByKey("arc")).readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me!] }),
  });
  const q = useQuery({ queryKey: ["wallet", "shopquote", p.id, token?.address], enabled: !!token && p.pay.token, refetchInterval: 10_000, queryFn: () => quote(token!, "buy", price) });
  const out = q.data ?? 0n;
  const net = token?.buyTaxBps ? afterBuyTax(out, token.buyTaxBps) : out;
  const low = bal.data != null && bal.data < price;
  const formOk = !!ship.name.trim() && !!ship.phone.trim() && !!ship.address.trim();

  const go = async () => {
    if (!token || !signer || (viaToken && out === 0n)) return;
    setErr("");
    localStorage.setItem(SHIP_KEY, JSON.stringify({ name: ship.name, phone: ship.phone, address: ship.address }));
    try {
      const rc = viaToken
        ? await executeTrade(account(), token, "buy", price, payMinOut(await quote(token, "buy", price)), setStep, p.seller as Address)
        : await transferUsdc(account(), p.seller as Address, price, setStep);
      setStep("submit");
      const clean = { name: ship.name.trim(), phone: ship.phone.trim(), address: ship.address.trim(), note: ship.note.trim() };
      setDone(await placeOrder(signer, p.id, rc.transactionHash, clean));
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      void qc.invalidateQueries({ queryKey: ["shop"] });
    } catch (e) {
      setErr(((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]);
    } finally {
      setStep(null);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <CheckCircle size={56} weight="fill" className="text-up" />
        <div className="text-[17px] font-semibold">{t("cw.shop.success")}</div>
        <div className="text-[13px] text-muted-foreground">#{done} · {p.title}</div>
        <Link href="/wallet/shop" onClick={onDone} className="mt-2 w-full">
          <PrimaryButton>{t("cw.shop.orders")}</PrimaryButton>
        </Link>
      </div>
    );
  }

  const input = (k: keyof Ship, area = false) => {
    const cls = "w-full rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none ring-1 ring-transparent focus:ring-border";
    return area ? (
      <textarea value={ship[k]} rows={2} maxLength={300} placeholder={t(`cw.shop.${k}`)} disabled={!!step} onChange={(e) => setShip({ ...ship, [k]: e.target.value })} className={cn(cls, "resize-none")} />
    ) : (
      <input value={ship[k]} maxLength={k === "note" ? 200 : 40} placeholder={t(`cw.shop.${k}`)} disabled={!!step} inputMode={k === "phone" ? "tel" : undefined} onChange={(e) => setShip({ ...ship, [k]: e.target.value })} className={cls} />
    );
  };

  return (
    <>
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imgSrc(p.images[0])} alt="" className="size-14 rounded-2xl bg-muted object-cover" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-[15px] font-semibold">{p.title}</div>
          <div className="font-mono text-[15px] text-up">{fmtPrice(p.priceUsd6)}</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-[13px] font-semibold">
        {t("cw.shop.shipTitle")}
        <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground"><LockSimple size={12} /> {t("cw.shop.privacy")}</span>
      </div>
      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          {input("name")}
          {input("phone")}
        </div>
        {input("address", true)}
        {input("note")}
      </div>
      {p.pay.token && p.pay.usdc && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(["token", "usdc"] as const).map((m) => (
            <button key={m} type="button" disabled={!!step} onClick={() => setMethod(m)} className={cn("rounded-2xl p-3 text-left ring-1 transition", method === m ? "bg-foreground/5 ring-foreground" : "ring-border")}>
              <div className="text-[14px] font-semibold">{m === "token" ? t("cw.shop.methodToken", { sym: `$${p.token!.symbol}` }) : t("cw.shop.methodUsdc")}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{m === "token" ? t("cw.shop.methodTokenHint") : t("cw.shop.methodUsdcHint")}</div>
            </button>
          ))}
        </div>
      )}
      <dl className="mt-3 space-y-1.5 px-1 text-[13px]">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.youPay")}</dt><dd className="font-mono font-semibold">{formatUnits(price, 6)} USDC</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">{viaToken ? t("cw.shop.sellerGets") : t("cw.shop.sellerGetsUsdc")}</dt><dd className="font-mono">{!viaToken ? `${formatUnits(price, 6)} USDC` : token && out > 0n ? `${fmtNum(Number(formatUnits(net, 18)), 2)} ${token.symbol}` : "…"}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.balance")}</dt><dd className={cn("font-mono", low && "text-down")}>{bal.data != null ? Number(formatUnits(bal.data, 6)).toFixed(2) : "…"}</dd></div>
      </dl>
      {err && <div className="mt-2 rounded-xl bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <PrimaryButton tone="up" className="mt-4" disabled={!!step || !formOk || low || (viaToken && out === 0n)} onClick={() => void go()}>
        {step ? (
          <span className="flex items-center justify-center gap-2"><CircleNotch size={18} className="animate-spin" /> {t(STEP[step])}</span>
        ) : low ? (
          t("cw.shop.lowBalance")
        ) : (
          t("cw.shop.pay", { price: fmtPrice(p.priceUsd6) })
        )}
      </PrimaryButton>
    </>
  );
}

/* ───────────── orders ───────────── */

function OrdersPage() {
  const signer = useSigner();
  const [session, setSession] = useState<{ ts: number; sig: string } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!signer) return;
    setPending(pendingOrders(signer.address));
    void signSession(signer).then(setSession).catch(() => {});
  }, [signer]);
  const q = useQuery({
    queryKey: ["shop", "orders", "buyer", signer?.address],
    enabled: !!signer && !!session,
    refetchInterval: 30_000,
    queryFn: () => fetchOrders(signer!.address, session!, "buyer"),
  });
  const retry = async (p: Pending) => {
    if (!signer) return;
    setBusy(true);
    try {
      await submitPending(p, signer);
      toast.success(t("cw.shop.success"));
      void q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(pendingOrders(signer.address));
      setBusy(false);
    }
  };
  return (
    <WalletFrame>
      <TopBar back="/wallet/token" title={t("cw.shop.orders")} />
      <div className="flex-1 space-y-3 px-4 pb-10">
        {pending.map((p) => (
          <div key={p.tx} className="flex items-center justify-between gap-3 rounded-[18px] bg-[#f5a524]/12 px-4 py-3 text-[13px]">
            <span>{t("cw.shop.pending")}</span>
            <button type="button" disabled={busy} onClick={() => void retry(p)} className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-[12px] font-semibold text-background">{t("cw.shop.retry")}</button>
          </div>
        ))}
        {q.isLoading || !session ? (
          <div className="flex justify-center py-16"><CircleNotch size={26} className="animate-spin text-muted-foreground" /></div>
        ) : !q.data?.length ? (
          <div className="flex flex-col items-center gap-2 py-16 text-[14px] text-muted-foreground"><Storefront size={36} />{t("cw.shop.noOrders")}</div>
        ) : (
          q.data.map((o) => <OrderRow key={o.id} o={o} onDone={async () => {
            if (!signer) return;
            try {
              await confirmReceived(signer, o.id);
              void q.refetch();
            } catch (e) {
              toast.error((e as Error).message);
            }
          }} />)
        )}
        <p className="px-1 pt-2 text-center text-[11px] text-muted-foreground">{t("cw.shop.manageWeb")}</p>
      </div>
    </WalletFrame>
  );
}

function OrderRow({ o, onDone }: { o: Order; onDone: () => void }) {
  const tone = o.status === "paid" ? "bg-[#f5a524]/15 text-[#b77700] dark:text-[#f5c26b]" : o.status === "shipped" ? "bg-primary/12 text-primary" : "bg-up/12 text-up";
  const label = { paid: "cw.shop.statusPaid", shipped: "cw.shop.statusShipped", done: "cw.shop.statusDone" }[o.status];
  return (
    <div className="rounded-[22px] bg-card p-3.5 ring-1 ring-border">
      <div className="flex gap-3">
        <Link href={`/wallet/shop?id=${o.productId}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgSrc(o.image)} alt="" className="size-16 rounded-2xl bg-muted object-cover" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="line-clamp-2 text-[14px] font-medium">{o.title}</div>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", tone)}>{t(label)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span className="font-mono text-foreground">{fmtPrice(o.paidUsd6)}</span>
            <span>#{o.id}</span>
            <span>{timeAgo(new Date(o.createdAt).getTime())}</span>
            <a href={explorerTx(chainByKey("arc"), o.tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5">{t("cw.shop.viewTx")} <ArrowSquareOut size={11} /></a>
          </div>
        </div>
      </div>
      {(o.tracking || o.shipNote) && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-muted px-3 py-2 text-[12px]">
          <Truck size={15} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            {o.tracking && (
              <button type="button" className="flex items-center gap-1 text-left" onClick={() => void navigator.clipboard.writeText(o.tracking).then(() => toast.success(t("cw.shop.copied")))}>
                {t("cw.shop.tracking")} {o.carrier} <span className="font-mono">{o.tracking}</span> <Copy size={11} />
              </button>
            )}
            {o.shipNote && <div className="text-muted-foreground">{o.shipNote}</div>}
          </div>
        </div>
      )}
      {o.status === "shipped" && (
        <button type="button" onClick={onDone} className="mt-3 h-10 w-full rounded-2xl bg-foreground text-[14px] font-semibold text-background active:scale-[0.98]">{t("cw.shop.confirmReceived")}</button>
      )}
    </div>
  );
}
