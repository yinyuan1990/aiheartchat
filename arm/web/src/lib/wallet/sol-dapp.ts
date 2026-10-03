import { formatUnits } from "viem";
import { fetchSolTokens } from "./assets";
import type { Line, Risk } from "./dapp-decode";
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  LAMPORTS,
  SIGNATURE_FEE,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  b58,
  b64,
  explainSolError,
  getTokenAccounts,
  sendAndConfirm,
  signBytes,
  solRpc,
  type SolKeypair,
} from "./sol";

/**
 * Solana requests from DApp pages (Wallet Standard, see the provider script in the App shells): strict parsing of the
 * transactions a site hands us, a plain-language summary that flags account-takeover instructions, a simulation of
 * the wallet's balance changes, then signing / sending.
 */

export type SolMessage = {
  versioned: boolean;
  /** numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned */
  header: [number, number, number];
  keys: string[];
  blockhash: string;
  ixs: { program: string; accounts: number[]; data: Uint8Array }[];
  /** accounts pulled in from address lookup tables (v0 only) */
  loaded: number;
};
export type SolWireTx = { bytes: Uint8Array; sigCount: number; sigStart: number; messageStart: number; msg: SolMessage };

function cu16(b: Uint8Array, at: number): [number, number] | null {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    if (at + i >= b.length) return null;
    n |= (b[at + i] & 0x7f) << (7 * i);
    if (!(b[at + i] & 0x80)) return [n, at + i + 1];
  }
  return null;
}

/** null unless `m` is exactly one legacy / v0 message. */
export function parseMessage(m: Uint8Array): SolMessage | null {
  let p = 0;
  const versioned = (m[0] & 0x80) !== 0;
  if (versioned) {
    if ((m[0] & 0x7f) !== 0) return null;
    p = 1;
  }
  if (p + 3 > m.length) return null;
  const header: [number, number, number] = [m[p], m[p + 1], m[p + 2]];
  p += 3;
  let r = cu16(m, p);
  if (!r) return null;
  const [nKeys] = r;
  p = r[1];
  if (nKeys === 0 || header[0] === 0 || header[0] > nKeys || header[1] >= header[0] || header[2] > nKeys - header[0] || p + nKeys * 32 + 32 > m.length) return null;
  const keys: string[] = [];
  for (let i = 0; i < nKeys; i++, p += 32) keys.push(b58.encode(m.subarray(p, p + 32)));
  const blockhash = b58.encode(m.subarray(p, p + 32));
  p += 32;
  r = cu16(m, p);
  if (!r) return null;
  const ixs: SolMessage["ixs"] = [];
  p = r[1];
  for (let n = r[0]; n > 0; n--) {
    if (p >= m.length) return null;
    const pi = m[p++];
    if (pi >= nKeys) return null;
    const na = cu16(m, p);
    if (!na || na[1] + na[0] > m.length) return null;
    const accounts = [...m.subarray(na[1], na[1] + na[0])];
    p = na[1] + na[0];
    const nd = cu16(m, p);
    if (!nd || nd[1] + nd[0] > m.length) return null;
    ixs.push({ program: keys[pi], accounts, data: m.slice(nd[1], nd[1] + nd[0]) });
    p = nd[1] + nd[0];
  }
  let loaded = 0;
  if (versioned) {
    r = cu16(m, p);
    if (!r) return null;
    p = r[1];
    for (let n = r[0]; n > 0; n--) {
      p += 32;
      for (let k = 0; k < 2; k++) {
        const c = cu16(m, p);
        if (!c || c[1] + c[0] > m.length) return null;
        loaded += c[0];
        p = c[1] + c[0];
      }
    }
  }
  if (p !== m.length) return null;
  const total = nKeys + loaded;
  if (ixs.some((i) => i.accounts.some((a) => a >= total))) return null;
  return { versioned, header, keys, blockhash, ixs, loaded };
}

export function parseWireTx(bytes: Uint8Array): SolWireTx | null {
  const r = cu16(bytes, 0);
  if (!r) return null;
  const [sigCount, sigStart] = r;
  const messageStart = sigStart + sigCount * 64;
  if (messageStart >= bytes.length) return null;
  const msg = parseMessage(bytes.subarray(messageStart));
  if (!msg || msg.header[0] !== sigCount) return null;
  return { bytes, sigCount, sigStart, messageStart, msg };
}

/** A "message" that is really a transaction would let the site broadcast it with our signature. */
export const looksLikeTransaction = (b: Uint8Array) => b.length > 64 && (parseMessage(b) !== null || parseWireTx(b) !== null);

export const signerSlot = (tx: SolWireTx, address: string) => {
  const i = tx.msg.keys.indexOf(address);
  return i >= 0 && i < tx.msg.header[0] ? i : -1;
};

