/**
 * /tools cross-chain swap — BNB (BNB Chain) ⇄ USDC (Arc mainnet), routed by LI.FI (li.quest). Boss 9.15: a plain
 * tool for users to move their own money; nothing is custodied, the user's wallet signs every step and pays every
 * fee. The only platform rule is the per-swap USD cap from /admin (`swapMaxUsd`).
 *
 * Flow: quote → (approve if the from-token is an ERC-20) → send `transactionRequest` on the from-chain → poll
 * /status until DONE. LI.FI listed Arc (5042) on 9.15; routes open with the public mainnet on 9.16.
 */
import { createPublicClient, createWalletClient, custom, http, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";
import { arcMainnet, bscChain, erc20Abi } from "./web3";

const API = "https://li.quest/v1";
const INTEGRATOR = "arm";

export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as Address;

export type Side = { chain: Chain; token: Address; symbol: string; decimals: number; explorer: string };
const BSC_EXPLORER = "https://bscscan.com";
export const SIDES = {
  bnb: { chain: bscChain, token: NATIVE, symbol: "BNB", decimals: 18, explorer: BSC_EXPLORER } satisfies Side,
  // 9.16: Arc USDC → native BNB depends on gas.zip liquidity, which ran dry within hours of launch; landing as a BSC
  // stablecoin goes through LI.FI intents and is always available, so the reverse direction lets the user pick.
  bscUsdt: { chain: bscChain, token: "0x55d398326f99059fF775485246999027B3197955" as Address, symbol: "USDT", decimals: 18, explorer: BSC_EXPLORER } satisfies Side,
  bscUsdc: { chain: bscChain, token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address, symbol: "USDC", decimals: 18, explorer: BSC_EXPLORER } satisfies Side,
  usdc: { chain: arcMainnet, token: ARC_USDC, symbol: "USDC", decimals: 6, explorer: "https://arc-scan.org" } satisfies Side,
};
export type Direction = "bnb2usdc" | "usdc2bnb";
/** The BSC-side asset: what the user pays with (BSC → Arc) or receives (Arc → BSC). 9.16 boss: BSC wallets mostly hold
 *  USDT / USDC, so both directions take the same picker. */
export type BscRecv = "BNB" | "USDT" | "USDC";
export const BSC_RECV: BscRecv[] = ["BNB", "USDT", "USDC"];
const bscSide = (r: BscRecv): Side => (r === "USDT" ? SIDES.bscUsdt : r === "USDC" ? SIDES.bscUsdc : SIDES.bnb);
export const dirSides = (d: Direction, recv: BscRecv = "BNB"): { from: Side; to: Side } =>
  d === "bnb2usdc" ? { from: bscSide(recv), to: SIDES.usdc } : { from: SIDES.usdc, to: bscSide(recv) };

export type LifiToken = { address: Address; symbol: string; decimals: number; priceUSD?: string; chainId: number };
export type Quote = {
  id: string;
  tool: string;
  toolDetails?: { key: string; name: string; logoURI?: string };
  action: { fromChainId: number; toChainId: number; fromToken: LifiToken; toToken: LifiToken; fromAmount: string; toAddress: Address };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: Address;
    executionDuration?: number;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    feeCosts?: { name: string; amount: string; amountUSD?: string; token: LifiToken; included?: boolean }[];
    gasCosts?: { amount: string; amountUSD?: string; token: LifiToken }[];
  };
  transactionRequest?: { to: Address; data: Hex; value?: string; gasLimit?: string; gasPrice?: string; chainId?: number };
};

export class LifiError extends Error {
  code?: number;
  constructor(msg: string, code?: number) {
    super(msg);
    this.code = code;
  }
}

async function call<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const r = await fetch(`${API}${path}?${qs}`, { headers: { accept: "application/json" } });
  const j = (await r.json().catch(() => ({}))) as { message?: string; code?: number } & T;
  if (!r.ok) throw new LifiError(j.message ?? `LI.FI ${r.status}`, j.code);
  return j;
}

