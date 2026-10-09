import { Hono } from "hono";
import { decodeEventLog, decodeFunctionData, erc20Abi, getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { sql } from "./db.js";
import { ADDR, client } from "./chain.js";
import { poolAbi } from "./abi.js";
import { quotePrice, quoteToUsdc } from "./quotes.js";

/**
 * Creator shops (10.9). A seller is any wallet that launched (or receives the fees of) an Arm token. Two ways to pay,
 * each switched on by the seller (shop_sellers.pay_token / pay_usdc):
 *   token — the buyer spends the item price in USDC buying the shop token for their own wallet (`recipient` = buyer).
 *           The money goes into the pool; the seller earns through the token's creator fee (78% of the 1% pool fee);
 *   usdc  — a plain USDC transfer of the price to the seller.
 * The buyer then posts the tx hash; we read it and accept the order only if the buyer sent it and it paid the seller
 * at least the price. Shipping is the seller's own business: the platform only stores what they fill in.
 *
 * Writes are EIP-191 signed (5-minute window). Reads that expose shipping addresses need a session signature
 * (24-hour window) from the seller or the buyer, sent as x-shop-addr / x-shop-ts / x-shop-sig headers.
 */

export const shopActionMessage = (action: string, address: string, ts: number, payload: string) =>
  `Arm shop\naction: ${action}\naddress: ${address.toLowerCase()}\nts: ${ts}\n\n${payload}`;
export const shopSessionMessage = (address: string, ts: number) =>
  `Arm shop session\naddress: ${address.toLowerCase()}\nts: ${ts}\n\nLets this device read your shop orders (and the shipping details in them) for 24 hours.`;
export const shopOrderMessage = (productId: number, tx: string, ts: number, ship: string) =>
  `Arm shop order\nproduct: ${productId}\ntx: ${tx.toLowerCase()}\nts: ${ts}\n\n${ship}`;

const MAX_IMAGES = 9;
const MIN_PRICE = 10_000n; // $0.01
const MAX_PRICE = 10_000_000_000n; // $10,000
/** two-hop routes (stock-quoted tokens) lose the stock pool's fee before the token pool sees the value */
const PRICE_TOLERANCE_BPS = 300n;
const ORDER_MAX_AGE_MS = 24 * 3600_000;

export async function ensureShopTables() {
  await sql`create table if not exists shop_sellers (
    seller text primary key,
    token text not null,
    updated_at timestamptz not null default now()
  )`;
  await sql`create table if not exists shop_products (
    id bigserial primary key,
    seller text not null,
    title text not null,
    body text not null default '',
    images jsonb not null default '[]'::jsonb,
    price_usd6 bigint not null default 1000000,
    stock int,
    sold int not null default 0,
    status text not null default 'on' check (status in ('on','off','deleted')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists shop_products_seller on shop_products (seller, created_at desc)`;
  await sql`create table if not exists shop_orders (
    id bigserial primary key,
    product_id bigint not null references shop_products(id),
    seller text not null,
    buyer text not null,
    token text not null,
    tx_hash text not null unique,
    paid_usd6 numeric(78,0) not null,
    tokens numeric(78,0) not null,
    title text not null,
    image text not null default '',
    price_usd6 bigint not null,
    ship jsonb not null,
    status text not null default 'paid' check (status in ('paid','shipped','done')),
    carrier text not null default '',
    tracking text not null default '',
    ship_note text not null default '',
    shipped_at timestamptz,
    done_at timestamptz,
    created_at timestamptz not null default now()
  )`;
  await sql`create index if not exists shop_orders_seller on shop_orders (seller, created_at desc)`;
  await sql`create index if not exists shop_orders_buyer on shop_orders (buyer, created_at desc)`;
  await sql`alter table shop_sellers add column if not exists pay_token boolean not null default true`;
  await sql`alter table shop_sellers add column if not exists pay_usdc boolean not null default false`;
  await sql`alter table shop_orders add column if not exists pay_method text not null default 'token'`;
  // buyer's saved shipping addresses (read / written with the 24 h session signature; nobody else sees them)
  await sql`create table if not exists shop_addresses (
    id bigserial primary key,
    owner text not null,
    name text not null,
    phone text not null,
    address text not null,
    is_default boolean not null default false,
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists shop_addresses_owner on shop_addresses (owner)`;
  // public Q&A under an item (wallet-signed, anyone) and reviews (one per order, by its buyer, after shipping)
  await sql`create table if not exists shop_comments (
    id bigserial primary key,
    product_id bigint not null references shop_products(id),
    author text not null,
    text text not null,
    reply_to bigint references shop_comments(id),
    created_at timestamptz not null default now()
  )`;
  await sql`create index if not exists shop_comments_product on shop_comments (product_id, created_at desc)`;
  await sql`create table if not exists shop_reviews (
    id bigserial primary key,
    order_id bigint not null unique references shop_orders(id),
    product_id bigint not null references shop_products(id),
    buyer text not null,
    rating int not null check (rating between 1 and 5),
    text text not null default '',
    created_at timestamptz not null default now()
  )`;
  await sql`create index if not exists shop_reviews_product on shop_reviews (product_id, created_at desc)`;
  await sql`alter table shop_reviews add column if not exists images jsonb not null default '[]'::jsonb`;
  await sql`alter table shop_comments add column if not exists images jsonb not null default '[]'::jsonb`;
}

type ProductRow = {
  id: string; seller: string; title: string; body: string; images: string[]; price_usd6: string; stock: number | null; sold: number; status: string; created_at: Date; volume_usd6?: string | null;
  token?: string | null; symbol?: string | null; name?: string | null; logo?: string | null; price?: number | null; quote?: string | null; quote_symbol?: string | null; factory?: string | null;
  pay_token?: boolean | null; pay_usdc?: boolean | null;
  review_count?: number | null; rating_avg?: number | null; comment_count?: number | null;
};

const shapeProduct = (r: ProductRow) => ({
  id: Number(r.id),
  seller: r.seller,
  title: r.title,
  body: r.body,
  images: r.images ?? [],
  priceUsd6: String(r.price_usd6),
  stock: r.stock,
  sold: r.sold,
  volumeUsd6: String(r.volume_usd6 ?? "0"),
  status: r.status,
  createdAt: r.created_at,
  token: r.token ? { address: r.token, symbol: r.symbol, name: r.name, logo: r.logo, price: Number(r.price ?? 0) } : null,
  pay: { token: r.pay_token !== false, usdc: r.pay_usdc === true },
  reviews: Number(r.review_count ?? 0),
  rating: r.rating_avg != null ? Math.round(Number(r.rating_avg) * 10) / 10 : null,
  comments: Number(r.comment_count ?? 0),
});

const productSelect = sql`select p.*, s.token, s.pay_token, s.pay_usdc, t.symbol, t.name, t.logo, t.last_price as price,
    (select coalesce(sum(o.paid_usd6), 0) from shop_orders o where o.product_id = p.id) as volume_usd6,
    (select count(*)::int from shop_reviews r where r.product_id = p.id) as review_count,
    (select avg(r.rating)::float from shop_reviews r where r.product_id = p.id) as rating_avg,
    (select count(*)::int from shop_comments m where m.product_id = p.id) as comment_count
  from shop_products p left join shop_sellers s on s.seller = p.seller left join tokens t on t.address = s.token`;

const usdText = (usd6: bigint | string | number) => {
  const n = Number(usd6) / 1e6;
  return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
};

type OrderRow = Record<string, unknown> & { id: string; product_id: string; paid_usd6: string; tokens: string; price_usd6: string };
const shapeOrder = (r: OrderRow, withShip: boolean) => ({
  id: Number(r.id),
  productId: Number(r.product_id),
  seller: r.seller,
  buyer: r.buyer,
  token: r.token,
  symbol: r.symbol ?? null,
  tx: r.tx_hash,
  paidUsd6: String(r.paid_usd6),
  tokens: String(r.tokens),
  title: r.title,
  image: r.image,
  priceUsd6: String(r.price_usd6),
  status: r.status,
  payMethod: r.pay_method ?? "token",
  reviewed: !!r.reviewed,
  carrier: r.carrier,
  tracking: r.tracking,
  shipNote: r.ship_note,
  shippedAt: r.shipped_at,
  doneAt: r.done_at,
  createdAt: r.created_at,
  ...(withShip ? { ship: r.ship } : {}),
});

/** Tokens a wallet may sell in: launched by it, or paying their creator fees to it. */
async function tokensOf(seller: string) {
  return sql<{ address: string; symbol: string; name: string; logo: string }[]>`
    select address, symbol, name, logo from tokens where (lower(deployer) = ${seller.toLowerCase()} or lower(payout) = ${seller.toLowerCase()}) and not hidden
    order by launch_ts desc`;
}

type Signed = { address: string; ts: number; signature: string; payload?: unknown };

async function checkAction(body: Signed | null, action: string) {
  if (!body || !isAddress(body.address) || typeof body.signature !== "string" || Math.abs(Date.now() - Number(body.ts)) > 5 * 60_000) return null;
  const ok = await verifyMessage({ address: getAddress(body.address), message: shopActionMessage(action, body.address, Number(body.ts), JSON.stringify(body.payload ?? {})), signature: body.signature as Hex }).catch(() => false);
  return ok ? getAddress(body.address) : null;
}

async function checkSession(h: (n: string) => string | undefined) {
  const a = h("x-shop-addr") ?? "";
  const ts = Number(h("x-shop-ts"));
  const sig = h("x-shop-sig") ?? "";
  if (!isAddress(a) || !Number.isFinite(ts) || ts > Date.now() + 5 * 60_000 || Date.now() - ts > 24 * 3600_000) return null;
  const ok = await verifyMessage({ address: getAddress(a), message: shopSessionMessage(a, ts), signature: sig as Hex }).catch(() => false);
  return ok ? getAddress(a) : null;
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");
const isImage = (u: unknown): u is string => typeof u === "string" && /^\/api\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(u);

function readProduct(p: Record<string, unknown>) {
  const title = clean(p.title, 60);
  const body = clean(p.body, 2000);
  const images = Array.isArray(p.images) ? p.images.filter(isImage).slice(0, MAX_IMAGES) : [];
  let price: bigint;
  try {
    price = BigInt(String(p.priceUsd6 ?? "1000000"));
  } catch {
    throw new Error("bad price");
  }
  const stock = p.stock == null || p.stock === "" ? null : Math.floor(Number(p.stock));
  if (!title) throw new Error("title required");
  if (images.length === 0) throw new Error("at least one picture");
  if (price < MIN_PRICE || price > MAX_PRICE) throw new Error("price $0.01 – $10,000");
  if (stock != null && (!Number.isFinite(stock) || stock < 0 || stock > 1_000_000)) throw new Error("bad stock");
  const status = p.status === "off" ? "off" : "on";
  return { title, body, images, price, stock, status };
}

type Paid = { method: "token" | "usdc"; usd: bigint; tokensOut: bigint } | { error: string; pending?: boolean };

/**
 * Verify the payment tx for an order: the buyer sent it within 24 h, and either
 *  - it is a USDC transfer(seller, ≥ price) (read from the call itself, not from logs: Arc reports USDC transfers
 *    through a system emitter), when the shop takes USDC; or
 *  - the buyer bought the shop token (pool Swap with recipient = buyer) for ≥ price, when the shop takes its token.
 */
async function checkPayment(tx: Hex, buyer: Address, seller: Address, token: string, priceUsd6: bigint, pay: { token: boolean; usdc: boolean }): Promise<Paid> {
  const [t] = await sql<{ pool: string; is_token0: boolean; quote: string; quote_decimals: number }[]>`
    select pool, is_token0, quote, quote_decimals from tokens where address = ${token}`;
  if (!t) return { error: "shop token not found" };
  const receipt = await client.getTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return { error: "not found yet", pending: true };
  if (receipt.status !== "success") return { error: "transaction reverted" };
  if (getAddress(receipt.from) !== buyer) return { error: "paid from another wallet" };
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (Date.now() - Number(block.timestamp) * 1000 > ORDER_MAX_AGE_MS) return { error: "payment is older than 24 hours" };
  if (receipt.to && getAddress(receipt.to) === getAddress(ADDR.usdc)) {
    if (!pay.usdc) return { error: "this shop does not take direct USDC" };
    const txn = await client.getTransaction({ hash: tx });
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data: txn.input });
      if (call.functionName !== "transfer") return { error: "not a USDC transfer" };
      const [to, amount] = call.args as [Address, bigint];
      if (getAddress(to) !== seller) return { error: "USDC went to another wallet" };
      if (amount < priceUsd6) return { error: "paid less than the price" };
      return { method: "usdc", usd: amount, tokensOut: 0n };
    } catch {
      return { error: "not a USDC transfer" };
    }
  }
  if (!pay.token) return { error: "this shop only takes direct USDC" };
  let quoteIn = 0n;
  let tokensOut = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== t.pool.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics });
      if (ev.eventName !== "Swap" || getAddress(ev.args.recipient) !== buyer) continue;
      const [tokAmt, quoteAmt] = t.is_token0 ? [ev.args.amount0, ev.args.amount1] : [ev.args.amount1, ev.args.amount0];
      if (tokAmt < 0n && quoteAmt > 0n) {
        tokensOut += -tokAmt;
        quoteIn += quoteAmt;
      }
    } catch {}
  }
  if (tokensOut === 0n) return { error: "no buy of the shop token by you in this transaction" };
  const usd = t.quote ? quoteToUsdc(quoteIn, Number(t.quote_decimals), quotePrice(t.quote)) : quoteIn;
  if (usd * 10_000n < priceUsd6 * (10_000n - PRICE_TOLERANCE_BPS)) return { error: "paid less than the price" };
  return { method: "token", usd, tokensOut };
}

