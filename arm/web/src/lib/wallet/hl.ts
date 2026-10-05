import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_BASE } from "@/lib/api";
import { t } from "./i18n";

/**
 * Hyperliquid perps for 「AI 合约」 (wallet plan §5.8), without its SDK:
 *  - trading actions (order / cancel / leverage) are msgpack-encoded, hashed with the nonce and signed as a "phantom agent"
 *    (EIP-712 domain "Exchange", chain 1337) by an **agent key** the wallet generates and keeps in the vault — agents can trade
 *    but cannot withdraw;
 *  - account actions (approve the agent, approve the builder fee, withdraw) are EIP-712 "HyperliquidSignTransaction" messages
 *    signed by the user's main wallet.
 * Reads and signed actions go through the indexer relay (/api/hl/*), which cannot alter what was signed.
 */

export const HL_API = `${API_BASE}/hl`;
/** Hyperliquid's deposit bridge on Arbitrum (official docs); it credits the sender, native USDC only, at least 5 USDC */
export const HL_BRIDGE: Address = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
export const ARB_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const MIN_DEPOSIT = 5;
export const WITHDRAW_FEE = 1;
/** Arbitrum: the chain id user-signed actions declare (any chain works; the wallet signs offline) */
const SIG_CHAIN = "0xa4b1";
/** Builder fee: off until an address with ≥ 100 USDC on Hyperliquid is configured (NEXT_PUBLIC_HL_BUILDER). */
export const HL_BUILDER = (process.env.NEXT_PUBLIC_HL_BUILDER || "").toLowerCase() as Address | "";
export const BUILDER_FEE_RATE = "0.05%";
/** in tenths of a basis point: 50 = 0.05% */
const BUILDER_FEE = 50;
export const AGENT_DAYS = 180;

// ---------- msgpack (only what Hyperliquid actions contain; same choices as its SDKs, so hashes match) ----------

function packInt(n: number | bigint, out: number[]) {
  const v = BigInt(n);
  if (v < 0n) throw new Error("negative int");
  if (v < 128n) out.push(Number(v));
  else if (v < 256n) out.push(0xcc, Number(v));
  else if (v < 65536n) out.push(0xcd, Number(v >> 8n), Number(v & 255n));
  else if (v < 4294967296n) out.push(0xce, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 255n)));
  else out.push(0xcf, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 255n)));
}
function pack(x: unknown, out: number[]) {
  if (x === null) out.push(0xc0);
  else if (typeof x === "boolean") out.push(x ? 0xc3 : 0xc2);
  else if (typeof x === "number" || typeof x === "bigint") {
    if (typeof x === "number" && !Number.isInteger(x)) throw new Error("floats are not used in Hyperliquid actions");
    packInt(x, out);
  } else if (typeof x === "string") {
    const b = new TextEncoder().encode(x);
    if (b.length < 32) out.push(0xa0 | b.length);
    else if (b.length < 256) out.push(0xd9, b.length);
    else out.push(0xda, b.length >> 8, b.length & 255);
    out.push(...b);
  } else if (Array.isArray(x)) {
    if (x.length < 16) out.push(0x90 | x.length);
    else out.push(0xdc, x.length >> 8, x.length & 255);
    x.forEach((v) => pack(v, out));
  } else if (typeof x === "object") {
    const entries = Object.entries(x as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length < 16) out.push(0x80 | entries.length);
    else out.push(0xde, entries.length >> 8, entries.length & 255);
    for (const [k, v] of entries) {
      pack(k, out);
      pack(v, out);
    }
  } else throw new Error(`cannot msgpack ${typeof x}`);
}
export function msgpack(x: unknown): Uint8Array {
  const out: number[] = [];
  pack(x, out);
  return new Uint8Array(out);
}

// ---------- signing ----------

export type Sig = { r: Hex; s: Hex; v: number };
const splitSig = (sig: Hex): Sig => ({ r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) });

/** keccak(msgpack(action) ‖ nonce u64 ‖ 0x00 (no vault)) */
export function actionHash(action: unknown, nonce: number): Hex {
  const a = msgpack(action);
  const buf = new Uint8Array(a.length + 9);
  buf.set(a);
  new DataView(buf.buffer).setBigUint64(a.length, BigInt(nonce));
  buf[a.length + 8] = 0;
  return bytesToHex(keccak_256(buf));
}

export async function signL1(signer: LocalAccount, action: unknown, nonce: number): Promise<Sig> {
  const sig = await signer.signTypedData!({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "a", connectionId: actionHash(action, nonce) },
  });
  return splitSig(sig);
}

