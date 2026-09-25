/** Mirrors contracts/src/libraries/PriceMath.sol. All amounts are raw integers. */

const SCALE = 10n ** 27n; // mcap(6dp) / 1e27 = price_raw (token0 orientation)
const Q96 = 2n ** 96n;

/** Floor square root. Newton from a power-of-two upper bound: strictly decreasing, O(log n) iterations. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1); // ≥ sqrt(n)
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export function sqrtPriceX96ForMcap(mcapUsdc6: bigint, tokenIsToken0: boolean): bigint {
  if (mcapUsdc6 <= 0n) throw new Error("mcap");
  return tokenIsToken0 ? isqrt((mcapUsdc6 << 128n) / SCALE) << 32n : isqrt((SCALE << 128n) / mcapUsdc6) << 32n;
}

/** Market cap in USDC (6 decimals) from a pool sqrt price. */
export function mcapFromSqrtPriceX96(sqrtPriceX96: bigint, tokenIsToken0: boolean): bigint {
  const p = sqrtPriceX96;
  const pp = (p * p) >> 64n; // price_raw · 2^128
  if (tokenIsToken0) return (pp * SCALE) >> 128n;
  if (pp === 0n) return 0n;
  return (SCALE << 128n) / pp;
}

/** USD price per whole token (float) from mcap6. */
export function priceUsdFromMcap6(mcap6: bigint): number {
  return Number(mcap6) / 1e6 / 1e9;
}

export { Q96 };