export const shop = new Hono();

shop.get("/products", async (c) => {
  const seller = c.req.query("seller");
  const token = c.req.query("token");
  // search: item title / description, the payment token's symbol / name, or a seller address
  const q = clean(c.req.query("q"), 40);
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 60, 1), 200);
  const rows = await sql<ProductRow[]>`${productSelect}
    where p.status = 'on' and s.token is not null
    ${seller && isAddress(seller) ? sql`and p.seller = ${getAddress(seller)}` : sql``}
    ${token && isAddress(token) ? sql`and lower(s.token) = ${token.toLowerCase()}` : sql``}
    ${q ? (isAddress(q) ? sql`and lower(p.seller) = ${q.toLowerCase()}` : sql`and (p.title ilike ${like} or p.body ilike ${like} or t.symbol ilike ${like} or t.name ilike ${like})`) : sql``}
    order by p.created_at desc limit ${limit}`;
  return c.json(rows.map(shapeProduct));
});

shop.get("/products/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "not found" }, 404);
  const [r] = await sql<ProductRow[]>`${productSelect} where p.id = ${id} and p.status <> 'deleted'`;
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json(shapeProduct(r));
});

/**
 * 喊单卡片（心之音通用卡片 msgType card，v1）。心之音后端（houduan card-call.service.ts）拉这里生成卡片 + 决定发进哪个群
 * （group：一个卖家地址一个店铺群）；聊天里的卡片隔一会儿再拉这里的 `values` 刷新销量 / 成交额。文字给中英两份。
 */
