import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Server-side Hyperliquid client for AI 托管 (wallet plan §5.8). Same encoding and signing as the wallet's
 * `web/src/lib/wallet/hl.ts` (scripts/_aibot-sig.mts checks both produce identical signatures); trading actions are signed
 * with the user's hosted **agent key**, which Hyperliquid lets trade but never withdraw.
 */

const HL = "https://api.hyperliquid.xyz";
/** Builder fee stays off until an address with ≥ 100 USDC on Hyperliquid is configured (HL_BUILDER, same as the wallet). */
const BUILDER = (process.env.HL_BUILDER || "").toLowerCase();
const BUILDER_FEE = 50;

// ---------- msgpack (only what Hyperliquid actions contain) ----------

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

export function actionHash(action: unknown, nonce: number): Hex {
  const out: number[] = [];
  pack(action, out);
  const buf = new Uint8Array(out.length + 9);
  buf.set(out);
  new DataView(buf.buffer).setBigUint64(out.length, BigInt(nonce));
  buf[out.length + 8] = 0;
  return keccak256(buf);
}

export type Sig = { r: Hex; s: Hex; v: number };
export async function signL1(signer: PrivateKeyAccount, action: unknown, nonce: number): Promise<Sig> {
  const sig = await signer.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "a", connectionId: actionHash(action, nonce) },
  });
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
}

// ---------- transport ----------

const shared = new Map<string, { at: number; v: unknown }>();
export async function info<T>(body: Record<string, unknown>, ttl = 0): Promise<T> {
  const key = ttl ? JSON.stringify(body) : "";
  const hit = key ? shared.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const r = await fetch(`${HL}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  const v = (await r.json()) as T;
  if (key) {
    if (shared.size > 2_000) shared.clear();
    shared.set(key, { at: Date.now(), v });
  }
  return v;
}

export function explain(m: string): string {
  if (/does not exist/i.test(m)) return "托管的交易授权失效了（过期或被撤销），请在钱包里重新开启托管";
  if (/insufficient margin/i.test(m)) return "保证金不够";
  if (/minimum value of \$?10/i.test(m)) return "下单金额太小，Hyperliquid 每笔至少 10 美元";
  if (/Builder fee has not been approved/i.test(m)) return "还没授权平台手续费";
  if (/could not immediately match/i.test(m)) return "没有成交（价格变动太快）";
  if (/Must deposit/i.test(m)) return "这个地址还没在 Hyperliquid 充值过";
  if (/Multi-sig required/i.test(m)) return "这个地址在 Hyperliquid 上开了多签，不支持";
  return m.slice(0, 200);
}

/** a fatal answer means the agent itself is unusable: the bot must stop asking */
export const agentDead = (m: string) => /托管的交易授权失效|多签/.test(m);

async function exchange(action: unknown, nonce: number, signature: Sig): Promise<unknown> {
  const r = await fetch(`${HL}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature }), signal: AbortSignal.timeout(15_000) });
  const j = (await r.json().catch(() => null)) as { status?: string; response?: unknown } | null;
  if (!r.ok || !j) throw new Error(`Hyperliquid HTTP ${r.status}`);
  if (j.status !== "ok") throw new Error(explain(String(j.response ?? "失败")));
  const statuses = (j.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses;
  const bad = statuses?.find((s) => typeof s === "object" && s && "error" in s) as { error: string } | undefined;
  if (bad) throw new Error(explain(bad.error));
  return j.response;
}

// ---------- market ----------

export type HlAsset = { index: number; name: string; szDecimals: number; maxLeverage: number; mark: number; mid: number; prevDay: number; funding: number; oi: number; volume: number; onlyIsolated: boolean };

export async function assets(): Promise<HlAsset[]> {
  type U = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean };
  type C = { markPx: string; midPx: string | null; prevDayPx: string; funding: string; openInterest: string; dayNtlVlm: string };
  const [meta, ctxs] = await info<[{ universe: U[] }, C[]]>({ type: "metaAndAssetCtxs" }, 3_000);
  const list: HlAsset[] = [];
  meta.universe.forEach((u, index) => {
    const c = ctxs[index];
    if (!c || u.isDelisted) return;
    const mark = Number(c.markPx);
    list.push({ index, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, mark, mid: Number(c.midPx ?? c.markPx), prevDay: Number(c.prevDayPx), funding: Number(c.funding), oi: Number(c.openInterest) * mark, volume: Number(c.dayNtlVlm), onlyIsolated: !!u.onlyIsolated });
  });
  return list;
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
/** market data is the same for every bot: shared for a minute */
export async function candles(coin: string, interval: "15m" | "1h" | "4h", count: number): Promise<Candle[]> {
  const ms = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 }[interval];
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const rows = await info<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - ms * count, endTime: end } }, 60_000);
  return rows.map((r) => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
}

// ---------- account ----------

export type HlPosition = { coin: string; size: number; side: "long" | "short"; entry: number; value: number; upnl: number; roe: number; liq: number | null; leverage: number; cross: boolean; margin: number };
export type HlAccount = { unified: boolean; equity: number; available: number; upnl: number; positions: HlPosition[] };

