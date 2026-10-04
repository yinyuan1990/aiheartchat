import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { slip10 } from "./sol";

/**
 * TON without @ton/core (it needs Buffer): ordinary cells with the standard representation hash, BOC in / out,
 * addresses, and the Wallet V5R1 ("W5") contract Tonkeeper creates by default. Keys follow TEP-0003 for a
 * 12 / 24-word BIP39 ("multichain") mnemonic: SLIP-0010 ed25519 on m/44'/607'/0' — same as Tonkeeper, MyTonWallet,
 * Trust Wallet. Pure functions only (no network), so scripts and the backend can check them against @ton/ton.
 */

export const TON_PATH = "m/44'/607'/0'";
export const NANO = 1_000_000_000;

// ---------- cells ----------

export class Cell {
  private h?: Uint8Array;
  private d?: number;
  constructor(
    /** one entry (0 | 1) per bit */
    readonly bits: Uint8Array,
    readonly refs: Cell[] = [],
  ) {
    if (bits.length > 1023 || refs.length > 4) throw new Error("cell overflow");
  }
  depth(): number {
    this.d ??= this.refs.length ? 1 + Math.max(...this.refs.map((r) => r.depth())) : 0;
    return this.d;
  }
  /** data bytes with the completion tag (a 1 bit, then zeros) when the length is not a multiple of 8 */
  data(): Uint8Array {
    const n = this.bits.length;
    const out = new Uint8Array(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    if (n % 8) out[n >> 3] |= 0x80 >> (n & 7);
    return out;
  }
  descriptors(): [number, number] {
    return [this.refs.length, Math.ceil(this.bits.length / 8) + Math.floor(this.bits.length / 8)];
  }
  hash(): Uint8Array {
    if (!this.h) {
      const parts: number[] = [...this.descriptors(), ...this.data()];
      for (const r of this.refs) parts.push(r.depth() >> 8, r.depth() & 0xff);
      for (const r of this.refs) parts.push(...r.hash());
      this.h = sha256(new Uint8Array(parts));
    }
    return this.h;
  }
  beginParse() {
    return new Slice(this);
  }
}

export class Builder {
  private b: number[] = [];
  private r: Cell[] = [];
  get bitLength() {
    return this.b.length;
  }
  get refCount() {
    return this.r.length;
  }
  get availableBits() {
    return 1023 - this.b.length;
  }
  bit(v: boolean | number) {
    this.b.push(v ? 1 : 0);
    return this;
  }
  uint(v: bigint | number, n: number) {
    const x = BigInt(v);
    if (x < 0n || x >= 1n << BigInt(n)) throw new Error(`uint${n} out of range`);
    for (let i = n - 1; i >= 0; i--) this.b.push(Number((x >> BigInt(i)) & 1n));
    return this;
  }
  int(v: bigint | number, n: number) {
    const x = BigInt(v);
    const lim = 1n << BigInt(n - 1);
    if (x < -lim || x >= lim) throw new Error(`int${n} out of range`);
    return this.uint(x < 0n ? x + (1n << BigInt(n)) : x, n);
  }
  bytes(v: Uint8Array) {
    for (const x of v) this.uint(x, 8);
    return this;
  }
  /** VarUInteger 16 */
  coins(v: bigint) {
    if (v < 0n) throw new Error("negative coins");
    let len = 0;
    while (v >> BigInt(len * 8) > 0n) len++;
    this.uint(len, 4);
    return len ? this.uint(v, len * 8) : this;
  }
  /** addr_std (no anycast), or addr_none for null */
  address(a: TonAddress | null) {
    if (!a) return this.uint(0, 2);
    return this.uint(2, 2).bit(0).int(a.wc, 8).bytes(a.hash);
  }
  ref(c: Cell) {
    if (this.r.length >= 4) throw new Error("too many refs");
    this.r.push(c);
    return this;
  }
  maybeRef(c: Cell | null) {
    this.bit(!!c);
    return c ? this.ref(c) : this;
  }
  /** appends the bits and refs of another cell (storeSlice) */
  cell(c: Cell) {
    for (const x of c.bits) this.b.push(x);
    for (const x of c.refs) this.ref(x);
    return this;
  }
  end(): Cell {
    return new Cell(new Uint8Array(this.b), [...this.r]);
  }
}
export const beginCell = () => new Builder();

export class Slice {
  private p = 0;
  private rp = 0;
  constructor(private c: Cell) {}
  get remainingBits() {
    return this.c.bits.length - this.p;
  }
  bit(): boolean {
    if (this.p >= this.c.bits.length) throw new Error("slice underflow");
    return this.c.bits[this.p++] === 1;
  }
  uint(n: number): bigint {
    let x = 0n;
    for (let i = 0; i < n; i++) x = (x << 1n) | (this.bit() ? 1n : 0n);
    return x;
  }
  int(n: number): bigint {
    const x = this.uint(n);
    return x >= 1n << BigInt(n - 1) ? x - (1n << BigInt(n)) : x;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Number(this.uint(8));
    return out;
  }
  coins(): bigint {
    const len = Number(this.uint(4));
    return len ? this.uint(len * 8) : 0n;
  }
  address(): TonAddress | null {
    const tag = Number(this.uint(2));
    if (tag === 0) return null;
    if (tag !== 2 || this.bit()) throw new Error("unsupported address");
    return { wc: Number(this.int(8)), hash: this.bytes(32) };
  }
  ref(): Cell {
    const r = this.c.refs[this.rp++];
    if (!r) throw new Error("no more refs");
    return r;
  }
}

// ---------- BOC ----------

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32c(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC32C[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const byteLen = (n: number) => {
  let b = 1;
  while (n >= 2 ** (8 * b)) b++;
  return b;
};
const be = (n: number, len: number) => Array.from({ length: len }, (_, i) => Math.floor(n / 2 ** (8 * (len - 1 - i))) & 0xff);

/** One root, no index, with crc32c (what @ton/core writes by default). */
export function toBoc(root: Cell): Uint8Array {
  // reverse post-order: every cell comes before the cells it refers to; equal subtrees are written once
  const seen = new Set<string>();
  const post: Cell[] = [];
  const visit = (c: Cell) => {
    const h = bytesToHex(c.hash());
    if (seen.has(h)) return;
    seen.add(h);
    c.refs.forEach(visit);
    post.push(c);
  };
  visit(root);
  const cells = post.reverse();
  const index = new Map(cells.map((c, i) => [bytesToHex(c.hash()), i]));
  const size = byteLen(cells.length);
  const body: number[] = [];
  for (const c of cells) {
    body.push(...c.descriptors(), ...c.data());
    for (const r of c.refs) body.push(...be(index.get(bytesToHex(r.hash()))!, size));
  }
  const off = byteLen(body.length);
  const out = [0xb5, 0xee, 0x9c, 0x72, 0x40 | size, off, ...be(cells.length, size), ...be(1, size), ...be(0, size), ...be(body.length, off), ...be(0, size), ...body];
  const crc = crc32c(new Uint8Array(out));
  out.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24);
  return new Uint8Array(out);
}

export function parseBoc(b: Uint8Array): Cell[] {
  if (b[0] !== 0xb5 || b[1] !== 0xee || b[2] !== 0x9c || b[3] !== 0x72) throw new Error("not a BOC");
  let p = 4;
  const flags = b[p++];
  const size = flags & 7;
  const off = b[p++];
  const read = (n: number) => {
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + b[p++];
    return x;
  };
  const count = read(size);
  const roots = read(size);
  read(size); // absent
  read(off); // total size
  const rootIdx = Array.from({ length: roots }, () => read(size));
  if (flags & 0x80) p += count * off;
  const raw: { bits: Uint8Array; refs: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    const d1 = b[p++];
    const d2 = b[p++];
    if (d1 & 8) throw new Error("exotic cells are not supported");
    const bytes = b.slice(p, p + Math.ceil(d2 / 2));
    p += bytes.length;
    let n = bytes.length * 8;
    if (d2 % 2) {
      // drop the completion tag: the last 1 bit and the zeros after it
      while (n > 0 && !(bytes[(n - 1) >> 3] & (0x80 >> ((n - 1) & 7)))) n--;
      n--;
    }
    const bits = new Uint8Array(n);
    for (let k = 0; k < n; k++) bits[k] = bytes[k >> 3] & (0x80 >> (k & 7)) ? 1 : 0;
    raw.push({ bits, refs: Array.from({ length: d1 & 7 }, () => read(size)) });
  }
  const cells: Cell[] = new Array(count);
  for (let i = count - 1; i >= 0; i--) cells[i] = new Cell(raw[i].bits, raw[i].refs.map((r) => cells[r]));
  return rootIdx.map((i) => cells[i]);
}
export const bocBase64 = (c: Cell) => base64.encode(toBoc(c));
export const cellFromBase64 = (s: string) => parseBoc(base64.decode(s))[0];

// ---------- addresses ----------

export type TonAddress = { wc: number; hash: Uint8Array };

function crc16(b: Uint8Array): number {
  let c = 0;
  for (const x of b) {
    c ^= x << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

/** "0:<hex>" or the 48-character user-friendly form (base64 / base64url); `bounceable` is null for the raw form. */
export function parseTonAddress(s: string): { addr: TonAddress; bounceable: boolean | null; testnet: boolean } | null {
  const t = s.trim();
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(t);
  if (raw) return { addr: { wc: Number(raw[1]), hash: hexToBytes(raw[2].toLowerCase()) }, bounceable: null, testnet: false };
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(t)) return null;
  let b: Uint8Array;
  try {
    b = base64.decode(t.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (b.length !== 36 || crc16(b.slice(0, 34)) !== b[34] * 256 + b[35]) return null;
  const tag = b[0] & 0x7f;
  if (tag !== 0x11 && tag !== 0x51) return null;
  const wc = b[1] === 0xff ? -1 : b[1];
  if (wc !== 0 && wc !== -1) return null;
  return { addr: { wc, hash: b.slice(2, 34) }, bounceable: tag === 0x11, testnet: !!(b[0] & 0x80) };
}
export const isTonAddress = (s: string) => {
  const p = parseTonAddress(s);
  return !!p && !p.testnet && p.addr.wc === 0;
};
export function formatTonAddress(a: TonAddress, bounceable = false): string {
  const b = new Uint8Array(36);
  b[0] = bounceable ? 0x11 : 0x51;
  b[1] = a.wc & 0xff;
  b.set(a.hash, 2);
  const c = crc16(b.slice(0, 34));
  b[34] = c >> 8;
  b[35] = c & 0xff;
  return base64.encode(b).replace(/\+/g, "-").replace(/\//g, "_");
}
export const rawTon = (a: TonAddress) => `${a.wc}:${bytesToHex(a.hash)}`;
/** Same account whatever the flags / form (EQ… / UQ… / 0:…) */
export function sameTonAddress(a?: string | null, b?: string | null): boolean {
  const x = a ? parseTonAddress(a) : null;
  const y = b ? parseTonAddress(b) : null;
  return !!x && !!y && rawTon(x.addr) === rawTon(y.addr);
}
/** The form wallets show for a user account: non-bounceable, url-safe ("UQ…") */
export const friendlyTon = (s: string) => {
  const p = parseTonAddress(s);
  return p ? formatTonAddress(p.addr, false) : s;
};

// ---------- keys + Wallet V5R1 ----------

export type TonKey = { seed: Uint8Array; publicKey: Uint8Array; address: string; raw: TonAddress };

export const W5_CODE_BOC =
  "b5ee9c7201021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0";
export const W5_CODE_HASH = "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f";
/** wallet_id of a mainnet, workchain 0, subwallet 0 W5: global id −239 XOR the client context (TEP-0003) */
export const W5_WALLET_ID = 0x7fffff11;

let code: Cell | null = null;
export const w5Code = () => (code ??= parseBoc(hexToBytes(W5_CODE_BOC))[0]);

export const w5Data = (publicKey: Uint8Array) => beginCell().bit(1).uint(0, 32).uint(W5_WALLET_ID, 32).bytes(publicKey).bit(0).end();
export const stateInit = (c: Cell, d: Cell) => beginCell().bit(0).bit(0).bit(1).ref(c).bit(1).ref(d).bit(0).end();
export const w5StateInit = (publicKey: Uint8Array) => stateInit(w5Code(), w5Data(publicKey));
export const w5Address = (publicKey: Uint8Array): TonAddress => ({ wc: 0, hash: w5StateInit(publicKey).hash() });

export function tonKeyFromSeed(seed: Uint8Array): TonKey {
  const publicKey = ed25519.getPublicKey(seed);
  const raw = w5Address(publicKey);
  return { seed, publicKey, raw, address: formatTonAddress(raw, false) };
}
export const tonKeyFromMnemonic = (phrase: string) => tonKeyFromSeed(slip10(mnemonicToSeedSync(phrase), [44, 607, 0]));

// ---------- messages ----------

/** @ton/core's rule for "inline or in a ref", so our hashes match the reference implementation exactly */
function storeBody(b: Builder, body: Cell | null) {
  if (!body) return b.bit(0);
  if (b.availableBits - 1 < body.bits.length || b.refCount + body.refs.length > 4) return b.bit(1).ref(body);
  return b.bit(0).cell(body);
}

export type OutMsg = { to: TonAddress; value: bigint; bounce: boolean; body?: Cell | null };

/** MessageRelaxed with int_msg_info (source and fees are filled in by the chain) */
export function internalMessage(m: OutMsg): Cell {
  const b = beginCell().bit(0).bit(1).bit(m.bounce).bit(0).address(null).address(m.to).coins(m.value).bit(0).coins(0n).coins(0n).uint(0, 64).uint(0, 32).bit(0);
  return storeBody(b, m.body ?? null).end();
}

export function externalMessage(to: TonAddress, init: Cell | null, body: Cell): Cell {
  const b = beginCell().uint(2, 2).address(null).address(to).coins(0n);
  if (init) {
    b.bit(1);
    if (b.availableBits - 2 < init.bits.length + body.bits.length) b.bit(1).ref(init);
    else b.bit(0).cell(init);
  } else b.bit(0);
  return storeBody(b, body).end();
}

/** Text comment ("memo"): op 0 + UTF-8, kept within one cell */
export function commentCell(text: string): Cell {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 123) throw new Error("备注太长");
  return beginCell().uint(0, 32).bytes(bytes).end();
}

/** TEP-74 jetton transfer, sent to our own jetton wallet */
export function jettonTransferBody(o: { queryId: bigint; amount: bigint; to: TonAddress; responseTo: TonAddress; forwardTon: bigint; comment?: Cell | null }): Cell {
  const b = beginCell().uint(0x0f8a7ea5, 32).uint(o.queryId, 64).coins(o.amount).address(o.to).address(o.responseTo).bit(0).coins(o.forwardTon);
  return (o.comment ? b.bit(1).ref(o.comment) : b.bit(0)).end();
}

/** SendMode: pay fees separately (1) + ignore errors (2, required by W5 for external messages) */
export const MODE_NORMAL = 3;
/** carry the whole balance (128) + ignore errors */
export const MODE_ALL = 130;

/** W5 signed external request: "sign" ‖ wallet_id ‖ valid_until ‖ seqno ‖ out list ‖ no extended actions ‖ signature (at the tail) */
export function w5Body(o: { seqno: number; validUntil: number; msgs: { msg: Cell; mode: number }[] }, sign: (hash: Uint8Array) => Uint8Array): Cell {
  let list = beginCell().end();
  for (const m of [...o.msgs].reverse()) list = beginCell().ref(list).uint(0x0ec3c86d, 32).uint(m.mode, 8).ref(m.msg).end();
  const signing = beginCell().uint(0x7369676e, 32).uint(W5_WALLET_ID, 32).uint(o.validUntil, 32).uint(o.seqno, 32).maybeRef(o.msgs.length ? list : null).bit(0).end();
  return beginCell().cell(signing).bytes(sign(signing.hash())).end();
}

export const signerOf = (key: TonKey) => (hash: Uint8Array) => ed25519.sign(hash, key.seed);

export type W5Order = { seqno: number; validUntil: number; msgs: OutMsg[]; modes?: number[]; deploy: boolean };

/** Signs a transfer; `deploy` adds the state init (first transaction of a new wallet). `body` is what nodes report as body_hash. */
export function w5TransferParts(key: Pick<TonKey, "publicKey" | "raw">, o: W5Order, sign: (hash: Uint8Array) => Uint8Array): { ext: Cell; body: Cell } {
  const body = w5Body({ seqno: o.seqno, validUntil: o.validUntil, msgs: o.msgs.map((m, i) => ({ msg: internalMessage(m), mode: o.modes?.[i] ?? MODE_NORMAL })) }, sign);
  return { ext: externalMessage(key.raw, o.deploy ? w5StateInit(key.publicKey) : null, body), body };
}
export const w5Transfer = (key: TonKey, o: W5Order) => w5TransferParts(key, o, signerOf(key)).ext;

export const hexOf = bytesToHex;
