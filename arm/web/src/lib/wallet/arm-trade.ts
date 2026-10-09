import { createWalletClient, encodePacked, http, maxUint256, erc20Abi as viemErc20Abi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { afterBuyTax, maxSellable, sellTaxOn, type TokenView } from "@/lib/api";
import { ADDR, POOL_FEE, addrsFor, erc20Abi, quoterAbi, routerAbi } from "@/lib/web3";
import { chainByKey, publicClientFor, rpcOf } from "./chains";
import { t } from "./i18n";

/**
 * Arm token swaps signed by the wallet's own key (same routes as components/token/trade-panel.tsx, which goes through
 * wagmi instead): the router / quoter of the factory generation that launched the token, two hops through the stock
 * pool for stock-quoted tokens, buy / sell tax applied by the token contract on top of the pool amounts.
 */

export type Side = "buy" | "sell";

const arc = () => chainByKey("arc");

function route(token: TokenView, side: Side) {
  const A = addrsFor(token.factory);
  const tokenAddr = token.address as Address;
  const quote = token.quote && token.quote !== ADDR.usdc.toLowerCase() ? (token.quote as Address) : undefined;
  const qFee = token.quoteUsdcFee ?? 0;
  const path: Hex | undefined = quote
    ? side === "buy"
      ? encodePacked(["address", "uint24", "address", "uint24", "address"], [ADDR.usdc, qFee, quote, POOL_FEE, tokenAddr])
      : encodePacked(["address", "uint24", "address", "uint24", "address"], [tokenAddr, POOL_FEE, quote, qFee, ADDR.usdc])
    : undefined;
  return { A, tokenAddr, path, tokenIn: side === "buy" ? ADDR.usdc : tokenAddr, tokenOut: side === "buy" ? tokenAddr : ADDR.usdc };
}

/** Pool-side output for `amountIn` (USDC 6dp on buys, tokens 18dp on sells). */
export async function quote(token: TokenView, side: Side, amountIn: bigint, pc: PublicClient = publicClientFor(arc())): Promise<bigint> {
  const r = route(token, side);
  if (r.path) {
    const { result } = await pc.simulateContract({ address: r.A.quoter, abi: quoterAbi, functionName: "quoteExactInput", args: [r.path, amountIn] });
    return result[0];
  }
  const { result } = await pc.simulateContract({
    address: r.A.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

export type QuoteView = {
  out: bigint;
  /** what lands in the wallet after a buy tax */
  outNet: bigint;
  minOut: bigint;
  minOutNet: bigint;
  /** sell tax charged on top of `amountIn` */
  sellTax: bigint;
  /** % worse than the indexer's spot price */
  impact: number;
};

export function shapeQuote(token: TokenView, side: Side, amountIn: bigint, out: bigint, slippagePct: number): QuoteView {
  const buyTax = token.buyTaxBps ?? 0;
  const sellTaxBps = token.sellTaxBps ?? 0;
  const outNet = side === "buy" && buyTax > 0 ? afterBuyTax(out, buyTax) : out;
  const minOut = out - (out * BigInt(Math.round(slippagePct * 100))) / 10_000n;
  const minOutNet = side === "buy" && buyTax > 0 ? afterBuyTax(minOut, buyTax) : minOut;
  const inNum = side === "buy" ? Number(amountIn) / 1e6 : Number(amountIn) / 1e18;
  const outNum = side === "buy" ? Number(outNet) / 1e18 : Number(out) / 1e6;
  const exec = outNum > 0 && inNum > 0 ? (side === "buy" ? inNum / outNum : outNum / inNum) : 0;
  const impact = token.price > 0 && exec > 0 ? Math.max(0, (side === "buy" ? exec / token.price - 1 : 1 - exec / token.price) * 100) : 0;
  return { out, outNet, minOut, minOutNet, sellTax: side === "sell" && sellTaxBps > 0 ? sellTaxOn(amountIn, sellTaxBps) : 0n, impact };
}

export const sellableOf = (token: TokenView, balance: bigint) => ((token.sellTaxBps ?? 0) > 0 ? maxSellable(balance, token.sellTaxBps) : balance);

export type TradeStep = "approving" | "swapping" | "confirming";

/** Plain USDC transfer on Arc signed by the wallet's key (shop "pay with USDC"); resolves with the receipt. */
export async function transferUsdc(account: LocalAccount, to: Address, amount: bigint, onStep?: (s: TradeStep, hash?: Hex) => void) {
  const chain = arc();
  const pc = publicClientFor(chain);
  const wc = createWalletClient({ account, chain: chain.chain, transport: http(rpcOf(chain)) });
  onStep?.("swapping");
  const hash = await wc.writeContract({ address: ADDR.usdc, abi: viemErc20Abi, functionName: "transfer", args: [to, amount] });
  onStep?.("confirming", hash);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw Object.assign(new Error(t("cw.coin.errReverted")), { hash });
  return rc;
}

/**
 * Approves the router once (max, like the site does) if needed, then swaps; resolves with the swap receipt.
 * `recipient` (buys only): deliver the tokens to another wallet — a shop purchase pays the seller this way.
 */
export async function executeTrade(
  account: LocalAccount,
  token: TokenView,
  side: Side,
  amountIn: bigint,
  minOut: bigint,
  onStep?: (s: TradeStep, hash?: Hex) => void,
  recipient?: Address,
) {
  const chain = arc();
  const pc = publicClientFor(chain);
  const wc = createWalletClient({ account, chain: chain.chain, transport: http(rpcOf(chain)) });
  const r = route(token, side);
  const me = account.address;
  const to = side === "buy" && recipient ? recipient : me;

  const allowance = await pc.readContract({ address: r.tokenIn, abi: erc20Abi, functionName: "allowance", args: [me, r.A.router] });
  if (allowance < amountIn) {
    onStep?.("approving");
    const h = await wc.writeContract({ address: r.tokenIn, abi: erc20Abi, functionName: "approve", args: [r.A.router, maxUint256] });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error(t("cw.coin.errApprove"));
  }

  onStep?.("swapping");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const hash = r.path
    ? await wc.writeContract({ address: r.A.router, abi: routerAbi, functionName: "exactInput", args: [{ path: r.path, recipient: to, deadline, amountIn, amountOutMinimum: minOut }] })
    : await wc.writeContract({
        address: r.A.router,
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, fee: POOL_FEE, recipient: to, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      });
  onStep?.("confirming", hash);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw Object.assign(new Error(t("cw.coin.errReverted")), { hash });
  return rc;
}
