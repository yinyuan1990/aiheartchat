import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { encodeFunctionData, erc20Abi, type LocalAccount } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { TRON_CHAIN, rpcOf } from "./chains";
import type { Secret } from "./vault";

/**
 * TRON (TRX + TRC20) without TronWeb: keys on TronLink's path m/44'/195'/0'/0/0 (a private-key wallet uses its key
 * as is: same curve), base58check addresses, transactions encoded here in protobuf and signed locally — the relay
 * (indexer /api/trx/*, TronGrid behind it) only reads chain state and broadcasts bytes we built, so it cannot change
 * the recipient or the amount.
 */

export const TRX_PATH = "m/44'/195'/0'/0/0";
export const SUN = 1_000_000;
export const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ---------- addresses ----------

const checksum = (b: Uint8Array) => sha256(sha256(b)).slice(0, 4);
/** 21-byte 0x41-prefixed form → base58check "T…" */
export const toBase58 = (raw21: Uint8Array) => base58.encode(new Uint8Array([...raw21, ...checksum(raw21)]));
/** "T…" → 21 bytes (0x41 ‖ 20-byte account id); null when malformed */
export function fromBase58(addr: string): Uint8Array | null {
  try {
    const b = base58.decode(addr.trim());
    if (b.length !== 25 || b[0] !== 0x41) return null;
    const raw = b.slice(0, 21);
    const sum = checksum(raw);
    return sum.every((x, i) => x === b[21 + i]) ? raw : null;
  } catch {
    return null;
  }
}
export const isTronAddress = (s: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s.trim()) && !!fromBase58(s);
/** The EVM-style 0x address with the same 20-byte id (TRON keys sign EVM messages too) */
export const tronToEvmHex = (addr: string) => `0x${bytesToHex(fromBase58(addr)!.slice(1))}` as const;
export const evmHexToTron = (hex: string) => toBase58(new Uint8Array([0x41, ...hexToBytes(hex.replace(/^0x/, ""))]));

export type TronKey = { priv: Uint8Array; address: string; account: LocalAccount };

const derived = new Map<string, TronKey>();
export function tronKeyOf(secret: Secret): TronKey {
  const id = secret.kind === "mnemonic" ? secret.phrase : secret.key;
  const hit = derived.get(id);
  if (hit) return hit;
  let priv: Uint8Array;
  let account: LocalAccount;
  if (secret.kind === "mnemonic") {
    // viem types the path as Ethereum's but derives any BIP-44 path
    const a = mnemonicToAccount(secret.phrase, { path: TRX_PATH as `m/44'/60'/${string}` });
    priv = a.getHdKey().privateKey!;
    account = a;
  } else {
    priv = hexToBytes(secret.key.slice(2));
    account = privateKeyToAccount(secret.key);
  }
  const pub = secp256k1.getPublicKey(priv, false);
  const address = toBase58(new Uint8Array([0x41, ...keccak_256(pub.slice(1)).slice(-20)]));
  const k = { priv, address, account };
  derived.set(id, k);
  return k;
}
export const tronAddressOf = (secret: Secret) => tronKeyOf(secret).address;

// ---------- relay ----------

export async function trx<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${rpcOf(TRON_CHAIN)}/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { Error?: string; error?: string };
  if (!r.ok) throw new Error(j.error ?? j.Error ?? (r.status === 429 ? "波场节点限流，请稍后再试" : `波场节点 HTTP ${r.status}`));
  return j;
}

export type TronAccount = { trx: bigint; trc20: Record<string, bigint>; exists: boolean };
/** TRX balance (full-node getaccount: `{}` for an address never activated) and the balances of `tokens` */
export async function tronAccount(address: string, tokens: string[] = []): Promise<TronAccount> {
  const [a, bals] = await Promise.all([trx<{ address?: string; balance?: number }>("wallet/getaccount", { address, visible: true }), Promise.all(tokens.map((t) => trc20Balance(address, t)))]);
  return { trx: BigInt(a.balance ?? 0), trc20: Object.fromEntries(tokens.map((t, i) => [t, bals[i]])), exists: !!a.address };
}

/** Constant (read-only) call of a TRC20; returns the 32-byte words as hex */
async function constantCall(owner: string, contract: string, data: `0x${string}`) {
  const j = await trx<{ constant_result?: string[]; energy_used?: number; result?: { result?: boolean; message?: string } }>("wallet/triggerconstantcontract", {
    owner_address: owner,
    contract_address: contract,
    function_selector: "",
    data: data.slice(2),
    visible: true,
  });
  return j;
}

