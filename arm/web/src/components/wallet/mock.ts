import type { Candle } from "@/components/token/price-chart";

export type ChainInfo = { id: number; key: string; name: string; gas: string; color: string; glyph: string };

export const CHAINS: ChainInfo[] = [
  { id: 5042, key: "arc", name: "Arc", gas: "USDC", color: "#111111", glyph: "A" },
  { id: 1, key: "eth", name: "Ethereum", gas: "ETH", color: "#627EEA", glyph: "Ξ" },
  { id: 56, key: "bsc", name: "BNB Chain", gas: "BNB", color: "#F0B90B", glyph: "B" },
  { id: 8453, key: "base", name: "Base", gas: "ETH", color: "#0052FF", glyph: "b" },
  { id: 42161, key: "arb", name: "Arbitrum", gas: "ETH", color: "#28A0F0", glyph: "A" },
  { id: 137, key: "polygon", name: "Polygon", gas: "POL", color: "#8247E5", glyph: "P" },
];

export const WALLET = {
  name: "我的钱包",
  address: "0x8DC74f9e76238aE763e24e76AB442e1D03C78D24",
  total: 1284.56,
  change: 12.3,
  changePct: 0.97,
};

export type Holding = { symbol: string; name: string; seed: string; logo?: string; amount: number; price: number; pct: number; spark: number[]; tag?: string };

const UPLOADS = "https://arm.yyheart.com/api/uploads";
export const USDC_LOGO = "/wallet/usdc.svg";

export const HOLDINGS: Holding[] = [
  { symbol: "USDC", name: "USD Coin", seed: "0x3600000000000000000000000000000000000000", logo: USDC_LOGO, amount: 846.21, price: 1, pct: 0, spark: [1, 1, 1, 1, 1, 1, 1, 1], tag: "Gas" },
  { symbol: "EGIRL", name: "E-Girl Companion", seed: "0x5AF2192dAe1887aA4b7687ad57bd8A0f3c7b25f6", logo: `${UPLOADS}/efaad11b80229dad6d5e791c57335f98.jpg`, amount: 3_920_118, price: 0.0000509, pct: 18.42, spark: [3, 4, 3.6, 5, 4.8, 6.2, 7, 7.4] },
  { symbol: "BOAT", name: "Speedboat", seed: "0x6fceD62cdb01E141Bb0895eA9f519d8caE0160e9", amount: 2_140_000, price: 0.00000516, pct: -4.1, spark: [6, 5.8, 6.1, 5.2, 5, 4.6, 4.9, 4.7] },
  { symbol: "TREEHOLE", name: "私密树洞", seed: "0x60e09ED7a616222FEa41b4540E443CE87e5231FE", logo: `${UPLOADS}/ce6c7d111fd609f7d5298b5493ab2a38.png`, amount: 512_400, price: 0.0000214, pct: 2.3, spark: [2, 2.1, 2, 2.2, 2.3, 2.2, 2.4, 2.4] },
  { symbol: "ACAT", name: "Arc Cat", seed: "0xc22290cBCa56ef218f6cE28CDB1e4BC0016c5416", logo: `${UPLOADS}/0d17108c9c203325f9d6ebc04f678d31.png`, amount: 88_000, price: 0.000131, pct: -12.6, spark: [9, 8, 8.4, 7, 6.2, 6.6, 5.8, 5.9] },
];

export type Activity = { kind: "send" | "receive" | "buy" | "sell" | "sign"; title: string; sub: string; amount: string; value?: string; ts: number; ok: boolean };

const now = Date.now();
export const ACTIVITY: Activity[] = [
  { kind: "buy", title: "买入 EGIRL", sub: "Arm · Uniswap V3", amount: "+196,412 EGIRL", value: "-10.00 USDC", ts: now - 4 * 60_000, ok: true },
  { kind: "receive", title: "收款", sub: "来自 0x6D80…160d", amount: "+500.00 USDC", ts: now - 3 * 3600_000, ok: true },
  { kind: "sign", title: "签名登录", sub: "arm.yyheart.com · 快艇", amount: "", ts: now - 5 * 3600_000, ok: true },
  { kind: "send", title: "转账", sub: "到 0x15C3…A681", amount: "-20.00 USDC", ts: now - 26 * 3600_000, ok: false },
];

export const RECENT_TO = [
  { label: "部署钱包", address: "0x6D80a1b2c3d4e5f60718293a4b5c6d7e8f90160d" },
  { label: "", address: "0x15C3f00dbeefcafe0011223344556677889aA681" },
];

export const TOKEN = {
  symbol: "EGIRL",
  name: "E-Girl Companion",
  address: "0x5AF2192dAe1887aA4b7687ad57bd8A0f3c7b25f6",
  logo: `${UPLOADS}/efaad11b80229dad6d5e791c57335f98.jpg`,
  price: 0.0000509,
  pct: 18.42,
  mcap: 50_900,
  vol24: 8_420,
  holders: 312,
  liquidity: 21_300,
  tax: 0,
  position: { amount: 3_920_118, cost: 160.2 },
};

/** Random-walk candles rescaled so the last close lands on `end`. */
export function mockCandles(end: number, n = 96, seed = 7): Candle[] {
  const raw = walk(n, seed);
  const k = end / raw[raw.length - 1].close;
  return raw.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));
}

function walk(n: number, seed: number, start = 1): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Candle[] = [];
  let p = start;
  const t0 = Math.floor(Date.now() / 1000) - n * 900;
  for (let i = 0; i < n; i++) {
    const drift = 1 + (rnd() - 0.44) * 0.06;
    const open = p;
    const close = Math.max(1e-7, p * drift);
    const high = Math.max(open, close) * (1 + rnd() * 0.02);
    const low = Math.min(open, close) * (1 - rnd() * 0.02);
    out.push({ time: t0 + i * 900, open, high, low, close, volume: 50 + rnd() * 400 });
    p = close;
  }
  return out;
}

export const TRADES = [
  { side: "buy" as const, who: "0x9a1e…22f0", usdc: 25, ago: 12_000 },
  { side: "sell" as const, who: "0x41bb…c901", usdc: 4.2, ago: 48_000 },
  { side: "buy" as const, who: "0x7c02…19ad", usdc: 1, ago: 95_000 },
  { side: "buy" as const, who: "0xe3f8…0b77", usdc: 60, ago: 160_000 },
];
