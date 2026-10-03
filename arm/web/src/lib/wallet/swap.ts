import { erc20Abi, getAddress, isAddress, parseUnits, type Address, type Hex, type LocalAccount } from "viem";
import type { TokenView } from "@/lib/api";
import { ADDR } from "@/lib/web3";
import { SOL_LOGO, USDC_LOGO, fetchSolTokens, iconUrl, type Asset, type SolTokenInfo } from "./assets";
import { SOL_CHAIN, isSolana, nativeIcon, publicClientFor, rpcOf, type WalletChain } from "./chains";
import { NATIVE, executeKyberSwap, isMarketChain, kyberDexes, kyberImpact, kyberQuote, rememberToken, type KyberQuote } from "./market";
import { executeSolSwap, jupQuote, routeLabel, type JupQuote } from "./pump";
import { executeTrade, quote as armQuote, shapeQuote } from "./arm-trade";
import { WSOL_MINT, isSolAddress, type SolKeypair } from "./sol";

/**
 * Quick swap on the wallet home: one form for every chain. Solana routes through Jupiter, the EVM market chains through
 * KyberSwap, Arc through Arm's own router (so one side must be USDC there). No platform fee anywhere.
 */

export type SwapToken = {
  /** contract / mint; the chain's native coin uses Kyber's 0xEeee… marker on EVM and the wSOL mint on Solana */
  address: string;
  symbol: string;
  name: string;
  logo?: string;
  seed: string;
  decimals: number;
  raw: bigint;
  native?: boolean;
  /** Arm-launched token (Arc) */
  arm?: boolean;
};

export type SwapEngine = "jupiter" | "kyber" | "arm";
export const engineOf = (chain: WalletChain): SwapEngine | null => (isSolana(chain) ? "jupiter" : isMarketChain(chain.key) ? "kyber" : chain.key === "arc" ? "arm" : null);
export const ENGINE_NAME: Record<SwapEngine, string> = { jupiter: "Jupiter", kyber: "KyberSwap", arm: "Arm 路由" };

const ARC_USDC = ADDR.usdc.toLowerCase();
export const isArcUsdc = (t?: SwapToken | null) => t?.address.toLowerCase() === ARC_USDC;

/** Native coin kept back for network fees when it is what you pay with. */
const GAS_RESERVE: Record<string, string> = { eth: "0.004", base: "0.0003", arb: "0.0003", bsc: "0.002", polygon: "0.5", arc: "0.05", sol: "0.01" };
export const gasReserve = (chain: WalletChain) => parseUnits(GAS_RESERVE[chain.key] ?? "0.001", isSolana(chain) ? 9 : chain.chain.nativeCurrency.decimals);

export function tokenOfAsset(chain: WalletChain, a: Asset): SwapToken | null {
  if (a.boat) return null;
  const native = a.id === "native";
  const address = isSolana(chain) ? (native ? WSOL_MINT : a.mint) : native ? NATIVE : a.token;
  if (!address) return null;
  return { address, symbol: a.symbol, name: a.name, logo: a.logo, seed: a.seed, decimals: a.decimals, raw: a.raw, native: native || (chain.key === "arc" && a.gas), arm: a.arm };
}

/** The coin that pays network fees, shown on the 支付 side until balances arrive (balance 0 until then). */
export function gasToken(chain: WalletChain): SwapToken {
  if (isSolana(chain)) return { address: WSOL_MINT, symbol: "SOL", name: "Solana", logo: SOL_LOGO, seed: "sol-native", decimals: 9, raw: 0n, native: true };
  if (chain.key === "arc") return { address: ADDR.usdc, symbol: "USDC", name: "USD Coin", logo: USDC_LOGO, seed: ADDR.usdc, decimals: 6, raw: 0n, native: true };
  const nc = chain.chain.nativeCurrency;
  return { address: NATIVE, symbol: nc.symbol, name: nc.name, logo: nativeIcon(chain), seed: `${chain.key}-native`, decimals: nc.decimals, raw: 0n, native: true };
}

export function tokenOfArm(t: TokenView, logo?: string): SwapToken {
  return { address: t.address, symbol: t.symbol, name: t.name, logo, seed: t.address, decimals: 18, raw: 0n, arm: true };
}

