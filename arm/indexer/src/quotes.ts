import type { Address } from "viem";
import { client } from "./chain.js";
import { deployments, quoteAssets, quoteByAddress, stockSet, type QuoteAsset } from "./config.js";
import { poolAbi, stockFactoryAbi } from "./abi.js";
import { sql } from "./db.js";

/**
 * Stock generation: every pool is quoted in a tokenized stock, but the site shows USD everywhere. This module keeps the
 * USDC price of each whitelisted quote asset (6 decimals per whole unit) and converts raw quote amounts to USD.
 *
 * Source of truth is the quote/USDC Uniswap V3 pool's spot price (the same pool the contracts use); the factory's
 * TWAP is stored alongside for the admin view. Prices are refreshed with the on-chain refresh loop and, during
 * indexing, re-read at the chunk's end block so historical trades convert at a price close to their own block.
 */

const Q96 = 2n ** 96n;
const spot = new Map<string, bigint>(); // lowercase quote → USDC (6dp) per 10^decimals, latest
const atBlock = new Map<string, bigint>(); // `${quote}:${block}` → price (small LRU)

export const hasStock = () => !!stockSet && quoteAssets.length > 0;

/** USDC (6dp) per whole quote unit from a pool sqrt price. */
function priceFromSqrt(sqrtPriceX96: bigint, q: QuoteAsset): bigint {
  const one = 10n ** BigInt(q.decimals);
  const quoteIsToken0 = q.address.toLowerCase() < deployments.usdc.toLowerCase();
  // selling one whole quote: token0 → token1: out = in · P ; token1 → token0: out = in / P, P = (sqrtP / 2^96)^2
  const p = sqrtPriceX96;
  if (quoteIsToken0) return (((one * p) / Q96) * p) / Q96;
  if (p === 0n) return 0n;
  return (((one * Q96) / p) * Q96) / p;
}

async function readSpot(q: QuoteAsset, blockNumber?: bigint): Promise<bigint> {
  const s0 = await client.readContract({ address: q.usdcPool, abi: poolAbi, functionName: "slot0", ...(blockNumber ? { blockNumber } : {}) });
  return priceFromSqrt(s0[0], q);
}

/** Latest USDC price of `quote` (6dp per whole unit); 0 when unknown. */
export function quotePrice(quote?: string | null): bigint {
  if (!quote) return 1_000_000n; // USDC itself
  return spot.get(quote.toLowerCase()) ?? 0n;
}

/** Price near `block` (read once per (quote, block) — the indexer passes each chunk's end block); falls back to latest. */
export async function quotePriceAt(quote: string, block: bigint): Promise<bigint> {
  const key = `${quote.toLowerCase()}:${block}`;
  const hit = atBlock.get(key);
  if (hit !== undefined) return hit;
  const q = quoteByAddress(quote);
  if (!q) return 0n;
  let p: bigint;
  try {
    p = await readSpot(q, block);
  } catch {
    p = quotePrice(quote) || (await readSpot(q).catch(() => 0n));
  }
  atBlock.set(key, p);
  if (atBlock.size > 2000) atBlock.delete(atBlock.keys().next().value!);
  if (p > 0n) spot.set(quote.toLowerCase(), p);
  return p;
}

/** raw quote amount → USDC 6dp at `priceUsdc` (per whole unit). */
export function quoteToUsdc(amountRaw: bigint, decimals: number, priceUsdc: bigint): bigint {
  return (amountRaw * priceUsdc) / 10n ** BigInt(decimals);
}

/** Refresh every whitelisted quote's spot (pool) and TWAP (factory) price and persist them. */
export async function refreshQuotePrices() {
  if (!hasStock()) return;
  for (const q of quoteAssets) {
    try {
      const [p, twap, cfg] = await Promise.all([
        readSpot(q),
        client.readContract({ address: stockSet!.launchFactory as Address, abi: stockFactoryAbi, functionName: "quotePriceUsdc", args: [q.address] }).then((r) => r[0]).catch(() => 0n),
        client.readContract({ address: stockSet!.launchFactory as Address, abi: stockFactoryAbi, functionName: "quotes", args: [q.address] }).catch(() => null),
      ]);
      if (p > 0n) spot.set(q.address.toLowerCase(), p);
      await sql`insert into quote_prices (address, symbol, decimals, usdc_fee, usdc_pool, price_usdc, twap_usdc, enabled, updated_at)
        values (${q.address}, ${q.symbol}, ${q.decimals}, ${q.usdcFee}, ${q.usdcPool}, ${p.toString()}, ${twap.toString()}, ${cfg ? cfg[0] : true}, now())
        on conflict (address) do update set price_usdc = excluded.price_usdc, twap_usdc = excluded.twap_usdc, enabled = excluded.enabled, updated_at = now()`;
    } catch (e) {
      console.warn(`[quotes] refresh ${q.symbol} failed:`, (e as Error).message.split("\n")[0]);
    }
  }
}

/** Warm the in-memory prices from the DB (startup) and then from chain. */
export async function loadQuotePrices() {
  if (!hasStock()) return;
  const rows = await sql<{ address: string; price_usdc: string }[]>`select address, price_usdc from quote_prices`;
  for (const r of rows) if (BigInt(r.price_usdc) > 0n) spot.set(r.address.toLowerCase(), BigInt(r.price_usdc));
  await refreshQuotePrices();
  console.log(`[quotes] ${quoteAssets.map((q) => `${q.symbol}=${(Number(quotePrice(q.address)) / 1e6).toFixed(2)}`).join(" ")}`);
}