export async function account(user: string): Promise<HlAccount> {
  type P = { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; returnOnEquity: string; liquidationPx: string | null; leverage: { type: string; value: number }; marginUsed: string } };
  const [s, spot, mode] = await Promise.all([
    info<{ marginSummary: { accountValue: string }; withdrawable: string; assetPositions: P[] }>({ type: "clearinghouseState", user }),
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
    upnl,
    positions: s.assetPositions.map(({ position: p }) => {
      const size = Number(p.szi);
      return { coin: p.coin, size: Math.abs(size), side: size >= 0 ? "long" : "short", entry: Number(p.entryPx), value: Number(p.positionValue), upnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity), liq: p.liquidationPx ? Number(p.liquidationPx) : null, leverage: p.leverage.value, cross: p.leverage.type === "cross", margin: Number(p.marginUsed) };
    }),
  };
}

/** Whether Hyperliquid lists this agent for the user (named agents come back from extraAgents) */
export async function agentListed(user: string, agent: string): Promise<{ ok: boolean; validUntil: number }> {
  const list = await info<{ address: string; name: string; validUntil: number }[]>({ type: "extraAgents", user });
  const hit = list.find((x) => x.address.toLowerCase() === agent.toLowerCase());
  return { ok: !!hit, validUntil: hit?.validUntil ?? 0 };
}

export const builderOk = async (user: string) => (BUILDER ? (await info<number>({ type: "maxBuilderFee", user, builder: BUILDER })) >= BUILDER_FEE : true);

// ---------- tick / lot rules ----------

const trimZeros = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
export function formatPx(px: number, szDecimals: number): string {
  if (!(px > 0)) throw new Error("价格不对");
  if (px >= 100_000) return String(Math.round(px));
  return trimZeros(Number(px.toPrecision(5)).toFixed(Math.max(6 - szDecimals, 0)));
}
export function formatSz(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const v = Math.floor(sz * f + 1e-9) / f;
  if (!(v > 0)) throw new Error("数量太小");
  return trimZeros(v.toFixed(szDecimals));
}

// ---------- trading (agent-signed) ----------

const nonces = new Map<string, number>();
/** ms timestamps, strictly increasing per agent */
const nextNonce = (agent: string) => {
  const n = Math.max(Date.now(), (nonces.get(agent) ?? 0) + 1);
  nonces.set(agent, n);
  return n;
};

async function send(agent: PrivateKeyAccount, action: Record<string, unknown>) {
  const nonce = nextNonce(agent.address);
  return exchange(action, nonce, await signL1(agent, action, nonce));
}

type Wire = { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Gtc" | "Ioc" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } } };
function orderAction(orders: Wire[], grouping: "na" | "normalTpsl") {
  const action: Record<string, unknown> = { type: "order", orders: orders.map((o) => ({ a: o.a, b: o.b, p: o.p, s: o.s, r: o.r, t: o.t })), grouping };
  if (BUILDER) action.builder = { b: BUILDER, f: BUILDER_FEE };
  return action;
}

export const agentAccount = (key: Hex) => privateKeyToAccount(key);

export async function setLeverage(agent: PrivateKeyAccount, asset: HlAsset, leverage: number): Promise<void> {
  await send(agent, { type: "updateLeverage", asset: asset.index, isCross: false, leverage: Math.max(1, Math.min(Math.round(leverage), asset.maxLeverage)) });
}

const SLIPPAGE = 0.03;
const marketPx = (asset: HlAsset, isBuy: boolean) => formatPx(asset.mid * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), asset.szDecimals);

/** Market entry with reduce-only market TP / SL attached (grouping normalTpsl), exactly as the wallet places them */
export async function openPosition(agent: PrivateKeyAccount, asset: HlAsset, isBuy: boolean, size: number, tp: number | null, sl: number | null) {
  const sz = formatSz(size, asset.szDecimals);
  const orders: Wire[] = [{ a: asset.index, b: isBuy, p: marketPx(asset, isBuy), s: sz, r: false, t: { limit: { tif: "Ioc" } } }];
  for (const [px, kind] of [[tp, "tp"], [sl, "sl"]] as const) {
    if (!px) continue;
    orders.push({ a: asset.index, b: !isBuy, p: formatPx(px * (isBuy ? (kind === "tp" ? 0.97 : 0.95) : kind === "tp" ? 1.03 : 1.05), asset.szDecimals), s: sz, r: true, t: { trigger: { isMarket: true, triggerPx: formatPx(px, asset.szDecimals), tpsl: kind } } });
  }
  return send(agent, orderAction(orders, orders.length > 1 ? "normalTpsl" : "na"));
}

export async function closePosition(agent: PrivateKeyAccount, asset: HlAsset, pos: HlPosition) {
  const isBuy = pos.side === "short";
  return send(agent, orderAction([{ a: asset.index, b: isBuy, p: marketPx(asset, isBuy), s: formatSz(pos.size, asset.szDecimals), r: true, t: { limit: { tif: "Ioc" } } }], "na"));
}

/** Leftover reduce-only TP / SL orders of a coin (after the position is gone) */
export async function cancelReduceOnly(agent: PrivateKeyAccount, user: string, asset: HlAsset) {
  const rows = await info<{ coin: string; oid: number; reduceOnly: boolean }[]>({ type: "frontendOpenOrders", user });
  const cancels = rows.filter((o) => o.coin === asset.name && o.reduceOnly).map((o) => ({ a: asset.index, o: o.oid }));
  if (cancels.length) await send(agent, { type: "cancel", cancels });
}

export const isAddress = (s: unknown): s is Address => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
