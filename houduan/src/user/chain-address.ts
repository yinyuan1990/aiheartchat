import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, createPublicKey, verify } from 'crypto';
import { getAddress, isAddress, verifyMessage } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 链上钱包收款地址：用户在钱包里打开「允许好友给我转账」时，钱包用自己的 EVM / Solana 私钥对下面这段话签名，
 * App 壳带着登录态交上来。要签名是防止登录态被盗后有人把收款地址换成自己的（好友的钱就转给了他）。
 * 只有和他聊过天（单聊会话）或在同一个群里的人能查到他的地址。
 */
export const addressMessage = (userId: string, evm: string | null, sol: string | null, trx: string | null | undefined, ton: string | null | undefined, ts: number) =>
  // 没有 trx / ton 那一行的是加波场 / TON 之前的钱包页
  `心之音收款地址\nuser: ${userId}\nevm: ${evm ?? '-'}\nsol: ${sol ?? '-'}\n${trx === undefined ? '' : `trx: ${trx ?? '-'}\n`}${ton === undefined ? '' : `ton: ${ton ?? '-'}\n`}ts: ${ts}`;

const MAX_SKEW_MS = 10 * 60_000;
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(s: string): Buffer | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/**
 * 波场地址：0x41 + 20 字节账户 id 的 base58check。波场私钥和以太坊一样是 secp256k1，钱包用波场私钥按 EVM 方式签名，
 * 恢复出的 0x 地址和波场地址是同一个 20 字节 id。
 */
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
export function tronToEvm(addr: string): string | null {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return null;
  const raw = base58(addr);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return null;
  const sum = sha256(sha256(raw.subarray(0, 21))).subarray(0, 4);
  return sum.equals(raw.subarray(21)) ? getAddress(`0x${raw.subarray(1, 21).toString('hex')}`) : null;
}

export const solKey = (address: string) => {
  const raw = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? base58(address) : null;
  return raw?.length === 32 ? createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' }) : null;
};

// ---------- TON ----------

function crc16(b: Buffer): number {
  let c = 0;
  for (const x of b) {
    c ^= x << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
/** TON 地址的几种写法（0:hex / EQ… / UQ…）都转成 "0:hex"；格式不对返回 null */
export function tonRaw(s: string): string | null {
  const t = String(s ?? '').trim();
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(t);
  if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(t)) return null;
  const b = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b.length !== 36 || crc16(b.subarray(0, 34)) !== b.readUInt16BE(34)) return null;
  const tag = b[0] & 0x7f;
  if ((tag !== 0x11 && tag !== 0x51) || b[0] & 0x80) return null; // 测试网地址不收
  return b[1] === 0 ? `0:${b.subarray(2, 34).toString('hex')}` : null;
}

/** 普通 cell 的表示哈希：d1 d2 数据（补齐标记）各子 cell 深度 各子 cell 哈希 */
function cellHash(bits: number[], refs: { hash: Buffer; depth: number }[]): Buffer {
  const data = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => v && (data[i >> 3] |= 0x80 >> (i & 7)));
  if (bits.length % 8) data[bits.length >> 3] |= 0x80 >> (bits.length & 7);
  const d = Buffer.from([refs.length, Math.ceil(bits.length / 8) + Math.floor(bits.length / 8)]);
  const depths = Buffer.concat(refs.map((r) => Buffer.from([r.depth >> 8, r.depth & 0xff])));
  return sha256(Buffer.concat([d, data, depths, ...refs.map((r) => r.hash)]));
}
const uintBits = (v: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (n - 1 - i)) & 1);
/** Wallet V5R1（Tonkeeper 默认的 W5）合约代码的哈希和深度；主网 workchain 0 的 wallet_id */
const W5_CODE = { hash: Buffer.from('20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f', 'hex'), depth: 6 };
const W5_WALLET_ID = 0x7fffff11;
/** 公钥 → W5 钱包地址（"0:hex"）：地址就是 StateInit{code, data} 的哈希，data = 1 | seqno 0 | wallet_id | 公钥 | 空扩展 */
export function tonW5Address(pub: Buffer): string {
  const bits = [1, ...uintBits(0, 32), ...uintBits(W5_WALLET_ID, 32), ...[...pub].flatMap((x) => uintBits(x, 8)), 0];
  const data = { hash: cellHash(bits, []), depth: 0 };
  return `0:${cellHash([0, 0, 1, 1, 0], [W5_CODE, data]).toString('hex')}`;
}

/** TON 签名格式「公钥 hex:签名 base64」（TON 地址恢复不出公钥，所以一起交上来）；公钥算出的 W5 地址要和 address 一致 */
export function verifyTonSig(msg: string, address: string, sig: unknown): boolean {
  const m = typeof sig === 'string' ? /^([0-9a-f]{64}):([A-Za-z0-9+/=]{86,88})$/.exec(sig) : null;
  const want = tonRaw(address);
  if (!m || !want) return false;
  const pub = Buffer.from(m[1], 'hex');
  const s = Buffer.from(m[2], 'base64');
  if (s.length !== 64 || tonW5Address(pub) !== want) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(msg, 'utf8'), key, s);
}

