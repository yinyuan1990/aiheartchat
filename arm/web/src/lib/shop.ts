import { useQuery } from "@tanstack/react-query";
import { encodePacked, erc20Abi, type Address, type Hex } from "viem";
import { API_BASE, type TokenView } from "@/lib/api";
import { ADDR, POOL_FEE, addrsFor, routerAbi } from "@/lib/web3";

/**
 * Creator shops (indexer/src/shop.ts). Paying = one swap that spends the item price in USDC on the shop's token with
 * the seller as `recipient`; the buyer then signs the tx hash + shipping details and posts the order. Used by both the
 * site (wagmi) and the in-App wallet (local key), so everything that signs takes a `sign(message)` callback.
 */

export type ShopToken = { address: string; symbol: string; name: string; logo: string; price: number };
export type Product = {
  id: number;
  seller: string;
  title: string;
  body: string;
  images: string[];
  priceUsd6: string;
  stock: number | null;
  sold: number;
  status: "on" | "off";
  createdAt: string;
  token: ShopToken | null;
  volumeUsd6: string;
  /** ways the shop takes payment (seller's choice, at least one) */
  pay: PayModes;
};
export type PayModes = { token: boolean; usdc: boolean };
export type PayMethod = "token" | "usdc";
export type ShopFront = { seller: string; token: ShopToken | null; pay: PayModes; eligible?: ShopToken[]; products: Product[]; orders: number; openOrders?: number };
export type Ship = { name: string; phone: string; address: string; note: string };
export type OrderStatus = "paid" | "shipped" | "done";
export type Order = {
  id: number;
  productId: number;
  seller: string;
  buyer: string;
  token: string;
  symbol: string | null;
  tx: string;
  paidUsd6: string;
  tokens: string;
  title: string;
  image: string;
  priceUsd6: string;
  status: OrderStatus;
  payMethod: PayMethod;
  carrier: string;
  tracking: string;
  shipNote: string;
  shippedAt: string | null;
  doneAt: string | null;
  createdAt: string;
  ship?: Ship;
};

export type Signer = { address: string; sign: (message: string) => Promise<string> };

export const shopActionMessage = (action: string, address: string, ts: number, payload: string) =>
  `Arm shop\naction: ${action}\naddress: ${address.toLowerCase()}\nts: ${ts}\n\n${payload}`;
export const shopSessionMessage = (address: string, ts: number) =>
  `Arm shop session\naddress: ${address.toLowerCase()}\nts: ${ts}\n\nLets this device read your shop orders (and the shipping details in them) for 24 hours.`;
export const shopOrderMessage = (productId: number, tx: string, ts: number, ship: string) =>
  `Arm shop order\nproduct: ${productId}\ntx: ${tx.toLowerCase()}\nts: ${ts}\n\n${ship}`;

/** host-relative upload paths come from the indexer; outside the API's own origin they need its host */
export const imgSrc = (u?: string | null) => {
  if (!u) return undefined;
  if (u.startsWith("/api/") && API_BASE.startsWith("http")) return new URL(API_BASE).origin + u;
  return u;
};
export const usd6 = (v: string | bigint | number) => Number(v) / 1e6;
export const fmtPrice = (v: string | bigint | number) => {
  const n = usd6(v);
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
};