export function signWire(tx: SolWireTx, kp: SolKeypair): { bytes: Uint8Array; signature: Uint8Array } {
  const slot = signerSlot(tx, kp.address);
  if (slot < 0) throw new Error("这笔交易不需要当前钱包签名");
  const signature = signBytes(tx.bytes.subarray(tx.messageStart), kp);
  const out = tx.bytes.slice();
  out.set(signature, tx.sigStart + slot * 64);
  return { bytes: out, signature };
}

// ---------- plain-language summary ----------

const PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: "系统程序",
  [TOKEN_PROGRAM]: "代币程序",
  [TOKEN_2022_PROGRAM]: "代币程序 2022",
  [ATA_PROGRAM]: "代币账户",
  [COMPUTE_BUDGET_PROGRAM]: "网络费设置",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "备注",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "备注",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex",
};
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const programName = (p: string) => PROGRAMS[p] ?? short(p);
const fmtSol = (lamports: number) => {
  const n = lamports / LAMPORTS;
  return `${n !== 0 && Math.abs(n) < 0.000001 ? n.toExponential(2) : n.toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL`;
};
const u32At = (d: Uint8Array, at: number) => (d.length >= at + 4 ? new DataView(d.buffer, d.byteOffset + at, 4).getUint32(0, true) : -1);
const u64At = (d: Uint8Array, at: number) => (d.length >= at + 8 ? new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true) : null);
const U64_MAX = 2n ** 64n - 1n;
const RANK: Record<Risk, number> = { none: 0, warn: 1, danger: 2 };

export type SolTxView = { lines: Line[]; notes: string[]; risk: Risk; feeLamports: number; programs: string[] };

export function describeSolTx(tx: SolWireTx, me: string): SolTxView {
  const { msg } = tx;
  const keyOf = (i: number) => msg.keys[i];
  let risk: Risk = "none";
  const bump = (r: Risk) => {
    if (RANK[r] > RANK[risk]) risk = r;
  };
  const notes: string[] = [];
  const lines: Line[] = [];
  const outs = new Map<string, number>();
  let cuLimit = -1;
  let cuPrice = 0n;
  let work = 0;

  for (let n = 0; n < msg.ixs.length; n++) {
    const ix = msg.ixs[n];
    const acc = (i: number) => (ix.accounts[i] != null ? keyOf(ix.accounts[i]) : undefined);
    const d = ix.data;
    if (ix.program === COMPUTE_BUDGET_PROGRAM) {
      if (d[0] === 2) cuLimit = u32At(d, 1);
      if (d[0] === 3) cuPrice = u64At(d, 1) ?? 0n;
      continue;
    }
    work++;
    if (ix.program === SYSTEM_PROGRAM) {
      const op = u32At(d, 0);
      if (op === 2 && acc(0) === me) {
        const to = acc(1) ?? "?";
        outs.set(to, (outs.get(to) ?? 0) + Number(u64At(d, 4) ?? 0n));
      } else if (op === 1 && acc(0) === me) {
        bump("danger");
        notes.push("这笔交易会把你的钱包账户交给别的程序管理，签了以后账户里的 SOL 可能被转走。正常的 DApp 不会这样做。");
      } else if (op === 4 && n === 0) {
        bump("warn");
        notes.push("这笔交易用的是长期有效的 nonce：签名后对方可以在任何时候再把它发出去，不会过期。");
      }
      continue;
    }
    if (ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) {
      const op = d[0];
      if ((op === 4 || op === 13) && acc(op === 4 ? 2 : 3) === me) {
        const amount = u64At(d, 1);
        const delegate = acc(op === 4 ? 1 : 2) ?? "?";
        bump(amount === U64_MAX ? "danger" : "warn");
        notes.push(`授权 ${short(delegate)} 动用你的代币${amount === U64_MAX ? "（数量不限）" : ""}。只在你信任这个网站时确认。`);
      } else if (op === 6 && acc(1) === me) {
        bump("danger");
        notes.push("这笔交易会把你的代币账户（或代币）的控制权交给别人。这是常见的盗币手法。");
      } else if (op === 9 && acc(2) === me && acc(1) !== me) {
        bump("warn");
        notes.push(`关闭你的一个代币账户，里面的租金退到 ${short(acc(1) ?? "?")}，不是退给你。`);
      }
    }
  }

  for (const [to, lamports] of outs) lines.push({ label: "转出 SOL", value: `${fmtSol(lamports)} → ${short(to)}`, mono: true, tone: "down" });
  const programs = [...new Set(msg.ixs.map((i) => i.program).filter((p) => p !== COMPUTE_BUDGET_PROGRAM))];
  lines.push({ label: "调用程序", value: programs.map(programName).join("、") || "—" });
  const unknown = programs.filter((p) => !PROGRAMS[p]);
  if (unknown.length) {
    bump("warn");
    notes.push(`调用了不认识的程序 ${unknown.map(short).join("、")}，看不出具体做什么，请以下面的余额变化为准。`);
  }
  if (msg.keys[0] !== me) notes.push("网络费由对方支付。");

  const limit = cuLimit >= 0 ? cuLimit : Math.min(1_400_000, 200_000 * Math.max(1, work));
  const feeLamports = msg.header[0] * SIGNATURE_FEE + Math.ceil((limit * Number(cuPrice)) / 1_000_000);
  return { lines, notes, risk, feeLamports: msg.keys[0] === me ? feeLamports : 0, programs };
}