export async function trc20Balance(owner: string, contract: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [tronToEvmHex(owner)] });
  const j = await constantCall(owner, contract, data);
  return j.constant_result?.[0] ? BigInt(`0x${j.constant_result[0]}`) : 0n;
}

export async function trc20Meta(contract: string): Promise<{ symbol: string; name: string; decimals: number } | null> {
  const owner = contract;
  const read = async (fn: "symbol" | "name" | "decimals") => (await constantCall(owner, contract, encodeFunctionData({ abi: erc20Abi, functionName: fn }))).constant_result?.[0];
  try {
    const [s, n, d] = await Promise.all([read("symbol"), read("name"), read("decimals")]);
    if (!s || !d) return null;
    const str = (hex: string) => {
      const b = hexToBytes(hex);
      const len = Number(BigInt(`0x${bytesToHex(b.slice(32, 64))}`));
      return new TextDecoder().decode(b.slice(64, 64 + len));
    };
    return { symbol: str(s), name: n ? str(n) : str(s), decimals: Number(BigInt(`0x${d}`)) };
  } catch {
    return null;
  }
}

// ---------- protobuf (just the fields these two transactions need) ----------

const varint = (n: bigint) => {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const field = (no: number, wire: 0 | 2, v: bigint | Uint8Array) =>
  wire === 0 ? [...varint(BigInt((no << 3) | 0)), ...varint(v as bigint)] : [...varint(BigInt((no << 3) | 2)), ...varint(BigInt((v as Uint8Array).length)), ...(v as Uint8Array)];
const msg = (...parts: number[][]) => new Uint8Array(parts.flat());

type Block = { refBytes: Uint8Array; refHash: Uint8Array; timestamp: number };
async function latestBlock(): Promise<Block> {
  const b = await trx<{ blockID: string; block_header: { raw_data: { number: number; timestamp: number } } }>("wallet/getnowblock", {});
  const num = BigInt(b.block_header.raw_data.number);
  const nb = new Uint8Array(8);
  new DataView(nb.buffer).setBigUint64(0, num, false);
  return { refBytes: nb.slice(6, 8), refHash: hexToBytes(b.blockID).slice(8, 16), timestamp: b.block_header.raw_data.timestamp };
}

function rawTx(block: Block, contract: Uint8Array, feeLimit?: bigint) {
  const now = BigInt(Date.now());
  return msg(
    field(1, 2, block.refBytes),
    field(4, 2, block.refHash),
    field(8, 0, now + 10n * 60_000n),
    field(11, 2, contract),
    field(14, 0, now),
    ...(feeLimit ? [field(18, 0, feeLimit)] : []),
  );
}
const contractOf = (type: number, typeName: string, value: Uint8Array) =>
  msg(field(1, 0, BigInt(type)), field(2, 2, msg(field(1, 2, new TextEncoder().encode(`type.googleapis.com/protocol.${typeName}`)), field(2, 2, value))));

export function transferTrxRaw(block: Block, from: string, to: string, sun: bigint) {
  return rawTx(block, contractOf(1, "TransferContract", msg(field(1, 2, fromBase58(from)!), field(2, 2, fromBase58(to)!), field(3, 0, sun))));
}
export function transferTrc20Raw(block: Block, from: string, token: string, to: string, amount: bigint, feeLimit: bigint) {
  const data = hexToBytes(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [tronToEvmHex(to), amount] }).slice(2));
  return rawTx(block, contractOf(31, "TriggerSmartContract", msg(field(1, 2, fromBase58(from)!), field(2, 2, fromBase58(token)!), field(4, 2, data))), feeLimit);
}

/** Signs raw_data; returns the txID and the full Transaction bytes ready for broadcasthex */
export function signTron(raw: Uint8Array, key: TronKey) {
  const id = sha256(raw);
  const sig = secp256k1.sign(id, key.priv);
  const signature = new Uint8Array([...sig.toCompactRawBytes(), sig.recovery + 27]);
  return { txid: bytesToHex(id), tx: msg(field(1, 2, raw), field(2, 2, signature)) };
}

// ---------- fees ----------

type Resources = { freeNetLimit?: number; freeNetUsed?: number; NetLimit?: number; NetUsed?: number; EnergyLimit?: number; EnergyUsed?: number };
type ChainParams = { chainParameter: { key: string; value?: number }[] };
let params: { at: number; energySun: number; bandwidthSun: number; createAccountSun: number } | null = null;
async function chainParams() {
  if (params && Date.now() - params.at < 600_000) return params;
  const j = await trx<ChainParams>("wallet/getchainparameters", {});
  const get = (k: string, d: number) => j.chainParameter.find((p) => p.key === k)?.value ?? d;
  params = { at: Date.now(), energySun: get("getEnergyFee", 210), bandwidthSun: get("getTransactionFee", 1000), createAccountSun: get("getCreateNewAccountFeeInSystemContract", 1_000_000) + get("getCreateAccountFee", 100_000) };
  return params;
}

