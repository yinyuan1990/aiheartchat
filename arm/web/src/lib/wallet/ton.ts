import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import { API_BASE } from "@/lib/api";
import { TON_CHAIN, rpcOf } from "./chains";
import type { Secret } from "./vault";
import {
  MODE_ALL,
  MODE_NORMAL,
  NANO,
  beginCell,
  bocBase64,
  cellFromBase64,
  commentCell,
  formatTonAddress,
  jettonTransferBody,
  parseTonAddress,
  signerOf,
  tonKeyFromMnemonic,
  w5Code,
  w5Data,
  w5TransferParts,
  type OutMsg,
  type TonAddress,
  type TonKey,
} from "./ton-cell";

/**
 * TON (Toncoin + jettons) for the wallet: W5 accounts of the mnemonic (ton-cell.ts), reads and sendBoc through a
 * toncenter-v2-style node (our relay /api/ton by default), transfers built and signed here. Private-key wallets have
 * no TON account (the key is secp256k1; TON needs ed25519), like Solana.
 */

export { NANO, isTonAddress, sameTonAddress, friendlyTon, type TonKey } from "./ton-cell";
export const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
/** Value sent along with a jetton transfer to pay the jetton wallets' gas; what is left comes back (excesses). */
export const JETTON_ATTACH = 50_000_000n;
/** Wallet-side fee when the node cannot estimate (W5 transfer ≈ 0.003, first one also deploys the wallet) */
const FALLBACK_FEE = 4_000_000n;
const FWD_FEE = 600_000n;

const derived = new Map<string, TonKey>();
export function tonKeyOf(secret: Secret): TonKey | null {
  if (secret.kind !== "mnemonic") return null;
  let k = derived.get(secret.phrase);
  if (!k) {
    k = tonKeyFromMnemonic(secret.phrase);
    derived.set(secret.phrase, k);
  }
  return k;
}
export const tonAddressOf = (secret: Secret) => tonKeyOf(secret)?.address ?? null;

// ---------- node ----------