const USER_TYPES = {
  approveAgent: { "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }] },
  approveBuilderFee: { "HyperliquidTransaction:ApproveBuilderFee": [{ name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" }, { name: "builder", type: "address" }, { name: "nonce", type: "uint64" }] },
  withdraw3: { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
} as const;

export async function signUser(signer: LocalAccount, kind: keyof typeof USER_TYPES, action: Record<string, unknown>): Promise<Sig> {
  const types = USER_TYPES[kind];
  const sig = await signer.signTypedData!({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: parseInt(SIG_CHAIN, 16), verifyingContract: "0x0000000000000000000000000000000000000000" },
    types,
    primaryType: Object.keys(types)[0],
    message: action,
  } as Parameters<NonNullable<LocalAccount["signTypedData"]>>[0]);
  return splitSig(sig);
}

// ---------- transport ----------

export async function info<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j as { error?: string } | null)?.error ?? (r.status === 429 ? t("cw.hl.rateLimited") : `Hyperliquid HTTP ${r.status}`));
  return j as T;
}

type ExchangeReply = { status: "ok" | "err"; response?: unknown };
/** Sends a signed action; turns Hyperliquid's errors (top level and per order) into a thrown message */
export async function exchange(action: unknown, nonce: number, signature: Sig): Promise<unknown> {
  const r = await fetch(`${HL_API}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature }) });
  const j = (await r.json().catch(() => null)) as ExchangeReply | { error?: string } | null;
  if (!r.ok || !j) throw new Error((j as { error?: string } | null)?.error ?? `Hyperliquid HTTP ${r.status}`);
  const reply = j as ExchangeReply;
  if (reply.status !== "ok") throw new Error(explain(String(reply.response ?? t("common.fail"))));
  const statuses = (reply.response as { data?: { statuses?: ({ error?: string } | string)[] } } | undefined)?.data?.statuses;
  const bad = statuses?.find((s) => typeof s === "object" && s && "error" in s) as { error: string } | undefined;
  if (bad) throw new Error(explain(bad.error));
  return reply.response;
}

function explain(m: string): string {
  if (/does not exist/i.test(m)) return t("cw.hl.errAgent");
  if (/insufficient margin|perpMarginRejected/i.test(m)) return t("cw.hl.errMargin");
  if (/minimum value of \$?10/i.test(m)) return t("cw.hl.errMinValue");
  if (/Builder fee has not been approved/i.test(m)) return t("cw.hl.errBuilder");
  if (/could not immediately match/i.test(m)) return t("cw.hl.errNoMatch");
  if (/reduce only/i.test(m)) return t("cw.hl.errReduceOnly");
  if (/Must deposit/i.test(m)) return t("cw.hl.errMustDeposit");
  if (/Multi-sig required/i.test(m)) return t("cw.hl.errMultisig");
  return m;
}

// ---------- market ----------

export type HlAsset = { index: number; name: string; szDecimals: number; maxLeverage: number; mark: number; mid: number; prevDay: number; funding: number; oi: number; volume: number; onlyIsolated: boolean };

let metaCache: { at: number; list: HlAsset[] } | null = null;
export async function assets(maxAgeMs = 3_000): Promise<HlAsset[]> {
  if (metaCache && Date.now() - metaCache.at < maxAgeMs) return metaCache.list;
  type U = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean };
  type C = { markPx: string; midPx: string | null; prevDayPx: string; funding: string; openInterest: string; dayNtlVlm: string };
  const [meta, ctxs] = await info<[{ universe: U[] }, C[]]>({ type: "metaAndAssetCtxs" });
  const list: HlAsset[] = [];
  meta.universe.forEach((u, index) => {
    const c = ctxs[index];
    if (!c || u.isDelisted) return;
    const mark = Number(c.markPx);
    list.push({ index, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, mark, mid: Number(c.midPx ?? c.markPx), prevDay: Number(c.prevDayPx), funding: Number(c.funding), oi: Number(c.openInterest) * mark, volume: Number(c.dayNtlVlm), onlyIsolated: !!u.onlyIsolated });
  });
  metaCache = { at: Date.now(), list };
  return list;
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export const CANDLE_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const;
export type CandleInterval = keyof typeof CANDLE_MS;
export async function candles(coin: string, interval: CandleInterval, count: number): Promise<Candle[]> {
  const ms = CANDLE_MS[interval];
  // rounded up to the minute so everybody's request is the same one the relay already cached
  const end = Math.ceil(Date.now() / 60_000) * 60_000;
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - ms * count, endTime: end } });
  return rows.map((r) => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
}

/** Latest mid prices (the relay refreshes them once a second for everybody) */
export async function mids(coins: string[]): Promise<Record<string, number>> {
  const r = await fetch(`${HL_API}/mids?coins=${encodeURIComponent(coins.join(","))}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { mids: Record<string, number> }).mids;
}

// ---------- account ----------

export type HlPosition = { coin: string; size: number; side: "long" | "short"; entry: number; value: number; upnl: number; roe: number; liq: number | null; leverage: number; cross: boolean; margin: number };
export type HlOrder = { coin: string; oid: number; side: "long" | "short"; px: number; size: number; reduceOnly: boolean; trigger: string | null; triggerPx: number | null; orderType: string };
/** `unified`: one USDC balance shared by spot and perps (Hyperliquid's default for new accounts) — balances live in the
 * spot clearinghouse; otherwise the perps clearinghouse has them. `available` is what new positions / withdrawals can use. */
export type HlAccount = { unified: boolean; equity: number; available: number; marginUsed: number; ntl: number; upnl: number; positions: HlPosition[] };

export async function account(user: Address): Promise<HlAccount> {
  type P = { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; returnOnEquity: string; liquidationPx: string | null; leverage: { type: string; value: number }; marginUsed: string } };
  const [s, spot, mode] = await Promise.all([
    info<{ marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string }; withdrawable: string; assetPositions: P[] }>({ type: "clearinghouseState", user }),
    info<{ balances: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user }),
    info<string | null>({ type: "userAbstraction", user }).catch(() => null),
  ]);
  const usdc = spot.balances.find((b) => b.coin === "USDC");
  const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
  const upnl = s.assetPositions.reduce((t, p) => t + Number(p.position.unrealizedPnl), 0);
  return {
    unified,
    equity: unified ? Number(usdc?.total ?? 0) + upnl : Number(s.marginSummary.accountValue),
    available: unified ? Math.max(0, Number(usdc?.total ?? 0) - Number(usdc?.hold ?? 0)) : Number(s.withdrawable),
    marginUsed: Number(s.marginSummary.totalMarginUsed),
    ntl: Number(s.marginSummary.totalNtlPos),
    upnl,
    positions: s.assetPositions.map(({ position: p }) => {
      const size = Number(p.szi);
      return { coin: p.coin, size: Math.abs(size), side: size >= 0 ? "long" : "short", entry: Number(p.entryPx), value: Number(p.positionValue), upnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity), liq: p.liquidationPx ? Number(p.liquidationPx) : null, leverage: p.leverage.value, cross: p.leverage.type === "cross", margin: Number(p.marginUsed) };
    }),
  };
}