export function getQuote(p: { dir: Direction; recv?: BscRecv; fromAmount: bigint; fromAddress: Address; toAddress: Address; slippage?: number }): Promise<Quote> {
  const { from, to } = dirSides(p.dir, p.recv);
  return call<Quote>("/quote", {
    fromChain: from.chain.id, toChain: to.chain.id, fromToken: from.token, toToken: to.token,
    fromAddress: p.fromAddress, toAddress: p.toAddress, fromAmount: p.fromAmount.toString(),
    slippage: p.slippage ?? 0.005, integrator: INTEGRATOR, order: "RECOMMENDED",
  });
}

/** USD price of a side's token (for the "max ≈ x BNB" hint before a quote exists). */
export async function tokenPriceUsd(side: Side): Promise<number | null> {
  const t = await call<LifiToken>("/token", { chain: side.chain.id, token: side.token }).catch(() => null);
  const p = Number(t?.priceUSD);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export type StatusName = "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
export type Status = {
  status: StatusName;
  substatus?: string;
  substatusMessage?: string;
  sending?: { txHash: Hex; txLink?: string; amount?: string; chainId?: number };
  receiving?: { txHash?: Hex; txLink?: string; amount?: string; chainId?: number; token?: LifiToken };
  lifiExplorerLink?: string;
};
export const getStatus = (p: { txHash: Hex; fromChain: number; toChain: number; bridge?: string }) =>
  call<Status>("/status", { txHash: p.txHash, fromChain: p.fromChain, toChain: p.toChain, bridge: p.bridge });

// ------------------------------------------------------------------ wallet plumbing (outside the app's wagmi config)

export const publicClientFor = (side: Side) => createPublicClient({ chain: side.chain, transport: http(side.chain.rpcUrls.default.http[0]) });

/** Wallet client on the connector's EIP-1193 provider, bound to the swap's from-chain. */
export function walletClientFor(provider: EIP1193Provider, side: Side, account: Address) {
  return createWalletClient({ chain: side.chain, transport: custom(provider), account });
}

/** Switch the wallet to `side.chain`, adding it first when the wallet has never seen it (4902). */
export async function ensureChain(provider: EIP1193Provider, side: Side) {
  const want = `0x${side.chain.id.toString(16)}` as Hex;
  const cur = (await provider.request({ method: "eth_chainId" })) as Hex;
  if (cur.toLowerCase() === want) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && !/unrecognized|not added|4902/i.test((e as Error).message ?? "")) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: want, chainName: side.chain.name, nativeCurrency: side.chain.nativeCurrency,
        rpcUrls: [...side.chain.rpcUrls.default.http], blockExplorerUrls: side.chain.blockExplorers ? [side.chain.blockExplorers.default.url] : undefined,
      }],
    });
  }
}

export async function balanceOf(side: Side, account: Address): Promise<bigint> {
  const pc = publicClientFor(side);
  if (side.token === NATIVE) return pc.getBalance({ address: account });
  return pc.readContract({ address: side.token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

export async function allowanceOf(side: Side, owner: Address, spender: Address): Promise<bigint> {
  if (side.token === NATIVE) return 2n ** 256n - 1n;
  return publicClientFor(side).readContract({ address: side.token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

/** The last swap sent from this browser, kept in localStorage so a closed tab picks the status polling back up.
 *  Exposed as a tiny external store (useSyncExternalStore) to stay SSR-safe without setState-in-effect. */
export type Pending = { txHash: Hex; dir: Direction; recv?: BscRecv; fromChain: number; toChain: number; bridge: string; fromAmount: string; toAddress: Address; at: number };
const KEY = "arm.tools.swap";
const listeners = new Set<() => void>();
let cached: Pending | null | undefined;
const read = (): Pending | null => {
  if (typeof window === "undefined") return null;
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    cached = null;
  }
  return cached;
};
export const pendingStore = {
  get: read,
  getServer: () => null as Pending | null,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  set: (next: Omit<Pending, "at"> | null) => {
    const p: Pending | null = next ? { ...next, at: Date.now() } : null;
    cached = p;
    if (typeof window !== "undefined") {
      if (p) window.localStorage.setItem(KEY, JSON.stringify(p));
      else window.localStorage.removeItem(KEY);
    }
    listeners.forEach((fn) => fn());
  },
};