async function api<T>(method: string, query?: Record<string, string>, body?: unknown): Promise<T> {
  const url = `${rpcOf(TON_CHAIN)}/${method}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error ?? (r.status === 429 ? "TON 节点限流，请稍后再试" : `TON 节点 HTTP ${r.status}`));
  return j.result as T;
}

export type TonAccountState = "active" | "uninitialized" | "frozen";
export async function tonState(address: string): Promise<{ balance: bigint; state: TonAccountState }> {
  const r = await api<{ balance?: string | number; state?: string; code?: string; frozen_hash?: string }>("getAddressInformation", { address });
  const state = (r.state === "active" || r.state === "frozen" ? r.state : r.state ? "uninitialized" : r.code ? "active" : r.frozen_hash ? "frozen" : "uninitialized") as TonAccountState;
  return { balance: BigInt(r.balance ?? 0), state };
}

type StackItem = [string, unknown];
async function runGet(address: string, method: string, stack: StackItem[] = []): Promise<{ exit: number; stack: StackItem[] }> {
  const r = await api<{ exit_code?: number; stack?: StackItem[] }>("runGetMethod", undefined, { address, method, stack });
  return { exit: r.exit_code ?? 0, stack: r.stack ?? [] };
}
const num = (it?: StackItem) => (it && it[0] === "num" && typeof it[1] === "string" ? BigInt(it[1]) : null);
const cellOf = (it?: StackItem) => {
  const v = it?.[1] as { bytes?: string } | string | undefined;
  const b64 = typeof v === "string" ? v : v?.bytes;
  return b64 ? cellFromBase64(b64) : null;
};

/** 0 for a wallet that was never deployed */
export async function seqnoOf(address: string): Promise<number> {
  try {
    const r = await runGet(address, "seqno");
    return r.exit === 0 ? Number(num(r.stack[0]) ?? 0n) : 0;
  } catch {
    return 0;
  }
}

const jwCache = new Map<string, TonAddress>();
/** The owner's jetton wallet for `master` (a getter on the master; never changes, so cached) */
export async function jettonWalletOf(owner: string, master: string): Promise<TonAddress> {
  const o = parseTonAddress(owner);
  if (!o) throw new Error("地址格式不对");
  const key = `${owner}|${master}`;
  const hit = jwCache.get(key);
  if (hit) return hit;
  const arg = bocBase64(beginCell().address(o.addr).end());
  const r = await runGet(master, "get_wallet_address", [["tvm.Slice", arg]]);
  const c = r.exit === 0 ? cellOf(r.stack[0]) : null;
  const a = c?.beginParse().address();
  if (!a) throw new Error("查不到这个代币的钱包地址，可能不是 jetton");
  jwCache.set(key, a);
  return a;
}
export async function jettonBalance(owner: string, master: string): Promise<bigint> {
  const jw = rawOf(await jettonWalletOf(owner, master));
  const r = await runGet(jw, "get_wallet_data");
  if (r.exit === 0) return num(r.stack[0]) ?? 0n;
  // -13 (no code) is normal for a jetton wallet that never received this token; a lagging node says it about live
  // ones too, so make sure before showing 0
  if ((await tonState(jw)).state !== "active") return 0n;
  throw new Error("TON 节点返回的数据不对，请稍后再试");
}
const rawOf = (a: TonAddress) => `${a.wc}:${bytesToHex(a.hash)}`;

export async function tonAccount(owner: string, masters: string[] = []) {
  const [s, bals] = await Promise.all([tonState(owner), Promise.all(masters.map((m) => jettonBalance(owner, m)))]);
  return { ton: s.balance, state: s.state, jettons: Object.fromEntries(masters.map((m, i) => [m, bals[i]])) as Record<string, bigint> };
}

export type TonJettonInfo = { symbol: string; name: string; decimals: number; image: string | null; verified: boolean; priceUsd: number | null; change24h: number | null };
/** names / icons / USD prices from the indexer (tonapi behind it); "ton" is Toncoin's price */
export async function fetchTonJettons(ids: string[]): Promise<Record<string, TonJettonInfo | null>> {
  if (!ids.length) return {};
  const r = await fetch(`${API_BASE}/ton/jettons?ids=${ids.map(encodeURIComponent).join(",")}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** For 添加代币: name / symbol / decimals of a jetton master (null if tonapi does not know it as a jetton) */
export async function tonJettonMeta(master: string): Promise<{ address: string; symbol: string; name: string; decimals: number; image: string | null } | null> {
  const p = parseTonAddress(master);
  if (!p) return null;
  const m = (await fetchTonJettons([master]))[master];
  return m ? { address: formatTonAddress(p.addr, true), symbol: m.symbol, name: m.name, decimals: m.decimals, image: m.image } : null;
}

// ---------- fees ----------

export type TonFee = { nano: bigint; attach: bigint; deploy: boolean; bounce: boolean; destState: TonAccountState | null };

const zeroSig = () => new Uint8Array(64);

/** Builds the order the wallet will sign (same for the estimate, signed with a dummy signature, and the real send) */
async function order(key: Pick<TonKey, "address" | "raw" | "publicKey">, to: string, amount: bigint, o: { jetton?: string; comment?: string; all?: boolean }) {
  const dest = parseTonAddress(to);
  if (!dest) throw new Error("地址格式不对");
  const [me, seqno, destInfo] = await Promise.all([tonState(key.address), seqnoOf(key.address), o.jetton ? Promise.resolve(null) : tonState(to).catch(() => null)]);
  if (me.state === "frozen") throw new Error("这个 TON 钱包被冻结了（长期欠存储费），需要先往里转一点 TON 解冻");
  const comment = o.comment ? commentCell(o.comment) : null;
  let msg: OutMsg;
  let bounce = false;
  if (o.jetton) {
    const jw = await jettonWalletOf(key.address, o.jetton);
    msg = { to: jw, value: JETTON_ATTACH, bounce: true, body: jettonTransferBody({ queryId: BigInt(Date.now()), amount, to: dest.addr, responseTo: key.raw, forwardTon: 1n, comment }) };
  } else {
    // a bounceable message to an account that does not exist yet would come back: only bounce to live contracts
    bounce = dest.bounceable !== false && destInfo?.state === "active";
    msg = { to: dest.addr, value: o.all ? 0n : amount, bounce, body: comment };
  }
  return { msg, seqno, deploy: me.state !== "active", bounce, destState: destInfo?.state ?? null, mode: o.all ? MODE_ALL : MODE_NORMAL };
}

export async function estimateTonFee(key: Pick<TonKey, "address" | "raw" | "publicKey">, to: string, amount: bigint, o: { jetton?: string; comment?: string; all?: boolean } = {}): Promise<TonFee> {
  const p = await order(key, to, amount, o);
  let nano = FALLBACK_FEE;
  try {
    const { body } = w5TransferParts(key, { seqno: p.seqno, validUntil: Math.floor(Date.now() / 1000) + 180, msgs: [p.msg], modes: [p.mode], deploy: p.deploy }, zeroSig);
    const f = await api<{ source_fees?: Record<string, number> }>("estimateFee", undefined, {
      address: key.address,
      body: bocBase64(body),
      init_code: p.deploy ? bocBase64(w5Code()) : "",
      init_data: p.deploy ? bocBase64(w5Data(key.publicKey)) : "",
      ignore_chksig: true,
    });
    const s = f.source_fees ?? {};
    const sum = ["in_fwd_fee", "storage_fee", "gas_fee", "fwd_fee"].reduce((t, k) => t + BigInt(Math.max(0, Math.round(Number(s[k] ?? 0)))), 0n);
    // the node's estimate leaves out the forward fee of the outgoing message (action phase)
    if (sum > 0n) nano = sum + FWD_FEE;
  } catch {}
  return { nano, attach: o.jetton ? JETTON_ATTACH : 0n, deploy: p.deploy, bounce: p.bounce, destState: p.destState };
}

// ---------- sending ----------

export type TonSent = { boc: string; bodyHash: string; validUntil: number };

export async function sendTon(key: TonKey, to: string, amount: bigint, o: { jetton?: string; comment?: string; all?: boolean } = {}): Promise<TonSent> {
  const p = await order(key, to, amount, o);
  const validUntil = Math.floor(Date.now() / 1000) + 180;
  const { ext, body } = w5TransferParts(key, { seqno: p.seqno, validUntil, msgs: [p.msg], modes: [p.mode], deploy: p.deploy }, signerOf(key));
  const boc = bocBase64(ext);
  try {
    await api("sendBoc", undefined, { boc });
  } catch (e) {
    const m = (e as Error).message;
    throw new Error(/balance|not enough|insufficient/i.test(m) ? "余额不足（含网络费）" : `发送失败：${m}`);
  }
  return { boc, bodyHash: base64.encode(body.hash()), validUntil };
}

type V2Tx = { transaction_id?: { hash?: string }; in_msg?: { source?: string; body_hash?: string }; out_msgs?: unknown[] };

/**
 * Waits for the wallet's transaction carrying our signed body; returns its hash (hex — what explorers, tonapi and the
 * chat transfer check use). The same message is re-sent every ~9 s until then (the seqno makes repeats harmless).
 */
export async function waitTon(address: string, sent: TonSent, timeoutMs = 120_000): Promise<string> {
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    const txs = await api<V2Tx[]>("getTransactions", { address, limit: "10" }).catch(() => [] as V2Tx[]);
    const tx = txs.find((t) => !t.in_msg?.source && t.in_msg?.body_hash === sent.bodyHash);
    if (tx?.transaction_id?.hash) {
      if (!tx.out_msgs?.length) throw new Error("交易上链了，但钱包没有转出（TON 不够付网络费），钱没有转走");
      return bytesToHex(base64.decode(tx.transaction_id.hash));
    }
    if (Date.now() / 1000 > sent.validUntil + 15) throw new Error("交易过期了没有上链，钱没有扣，可以重新发");
    if (Date.now() - t0 > timeoutMs) throw new Error("等了很久还没确认，可以稍后在 Tonviewer 里查这个钱包");
    if (i % 3 === 0) void api("sendBoc", undefined, { boc: sent.boc }).catch(() => {});
  }
}

/** ed25519 over the UTF-8 text; the backend needs the public key to check it and to rebuild the W5 address */
export const signTonText = (key: TonKey, text: string) => `${bytesToHex(key.publicKey)}:${base64.encode(ed25519.sign(new TextEncoder().encode(text), key.seed))}`;

export const tonOf = (nano: bigint, max = 6) => (Number(nano) / NANO).toLocaleString("en-US", { maximumFractionDigits: max });

const MAINNET_ZEROSTATE = "F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=";
export async function probeTonNode(url: string, timeoutMs = 6000): Promise<{ ms: number; block?: number; mainnet?: boolean; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(`${url}/getMasterchainInfo`, { signal: ac.signal });
    const j = (await r.json()) as { result?: { last?: { seqno?: number }; init?: { root_hash?: string } } };
    return { ms: Math.round(performance.now() - t0), block: j.result?.last?.seqno, mainnet: j.result?.init?.root_hash === MAINNET_ZEROSTATE };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: ac.signal.aborted ? "超时" : (e as Error).message || "连不上" };
  } finally {
    clearTimeout(timer);
  }
}