const SITE = (process.env.SHOP_SITE ?? "https://arm.yyheart.com").replace(/\/$/, "");
const abs = (u: string) => (u.startsWith("/") ? `${SITE}${u}` : u);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

shop.get("/card/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "not found" }, 404);
  const [p] = await sql<ProductRow[]>`${productSelect} where p.id = ${id} and p.status <> 'deleted'`;
  if (!p || !p.token) return c.json({ error: "not found" }, 404);
  const values = { sold: String(p.sold), volume: usdText(p.volume_usd6 ?? 0), price: usdText(p.price_usd6) };
  const sym = `$${p.symbol}`;
  const card = {
    v: 1,
    kind: "shop",
    fallback: `[商品] ${p.title} ${values.price} ${SITE}/shop/${id}`,
    cover: p.images?.[0] ? abs(p.images[0]) : null,
    title: p.title,
    subtitle: (() => {
      const ways = [p.pay_usdc ? "USDC" : null, p.pay_token !== false ? sym : null].filter(Boolean).join(" / ");
      return { zh: `${ways} 支付 · 卖家 ${short(p.seller)}`, en: `Pay with ${ways} · seller ${short(p.seller)}` };
    })(),
    badge: { text: { zh: "商品", en: "Item" }, tone: "accent" },
    stats: [
      { label: { zh: "价格", en: "Price" }, value: values.price, live: "price", tone: "up" },
      { label: { zh: "销量", en: "Sold" }, value: values.sold, live: "sold" },
      { label: { zh: "成交额", en: "Volume" }, value: values.volume, live: "volume" },
    ],
    actions: [{ text: { zh: "去看看", en: "View" }, type: "wallet", path: `/wallet/shop?id=${id}`, url: `${SITE}/shop/${id}`, primary: true }],
    live: `${SITE}/api/shop/card/${id}`,
  };
  const seller = p.seller.toLowerCase();
  const group = {
    ns: "shop",
    key: seller,
    name: `${sym} 店铺 · ${short(p.seller)}`,
    image: p.logo ? abs(p.logo) : null,
    symbol: p.symbol,
    notice: `${short(p.seller)} 的店铺群：店里所有商品的喊单都在这里。付款方式由卖家设置：买入等值的 ${sym}（代币进买家自己的钱包，卖家拿交易手续费分成）或 USDC 直付给卖家。发货由卖家自己处理，平台不经手；有问题先在订单里找卖家。陌生链接、私聊「客服」、让你签名授权的，基本都是骗局。`,
  };
  c.header("cache-control", "public, max-age=15");
  return c.json({ card, group, values });
});

