import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { encodePacked, erc20Abi, type Address, type Hex } from "viem";
import { API_BASE, type TokenView } from "@/lib/api";
import { ADDR, POOL_FEE, addrsFor, routerAbi } from "@/lib/web3";

/**
 * Creator shops (indexer/src/shop.ts). Paying = either buying the item price's worth of the shop token for oneself, or a
 * USDC transfer to the seller; the buyer then signs the tx hash + shipping details and posts the order. Used by both the
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
  /** physical ships to an address; virtual is delivered as text in the order (by hand, or automatically on payment) */
  kind: ItemKind;
  delivery: Delivery;
  /** only in the seller's own view: what auto delivery sends */
  autoContent?: string;
  stock: number | null;
  sold: number;
  status: "on" | "off";
  createdAt: string;
  token: ShopToken | null;
  volumeUsd6: string;
  /** ways the shop takes payment (seller's choice, at least one) */
  pay: PayModes;
  reviews: number;
  /** average stars (1–5, one decimal), null before the first review */
  rating: number | null;
  comments: number;
};
export type ShopComment = { id: number; author: string; text: string; images: string[]; replyTo: number | null; time: string; isSeller: boolean };
export type ShopReview = { id: number; buyer: string; rating: number; text: string; images: string[]; time: string; payMethod: PayMethod };
export type PayModes = { token: boolean; usdc: boolean };
export type ItemKind = "physical" | "virtual";
export type Delivery = "manual" | "auto";
export type PayMethod = "token" | "usdc";
export type ShopFront = {
  seller: string;
  token: ShopToken | null;
  pay: PayModes;
  eligible?: ShopToken[];
  products: Product[];
  /** listed / hidden item counts (hidden only for the owner) */
  items: { on: number; off?: number };
  orders: number;
  openOrders?: number;
};
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
  reviewed: boolean;
  carrier: string;
  tracking: string;
  shipNote: string;
  shippedAt: string | null;
  doneAt: string | null;
  createdAt: string;
  kind: ItemKind;
  ship?: Ship;
  /** virtual items: what the seller delivered (code / link / account …) */
  content?: string;
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
export type Session = { ts: number; sig: string };
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

export const useShopProducts = (q: { seller?: string; token?: string; q?: string; limit?: number } = {}, enabled = true) =>
  useQuery({
    queryKey: ["shop", "products", q.seller ?? "", q.token ?? "", q.q ?? "", q.limit ?? 60],
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: () =>
      call<Product[]>(`/products?${new URLSearchParams({ ...(q.seller ? { seller: q.seller } : {}), ...(q.token ? { token: q.token } : {}), ...(q.q ? { q: q.q } : {}), limit: String(q.limit ?? 60) })}`),
  });

export const useProduct = (id?: number) =>
  useQuery({ queryKey: ["shop", "product", id], enabled: !!id, staleTime: 30_000, queryFn: () => call<Product>(`/products/${id}`) });

/** `viewer` with a stored session = the owner sees hidden items and the tokens it could take payment in */
const viewerHeaders = (viewer?: string) => {
  const s = viewer ? storedSession(viewer) : null;
  return s && viewer ? sessionHeaders(viewer, s) : {};
};

/** shop header only (token, payment ways, counts); the items come through `useProductPages` */
export const useShopFront = (seller?: string, viewer?: string) =>
  useQuery({
    queryKey: ["shop", "front", seller?.toLowerCase(), viewer?.toLowerCase() ?? ""],
    enabled: !!seller,
    queryFn: () => call<ShopFront>(`/sellers/${seller}?brief=1`, { headers: viewerHeaders(viewer) }),
  });

/** pages can overlap by an item or two when something new is listed meanwhile */
export const flatPages = <T extends { id: number }>(d?: InfiniteData<T[]>) => {
  const seen = new Set<number>();
  return (d?.pages ?? []).flat().filter((x) => !seen.has(x.id) && !!seen.add(x.id));
};

