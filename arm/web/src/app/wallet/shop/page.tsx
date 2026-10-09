"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type Address } from "viem";
import { ArrowSquareOut, CaretRight, CheckCircle, CircleNotch, Copy, LockSimple, MagnifyingGlass, MapPin, Megaphone, Package, PencilSimple, Plus, ShareNetwork, Storefront, Trash, Truck } from "@phosphor-icons/react";
import { toast } from "sonner";
import { TokenAvatar } from "@/components/shared";
import { afterBuyTax, useToken } from "@/lib/api";
import { fmtNum, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ADDR } from "@/lib/web3";
import { chainByKey, explorerTx, publicClientFor } from "@/lib/wallet/chains";
import { executeTrade, quote, transferUsdc, type TradeStep } from "@/lib/wallet/arm-trade";
import { t } from "@/lib/wallet/i18n";
import { hasFeature, nativeBridge, shareText } from "@/lib/wallet/native";
import {
  HEARTCHAT_DOWNLOAD, confirmReceived, defaultMethod, deleteAddress, fetchAddresses, fetchOrders, fmtPrice, imgSrc, payMinOut, pendingOrders, pickAddress, pickedAddress, placeOrder, saveAddress,
  productUrl, sellerFeeShare, sendCardCall, signSession, submitPending, useProduct, useShopProducts, usd6,
  type AddressInput, type Order, type PayMethod, type Pending, type Product, type SavedAddress, type Signer,
} from "@/lib/shop";
import { useVault } from "@/components/wallet/wallet-context";
import { BottomSheet, PrimaryButton, TopBar, WalletFrame } from "@/components/wallet/ui";
import { ItemFeedback, ItemGrid, ReviewSheetBody, StarRow } from "@/components/wallet/shop";