/** A contract / mint the user pasted: reads its metadata from the chain (EVM) or the indexer (Solana). */
export async function lookupToken(chain: WalletChain, input: string): Promise<SwapToken | null> {
  const s = input.trim();
  if (isSolana(chain)) {
    if (!isSolAddress(s)) return null;
    const all = await fetchSolTokens([s]).catch((): Record<string, SolTokenInfo | null> => ({}));
    const info = all[s];
    if (!info) return null;
    return { address: s, symbol: info.symbol, name: info.name, logo: iconUrl(info.icon), seed: s, decimals: info.decimals, raw: 0n };
  }
  if (!isAddress(s)) return null;
  const address = getAddress(s);
  const pc = publicClientFor(chain);
  try {
    const [symbol, name, decimals] = await Promise.all([
      pc.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      pc.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => ""),
      pc.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { address, symbol, name: name || symbol, seed: address, decimals: Number(decimals), raw: 0n };
  } catch {
    return null;
  }
}

export async function decimalsOf(chain: WalletChain, address: string): Promise<number> {
  return Number(await publicClientFor(chain).readContract({ address: address as Address, abi: erc20Abi, functionName: "decimals" }));
}

export type SwapQuote = {
  out: bigint;
  minOut: bigint;
  /** % worse than the market price (Kyber includes pool fees) */
  impact: number | null;
  route: string;
  raw: { kind: "jupiter"; q: JupQuote } | { kind: "kyber"; q: KyberQuote } | { kind: "arm"; token: TokenView; side: "buy" | "sell"; poolMin: bigint };
};

export async function getSwapQuote(chain: WalletChain, from: SwapToken, to: SwapToken, amountIn: bigint, slipPct: number, arm?: TokenView): Promise<SwapQuote> {
  const bps = Math.round(slipPct * 100);
  const engine = engineOf(chain);
  if (engine === "jupiter") {
    const q = await jupQuote(from.address, to.address, amountIn, bps);
    const impact = Number(q.priceImpactPct);
    return { out: BigInt(q.outAmount), minOut: BigInt(q.otherAmountThreshold), impact: Number.isFinite(impact) ? impact * 100 : null, route: routeLabel(q), raw: { kind: "jupiter", q } };
  }
  if (engine === "kyber") {
    const q = await kyberQuote(chain.key, from.address, to.address, amountIn);
    const out = BigInt(q.routeSummary.amountOut);
    return { out, minOut: (out * BigInt(10_000 - bps)) / 10_000n, impact: kyberImpact(q), route: kyberDexes(q), raw: { kind: "kyber", q } };
  }
  if (engine === "arm") {
    if (!arm) throw new Error("Arc 上只能在 USDC 和 Arm 代币之间兑换");
    const side = isArcUsdc(from) ? "buy" : "sell";
    const out = await armQuote(arm, side, amountIn);
    const v = shapeQuote(arm, side, amountIn, out, slipPct);
    return { out: v.outNet, minOut: v.minOutNet, impact: v.impact, route: "Arm · Uniswap V3", raw: { kind: "arm", token: arm, side, poolMin: v.minOut } };
  }
  throw new Error("这条链暂时不支持兑换");
}

export type SwapStep = "approving" | "building" | "swapping" | "confirming";
export const STEP_LABEL: Record<SwapStep, string> = { approving: "首次使用这个币，正在授权…", building: "生成交易…", swapping: "签名发送中…", confirming: "等待链上确认…" };

/** Signs and sends the quoted swap; resolves the transaction hash / signature. */
export async function executeSwap(chain: WalletChain, q: SwapQuote, to: SwapToken, amountIn: bigint, slipPct: number, signer: { evm: () => LocalAccount; sol: () => SolKeypair }, onStep: (s: SwapStep) => void): Promise<string> {
  const r = q.raw;
  if (r.kind === "jupiter") return executeSolSwap(signer.sol(), r.q, rpcOf(SOL_CHAIN), "high", (s) => onStep(s === "building" ? "building" : "confirming"));
  if (r.kind === "kyber") {
    const hash: Hex = await executeKyberSwap(signer.evm(), chain, r.q, Math.round(slipPct * 100), onStep);
    if (!to.native) rememberToken(chain.key, { address: to.address, symbol: to.symbol, name: to.name, image: to.logo ?? null, decimals: to.decimals });
    return hash;
  }
  const rc = await executeTrade(signer.evm(), r.token, r.side, amountIn, r.poolMin, (s) => onStep(s));
  return rc.transactionHash;
}