export type ItemStatus = "on" | "off" | "all";
/** Paged items, newest first. `viewer` = the seller themself (with a session) also gets hidden items, filtered by `status`. */
export const useProductPages = (q: { seller?: string; token?: string; q?: string; status?: ItemStatus; viewer?: string }, size = 24, enabled = true) =>
  useInfiniteQuery({
    queryKey: ["shop", "products", "pages", q.seller?.toLowerCase() ?? "", q.token ?? "", q.q ?? "", q.status ?? "", q.viewer?.toLowerCase() ?? "", size],
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: 0,
    getNextPageParam: (last: Product[], all: Product[][]) => (last.length < size ? undefined : all.length * size),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(size), offset: String(pageParam) });
      if (q.seller) p.set("seller", q.seller);
      if (q.token) p.set("token", q.token);
      if (q.q) p.set("q", q.q);
      if (q.status) p.set("status", q.status);
      return call<Product[]>(`/products?${p}`, { headers: viewerHeaders(q.viewer) });
    },
  });

export const useComments = (id?: number) =>
  useQuery({ queryKey: ["shop", "comments", id], enabled: !!id, queryFn: () => call<ShopComment[]>(`/products/${id}/comments`) });
export const useReviews = (id?: number) =>
  useQuery({ queryKey: ["shop", "reviews", id], enabled: !!id, queryFn: () => call<ShopReview[]>(`/products/${id}/reviews`) });

/** product page link people can share (always the public site, also from inside the wallet) */
export const productUrl = (id: number) => `${SHARE_ORIGIN}/shop/${id}`;
const SHARE_ORIGIN = "https://arm.yyheart.com";

export type OrderFilter = "all" | OrderStatus;
export type OrderCounts = Record<OrderFilter, number>;
export const ORDER_FILTERS: OrderFilter[] = ["all", "paid", "shipped", "done"];

/** Paged orders (newest first) of one status; `session` null keeps it idle until the user has signed in. */
export const useOrderPages = (address: string | undefined, session: Session | null, role: "buyer" | "seller", status: OrderFilter, size = 20) =>
  useInfiniteQuery({
    queryKey: ["shop", "orders", role, address?.toLowerCase(), status, size],
    enabled: !!address && !!session,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: 0,
    getNextPageParam: (last: Order[], all: Order[][]) => (last.length < size ? undefined : all.length * size),
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ role, limit: String(size), offset: String(pageParam) });
      if (status !== "all") p.set("status", status);
      return call<Order[]>(`/orders?${p}`, { headers: sessionHeaders(address!, session!) });
    },
  });

export const useOrderCounts = (address: string | undefined, session: Session | null, role: "buyer" | "seller") =>
  useQuery({
    queryKey: ["shop", "orders", "counts", role, address?.toLowerCase()],
    enabled: !!address && !!session,
    refetchInterval: 30_000,
    queryFn: () => call<OrderCounts>(`/orders/counts?role=${role}`, { headers: sessionHeaders(address!, session!) }),
  });

// ---------- shipping address book (session signature; only the owner sees it) ----------

export type SavedAddress = { id: number; name: string; phone: string; address: string; isDefault: boolean };
export type AddressInput = { id?: number; name: string; phone: string; address: string; isDefault?: boolean };

export async function fetchAddresses(s: Signer) {
  const session = await signSession(s);
  return call<SavedAddress[]>("/addresses", { headers: sessionHeaders(s.address, session) });
}
export async function saveAddress(s: Signer, a: AddressInput) {
  const session = await signSession(s);
  return call<SavedAddress>("/addresses", { method: "POST", headers: { "content-type": "application/json", ...sessionHeaders(s.address, session) }, body: JSON.stringify(a) });
}
export async function deleteAddress(s: Signer, id: number) {
  const session = await signSession(s);
  return call<{ ok: boolean }>(`/addresses/${id}/delete`, { method: "POST", headers: sessionHeaders(s.address, session) });
}

/** the address the buyer picked on the address page for the next checkout (falls back to the default) */
const PICK_KEY = "arm.shop.pickedAddress";
export const pickAddress = (id: number) => sessionStorage.setItem(PICK_KEY, String(id));
export const pickedAddress = (list: SavedAddress[]) => {
  const id = typeof sessionStorage === "undefined" ? NaN : Number(sessionStorage.getItem(PICK_KEY));
  return list.find((a) => a.id === id) ?? list.find((a) => a.isDefault) ?? list[0] ?? null;
};

