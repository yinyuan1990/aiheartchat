import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import type { Secret } from "./vault";

/**
 * Solana without @solana/web3.js: SLIP-0010 ed25519 keys on Phantom's path, legacy-message transfers we build ourselves,
 * and signing of serialized (legacy or v0) transactions handed to us by Jupiter / DApps.
 */

export const SOL_PATH = "m/44'/501'/0'/0'";
export const LAMPORTS = 1_000_000_000;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** CAIP-2 / Wallet Standard chain id: the genesis hash cut to 32 characters. */
export const SOLANA_MAINNET_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** Rent-exempt minimum of a 165-byte token account, paid once when the recipient has no account for the mint yet. */
export const TOKEN_ACCOUNT_RENT = 2_039_280;
/** Base fee per signature. */
export const SIGNATURE_FEE = 5_000;

export type SolKeypair = { seed: Uint8Array; publicKey: Uint8Array; address: string };

const enc = new TextEncoder();

export function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, enc.encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | 0x80000000) >>> 0, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

export function keypairFromSeed32(seed: Uint8Array): SolKeypair {
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, address: base58.encode(publicKey) };
}

const derived = new Map<string, SolKeypair>();
/** Phantom / Solflare default account of a mnemonic. Private-key (EVM) wallets have no Solana account → null. */
export function solKeypairOf(secret: Secret): SolKeypair | null {
  if (secret.kind !== "mnemonic") return null;
  let kp = derived.get(secret.phrase);
  if (!kp) {
    kp = keypairFromSeed32(slip10(mnemonicToSeedSync(secret.phrase), [44, 501, 0, 0]));
    derived.set(secret.phrase, kp);
  }
  return kp;
}
export const solAddressOf = (secret: Secret) => solKeypairOf(secret)?.address ?? null;

/** Phantom's "export private key" format: base58 of seed ‖ public key. */
export const exportSolKey = (kp: SolKeypair) => base58.encode(new Uint8Array([...kp.seed, ...kp.publicKey]));

export function decodeAddress(s: string): Uint8Array | null {
  try {
    const b = base58.decode(s.trim());
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
export const isSolAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim()) && !!decodeAddress(s);

function isOnCurve(b: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(b);
    return true;
  } catch {
    return false;
  }
}
/** Off-curve addresses belong to programs (PDAs); sending SOL there is almost always a mistake. */
export const isWalletAddress = (s: string) => {
  const b = decodeAddress(s);
  return !!b && isOnCurve(b);
};

function findPda(seeds: Uint8Array[], programId: string): string {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...program, ...enc.encode("ProgramDerivedAddress")]));
    if (!isOnCurve(h)) return base58.encode(h);
  }
  throw new Error("no PDA");
}
export const ataOf = (owner: string, mint: string, tokenProgram = TOKEN_PROGRAM) => findPda([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], ATA_PROGRAM);

// ---------- wire format ----------

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return out;
  }
}
function readCompactU16(b: Uint8Array, at: number): [number, number] {
  let n = 0;
  let shift = 0;
  for (let i = at; ; i++) {
    n |= (b[i] & 0x7f) << shift;
    if (!(b[i] & 0x80)) return [n, i + 1];
    shift += 7;
  }
}
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

export type AccountMeta = { pubkey: string; signer: boolean; writable: boolean };
export type Instruction = { programId: string; keys: AccountMeta[]; data: Uint8Array };

export const ix = {
  computeLimit: (units: number): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Uint8Array([2, ...u32(units)]) }),
  /** micro-lamports per compute unit */
  computePrice: (microLamports: bigint): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: new Uint8Array([3, ...u64(microLamports)]) }),
  transfer: (from: string, to: string, lamports: bigint): Instruction => ({
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, signer: true, writable: true },
      { pubkey: to, signer: false, writable: true },
    ],
    data: new Uint8Array([...u32(2), ...u64(lamports)]),
  }),
  createAtaIdempotent: (payer: string, owner: string, mint: string, tokenProgram: string): Instruction => ({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, signer: true, writable: true },
      { pubkey: ataOf(owner, mint, tokenProgram), signer: false, writable: true },
      { pubkey: owner, signer: false, writable: false },
      { pubkey: mint, signer: false, writable: false },
      { pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
      { pubkey: tokenProgram, signer: false, writable: false },
    ],
    data: new Uint8Array([1]),
  }),
  transferChecked: (source: string, mint: string, dest: string, owner: string, amount: bigint, decimals: number, tokenProgram: string): Instruction => ({
    programId: tokenProgram,
    keys: [
      { pubkey: source, signer: false, writable: true },
      { pubkey: mint, signer: false, writable: false },
      { pubkey: dest, signer: false, writable: true },
      { pubkey: owner, signer: true, writable: false },
    ],
    data: new Uint8Array([12, ...u64(amount), decimals]),
  }),
};