/** `worstCase`: the dry run could not run (e.g. amount above the balance), energy is the upper bound */
export type TronFee = { sun: bigint; energy: number; worstCase: boolean; bandwidthFree: boolean; newAccount: boolean; feeLimit: bigint };

/** What sending will burn: bandwidth (free 600/day per account), energy for TRC20, and the fee to activate a new address. */
export async function estimateTronFee(from: string, to: string, token?: string, amount = 1n): Promise<TronFee> {
  const [p, res, dest] = await Promise.all([chainParams(), trx<Resources>("wallet/getaccountresource", { address: from, visible: true }), tronAccount(to).catch(() => null)]);
  const bytes = token ? 350 : 270;
  const freeLeft = (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0) + (res.NetLimit ?? 0) - (res.NetUsed ?? 0);
  const bandwidthFree = freeLeft >= bytes;
  let sun = bandwidthFree ? 0n : BigInt(bytes * p.bandwidthSun);
  let energy = 0;
  let worstCase = false;
  const newAccount = !token && dest !== null && !dest.exists;
  if (newAccount) sun += BigInt(p.createAccountSun);
  if (token) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [tronToEvmHex(to), amount] });
    // a dry run that reverts (sender holds less than `amount` yet) stops early: assume a recipient without a balance
    const used = (await constantCall(from, token, data).catch(() => null))?.energy_used ?? 0;
    worstCase = used < 20_000;
    energy = worstCase ? 131_000 : used;
    const own = Math.max(0, (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0));
    sun += BigInt(Math.max(0, energy - own) * p.energySun);
  }
  // fee_limit caps what a TRC20 call may burn: a margin over the estimate, at most 150 TRX
  const feeLimit = token ? BigInt(Math.min(150 * SUN, Math.max(30 * SUN, Number(sun) * 2))) : 0n;
  return { sun, energy, worstCase, bandwidthFree, newAccount, feeLimit };
}

// ---------- sending ----------

export async function sendTron(key: TronKey, to: string, sun: bigint, token?: { address: string; amount: bigint }, feeLimit = 100n * BigInt(SUN)): Promise<string> {
  const block = await latestBlock();
  const raw = token ? transferTrc20Raw(block, key.address, token.address, to, token.amount, feeLimit) : transferTrxRaw(block, key.address, to, sun);
  const { txid, tx } = signTron(raw, key);
  const r = await trx<{ result?: boolean; code?: string; message?: string }>("wallet/broadcasthex", { transaction: bytesToHex(tx) });
  if (!r.result) {
    const m = r.message ? (/^[0-9a-f]+$/i.test(r.message) ? new TextDecoder().decode(hexToBytes(r.message)) : r.message) : r.code;
    throw new Error(/balance is not sufficient|insufficient/i.test(m ?? "") ? "余额不足（含网络费）" : `广播失败：${m ?? "未知原因"}`);
  }
  return txid;
}

/** Waits until the transaction is in a block; rejects when it failed on chain (TRC20 out of energy / reverted). */
export async function waitTron(txid: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3_000));
    const info = await trx<{ id?: string; receipt?: { result?: string }; result?: string; resMessage?: string }>("wallet/gettransactioninfobyid", { value: txid }).catch(() => ({}) as { id?: string });
    if (info.id) {
      const res = (info as { receipt?: { result?: string } }).receipt?.result;
      if ((info as { result?: string }).result === "FAILED" || (res && res !== "SUCCESS")) throw new Error(res === "OUT_OF_ENERGY" ? "能量不够，交易失败（网络费已扣）" : "交易在链上失败了");
      return;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("等了很久还没确认，可以稍后在波场浏览器里查这笔交易");
  }
}

export async function probeTronNode(url: string, timeoutMs = 6000): Promise<{ ms: number; block?: number; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(`${url}/wallet/getnowblock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: ac.signal });
    const j = (await r.json()) as { block_header?: { raw_data?: { number?: number } } };
    return { ms: Math.round(performance.now() - t0), block: j.block_header?.raw_data?.number };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: ac.signal.aborted ? "超时" : (e as Error).message || "连不上" };
  } finally {
    clearTimeout(timer);
  }
}
