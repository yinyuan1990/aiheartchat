import { readFileSync } from "node:fs";
import type { Address } from "viem";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

/** One factory generation: the launch factory + the locker / router / quoter that belong to it. */
export type ContractSet = {
  launchFactory: Address;
  feeLocker: Address;
  swapRouter: Address;
  quoterV2: Address;
  uniswapV3Factory: Address;
  positionManager: Address;
  deployBlock: number;
  label?: string;
  /** "stock": pools are quoted in a whitelisted tokenized stock instead of USDC (StockLaunchFactory / StockFeeLocker). */
  kind?: "usdc" | "stock";
};

/** A whitelisted quote asset of the stock generation (from deployments.stock.quotes, written by DeployStock.s.sol). */
export type QuoteAsset = { symbol: string; address: Address; decimals: number; usdcFee: number; usdcPool: Address };

export type StockSet = ContractSet & { quoteOracle: Address; quotes: Record<string, Omit<QuoteAsset, "symbol">> };

type Deployments = ContractSet & {
  chainId: number;
  usdc: Address;
  treasury: Address;
  /** Arm: creates the per-launch CreatorFeeSplitter (the lock's payout) and holds the settling keeper. */
  referralHub?: Address;
  /** Earlier factory generations still holding live tokens (LP is locked forever, so they never go away). Indexed and
   *  tradable alongside the current set; new launches only go through the top-level factory. */
  legacy?: ContractSet[];
  /** The stock generation (9.18): runs in parallel with the USDC factory; new stock-paired launches go here. */
  stock?: StockSet;
};

const depPath = env("DEPLOYMENTS_FILE", "./deployments.json");
export const deployments: Deployments = JSON.parse(readFileSync(depPath, "utf8").replace(/^\uFEFF/, ""));
export const stockSet: StockSet | undefined = deployments.stock ? { ...deployments.stock, kind: "stock" } : undefined;
/** Current USDC set first, then the stock set, then legacy ones. */
export const contractSets: ContractSet[] = [deployments, ...(stockSet ? [stockSet] : []), ...(deployments.legacy ?? [])];
const byFactory = new Map(contractSets.map((s) => [s.launchFactory.toLowerCase(), s]));
/** The contract set a token belongs to, keyed by the factory that launched it (falls back to the current set). */
export const setFor = (factory?: string | null): ContractSet => (factory && byFactory.get(factory.toLowerCase())) || deployments;
export const isStockFactory = (factory?: string | null) => !!stockSet && !!factory && factory.toLowerCase() === stockSet.launchFactory.toLowerCase();
/** Whitelisted quote assets, symbol included. */
export const quoteAssets: QuoteAsset[] = Object.entries(stockSet?.quotes ?? {}).map(([symbol, q]) => ({ symbol, ...q }));
export const quoteByAddress = (a?: string | null): QuoteAsset | undefined => a ? quoteAssets.find((q) => q.address.toLowerCase() === a.toLowerCase()) : undefined;
/** Oldest deploy block across generations — where a fresh index has to start. */
export const firstDeployBlock = Math.min(...contractSets.map((s) => s.deployBlock));

/** Arc mainnet (5042) vs testnet (5042002) — decided by the deployments file, everything else follows. */
export const isMainnet = deployments.chainId === 5042;
// rpc.mainnet.arc.io = official public RPC (live since the 9.16 mainnet launch); production sets RPC_URL to a keyed
// Alchemy / Infura endpoint via the server .env
const defaultRpc = isMainnet ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io";

const rpcUrl = env("RPC_URL", defaultRpc);
// The keyless public RPCs rate-limit bursts (the 60s keeper tick + 1.5s indexer poll + API reads); `fallback` transports
// hop to the next URL on any RPC error. RPC_URLS (comma-separated) overrides the whole list; RPC_URL is always first.
const defaultFallbacks = isMainnet ? ["https://rpc.arc-scan.org"] : [];
const rpcUrls = [...new Set([rpcUrl, ...(process.env.RPC_URLS?.split(",") ?? defaultFallbacks).map((s) => s.trim()).filter(Boolean)])];

export const config = {
  rpcUrl,
  rpcUrls,
  wsUrl: process.env.WS_URL, // optional
  databaseUrl: env("DATABASE_URL", "postgres://arm:arm@localhost:5432/arm"),
  port: Number(env("PORT", "3101")),
  startBlock: BigInt(process.env.START_BLOCK ?? firstDeployBlock),
  chunkSize: BigInt(process.env.CHUNK_SIZE ?? "2000"),
  pollMs: Number(process.env.POLL_MS ?? "1500"),
  refreshMs: Number(process.env.REFRESH_MS ?? "15000"),
  keeper: {
    enabled: (process.env.KEEPER_ENABLED ?? "false") === "true",
    privateKey: process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined,
    intervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? "60000"),
    // distribute when estimated accrued USDC fees >= this (6 decimals) ...
    feeThresholdUsdc: BigInt(process.env.KEEPER_FEE_THRESHOLD ?? "50000"), // 0.05 USDC on testnet
    // ... or when this much time passed since the last distribution and any volume happened
    maxAgeMs: Number(process.env.KEEPER_MAX_AGE_MS ?? String(30 * 60 * 1000)),
  },
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  SUPPLY: 1_000_000_000n * 10n ** 18n,
};