// ---------- simulation ----------

export type SolChange = { mint: string; symbol: string; delta: number };
export type SolSim = { error?: string; changes: SolChange[] };

/** What the wallet's SOL and token balances would become; only accounts named in the transaction (or our own) can be watched. */
export async function simulateChanges(url: string, tx: SolWireTx, me: string): Promise<SolSim> {
  const { msg } = tx;
  const [bal, mine] = await Promise.all([solRpc<{ value: number }>(url, "getBalance", [me, { commitment: "confirmed" }]), getTokenAccounts(url, me).catch(() => [])]);
  const budget = msg.keys.length + msg.loaded;
  const writable = (i: number) => (i < msg.header[0] ? i < msg.header[0] - msg.header[1] : i < msg.keys.length - msg.header[2]);
  const watch = [me];
  const add = (a: string) => watch.length < budget && !watch.includes(a) && watch.push(a);
  msg.keys.forEach((k, i) => writable(i) && add(k));
  mine.forEach((a) => add(a.pubkey));

  type Acct = { lamports: number; owner: string; data: [string, string] } | null;
  const r = await solRpc<{ value: { err: unknown; logs: string[] | null; accounts: Acct[] | null } }>(url, "simulateTransaction", [
    b64.encode(tx.bytes),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch } },
  ]);
  if (r.value.err) return { error: explainSolError(r.value.err, r.value.logs ?? []), changes: [] };

  const pre = new Map(mine.map((a) => [a.pubkey, a]));
  const deltas = new Map<string, { raw: bigint; decimals?: number }>();
  const lamports = (r.value.accounts?.[0]?.lamports ?? bal.value) - bal.value;
  r.value.accounts?.forEach((a, i) => {
    if (i === 0) return;
    const addr = watch[i];
    const before = pre.get(addr);
    let mint: string | undefined;
    let after = 0n;
    if (a && (a.owner === TOKEN_PROGRAM || a.owner === TOKEN_2022_PROGRAM)) {
      const d = b64.decode(a.data[0]);
      if (d.length < 72 || b58.encode(d.subarray(32, 64)) !== me) return;
      mint = b58.encode(d.subarray(0, 32));
      after = u64At(d, 64) ?? 0n;
    } else if (!a && before) mint = before.mint;
    else return;
    const diff = after - (before?.mint === mint ? before.amount : 0n);
    if (diff === 0n) return;
    const cur = deltas.get(mint!) ?? { raw: 0n, decimals: before?.decimals };
    deltas.set(mint!, { raw: cur.raw + diff, decimals: cur.decimals ?? before?.decimals });
  });

  const mints = [...deltas.keys()];
  const info = mints.length ? await fetchSolTokens(mints).catch(() => ({}) as Awaited<ReturnType<typeof fetchSolTokens>>) : {};
  const changes: SolChange[] = [];
  if (lamports !== 0) changes.push({ mint: WSOL_MINT, symbol: "SOL", delta: lamports / LAMPORTS });
  for (const [mint, v] of deltas) {
    const t = info[mint];
    const decimals = v.decimals ?? t?.decimals;
    if (decimals == null) continue;
    changes.push({ mint, symbol: t?.symbol ?? short(mint), delta: Number(formatUnits(v.raw, decimals)) });
  }
  return { changes };
}

// ---------- sending ----------

export type SendOptions = { skipPreflight?: boolean; preflightCommitment?: string; maxRetries?: number; mode?: "parallel" | "serial" };

/**
 * Broadcasts one signed transaction: the first send runs preflight (unless the site turned it off) so obvious failures
 * come back as errors; afterwards it keeps re-broadcasting in the background until confirmed or expired.
 */
export async function broadcast(url: string, bytes: Uint8Array, signature: Uint8Array, opts: SendOptions, wait: boolean): Promise<void> {
  const sig = b58.encode(signature);
  await solRpc<string>(url, "sendTransaction", [
    b64.encode(bytes),
    { encoding: "base64", skipPreflight: !!opts.skipPreflight, preflightCommitment: opts.preflightCommitment ?? "confirmed", maxRetries: 0 },
  ]).catch((e: Error & { logs?: string[] }) => {
    const why = explainSolError(e.message, e.logs ?? []);
    throw new Error(why === e.message ? `发送前检查没通过：${e.message.replace(/^Transaction simulation failed:?\s*/, "") || "交易会失败"}` : why);
  });
  const confirmed = sendAndConfirm(url, bytes, sig);
  if (wait) await confirmed;
  else void confirmed.catch(() => {});
}
