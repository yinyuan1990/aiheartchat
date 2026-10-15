import { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseSignature, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { sql } from "./db.js";
import { ensureAiUsers, remoteFee, signerOnline, type AiUser } from "./ai-users.js";

/**
 * 10.15 Arm AI service fee: AI_FEE_BPS (5%) of what BlockRun charged for a user's successful calls accrues as owed.
 * Once it reaches AI_FEE_SETTLE the user's app signs one EIP-3009 USDC transfer to AI_FEE_TO and this server submits
 * it (gas paid by AI_FEE_RELAYER_KEY / AI_PROXY_WALLET_KEY). Past AI_FEE_BLOCK still unpaid, new calls wait for it.
 * The app keeps its own count of what it signed and never signs more fee than that count allows.
 */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const FEE_TO = getAddress(process.env.AI_FEE_TO ?? "0xa47c8dC4886411Bfd45F81Fd81e76aec7bF36Db0");
export const FEE_BPS = Math.round(Number(process.env.AI_FEE_BPS ?? 500));
const micro = (v: string | undefined, d: number) => {
  const n = Number(v ?? d);
  return Math.round((Number.isFinite(n) && n > 0 ? n : d) * 1e6);
};
export const FEE_SETTLE = micro(process.env.AI_FEE_SETTLE, 1);
export const FEE_BLOCK = micro(process.env.AI_FEE_BLOCK, 2);
const relayerKey = process.env.AI_FEE_RELAYER_KEY ?? process.env.AI_PROXY_WALLET_KEY;
const relayer = relayerKey ? privateKeyToAccount(relayerKey as Hex) : null;
const rpc = http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org");
const chain = createPublicClient({ chain: base, transport: rpc });
const wallet = relayer ? createWalletClient({ chain: base, transport: rpc, account: relayer }) : null;
const abi = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]);
const busy = new Set<string>();

/** micro-USDC: accrued = BPS of BlockRun's charges since fee_since; paid includes settlements still in flight */
export async function feeOf(user: AiUser) {
  await ensureAiUsers();
  const [r] = await sql<{ spent: string; paid: string }[]>`select
    (select coalesce(sum(c.cost), 0) from ai_proxy_calls c join ai_users u on u.id = c.user_id where c.user_id = ${user.id} and c.at >= u.fee_since and c.cost > 0)::text as spent,
    (select coalesce(sum(amount), 0) from ai_fees where user_id = ${user.id} and status in ('paid', 'pending'))::text as paid`;
  const accrued = Math.floor((Number(r.spent) * FEE_BPS) / 10_000);
  const paid = Number(r.paid);
  return { bps: FEE_BPS, to: FEE_TO, settleAt: FEE_SETTLE, blockAt: FEE_BLOCK, accrued, paid, owed: Math.max(0, accrued - paid) };
}

/** settle what this user owes if it reached the threshold and their app is online (one at a time per user) */
export async function settleFee(user: AiUser) {
  if (!wallet || busy.has(user.id) || !signerOnline(user)) return;
  busy.add(user.id);
  try {
    const { owed } = await feeOf(user);
    if (owed <= 0 || owed < FEE_SETTLE) return;
    const { authorization: a, signature } = await remoteFee(user, { to: FEE_TO, amount: owed, bps: FEE_BPS, owed });
    const value = BigInt(a.value);
    if (getAddress(a.from) !== getAddress(user.address) || getAddress(a.to) !== FEE_TO || value <= 0n || value > BigInt(owed)) throw new Error("fee authorization does not match");
    const [row] = await sql<{ id: string }[]>`insert into ai_fees (user_id, amount, status, nonce) values (${user.id}, ${value.toString()}, 'pending', ${a.nonce}) returning id::text`;
    let hash: Hex | null = null;
    try {
      const sig = parseSignature(signature as Hex);
      const v = Number(sig.v ?? 27n + BigInt(sig.yParity ?? 0));
      // writeContract estimates first: a transfer that would revert (too little USDC) is never sent, no gas spent
      hash = await wallet.writeContract({ address: USDC, abi, functionName: "transferWithAuthorization", args: [getAddress(a.from), FEE_TO, value, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex, v, sig.r, sig.s] });
      await sql`update ai_fees set tx = ${hash} where id = ${row.id}`;
      const rc = await chain.waitForTransactionReceipt({ hash, timeout: 120_000 });
      await sql`update ai_fees set status = ${rc.status === "success" ? "paid" : "failed"} where id = ${row.id}`;
    } catch (e) {
      // sent but no receipt yet: stays pending (counted as paid), never asked for twice
      await sql`update ai_fees set status = ${hash ? "pending" : "failed"}, reason = ${(e as Error).message.slice(0, 300)} where id = ${row.id}`;
    }
  } catch (e) {
    console.warn(`[ai-fee] user ${user.id}: ${(e as Error).message}`);
  } finally {
    busy.delete(user.id);
  }
}

/** recent settlements of one user (or all, for the operator) */
export async function feeRows(userId: string | null, limit = 20) {
  await ensureAiUsers();
  return sql`select at, user_id::text, amount::float8 as amount, status, tx, reason from ai_fees where ${userId === null ? sql`true` : sql`user_id = ${userId}`} order by id desc limit ${limit}`;
}