/** Shop front: the seller's payment token, the tokens it could switch to, and its items (owner sees hidden ones too). */
shop.get("/sellers/:address", async (c) => {
  const a = c.req.param("address");
  if (!isAddress(a)) return c.json({ error: "bad address" }, 400);
  const seller = getAddress(a);
  const [s] = await sql<{ token: string; pay_token: boolean; pay_usdc: boolean }[]>`select token, pay_token, pay_usdc from shop_sellers where seller = ${seller}`;
  const [tok] = s ? await sql`select address, symbol, name, logo, last_price as price, factory from tokens where address = ${s.token}` : [];
  const viewer = await checkSession((n) => c.req.header(n));
  const own = viewer === seller;
  const rows = await sql<ProductRow[]>`${productSelect} where p.seller = ${seller} and ${own ? sql`p.status <> 'deleted'` : sql`p.status = 'on'`} order by p.created_at desc`;
  const [stats] = await sql<{ orders: number; open: number }[]>`select count(*)::int as orders, count(*) filter (where status = 'paid')::int as open from shop_orders where seller = ${seller}`;
  return c.json({
    seller,
    token: tok ? { address: tok.address, symbol: tok.symbol, name: tok.name, logo: tok.logo, price: Number(tok.price ?? 0) } : null,
    pay: { token: s ? s.pay_token : true, usdc: s ? s.pay_usdc : false },
    eligible: own ? await tokensOf(seller) : undefined,
    products: rows.map(shapeProduct),
    orders: stats?.orders ?? 0,
    openOrders: own ? (stats?.open ?? 0) : undefined,
  });
});