export async function openOrders(user: Address): Promise<HlOrder[]> {
  type O = { coin: string; oid: number; side: "B" | "A"; limitPx: string; sz: string; reduceOnly: boolean; isTrigger: boolean; triggerPx: string; orderType: string; tpsl?: string };
  const rows = await info<O[]>({ type: "frontendOpenOrders", user });
  return rows.map((o) => ({ coin: o.coin, oid: o.oid, side: o.side === "B" ? "long" : "short", px: Number(o.limitPx), size: Number(o.sz), reduceOnly: o.reduceOnly, trigger: o.isTrigger ? (/take profit/i.test(o.orderType) ? "tp" : "sl") : null, triggerPx: o.isTrigger ? Number(o.triggerPx) : null, orderType: o.orderType }));
}

/** One order's fills merged; `reason` says what closed / opened it (the trigger order, a liquidation, or a plain order) */
export type HlTrade = { oid: number; time: number; coin: string; dir: string; px: number; size: number; pnl: number; fee: number; openFee: number; reason: "tp" | "sl" | "liq" | "market" | "limit" };
export async function trades(user: Address): Promise<HlTrade[]> {
  type F = { coin: string; px: string; sz: string; time: number; dir: string; closedPnl: string; fee: string; oid: number; crossed: boolean; liquidation?: unknown };
  type H = { order: { oid: number; orderType: string } };
  const [fills, hist] = await Promise.all([info<F[]>({ type: "userFills", user }), info<H[]>({ type: "historicalOrders", user }).catch(() => [] as H[])]);
  const kind = new Map(hist.map((h) => [h.order.oid, h.order.orderType]));
  const byOid = new Map<number, HlTrade & { notional: number }>();
  for (const f of fills) {
    const sz = Number(f.sz), px = Number(f.px);
    const t = byOid.get(f.oid);
    if (t) {
      t.size += sz;
      t.notional += sz * px;
      t.px = t.notional / t.size;
      t.pnl += Number(f.closedPnl);
      t.fee += Number(f.fee);
      t.time = Math.max(t.time, f.time);
      continue;
    }
    const ot = kind.get(f.oid) ?? "";
    const reason = f.liquidation ? "liq" : /take profit/i.test(ot) ? "tp" : /stop/i.test(ot) ? "sl" : f.crossed ? "market" : "limit";
    byOid.set(f.oid, { oid: f.oid, time: f.time, coin: f.coin, dir: f.dir, px, size: sz, pnl: Number(f.closedPnl), fee: Number(f.fee), openFee: 0, reason, notional: sz * px });
  }
  // a close also carries its share of the fees paid to open that size, so "after fees" is the whole round trip
  const list = [...byOid.values()].sort((a, b) => a.time - b.time);
  const pool = new Map<string, { size: number; fee: number }>();
  for (const t of list) {
    const p = pool.get(t.coin) ?? { size: 0, fee: 0 };
    if (t.dir.startsWith("Open")) {
      p.size += t.size;
      p.fee += t.fee;
    } else if (p.size > 0) {
      const share = Math.min(1, t.size / p.size);
      t.openFee = p.fee * share;
      p.fee -= t.openFee;
      p.size = t.dir.includes(">") ? 0 : Math.max(0, p.size - t.size);
      if (!p.size) p.fee = 0;
    }
    pool.set(t.coin, p);
  }
  return list.reverse().map(({ notional: _, ...t }) => t);
}

