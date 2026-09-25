import { createPublicClient, createWalletClient, defineChain, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, contractSets, deployments, setFor } from "./config.js";

export const arc = defineChain({
  id: deployments.chainId,
  name: deployments.chainId === 5042002 ? "Arc Testnet" : "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: config.rpcUrls } },
  contracts: { multicall3: { address: config.multicall3 } },
  testnet: deployments.chainId === 5042002,
});

// primary first, others only when it errors (rate limit, 5xx, timeout); `rank: false` keeps the order deterministic
const transport = (batch: boolean) =>
  fallback(config.rpcUrls.map((u) => http(u, { batch, retryCount: 2, timeout: 30_000 })), { rank: false });

export const client = createPublicClient({ chain: arc, transport: transport(true) });

export function keeperWallet() {
  if (!config.keeper.privateKey) throw new Error("KEEPER_PRIVATE_KEY not set");
  const account = privateKeyToAccount(config.keeper.privateKey);
  return {
    account,
    wallet: createWalletClient({ account, chain: arc, transport: transport(false) }),
  };
}

/** Current-generation addresses (new launches, parameter reads, admin identity). */
export const ADDR = {
  factory: deployments.launchFactory as Address,
  locker: deployments.feeLocker as Address,
  usdc: deployments.usdc as Address,
  treasury: deployments.treasury as Address,
  router: deployments.swapRouter as Address,
  quoter: deployments.quoterV2 as Address,
  hub: (deployments.referralHub ?? "0x0000000000000000000000000000000000000000") as Address,
};
/** Every factory / locker across generations — what the indexer listens to. */
export const ALL_FACTORIES = contractSets.map((s) => s.launchFactory as Address);
export const ALL_LOCKERS = contractSets.map((s) => s.feeLocker as Address);
const lc = (a: string) => a.toLowerCase();
export const isFactory = (a: string) => ALL_FACTORIES.some((f) => lc(f) === lc(a));
export const isLocker = (a: string) => ALL_LOCKERS.some((f) => lc(f) === lc(a));
/** Locker / factory / router for a token, by the factory that launched it. */
export const addrsFor = (factory?: string | null) => {
  const s = setFor(factory);
  return { factory: s.launchFactory as Address, locker: s.feeLocker as Address, router: s.swapRouter as Address, quoter: s.quoterV2 as Address };
};