shop.post("/sellers/token", async (c) => {
  const body = await c.req.json<Signed>().catch(() => null);
  const seller = await checkAction(body, "token");
  if (!seller) return c.json({ error: "bad signature" }, 401);
  const token = String((body!.payload as { token?: string })?.token ?? "");
  const mine = await tokensOf(seller);
  const hit = mine.find((x) => x.address.toLowerCase() === token.toLowerCase());
  if (!hit) return c.json({ error: "you can only take payment in a token you launched" }, 403);
  await sql`insert into shop_sellers (seller, token) values (${seller}, ${hit.address})
            on conflict (seller) do update set token = excluded.token, updated_at = now()`;
  return c.json({ ok: true, token: hit.address });
});

/** Which ways the shop takes payment (at least one). */
shop.post("/sellers/settings", async (c) => {
  const body = await c.req.json<Signed>().catch(() => null);
  const seller = await checkAction(body, "settings");
  if (!seller) return c.json({ error: "bad signature" }, 401);
  const p = (body!.payload ?? {}) as { payToken?: unknown; payUsdc?: unknown };
  const payToken = p.payToken === true;
  const payUsdc = p.payUsdc === true;
  if (!payToken && !payUsdc) return c.json({ error: "turn on at least one way to pay" }, 400);
  const [row] = await sql`update shop_sellers set pay_token = ${payToken}, pay_usdc = ${payUsdc}, updated_at = now() where seller = ${seller} returning seller`;
  if (!row) return c.json({ error: "pick the token your shop takes first" }, 400);
  return c.json({ ok: true });
});