/** Hyperliquid's base taker fee (0.045%), for estimates */
export const TAKER_FEE = 0.00045;
/** share of the free margin an order may use: the rest absorbs the gap between order price and mark */
export const MARGIN_SAFETY = 0.995;

export const builderApproved = async (user: Address) => (HL_BUILDER ? (await info<number>({ type: "maxBuilderFee", user, builder: HL_BUILDER })) >= BUILDER_FEE : true);

// ---------- price / size formatting (Hyperliquid tick and lot rules) ----------

const trimZeros = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
/** at most 5 significant figures and (6 − szDecimals) decimals; whole numbers are always fine */
export function formatPx(px: number, szDecimals: number): string {
  if (!(px > 0)) throw new Error(t("cw.hl.badPrice"));
  if (px >= 100_000) return String(Math.round(px));
  const dec = Math.max(6 - szDecimals, 0);
  return trimZeros(Number(px.toPrecision(5)).toFixed(dec));
}
/** truncated (never rounded up) to szDecimals */
export function formatSz(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const v = Math.floor(sz * f + 1e-9) / f;
  if (!(v > 0)) throw new Error(t("cw.hl.sizeTooSmall"));
  return trimZeros(v.toFixed(szDecimals));
}

// ---------- agent key ----------

export type Agent = { key: Hex; address: Address; validUntil: number; name: string };
/** Hyperliquid keeps one agent per name: this phone's key and the AI 托管 key live side by side */
export const PHONE_AGENT = "xinzhiyin";
export const HOSTED_AGENT = "xinzhiyin-ai";
export const newAgent = (name = PHONE_AGENT): Agent => {
  const key = generatePrivateKey();
  const validUntil = Date.now() + AGENT_DAYS * 86_400_000;
  return { key, address: privateKeyToAccount(key).address, validUntil, name };
};
export const agentSigner = (a: Agent) => privateKeyToAccount(a.key);

/** Whether Hyperliquid still knows this agent for the user (named agents are listed by extraAgents). */
export async function agentActive(user: Address, a: Agent): Promise<boolean> {
  if (Date.now() > a.validUntil - 60_000) return false;
  const list = await info<{ address: string; name: string; validUntil: number }[]>({ type: "extraAgents", user });
  return list.some((x) => x.address.toLowerCase() === a.address.toLowerCase());
}

/** Main wallet authorizes the agent (trade only, no withdrawals) for AGENT_DAYS */
export async function approveAgent(main: LocalAccount, a: Agent): Promise<void> {
  const nonce = Date.now();
  const action = { type: "approveAgent", signatureChainId: SIG_CHAIN, hyperliquidChain: "Mainnet", agentAddress: a.address.toLowerCase(), agentName: `${a.name} valid_until ${a.validUntil}`, nonce };
  await exchange(action, nonce, await signUser(main, "approveAgent", action));
}