class ShopError extends Error {
  constructor(message: string, readonly status: number, readonly pending = false) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}/shop${path}`, { cache: "no-store", ...init });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; pending?: boolean };
  if (!r.ok || r.status === 202) throw new ShopError(j.error ?? `${r.status}`, r.status, !!j.pending);
  return j;
}
const postJson = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- session (reads that include shipping details) ----------

const SESSION_KEY = (a: string) => `arm.shop.session.${a.toLowerCase()}`;
type Session = { ts: number; sig: string };
const freshSession = (s: Session | null) => !!s && Date.now() - s.ts < 23 * 3600_000;

export function storedSession(address?: string): Session | null {
  if (!address || typeof localStorage === "undefined") return null;
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY(address)) ?? "null") as Session | null;
    return freshSession(s) ? s : null;
  } catch {
    return null;
  }
}

export async function signSession(s: Signer): Promise<Session> {
  const have = storedSession(s.address);
  if (have) return have;
  const ts = Date.now();
  const sig = await s.sign(shopSessionMessage(s.address, ts));
  const session = { ts, sig };
  localStorage.setItem(SESSION_KEY(s.address), JSON.stringify(session));
  return session;
}

const sessionHeaders = (address: string, s: Session): Record<string, string> => ({ "x-shop-addr": address, "x-shop-ts": String(s.ts), "x-shop-sig": s.sig });

// ---------- reads ----------

export const useShopProducts = (q: { seller?: string; token?: string; limit?: number } = {}, enabled = true) =>
  useQuery({
    queryKey: ["shop", "products", q.seller ?? "", q.token ?? "", q.limit ?? 60],
    enabled,
    staleTime: 30_000,
    queryFn: () => call<Product[]>(`/products?${new URLSearchParams({ ...(q.seller ? { seller: q.seller } : {}), ...(q.token ? { token: q.token } : {}), limit: String(q.limit ?? 60) })}`),
  });

export const useProduct = (id?: number) =>
  useQuery({ queryKey: ["shop", "product", id], enabled: !!id, staleTime: 30_000, queryFn: () => call<Product>(`/products/${id}`) });

/** `viewer` with a stored session = the owner sees hidden items and the tokens it could take payment in */
export const useShopFront = (seller?: string, viewer?: string) =>
  useQuery({
    queryKey: ["shop", "front", seller?.toLowerCase(), viewer?.toLowerCase() ?? ""],
    enabled: !!seller,
    queryFn: () => {
      const s = viewer ? storedSession(viewer) : null;
      return call<ShopFront>(`/sellers/${seller}`, { headers: s && viewer ? sessionHeaders(viewer, s) : {} });
    },
  });

export async function fetchOrders(address: string, session: Session, role: "buyer" | "seller") {
  return call<Order[]>(`/orders?role=${role}`, { headers: sessionHeaders(address, session) });
}

// ---------- writes ----------

export async function signedAction<T = { ok: boolean }>(s: Signer, path: string, action: string, payload: unknown) {
  const ts = Date.now();
  const signature = await s.sign(shopActionMessage(action, s.address, ts, JSON.stringify(payload ?? {})));
  return postJson<T>(path, { address: s.address, ts, signature, payload });
}

export type ProductInput = { title: string; body: string; images: string[]; priceUsd6: string; stock: number | null; status: "on" | "off" };
export const setShopToken = (s: Signer, token: string) => signedAction(s, "/sellers/token", "token", { token });
export const setPayModes = (s: Signer, m: PayModes) => signedAction(s, "/sellers/settings", "settings", { payToken: m.token, payUsdc: m.usdc });
export const createProduct = (s: Signer, p: ProductInput) => signedAction<{ id: number }>(s, "/products", "create", p);
export const updateProduct = (s: Signer, id: number, p: ProductInput) => signedAction(s, `/products/${id}`, `product:${id}`, p);
export const deleteProduct = (s: Signer, id: number) => signedAction(s, `/products/${id}`, `product:${id}`, { delete: true });
export const shipOrder = (s: Signer, id: number, p: { carrier: string; tracking: string; note: string }) => signedAction(s, `/orders/${id}/ship`, `ship:${id}`, p);
export const confirmReceived = (s: Signer, id: number) => signedAction(s, `/orders/${id}/done`, `done:${id}`, {});

// ---------- paying ----------

/** Router call that spends `amountIn` USDC on the shop token and delivers the tokens to the seller. */
export function payCall(token: TokenView, amountIn: bigint, minOut: bigint, seller: Address) {
  const A = addrsFor(token.factory);
  const tokenAddr = token.address as Address;
  const quote = token.quote && token.quote !== ADDR.usdc.toLowerCase() ? (token.quote as Address) : undefined;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  if (quote) {
    const path: Hex = encodePacked(["address", "uint24", "address", "uint24", "address"], [ADDR.usdc, token.quoteUsdcFee ?? 0, quote, POOL_FEE, tokenAddr]);
    return { address: A.router, abi: routerAbi, functionName: "exactInput" as const, args: [{ path, recipient: seller, deadline, amountIn, amountOutMinimum: minOut }] as const };
  }
  return {
    address: A.router,
    abi: routerAbi,
    functionName: "exactInputSingle" as const,
    args: [{ tokenIn: ADDR.usdc, tokenOut: tokenAddr, fee: POOL_FEE, recipient: seller, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] as const,
  };
}

/** Direct USDC payment: a plain transfer of the price to the seller. */
export const usdcPayCall = (amount: bigint, seller: Address) => ({ address: ADDR.usdc, abi: erc20Abi, functionName: "transfer" as const, args: [seller, amount] as const });


/** what the buyer sees first: buying the token helps the creator's market, so it leads when the shop takes both */
export const defaultMethod = (pay: PayModes): PayMethod => (pay.token ? "token" : "usdc");

/** 5% under the quote: the buyer pays a fixed USDC amount, only the token count the seller gets can move */
export const PAY_SLIPPAGE_BPS = 500n;
export const payMinOut = (out: bigint) => out - (out * PAY_SLIPPAGE_BPS) / 10_000n;

// ---------- placing the order ----------

export type Pending = { productId: number; tx: string; buyer: string; ship: Ship; ts: number; signature: string };
const PENDING_KEY = "arm.shop.pending";

export function pendingOrders(buyer?: string): Pending[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as Pending[];
    return buyer ? all.filter((p) => p.buyer.toLowerCase() === buyer.toLowerCase()) : all;
  } catch {
    return [];
  }
}
const savePending = (list: Pending[]) => localStorage.setItem(PENDING_KEY, JSON.stringify(list));
const dropPending = (tx: string) => savePending(pendingOrders().filter((p) => p.tx.toLowerCase() !== tx.toLowerCase()));

/** Signs the order right after the payment lands, remembers it locally, then posts it (retrying while the node catches up). */
export async function placeOrder(s: Signer, productId: number, tx: string, ship: Ship, onSigned?: () => void): Promise<number> {
  const ts = Date.now();
  const signature = await s.sign(shopOrderMessage(productId, tx, ts, JSON.stringify(ship)));
  onSigned?.();
  const p: Pending = { productId, tx, buyer: s.address, ship, ts, signature };
  savePending([...pendingOrders().filter((x) => x.tx.toLowerCase() !== tx.toLowerCase()), p]);
  return submitPending(p);
}

/** The server takes the signature for 30 minutes; later retries need a fresh one (`resign`). */
export async function submitPending(p: Pending, resign?: Signer): Promise<number> {
  let body = p;
  if (resign && Date.now() - p.ts > 25 * 60_000) {
    const ts = Date.now();
    body = { ...p, ts, signature: await resign.sign(shopOrderMessage(p.productId, p.tx, ts, JSON.stringify(p.ship))) };
  }
  for (let i = 0; ; i++) {
    try {
      const r = await postJson<{ id: number }>("/orders", body);
      dropPending(p.tx);
      return r.id;
    } catch (e) {
      if (e instanceof ShopError && e.pending && i < 20) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      // a definite no from the server (wrong payment, already used, …) will not change on retry
      if (e instanceof ShopError && !e.pending && [400, 403, 404, 409].includes(e.status)) dropPending(p.tx);
      throw e;
    }
  }
}

// ---------- 喊单 (心之音 generic card, houduan card-call.service.ts) ----------

/** 心之音官网下载页：不在 App 里打开时，喊单按钮去这里 */
export const HEARTCHAT_DOWNLOAD = "https://app.yyheart.com";
export const CARD_CALL_METHOD = "heartchat_cardCall";
export type CardCall = { kind: "shop"; productId: number; note: string };

type ArmProvider = { isArmWallet?: boolean; request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const armProvider = () => (typeof window === "undefined" ? undefined : ((window as unknown as { ethereum?: ArmProvider }).ethereum?.isArmWallet ? (window as unknown as { ethereum: ArmProvider }).ethereum : undefined));

/**
 * Where a call-out can be posted from:
 *  - "wallet": the wallet page inside the App (native bridge `perpCall`, which forwards any body to houduan /im/perp-call);
 *  - "dapp":   the Arm site inside the App's DApp browser — the injected provider passes `heartchat_cardCall` to the
 *              wallet page, which forwards it to the same bridge (only for our own origins, dapp-approver.tsx);
 *  - null:     an ordinary browser → send people to the download page.
 */
export function calloutChannel(bridgeOk: boolean): "wallet" | "dapp" | null {
  if (bridgeOk) return "wallet";
  return armProvider() ? "dapp" : null;
}

export async function sendCardCall(body: CardCall, viaBridge?: (b: CardCall) => Promise<unknown>) {
  if (viaBridge) return viaBridge(body);
  const p = armProvider();
  if (!p) throw new Error("not in the HeartChat app");
  return p.request({ method: CARD_CALL_METHOD, params: [body] });
}

// ---------- pictures ----------

/** Downscaled to 1280px JPEG on the device (the upload endpoint caps files at 1 MB). */
export async function uploadPicture(file: File): Promise<string> {
  const src = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("bad image"));
    i.src = src;
  }).finally(() => setTimeout(() => URL.revokeObjectURL(src), 0));
  const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  let blob: Blob | null = null;
  for (const q of [0.88, 0.75, 0.6]) {
    blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size < 950_000) break;
  }
  if (!blob) throw new Error("bad image");
  const fd = new FormData();
  fd.append("file", blob, "item.jpg");
  const r = await fetch(`${API_BASE}/upload`, { method: "POST", body: fd });
  const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!r.ok || !j.url) throw new Error(j.error ?? "upload failed");
  return j.url;
}