shop.post("/products", async (c) => {
  const body = await c.req.json<Signed>().catch(() => null);
  const seller = await checkAction(body, "create");
  if (!seller) return c.json({ error: "bad signature" }, 401);
  const [s] = await sql`select 1 from shop_sellers where seller = ${seller}`;
  if (!s) return c.json({ error: "pick the token your shop takes first" }, 400);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from shop_products where seller = ${seller} and status <> 'deleted'`;
  if (n >= 200) return c.json({ error: "200 items per shop" }, 400);
  try {
    const p = readProduct((body!.payload ?? {}) as Record<string, unknown>);
    const [row] = await sql`insert into shop_products (seller, title, body, images, price_usd6, stock, status)
      values (${seller}, ${p.title}, ${p.body}, ${sql.json(p.images)}, ${p.price.toString()}, ${p.stock}, ${p.status}) returning id`;
    return c.json({ id: Number(row.id) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

shop.post("/products/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Signed>().catch(() => null);
  const seller = await checkAction(body, `product:${id}`);
  if (!seller) return c.json({ error: "bad signature" }, 401);
  const [row] = await sql`select seller from shop_products where id = ${id} and status <> 'deleted'`;
  if (!row || row.seller !== seller) return c.json({ error: "not found" }, 404);
  const payload = (body!.payload ?? {}) as Record<string, unknown>;
  if (payload.delete === true) {
    await sql`update shop_products set status = 'deleted', updated_at = now() where id = ${id}`;
    return c.json({ ok: true });
  }
  try {
    const p = readProduct(payload);
    await sql`update shop_products set title = ${p.title}, body = ${p.body}, images = ${sql.json(p.images)}, price_usd6 = ${p.price.toString()},
      stock = ${p.stock}, status = ${p.status}, updated_at = now() where id = ${id}`;
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

type Ship = { name: string; phone: string; address: string; note: string };
function readShip(s: unknown): Ship {
  const o = (s ?? {}) as Record<string, unknown>;
  const ship = { name: clean(o.name, 40), phone: clean(o.phone, 30), address: clean(o.address, 300), note: clean(o.note, 200) };
  if (!ship.name || !ship.phone || !ship.address) throw new Error("name, phone and address are required");
  return ship;
}

/** The buyer posts the paid tx; `ship` is signed together with it so nobody else can attach their address to it. */
shop.post("/orders", async (c) => {
  const body = await c.req.json<{ productId: number; tx: string; buyer: string; ship: unknown; ts: number; signature: string }>().catch(() => null);
  if (!body || !isAddress(body.buyer) || !/^0x[0-9a-fA-F]{64}$/.test(body.tx ?? "") || Math.abs(Date.now() - Number(body.ts)) > 30 * 60_000) return c.json({ error: "bad request" }, 400);
  let ship: Ship;
  try {
    ship = readShip(body.ship);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const productId = Number(body.productId);
  const ok = await verifyMessage({ address: getAddress(body.buyer), message: shopOrderMessage(productId, body.tx, Number(body.ts), JSON.stringify(body.ship)), signature: body.signature as Hex }).catch(() => false);
  if (!ok) return c.json({ error: "bad signature" }, 401);
  const tx = body.tx.toLowerCase();
  const [dup] = await sql`select id, buyer from shop_orders where tx_hash = ${tx}`;
  if (dup) return dup.buyer === getAddress(body.buyer) ? c.json({ id: Number(dup.id), existing: true }) : c.json({ error: "this payment is already used" }, 409);
  const [p] = await sql<(ProductRow & { token: string | null })[]>`${productSelect} where p.id = ${productId} and p.status <> 'deleted'`;
  if (!p || !p.token) return c.json({ error: "item not found" }, 404);
  const buyer = getAddress(body.buyer);
  const seller = getAddress(p.seller);
  if (buyer === seller) return c.json({ error: "you can't buy from your own shop" }, 400);
  const paid = await checkPayment(tx as Hex, buyer, seller, p.token, BigInt(p.price_usd6), { token: p.pay_token !== false, usdc: p.pay_usdc === true });
  if ("error" in paid) return c.json({ error: paid.error, pending: paid.pending ?? false }, paid.pending ? 202 : 400);
  const [row] = await sql`insert into shop_orders (product_id, seller, buyer, token, tx_hash, paid_usd6, tokens, title, image, price_usd6, ship, pay_method)
    values (${productId}, ${seller}, ${buyer}, ${p.token}, ${tx}, ${paid.usd.toString()}, ${paid.tokensOut.toString()}, ${p.title}, ${p.images?.[0] ?? ""}, ${p.price_usd6}, ${sql.json(ship)}, ${paid.method})
    on conflict (tx_hash) do nothing returning id`;
  if (!row) return c.json({ error: "this payment is already used" }, 409);
  await sql`update shop_products set sold = sold + 1 where id = ${productId}`;
  return c.json({ id: Number(row.id) });
});

// ---- 留言 (public, wallet-signed) and 评价 (buyer of a shipped order, once per order) ----

shop.get("/products/:id/comments", async (c) => {
  const id = Number(c.req.param("id"));
  const [p] = await sql`select seller from shop_products where id = ${id}`;
  if (!p) return c.json({ error: "not found" }, 404);
  const rows = await sql`select id, author, text, images, reply_to, created_at from shop_comments where product_id = ${id} order by created_at asc limit 500`;
  return c.json(rows.map((r) => ({ id: Number(r.id), author: r.author, text: r.text, images: r.images ?? [], replyTo: r.reply_to ? Number(r.reply_to) : null, time: r.created_at, isSeller: r.author === p.seller })));
});

shop.post("/products/:id/comments", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Signed>().catch(() => null);
  const author = await checkAction(body, `comment:${id}`);
  if (!author) return c.json({ error: "bad signature" }, 401);
  const pl = (body!.payload ?? {}) as { text?: unknown; replyTo?: unknown; images?: unknown };
  const text = clean(pl.text, 300);
  const images = Array.isArray(pl.images) ? pl.images.filter(isImage).slice(0, 3) : [];
  if (!text && !images.length) return c.json({ error: "say something" }, 400);
  const [p] = await sql`select 1 from shop_products where id = ${id} and status <> 'deleted'`;
  if (!p) return c.json({ error: "not found" }, 404);
  const replyTo = pl.replyTo != null ? Number(pl.replyTo) : null;
  if (replyTo != null) {
    const [r] = await sql`select 1 from shop_comments where id = ${replyTo} and product_id = ${id}`;
    if (!r) return c.json({ error: "bad replyTo" }, 400);
  }
  const [recent] = await sql`select created_at from shop_comments where author = ${author} order by created_at desc limit 1`;
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 10_000) return c.json({ error: "slow down" }, 429);
  const [row] = await sql`insert into shop_comments (product_id, author, text, images, reply_to) values (${id}, ${author}, ${text}, ${sql.json(images)}, ${replyTo}) returning id`;
  return c.json({ id: Number(row.id) });
});

shop.get("/products/:id/reviews", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await sql`select r.id, r.buyer, r.rating, r.text, r.images, r.created_at, o.pay_method from shop_reviews r join shop_orders o on o.id = r.order_id
    where r.product_id = ${id} order by r.created_at desc limit 300`;
  return c.json(rows.map((r) => ({ id: Number(r.id), buyer: r.buyer, rating: r.rating, text: r.text, images: r.images ?? [], time: r.created_at, payMethod: r.pay_method })));
});

/** the buyer reviews their order once the seller has shipped it (marks the order completed too) */
shop.post("/orders/:id/review", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Signed>().catch(() => null);
  const buyer = await checkAction(body, `review:${id}`);
  if (!buyer) return c.json({ error: "bad signature" }, 401);
  const pl = (body!.payload ?? {}) as { rating?: unknown; text?: unknown; images?: unknown };
  const rating = Math.round(Number(pl.rating));
  if (!(rating >= 1 && rating <= 5)) return c.json({ error: "rating 1–5" }, 400);
  const text = clean(pl.text, 500);
  const images = Array.isArray(pl.images) ? pl.images.filter(isImage).slice(0, 6) : [];
  const [o] = await sql`select product_id, status from shop_orders where id = ${id} and buyer = ${buyer}`;
  if (!o) return c.json({ error: "not found" }, 404);
  if (o.status === "paid") return c.json({ error: "you can review once the seller has shipped" }, 400);
  const [row] = await sql`insert into shop_reviews (order_id, product_id, buyer, rating, text, images) values (${id}, ${o.product_id}, ${buyer}, ${rating}, ${text}, ${sql.json(images)})
    on conflict (order_id) do nothing returning id`;
  if (!row) return c.json({ error: "already reviewed" }, 409);
  await sql`update shop_orders set status = 'done', done_at = coalesce(done_at, now()) where id = ${id}`;
  return c.json({ id: Number(row.id) });
});

// ---- shipping address book (session headers) ----
const MAX_ADDRESSES = 20;
const shapeAddress = (r: Record<string, unknown>) => ({ id: Number(r.id), name: r.name, phone: r.phone, address: r.address, isDefault: !!r.is_default });

shop.get("/addresses", async (c) => {
  const me = await checkSession((n) => c.req.header(n));
  if (!me) return c.json({ error: "sign in" }, 401);
  const rows = await sql`select * from shop_addresses where owner = ${me} order by is_default desc, updated_at desc`;
  return c.json(rows.map(shapeAddress));
});

/** create (no id) or update; `isDefault` moves the default flag here */
shop.post("/addresses", async (c) => {
  const me = await checkSession((n) => c.req.header(n));
  if (!me) return c.json({ error: "sign in" }, 401);
  const b = await c.req.json<{ id?: number; name?: string; phone?: string; address?: string; isDefault?: boolean }>().catch(() => null);
  let a: Ship;
  try {
    a = readShip({ ...b, note: "" });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from shop_addresses where owner = ${me}`;
  const makeDefault = b?.isDefault === true || n === 0;
  const row = await sql.begin(async (tx) => {
    if (makeDefault) await tx`update shop_addresses set is_default = false where owner = ${me}`;
    if (b?.id) {
      const [r] = await tx`update shop_addresses set name = ${a.name}, phone = ${a.phone}, address = ${a.address}, updated_at = now()
        ${makeDefault ? tx`, is_default = true` : tx``} where id = ${Number(b.id)} and owner = ${me} returning *`;
      return r;
    }
    if (n >= MAX_ADDRESSES) return null;
    const [r] = await tx`insert into shop_addresses (owner, name, phone, address, is_default) values (${me}, ${a.name}, ${a.phone}, ${a.address}, ${makeDefault}) returning *`;
    return r;
  });
  if (!row) return c.json({ error: b?.id ? "not found" : `${MAX_ADDRESSES} addresses at most` }, b?.id ? 404 : 400);
  return c.json(shapeAddress(row));
});

