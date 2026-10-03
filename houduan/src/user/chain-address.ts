import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createPublicKey, verify } from 'crypto';
import { getAddress, isAddress, verifyMessage } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 链上钱包收款地址：用户在钱包里打开「允许好友给我转账」时，钱包用自己的 EVM / Solana 私钥对下面这段话签名，
 * App 壳带着登录态交上来。要签名是防止登录态被盗后有人把收款地址换成自己的（好友的钱就转给了他）。
 * 只有和他聊过天（单聊会话）或在同一个群里的人能查到他的地址。
 */
export const addressMessage = (userId: string, evm: string | null, sol: string | null, ts: number) =>
  `心之音收款地址\nuser: ${userId}\nevm: ${evm ?? '-'}\nsol: ${sol ?? '-'}\nts: ${ts}`;

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

export const solKey = (address: string) => {
  const raw = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? base58(address) : null;
  return raw?.length === 32 ? createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' }) : null;
};

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
  try {
    return isAddress(from) && verifyMessage(msg, proof) === getAddress(from);
  } catch {
    return false;
  }
}

export type ChainAddressBody = { evm?: string | null; sol?: string | null; ts?: number; evmSig?: string; solSig?: string; off?: boolean };

/** userId 给钱包页拼签名内容用（钱包页本身不知道心之音账号） */
export async function myChainAddress(prisma: PrismaService, userId: bigint) {
  const row = await prisma.userChainAddress.findUnique({ where: { userId } });
  return { userId: String(userId), evm: row?.evm ?? null, sol: row?.sol ?? null };
}

export async function setChainAddress(prisma: PrismaService, userId: bigint, body: ChainAddressBody) {
  if (body?.off) {
    await prisma.userChainAddress.deleteMany({ where: { userId } });
    return { userId: String(userId), evm: null, sol: null };
  }
  const ts = Number(body?.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) throw new BadRequestException('签名已过期，请重试');
  const evm = body.evm ? String(body.evm) : null;
  const sol = body.sol ? String(body.sol) : null;
  if (!evm && !sol) throw new BadRequestException('没有地址');
  const msg = addressMessage(String(userId), evm, sol, ts);

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

  const data = { evm: evmOut, sol };
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
  return { evm: row?.evm ?? null, sol: row?.sol ?? null };
}
