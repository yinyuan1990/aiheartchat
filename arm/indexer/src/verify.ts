import { createPublicClient, decodeEventLog, erc20Abi, fallback, getAddress, http, isAddress, type Hex, type PublicClient } from "viem";
import { client as arcClient } from "./chain.js";
import { solRelay } from "./solana.js";

/**
 * Checks a transfer someone claims to have made, for 心之音's chat transfer cards: the transaction succeeded, came from
 * `from`, and moved exactly `amount` (smallest units) of `token` ("native" or a contract / mint) to `to`.
 * `pending` = not visible on chain yet; the caller retries.
 */

const EVM_RPCS: Record<string, string[]> = {
  eth: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
  bsc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://1rpc.io/base"],
  arb: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arb"],
  polygon: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
};
const clients = new Map<string, PublicClient>();
function evmClient(chain: string): PublicClient | null {
  if (chain === "arc") return arcClient as unknown as PublicClient;
  const urls = EVM_RPCS[chain];
  if (!urls) return null;
  let c = clients.get(chain);
  if (!c) {
    c = createPublicClient({ transport: fallback(urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 }))) });
    clients.set(chain, c);
  }
  return c;
}

export type TransferClaim = { chain: string; hash: string; from: string; to: string; token: string; amount: string };
export type TransferCheck = { ok: true } | { ok: false; pending?: boolean; reason: string };

const fail = (reason: string, pending = false): TransferCheck => ({ ok: false, reason, pending });

export function claimOf(q: Record<string, string | undefined>): TransferClaim | null {
  const c = { chain: q.chain ?? "", hash: q.hash ?? "", from: q.from ?? "", to: q.to ?? "", token: q.token ?? "", amount: q.amount ?? "" };
  if (!/^\d{1,40}$/.test(c.amount) || c.amount === "0" || !c.chain || !c.hash || !c.from || !c.to || !c.token) return null;
  return c;
}

export async function verifyTransfer(c: TransferClaim): Promise<TransferCheck> {
  return c.chain === "sol" ? verifySol(c) : verifyEvm(c);
}

async function verifyEvm(c: TransferClaim): Promise<TransferCheck> {
  const pc = evmClient(c.chain);
  if (!pc) return fail("unsupported chain");
  if (!/^0x[0-9a-fA-F]{64}$/.test(c.hash) || !isAddress(c.from) || !isAddress(c.to) || (c.token !== "native" && !isAddress(c.token))) return fail("bad params");
  const hash = c.hash as Hex;
  const receipt = await pc.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return fail("not found yet", true);
  if (receipt.status !== "success") return fail("transaction reverted");
  const from = getAddress(c.from);
  const to = getAddress(c.to);
  const amount = BigInt(c.amount);
  if (getAddress(receipt.from) !== from) return fail("sent from another address");
  if (c.token === "native") {
    const tx = await pc.getTransaction({ hash }).catch(() => null);
    if (!tx) return fail("not found yet", true);
    return tx.to && getAddress(tx.to) === to && tx.value === amount ? { ok: true } : fail("amount or recipient does not match");
  }
  const token = getAddress(c.token);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== token) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer" && getAddress(ev.args.from) === from && getAddress(ev.args.to) === to && ev.args.value === amount) return { ok: true };
    } catch {}
  }
  return fail("no matching token transfer");
}

type SolBal = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
type SolIx = { program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } };
type SolTx = {
  meta: { err: unknown; preTokenBalances?: SolBal[]; postTokenBalances?: SolBal[]; innerInstructions?: { instructions: SolIx[] }[] } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: SolIx[] } };
};

async function verifySol(c: TransferClaim): Promise<TransferCheck> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(c.hash)) return fail("bad signature");
  const r = await solRelay({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [c.hash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }, "verify-transfer");
  const tx = (r.json as { result?: SolTx | null }).result;
  if (r.status !== 200) return fail("node unavailable", true);
  if (!tx) return fail("not found yet", true);
  if (!tx.meta || tx.meta.err) return fail("transaction failed");
  if (!tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey === c.from)) return fail("not signed by the sender");
  if (c.token === "native") {
    const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
    const hit = all.some((ix) => ix.program === "system" && ix.parsed?.type === "transfer" && ix.parsed.info?.source === c.from && ix.parsed.info.destination === c.to && String(ix.parsed.info.lamports) === c.amount);
    return hit ? { ok: true } : fail("amount or recipient does not match");
  }
  const sum = (list: SolBal[] | undefined, owner: string) => (list ?? []).filter((b) => b.owner === owner && b.mint === c.token).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const received = sum(tx.meta.postTokenBalances, c.to) - sum(tx.meta.preTokenBalances, c.to);
  const spent = sum(tx.meta.preTokenBalances, c.from) - sum(tx.meta.postTokenBalances, c.from);
  return received === BigInt(c.amount) && spent >= BigInt(c.amount) ? { ok: true } : fail("amount or recipient does not match");
}