/** Legacy message with `payer` as the only signer. */
export function compileMessage(payer: string, ixs: Instruction[], blockhash: string): Uint8Array {
  const metas = new Map<string, AccountMeta>([[payer, { pubkey: payer, signer: true, writable: true }]]);
  for (const i of ixs) {
    for (const k of i.keys) {
      const m = metas.get(k.pubkey);
      metas.set(k.pubkey, m ? { pubkey: k.pubkey, signer: m.signer || k.signer, writable: m.writable || k.writable } : { ...k });
    }
    if (!metas.has(i.programId)) metas.set(i.programId, { pubkey: i.programId, signer: false, writable: false });
  }
  const rank = (m: AccountMeta) => (m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3);
  const all = [...metas.values()];
  const keys = [all[0], ...all.slice(1).sort((a, b) => rank(a) - rank(b))];
  const signers = keys.filter((k) => k.signer);
  if (signers.length !== 1) throw new Error("only the wallet may sign");
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));
  const out: number[] = [signers.length, signers.filter((k) => !k.writable).length, keys.filter((k) => !k.signer && !k.writable).length];
  out.push(...compactU16(keys.length));
  for (const k of keys) out.push(...base58.decode(k.pubkey));
  out.push(...base58.decode(blockhash));
  out.push(...compactU16(ixs.length));
  for (const i of ixs) {
    out.push(index.get(i.programId)!);
    out.push(...compactU16(i.keys.length), ...i.keys.map((k) => index.get(k.pubkey)!));
    out.push(...compactU16(i.data.length), ...i.data);
  }
  return new Uint8Array(out);
}

/** Zero signature: enough for simulateTransaction with sigVerify off, no key needed. */
export const unsignedTx = (message: Uint8Array) => new Uint8Array([...compactU16(1), ...new Uint8Array(64), ...message]);

/** Lamports a system account must keep (or be emptied to 0). */
export const RENT_EXEMPT_MIN = 890_880;

export function signMessageTx(message: Uint8Array, kp: SolKeypair): { tx: Uint8Array; signature: string } {
  const sig = ed25519.sign(message, kp.seed);
  return { tx: new Uint8Array([...compactU16(1), ...sig, ...message]), signature: base58.encode(sig) };
}

export type ParsedTx = { sigCount: number; sigStart: number; messageStart: number; signers: string[]; versioned: boolean };
export function parseTx(tx: Uint8Array): ParsedTx {
  const [sigCount, sigStart] = readCompactU16(tx, 0);
  const messageStart = sigStart + sigCount * 64;
  let p = messageStart;
  const versioned = (tx[p] & 0x80) !== 0;
  if (versioned) p++;
  const required = tx[p];
  p += 3;
  const [nKeys, keysAt] = readCompactU16(tx, p);
  const signers: string[] = [];
  for (let i = 0; i < Math.min(required, nKeys); i++) signers.push(base58.encode(tx.slice(keysAt + i * 32, keysAt + (i + 1) * 32)));
  return { sigCount, sigStart, messageStart, signers, versioned };
}

/** Adds our signature to a serialized transaction someone else built; other signature slots are left as they are. */
export function signSerialized(tx: Uint8Array, kp: SolKeypair): { tx: Uint8Array; signature: string } {
  const p = parseTx(tx);
  const slot = p.signers.indexOf(kp.address);
  if (slot < 0 || slot >= p.sigCount) throw new Error("这笔交易不需要当前钱包签名");
  const sig = ed25519.sign(tx.slice(p.messageStart), kp.seed);
  const out = tx.slice();
  out.set(sig, p.sigStart + slot * 64);
  return { tx: out, signature: base58.encode(sig) };
}

export const signBytes = (msg: Uint8Array, kp: SolKeypair) => ed25519.sign(msg, kp.seed);
export const b64 = base64;
export const b58 = base58;

// ---------- RPC ----------

export class SolRpcError extends Error {
  constructor(message: string, readonly logs?: string[]) {
    super(message);
  }
}