/**
 * 转账卡片的「付款人证明」：钱包用付款地址的私钥签这段话。没有它，任何人都能拿别人付给对方的一笔交易冒充自己付的。
 * 和 Arm 钱包 lib/wallet/payee.ts 的 transferMessage 一致。
 */
export const transferMessage = (hash: string, from: string, to: string) => `心之音转账\nhash: ${hash}\nfrom: ${from}\nto: ${to}`;

export function verifyTransferProof(chain: string, hash: string, from: string, to: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !proof) return false;
  const msg = transferMessage(hash, from, to);
  if (chain === 'sol') {
    const key = solKey(from);
    const sig = Buffer.from(proof, 'base64');
    return !!key && sig.length === 64 && verify(null, Buffer.from(msg, 'utf8'), key, sig);
  }
  if (chain === 'ton') return verifyTonSig(msg, from, proof);
  try {
    const signer = chain === 'trx' ? tronToEvm(from) : isAddress(from) ? getAddress(from) : null;
    return !!signer && verifyMessage(msg, proof) === signer;
  } catch {
    return false;
  }
}

export type ChainAddressBody = { evm?: string | null; sol?: string | null; trx?: string | null; ton?: string | null; ts?: number; evmSig?: string; solSig?: string; trxSig?: string; tonSig?: string; off?: boolean };

/** userId 给钱包页拼签名内容用（钱包页本身不知道心之音账号） */
export async function myChainAddress(prisma: PrismaService, userId: bigint) {
  const row = await prisma.userChainAddress.findUnique({ where: { userId } });
  return { userId: String(userId), evm: row?.evm ?? null, sol: row?.sol ?? null, trx: row?.trx ?? null, ton: row?.ton ?? null };
}

export async function setChainAddress(prisma: PrismaService, userId: bigint, body: ChainAddressBody) {
  if (body?.off) {
    await prisma.userChainAddress.deleteMany({ where: { userId } });
    return { userId: String(userId), evm: null, sol: null, trx: null, ton: null };
  }
  const ts = Number(body?.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) throw new BadRequestException('签名已过期，请重试');
  const evm = body.evm ? String(body.evm) : null;
  const sol = body.sol ? String(body.sol) : null;
  const trx = body.trx ? String(body.trx) : null;
  const ton = body.ton ? String(body.ton) : null;
  if (!evm && !sol && !trx && !ton) throw new BadRequestException('没有地址');
  const msg = addressMessage(String(userId), evm, sol, 'trx' in body ? trx : undefined, 'ton' in body ? ton : undefined, ts);

  let evmOut: string | null = null;
  if (evm) {
    if (!isAddress(evm) || typeof body.evmSig !== 'string') throw new BadRequestException('EVM 地址或签名不对');
    let signer = '';
    try {
      signer = verifyMessage(msg, body.evmSig);
    } catch {}
    if (signer !== getAddress(evm)) throw new BadRequestException('EVM 签名对不上地址');
    evmOut = getAddress(evm);
  }
  if (sol) {
    const key = solKey(sol);
    const sig = typeof body.solSig === 'string' ? Buffer.from(body.solSig, 'base64') : null;
    if (!key || !sig || sig.length !== 64 || !verify(null, Buffer.from(msg, 'utf8'), key, sig)) throw new BadRequestException('Solana 签名对不上地址');
  }
  if (trx) {
    const want = tronToEvm(trx);
    let signer = '';
    try {
      signer = typeof body.trxSig === 'string' ? verifyMessage(msg, body.trxSig) : '';
    } catch {}
    if (!want || signer !== want) throw new BadRequestException('波场签名对不上地址');
  }
  if (ton && !verifyTonSig(msg, ton, body.tonSig)) throw new BadRequestException('TON 签名对不上地址');

  const data = { evm: evmOut, sol, trx, ton };
  await prisma.userChainAddress.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return { userId: String(userId), ...data };
}

/** 两个人聊过天（有单聊会话）或在同一个群 / 频道里 */
async function related(prisma: PrismaService, a: bigint, b: bigint) {
  const [min, max] = a < b ? [a, b] : [b, a];
  if (await prisma.conversation.findUnique({ where: { pairKey: `${min}_${max}` }, select: { id: true } })) return true;
  const mine = await prisma.groupMember.findMany({ where: { userId: a }, select: { groupId: true } });
  if (!mine.length) return false;
  return !!(await prisma.groupMember.findFirst({ where: { userId: b, groupId: { in: mine.map((m) => m.groupId) } }, select: { groupId: true } }));
}

export async function peerChainAddress(prisma: PrismaService, me: bigint, peerId: bigint) {
  const peer = await prisma.user.findUnique({ where: { id: peerId }, select: { id: true, status: true } });
  if (!peer || peer.status !== 0) throw new NotFoundException('对方不存在');
  if (peerId !== me && !(await related(prisma, me, peerId))) throw new ForbiddenException('只能查看聊过天的人');
  const row = await prisma.userChainAddress.findUnique({ where: { userId: peerId } });
  return { evm: row?.evm ?? null, sol: row?.sol ?? null, trx: row?.trx ?? null, ton: row?.ton ?? null };
}