shop.post("/addresses/:id/delete", async (c) => {
  const me = await checkSession((n) => c.req.header(n));
  if (!me) return c.json({ error: "sign in" }, 401);
  const id = Number(c.req.param("id"));
  const [gone] = await sql`delete from shop_addresses where id = ${id} and owner = ${me} returning is_default`;
  if (gone?.is_default) await sql`update shop_addresses set is_default = true where id = (select id from shop_addresses where owner = ${me} order by updated_at desc limit 1)`;
  return c.json({ ok: true });
});

/** role=seller: orders of my shop; role=buyer (default): my purchases. Needs the session headers. */
shop.get("/orders", async (c) => {
  const me = await checkSession((n) => c.req.header(n));
  if (!me) return c.json({ error: "sign in" }, 401);
  const seller = c.req.query("role") === "seller";
  const status = c.req.query("status");
  const rows = await sql<OrderRow[]>`select o.*, t.symbol, exists(select 1 from shop_reviews r where r.order_id = o.id) as reviewed
    from shop_orders o left join tokens t on t.address = o.token
    where ${seller ? sql`o.seller = ${me}` : sql`o.buyer = ${me}`}
    ${status && ["paid", "shipped", "done"].includes(status) ? sql`and o.status = ${status}` : sql``}
    order by o.created_at desc limit 300`;
  return c.json(rows.map((r) => shapeOrder(r, true)));
});

shop.post("/orders/:id/ship", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Signed>().catch(() => null);
  const seller = await checkAction(body, `ship:${id}`);
  if (!seller) return c.json({ error: "bad signature" }, 401);
  const p = (body!.payload ?? {}) as Record<string, unknown>;
  const carrier = clean(p.carrier, 40);
  const tracking = clean(p.tracking, 80);
  const note = clean(p.note, 200);
  if (!tracking && !note) return c.json({ error: "tracking number or a note" }, 400);
  const [row] = await sql`update shop_orders set status = 'shipped', carrier = ${carrier}, tracking = ${tracking}, ship_note = ${note}, shipped_at = coalesce(shipped_at, now())
    where id = ${id} and seller = ${seller} and status in ('paid','shipped') returning id`;
  return row ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

shop.post("/orders/:id/done", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Signed>().catch(() => null);
  const buyer = await checkAction(body, `done:${id}`);
  if (!buyer) return c.json({ error: "bad signature" }, 401);
  const [row] = await sql`update shop_orders set status = 'done', done_at = now() where id = ${id} and buyer = ${buyer} and status = 'shipped' returning id`;
  return row ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