export async function solRpc<T>(url: string, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
  if (!r.ok) throw new SolRpcError(r.status === 429 ? "节点限流，请稍后再试或换个节点" : `节点 HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string; data?: { logs?: string[] } } };
  if (j.error) throw new SolRpcError(j.error.message ?? "节点出错", j.error.data?.logs);
  return j.result as T;
}

export type TokenAccount = { pubkey: string; mint: string; amount: bigint; decimals: number; program: string };

export async function getTokenAccounts(url: string, owner: string): Promise<TokenAccount[]> {
  type R = { value: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] };
  const lists = await Promise.all(
    [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((program) =>
      solRpc<R>(url, "getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]).then((r) =>
        r.value.map((v) => ({ pubkey: v.pubkey, mint: v.account.data.parsed.info.mint, amount: BigInt(v.account.data.parsed.info.tokenAmount.amount), decimals: v.account.data.parsed.info.tokenAmount.decimals, program })),
      ),
    ),
  );
  return lists.flat();
}

export async function accountExists(url: string, address: string): Promise<boolean> {
  const r = await solRpc<{ value: unknown | null }>(url, "getAccountInfo", [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]);
  return r.value != null;
}

export async function latestBlockhash(url: string) {
  const r = await solRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  return r.value;
}

/** Recent priority fees (µlamports / CU) paid by transactions touching `accounts`, low → high percentiles. */
export async function priorityFees(url: string, accounts: string[]): Promise<{ low: bigint; mid: bigint; high: bigint }> {
  const r = await solRpc<{ prioritizationFee: number }[]>(url, "getRecentPrioritizationFees", [accounts.slice(0, 128)]);
  const v = r.map((x) => x.prioritizationFee).sort((a, b) => a - b);
  const pick = (q: number) => BigInt(v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0);
  const floor = (x: bigint, min: bigint) => (x < min ? min : x);
  return { low: floor(pick(0.25), 1_000n), mid: floor(pick(0.5), 10_000n), high: floor(pick(0.85), 100_000n) };
}

export async function simulate(url: string, tx: Uint8Array): Promise<{ units: number; err: unknown; logs: string[] }> {
  const r = await solRpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>(url, "simulateTransaction", [
    base64.encode(tx),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  return { units: r.value.unitsConsumed ?? 0, err: r.value.err, logs: r.value.logs ?? [] };
}

/** Readable reason for a failed simulation / send. */
export function explainSolError(err: unknown, logs: string[] = []): string {
  const s = JSON.stringify(err ?? "");
  const log = logs.join("\n");
  if (/insufficient lamports|InsufficientFundsForRent|"Custom":1\b/.test(s + log)) return "SOL 不够（转账金额 + 网络费 + 可能的开户租金）";
  if (/InsufficientFunds|insufficient funds/i.test(s + log)) return "余额不足";
  if (/BlockhashNotFound/.test(s)) return "交易过期了，请重试";
  if (/SlippageToleranceExceeded|0x1771|Slippage/i.test(s + log)) return "价格变动超过滑点，请调大滑点或重试";
  if (/AccountNotFound/.test(s)) return "钱包里还没有 SOL，先转入一点 SOL 付网络费";
  return typeof err === "string" ? err : s.slice(0, 160);
}

/**
 * Sends a signed transaction and waits until it is confirmed, re-broadcasting every 2 s (public nodes drop
 * transactions under load). Resolves the signature; rejects with a readable message.
 */
export async function sendAndConfirm(url: string, tx: Uint8Array, signature: string, lastValidBlockHeight?: number, timeoutMs = 75_000): Promise<string> {
  const wire = base64.encode(tx);
  const send = () => solRpc<string>(url, "sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  await send();
  const t0 = Date.now();
  let lastSend = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));
    const st = await solRpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(url, "getSignatureStatuses", [[signature]]).catch(() => null);
    const s = st?.value[0];
    if (s?.err) throw new SolRpcError(explainSolError(s.err));
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return signature;
    if (Date.now() - t0 > timeoutMs) throw new SolRpcError("等了很久还没确认，可能网络拥堵；可以稍后在浏览器里查这笔交易");
    if (lastValidBlockHeight && !s) {
      const h = await solRpc<number>(url, "getBlockHeight", [{ commitment: "confirmed" }]).catch(() => 0);
      if (h > lastValidBlockHeight) throw new SolRpcError("交易过期没有上链（网络拥堵），钱没有扣，请重试");
    }
    if (Date.now() - lastSend > 2000) {
      lastSend = Date.now();
      void send().catch(() => {});
    }
  }
}

export async function probeSolNode(url: string, timeoutMs = 6000): Promise<{ ms: number; slot?: number; mainnet?: boolean; error?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const slot = await solRpc<number>(url, "getSlot", [{ commitment: "confirmed" }], ac.signal);
    const ms = Math.round(performance.now() - t0);
    const genesis = await solRpc<string>(url, "getGenesisHash", [], ac.signal);
    return { ms, slot, mainnet: genesis === MAINNET_GENESIS };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: ac.signal.aborted ? "超时" : (e as Error).message || "连不上" };
  } finally {
    clearTimeout(timer);
  }
}