export async function approveBuilder(main: LocalAccount): Promise<void> {
  if (!HL_BUILDER) return;
  const nonce = Date.now();
  const action = { type: "approveBuilderFee", signatureChainId: SIG_CHAIN, hyperliquidChain: "Mainnet", maxFeeRate: BUILDER_FEE_RATE, builder: HL_BUILDER, nonce };
  await exchange(action, nonce, await signUser(main, "approveBuilderFee", action));
}

/** To the user's own address on Arbitrum; Hyperliquid deducts WITHDRAW_FEE */
export async function withdraw(main: LocalAccount, amount: number): Promise<void> {
  const time = Date.now();
  const action = { type: "withdraw3", signatureChainId: SIG_CHAIN, hyperliquidChain: "Mainnet", destination: main.address.toLowerCase(), amount: trimZeros(amount.toFixed(2)), time };
  await exchange(action, time, await signUser(main, "withdraw3", action));
}

// ---------- trading (signed by the agent) ----------

let lastNonce = 0;
/** ms timestamps, strictly increasing per signer */
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1));

type Wire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } } };
const wire = (o: Wire) => ({ a: o.a, b: o.b, p: o.p, s: o.s, r: o.r, t: o.t });

async function sendOrders(agent: Agent, orders: Wire[], grouping: "na" | "normalTpsl" | "positionTpsl") {
  const action: Record<string, unknown> = { type: "order", orders: orders.map(wire), grouping };
  if (HL_BUILDER) action.builder = { b: HL_BUILDER, f: BUILDER_FEE };
  const nonce = nextNonce();
  return exchange(action, nonce, await signL1(agentSigner(agent), action, nonce));
}

export async function setLeverage(agent: Agent, asset: HlAsset, leverage: number, cross = true): Promise<void> {
  const action = { type: "updateLeverage", asset: asset.index, isCross: cross && !asset.onlyIsolated, leverage: Math.max(1, Math.min(Math.round(leverage), asset.maxLeverage)) };
  const nonce = nextNonce();
  await exchange(action, nonce, await signL1(agentSigner(agent), action, nonce));
}

/** Market orders are IOC limits a few percent through the mid, the way Hyperliquid's own SDKs do it */
const SLIPPAGE = 0.03;
export const marketPx = (asset: HlAsset, isBuy: boolean) => formatPx(asset.mid * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), asset.szDecimals);

export type OpenParams = { asset: HlAsset; isBuy: boolean; size: number; limitPx?: number; tp?: number; sl?: number };

/** Opens (or adds to) a position; a take-profit / stop-loss given here is attached to the entry (grouping normalTpsl). */
export async function openPosition(agent: Agent, p: OpenParams) {
  const { asset } = p;
  const sz = formatSz(p.size, asset.szDecimals);
  const orders: Wire[] = [{ a: asset.index, b: p.isBuy, p: p.limitPx ? formatPx(p.limitPx, asset.szDecimals) : marketPx(asset, p.isBuy), s: sz, r: false, t: { limit: { tif: p.limitPx ? "Gtc" : "Ioc" } } }];
  for (const [px, kind] of [[p.tp, "tp"], [p.sl, "sl"]] as const) {
    if (!px) continue;
    // trigger orders close the position: opposite side, reduce only, executed at market once triggered
    orders.push({ a: asset.index, b: !p.isBuy, p: formatPx(px * (p.isBuy ? (kind === "tp" ? 0.97 : 0.95) : kind === "tp" ? 1.03 : 1.05), asset.szDecimals), s: sz, r: true, t: { trigger: { isMarket: true, triggerPx: formatPx(px, asset.szDecimals), tpsl: kind } } });
  }
  return sendOrders(agent, orders, orders.length > 1 ? "normalTpsl" : "na");
}

export async function closePosition(agent: Agent, asset: HlAsset, pos: HlPosition) {
  const isBuy = pos.side === "short";
  return sendOrders(agent, [{ a: asset.index, b: isBuy, p: marketPx(asset, isBuy), s: formatSz(pos.size, asset.szDecimals), r: true, t: { limit: { tif: "Ioc" } } }], "na");
}

export async function cancelOrder(agent: Agent, asset: HlAsset, oid: number) {
  const action = { type: "cancel", cancels: [{ a: asset.index, o: oid }] };
  const nonce = nextNonce();
  return exchange(action, nonce, await signL1(agentSigner(agent), action, nonce));
}

// helpers for the UI
export const parseAgent = (s: string | null): Agent | null => {
  try {
    const a = s ? (JSON.parse(s) as Agent) : null;
    return a?.key && a.address ? a : null;
  } catch {
    return null;
  }
};
export const agentExtraKey = (user: string) => `hl:agent:${user.toLowerCase()}`;