export default function WalletShopRoute() {
  return (
    <Suspense fallback={<WalletFrame>{null}</WalletFrame>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const sp = useSearchParams();
  const id = Number(sp.get("id"));
  if (Number.isSafeInteger(id) && id > 0) return <ItemPage id={id} />;
  const tab = sp.get("tab");
  if (tab === "orders") return <OrdersPage />;
  if (tab === "address") return <AddressPage back={sp.get("back")} />;
  return <MarketPage />;
}

/** 商城 / 我的订单 / 收货地址 */
function ShopTabs({ on }: { on: "market" | "orders" | "address" }) {
  const tabs = [
    { k: "market", href: "/wallet/shop", label: t("cw.shop.market") },
    { k: "orders", href: "/wallet/shop?tab=orders", label: t("cw.shop.orders") },
    { k: "address", href: "/wallet/shop?tab=address", label: t("cw.shop.addrTitle") },
  ] as const;
  return (
    <div className="mx-4 mb-3 grid grid-cols-3 rounded-2xl bg-muted p-1">
      {tabs.map((x) => (
        <Link key={x.k} href={x.href} replace className={cn("rounded-xl py-2 text-center text-[14px] font-semibold transition", on === x.k ? "bg-background shadow-sm" : "text-muted-foreground")}>
          {x.label}
        </Link>
      ))}
    </div>
  );
}

/* ───────────── market ───────────── */

function MarketPage() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  const q = useShopProducts({ q: query, limit: 100 });
  return (
    <WalletFrame>
      <TopBar back="/wallet" title={t("cw.shop.market")} />
      <ShopTabs on="market" />
      <div className="mx-4 mb-3 flex items-center gap-2 rounded-2xl bg-muted px-3.5">
        <MagnifyingGlass size={18} className="shrink-0 text-muted-foreground" />
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={60} placeholder={t("cw.shop.search")} className="h-11 w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </div>
      <div className="flex-1 px-4 pb-10">
        {q.isLoading ? (
          <div className="flex justify-center py-16"><CircleNotch size={26} className="animate-spin text-muted-foreground" /></div>
        ) : !q.data?.length ? (
          <div className="flex flex-col items-center gap-2 py-16 text-[14px] text-muted-foreground"><Storefront size={36} />{t("cw.shop.empty")}</div>
        ) : (
          <ItemGrid items={q.data} />
        )}
      </div>
    </WalletFrame>
  );
}

/* ───────────── addresses ───────────── */

function AddressPage({ back }: { back: string | null }) {
  const signer = useSigner();
  const router = useRouter();
  const safeBack = back && back.startsWith("/wallet/") ? back : null;
  const q = useQuery({ queryKey: ["shop", "addresses", signer?.address], enabled: !!signer, queryFn: () => fetchAddresses(signer!) });
  const list = q.data ?? [];
  const current = pickedAddress(list);
  const [edit, setEdit] = useState<AddressInput | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = (a: SavedAddress) => {
    pickAddress(a.id);
    if (safeBack) router.push(safeBack);
  };
  const field = "w-full rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none";
  return (
    <WalletFrame>
      <TopBar back={safeBack ?? "/wallet/shop"} title={t("cw.shop.addrTitle")} />
      {!safeBack && <ShopTabs on="address" />}
      <div className="flex-1 space-y-2.5 px-4 pb-10">
        <p className="px-1 text-[12px] text-muted-foreground">{t("cw.shop.addrHint")}</p>
        {list.map((a) => (
          <div key={a.id} className={cn("flex items-start gap-3 rounded-[20px] bg-card p-3.5 ring-1", safeBack && current?.id === a.id ? "ring-foreground" : "ring-border")}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => choose(a)}>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">{a.name}</span>
                <span className="text-[13px] text-muted-foreground">{a.phone}</span>
                {a.isDefault && <span className="rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-semibold text-primary">{t("cw.shop.addrDefault")}</span>}
              </div>
              <div className="mt-1 text-[13px] whitespace-pre-wrap text-secondary-foreground">{a.address}</div>
            </button>
            <div className="flex shrink-0 gap-1">
              <button type="button" aria-label="edit" onClick={() => setEdit({ id: a.id, name: a.name, phone: a.phone, address: a.address, isDefault: a.isDefault })} className="flex size-9 items-center justify-center rounded-full hover:bg-muted"><PencilSimple size={18} /></button>
              <button type="button" aria-label="delete" disabled={busy} onClick={() => confirm(t("cw.shop.addrDeleteConfirm")) && void run(() => deleteAddress(signer!, a.id))} className="flex size-9 items-center justify-center rounded-full text-down hover:bg-muted"><Trash size={18} /></button>
            </div>
          </div>
        ))}
        {!q.isLoading && list.length === 0 && <div className="py-10 text-center text-[14px] text-muted-foreground">{t("cw.shop.addrEmpty")}</div>}
        {list.length < 20 && (
          <button type="button" onClick={() => setEdit({ name: "", phone: "", address: "", isDefault: list.length === 0 })} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl ring-1 ring-border text-[15px] font-semibold">
            <Plus size={18} /> {t("cw.shop.addrAdd")}
          </button>
        )}
      </div>
      <BottomSheet open={!!edit} onClose={() => !busy && setEdit(null)}>
        {edit && (
          <>
            <div className="text-[17px] font-semibold">{edit.id ? t("cw.shop.addrEdit") : t("cw.shop.addrAdd")}</div>
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input value={edit.name} maxLength={40} placeholder={t("cw.shop.name")} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className={field} />
                <input value={edit.phone} maxLength={30} inputMode="tel" placeholder={t("cw.shop.phone")} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} className={field} />
              </div>
              <textarea value={edit.address} maxLength={300} rows={3} placeholder={t("cw.shop.address")} onChange={(e) => setEdit({ ...edit, address: e.target.value })} className={cn(field, "resize-none")} />
              <label className="flex items-center gap-2 px-1 text-[14px]">
                <input type="checkbox" checked={!!edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> {t("cw.shop.addrSetDefault")}
              </label>
            </div>
            <PrimaryButton
              className="mt-4"
              disabled={busy || !edit.name.trim() || !edit.phone.trim() || !edit.address.trim()}
              onClick={() => void run(async () => {
                const saved = await saveAddress(signer!, { ...edit, name: edit.name.trim(), phone: edit.phone.trim(), address: edit.address.trim() });
                setEdit(null);
                if (safeBack && !edit.id) pickAddress(saved.id);
              })}
            >
              {t("cw.shop.addrSave")}
            </PrimaryButton>
          </>
        )}
      </BottomSheet>
    </WalletFrame>
  );
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
  const signer = useSigner();
  const pq = useProduct(id);
  const p = pq.data;
  const more = useShopProducts({ seller: p?.seller, limit: 9 }, !!p);
  const [sheet, setSheet] = useState(false);
  const [callout, setCallout] = useState(false);
  // back from the address page (&buy=1): reopen the buy sheet
  const ready = !!p;
  useEffect(() => {
    if (!ready || new URLSearchParams(window.location.search).get("buy") !== "1") return;
    setSheet(true);
    window.history.replaceState(null, "", `/wallet/shop?id=${id}`);
  }, [ready, id]);
  if (!p) {
    return (
      <WalletFrame>
        <TopBar back="/wallet/shop" title={t("cw.shop.title")} />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">{pq.isError ? t("cw.shop.notFound") : <CircleNotch size={28} className="animate-spin" />}</div>
      </WalletFrame>
    );
  }
  const soldOut = p.stock != null && p.sold >= p.stock;
  const own = !!active && active.address.toLowerCase() === p.seller.toLowerCase();
  const others = (more.data ?? []).filter((x) => x.id !== p.id);
  return (
    <WalletFrame>
      <TopBar
        back="/wallet/shop"
        title={t("cw.shop.title")}
        right={
          <span className="flex">
            <button type="button" aria-label={t("cw.shop.share")} onClick={() => void shareText(`${p.title} ${productUrl(p.id)}`)} className="flex size-10 items-center justify-center rounded-full hover:bg-muted"><ShareNetwork size={20} /></button>
            <Link href="/wallet/shop?tab=orders" className="flex size-10 items-center justify-center rounded-full hover:bg-muted"><Package size={20} /></Link>
          </span>
        }
      />
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
          {p.rating != null && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <StarRow value={p.rating} size={13} /> <span className="font-mono text-foreground">{p.rating.toFixed(1)}</span> · {t("cw.shop.reviews")} {p.reviews}
            </div>
          )}
          {p.token && (
            <Link href={`/wallet/token?address=${p.token.address}`} className="mt-3 flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-[13px]">
              <TokenAvatar logo={imgSrc(p.token.logo)} symbol={p.token.symbol} seed={p.token.address} size={20} className="rounded-full" />
              <span className="font-medium">{t("cw.shop.payIn", { sym: payWaysOf(p) })}</span>
            </Link>
          )}
          {p.pay.token && <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{t("cw.shop.howPayToken", { price: usd6(p.priceUsd6).toFixed(2), sym: p.token ? `$${p.token.symbol}` : "" })}</p>}
          {p.pay.usdc && <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{t("cw.shop.howPayUsdc", { price: usd6(p.priceUsd6).toFixed(2) })}</p>}
        </section>
        {p.body && (
          <section className="mx-4 mt-3 rounded-[22px] bg-card p-4 ring-1 ring-border">
            <div className="text-[14px] font-semibold">{t("cw.shop.details")}</div>
            <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap text-secondary-foreground">{p.body}</p>
          </section>
        )}
        <ItemFeedback p={p} signer={signer} />
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

const STEP: Record<TradeStep | "submit", string> = { approving: "cw.shop.stepApproving", swapping: "cw.shop.stepSwapping", confirming: "cw.shop.stepConfirming", submit: "cw.shop.stepSubmit" };
const addressPage = (productId: number) => `/wallet/shop?tab=address&back=${encodeURIComponent(`/wallet/shop?id=${productId}&buy=1`)}`;

function BuySheet({ p, onDone }: { p: Product; onDone: () => void }) {
  const { active, account } = useVault();
  const signer = useSigner();
  const qc = useQueryClient();
  const tq = useToken(p.token!.address);
  const token = tq.data;
  const price = BigInt(p.priceUsd6);
  const [note, setNote] = useState("");
  const [step, setStep] = useState<TradeStep | "submit" | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>(defaultMethod(p.pay));
  const viaToken = method === "token";
  const addrs = useQuery({ queryKey: ["shop", "addresses", signer?.address], enabled: !!signer, queryFn: () => fetchAddresses(signer!) });
  const ship = addrs.data ? pickedAddress(addrs.data) : null;
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

  const go = async () => {
    if (!token || !signer || !ship || (viaToken && out === 0n)) return;
    setErr("");
    try {
      // buying the token = for the buyer's own wallet; the seller earns the creator share of the pool fee
      const rc = viaToken
        ? await executeTrade(account(), token, "buy", price, payMinOut(await quote(token, "buy", price)), setStep)
        : await transferUsdc(account(), p.seller as Address, price, setStep);
      setStep("submit");
      setDone(await placeOrder(signer, p.id, rc.transactionHash, { name: ship.name, phone: ship.phone, address: ship.address, note: note.trim() }));
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
        <Link href="/wallet/shop?tab=orders" onClick={onDone} className="mt-2 w-full">
          <PrimaryButton>{t("cw.shop.orders")}</PrimaryButton>
        </Link>
      </div>
    );
  }

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
      <Link href={addressPage(p.id)} className="mt-2 flex items-center gap-3 rounded-2xl bg-muted px-3.5 py-3">
        <MapPin size={20} weight="fill" className="shrink-0 text-primary" />
        {ship ? (
          <span className="min-w-0 flex-1">
            <span className="text-[15px] font-semibold">{ship.name}</span> <span className="text-[13px] text-muted-foreground">{ship.phone}</span>
            <span className="mt-0.5 line-clamp-2 block text-[12px] text-secondary-foreground">{ship.address}</span>
          </span>
        ) : (
          <span className="flex-1 text-[15px] font-medium">{addrs.isLoading ? "…" : t("cw.shop.addrAdd")}</span>
        )}
        <CaretRight size={16} className="shrink-0 text-muted-foreground" />
      </Link>
      <input value={note} maxLength={200} placeholder={t("cw.shop.note")} disabled={!!step} onChange={(e) => setNote(e.target.value)} className="mt-2 w-full rounded-2xl bg-muted px-3.5 py-3 text-[15px] outline-none" />
      {p.pay.token && p.pay.usdc && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(["token", "usdc"] as const).map((m) => (
            <button key={m} type="button" disabled={!!step} onClick={() => setMethod(m)} className={cn("rounded-2xl p-3 text-left ring-1 transition", method === m ? "bg-foreground/5 ring-foreground" : "ring-border")}>
              <div className="text-[14px] font-semibold">{m === "token" ? t("cw.shop.methodBuy", { sym: `$${p.token!.symbol}` }) : t("cw.shop.methodUsdc")}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{m === "token" ? t("cw.shop.methodBuyHint") : t("cw.shop.methodUsdcHint")}</div>
            </button>
          ))}
        </div>
      )}
      <dl className="mt-3 space-y-1.5 px-1 text-[13px]">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.youPay")}</dt><dd className="font-mono font-semibold">{formatUnits(price, 6)} USDC</dd></div>
        {viaToken ? (
          <>
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.youGet")}</dt><dd className="font-mono">{token && out > 0n ? `${fmtNum(Number(formatUnits(net, 18)), 2)} ${token.symbol}` : "…"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.sellerFee")}</dt><dd className="font-mono">≈ ${Number(formatUnits(sellerFeeShare(price), 6)).toFixed(4)}</dd></div>
          </>
        ) : (
          <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.sellerGetsUsdc")}</dt><dd className="font-mono">{formatUnits(price, 6)} USDC</dd></div>
        )}
        <div className="flex justify-between"><dt className="text-muted-foreground">{t("cw.shop.balance")}</dt><dd className={cn("font-mono", low && "text-down")}>{bal.data != null ? Number(formatUnits(bal.data, 6)).toFixed(2) : "…"}</dd></div>
      </dl>
      {err && <div className="mt-2 rounded-xl bg-down/10 px-3 py-2 text-[12px] text-down">{err}</div>}
      <PrimaryButton tone="up" className="mt-4" disabled={!!step || !ship || low || (viaToken && out === 0n)} onClick={() => void go()}>
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
  const [reviewing, setReviewing] = useState<Order | null>(null);
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
      <TopBar back="/wallet" title={t("cw.shop.orders")} />
      <ShopTabs on="orders" />
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
          q.data.map((o) => <OrderRow key={o.id} o={o} onReview={() => setReviewing(o)} onDone={async () => {
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
      <BottomSheet open={!!reviewing} onClose={() => setReviewing(null)}>
        {reviewing && signer && <ReviewSheetBody key={reviewing.id} order={reviewing} signer={signer} onDone={() => { setReviewing(null); void q.refetch(); }} />}
      </BottomSheet>
    </WalletFrame>
  );
}

function OrderRow({ o, onDone, onReview }: { o: Order; onDone: () => void; onReview: () => void }) {
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
      {o.status !== "paid" && (
        <div className="mt-3 flex gap-2">
          {o.status === "shipped" && (
            <button type="button" onClick={onDone} className="h-10 flex-1 rounded-2xl bg-muted text-[14px] font-semibold active:scale-[0.98]">{t("cw.shop.confirmReceived")}</button>
          )}
          <button type="button" disabled={o.reviewed} onClick={onReview} className="h-10 flex-1 rounded-2xl bg-foreground text-[14px] font-semibold text-background active:scale-[0.98] disabled:bg-muted disabled:text-muted-foreground">
            {o.reviewed ? t("cw.shop.reviewed") : t("cw.shop.review")}
          </button>
        </div>
      )}
    </div>
  );
}