// ---------- writes ----------

export async function signedAction<T = { ok: boolean }>(s: Signer, path: string, action: string, payload: unknown) {
  const ts = Date.now();
  const signature = await s.sign(shopActionMessage(action, s.address, ts, JSON.stringify(payload ?? {})));
  return postJson<T>(path, { address: s.address, ts, signature, payload });
}

export type ProductInput = { title: string; body: string; images: string[]; priceUsd6: string; stock: number | null; status: "on" | "off"; kind: ItemKind; delivery: Delivery; autoContent: string };
export const setShopToken = (s: Signer, token: string) => signedAction(s, "/sellers/token", "token", { token });
export const setPayModes = (s: Signer, m: PayModes) => signedAction(s, "/sellers/settings", "settings", { payToken: m.token, payUsdc: m.usdc });
export const createProduct = (s: Signer, p: ProductInput) => signedAction<{ id: number }>(s, "/products", "create", p);
export const updateProduct = (s: Signer, id: number, p: ProductInput) => signedAction(s, `/products/${id}`, `product:${id}`, p);
export const deleteProduct = (s: Signer, id: number) => signedAction(s, `/products/${id}`, `product:${id}`, { delete: true });
/** physical: carrier / tracking / note; virtual: `content` (what the buyer gets) + optional note */
export type ShipInput = { carrier: string; tracking: string; note: string; content?: string };
export const shipOrder = (s: Signer, id: number, p: ShipInput) => signedAction(s, `/orders/${id}/ship`, `ship:${id}`, p);
export const confirmReceived = (s: Signer, id: number) => signedAction(s, `/orders/${id}/done`, `done:${id}`, {});
export const postShopComment = (s: Signer, productId: number, c: { text: string; images: string[]; replyTo?: number | null }) =>
  signedAction<{ id: number }>(s, `/products/${productId}/comments`, `comment:${productId}`, c);
/** review an order once it has shipped (also marks it completed) */
export const postReview = (s: Signer, orderId: number, r: { rating: number; text: string; images: string[] }) =>
  signedAction<{ id: number }>(s, `/orders/${orderId}/review`, `review:${orderId}`, r);

// ---------- paying ----------

/**
 * "Buy the token" payment: the buyer spends `amountIn` USDC on the shop token for their own wallet (`recipient` =
 * the buyer). The money goes into the pool; the seller earns the creator share (78%) of the 1% pool fee.
 */
export function payCall(token: TokenView, amountIn: bigint, minOut: bigint, recipient: Address) {
  const A = addrsFor(token.factory);
  const tokenAddr = token.address as Address;
  const quote = token.quote && token.quote !== ADDR.usdc.toLowerCase() ? (token.quote as Address) : undefined;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  if (quote) {
    const path: Hex = encodePacked(["address", "uint24", "address", "uint24", "address"], [ADDR.usdc, token.quoteUsdcFee ?? 0, quote, POOL_FEE, tokenAddr]);
    return { address: A.router, abi: routerAbi, functionName: "exactInput" as const, args: [{ path, recipient, deadline, amountIn, amountOutMinimum: minOut }] as const };
  }
  return {
    address: A.router,
    abi: routerAbi,
    functionName: "exactInputSingle" as const,
    args: [{ tokenIn: ADDR.usdc, tokenOut: tokenAddr, fee: POOL_FEE, recipient, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] as const,
  };
}

/** Direct USDC payment: a plain transfer of the price to the seller. */
export const usdcPayCall = (amount: bigint, seller: Address) => ({ address: ADDR.usdc, abi: erc20Abi, functionName: "transfer" as const, args: [seller, amount] as const });


/** the seller's cut of a "buy the token" payment: 78% of the 1% pool fee */
export const sellerFeeShare = (usd6: bigint) => (usd6 * 78n) / 10_000n;

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
