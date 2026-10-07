import { useQuery } from "@tanstack/react-query";
import { createWalletClient, erc20Abi, http, parseAbi, type Address, type Hex, type LocalAccount } from "viem";
import { API_BASE } from "@/lib/api";
import { chainByKey, publicClientFor, rpcOf } from "./chains";
import { t } from "./i18n";

/**
 * 「USDC 生息」: USDC on Base deposited straight from the wallet into a Morpho vault (ERC-4626). The vault list is pinned
 * here — the indexer (/api/earn/*) only supplies rates and earnings — and every balance is read from the chain. The
 * wallet never holds the funds: deposit / withdraw go from the user's address to the vault and back.
 */

export const EARN_CHAIN = chainByKey("base");
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;

export type EarnVaultInfo = { address: Address; name: string; curator: string; color: string };
/** keep in sync with EARN_VAULTS in arm/indexer/src/earn.ts — Morpho's largest Base USDC vaults, blue-chip collateral */
export const VAULTS: EarnVaultInfo[] = [
  { address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", name: "Gauntlet USDC Prime", curator: "Gauntlet", color: "#5B4BF5" },
  { address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", name: "Spark USDC Vault", curator: "Spark", color: "#F27A1A" },
  { address: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", name: "Steakhouse USDC", curator: "Steakhouse", color: "#B5322E" },
];
const isPinned = (a: string) => VAULTS.some((v) => v.address.toLowerCase() === a.toLowerCase());

export type VaultRates = { address: string; name: string; netApy: number | null; apy: number | null; fee: number | null; tvlUsd: number | null; liquidityUsd: number | null };
export type VaultPnl = { vault: string; assets: string; pnl: string };

const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);

/** Localhost-only promo recording (?demo=1, kept for the tab): a sample position and a simulated deposit, no chain writes. */
export const earnDemo = () => {
  if (typeof window === "undefined" || window.location.hostname !== "localhost") return false;
  if (new URLSearchParams(window.location.search).get("demo") === "1") sessionStorage.setItem("arm-earn-demo", "1");
  return sessionStorage.getItem("arm-earn-demo") === "1";
};

export function useVaultRates() {
  return useQuery({
    queryKey: ["earn", "vaults"],
    queryFn: async (): Promise<VaultRates[]> => {
      const r = await fetch(`${API_BASE}/earn/vaults`);
      if (!r.ok) throw new Error(t("cw.earn.ratesFailed"));
      return (await r.json()) as VaultRates[];
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export type EarnState = {
  usdc: bigint;
  eth: bigint;
  /** per vault, in VAULTS order */
  shares: bigint[];
  assets: bigint[];
  maxWithdraw: bigint[];
  at: number;
};

const demo = { usdc: 2_480_000_000n, assets: [1_000_000_000n, 0n, 0n] };
const DEMO_STATE = (): EarnState => ({ usdc: demo.usdc, eth: 2_000_000_000_000_000n, shares: [...demo.assets], assets: [...demo.assets], maxWithdraw: [...demo.assets], at: Date.now() });
const demoMove = (vault: Address, delta: bigint) => {
  const i = VAULTS.findIndex((v) => v.address === vault);
  demo.assets[i] += delta;
  demo.usdc -= delta;
};

export function useEarnState(user?: string) {
  const demo = earnDemo();
  return useQuery({
    queryKey: ["wallet", "earn", user, demo],
    enabled: !!user,
    refetchInterval: 20_000,
    queryFn: async (): Promise<EarnState> => {
      if (demo) return DEMO_STATE();
      const pc = publicClientFor(EARN_CHAIN);
      const me = user as Address;
      const [usdc, eth, shares, maxWithdraw] = await Promise.all([
        pc.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        pc.getBalance({ address: me }),
        Promise.all(VAULTS.map((v) => pc.readContract({ address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [me] }))),
        Promise.all(VAULTS.map((v) => pc.readContract({ address: v.address, abi: vaultAbi, functionName: "maxWithdraw", args: [me] }))),
      ]);
      const assets = await Promise.all(VAULTS.map((v, i) => (shares[i] > 0n ? pc.readContract({ address: v.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares[i]] }) : Promise.resolve(0n))));
      return { usdc, eth, shares, assets, maxWithdraw, at: Date.now() };
    },
  });
}

/** Lifetime earnings per vault from Morpho's indexer (lags the chain by a few minutes). */
export function useEarnPnl(user?: string) {
  const demo = earnDemo();
  return useQuery({
    queryKey: ["earn", "pnl", user, demo],
    enabled: !!user,
    refetchInterval: 60_000,
    queryFn: async (): Promise<VaultPnl[]> => {
      if (demo) return [{ vault: VAULTS[0].address, assets: "1000000000", pnl: "3816420" }];
      const r = await fetch(`${API_BASE}/earn/positions/${user}`);
      if (!r.ok) return [];
      return (await r.json()) as VaultPnl[];
    },
  });
}

export type EarnStep = "approving" | "depositing" | "withdrawing" | "confirming";
/** i18n keys */
export const EARN_STEP: Record<EarnStep, string> = { approving: "cw.earn.stepApprove", depositing: "cw.earn.stepDeposit", withdrawing: "cw.earn.stepWithdraw", confirming: "cw.coin.stepConfirming" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function depositToVault(account: LocalAccount, vault: Address, amount: bigint, onStep: (s: EarnStep) => void): Promise<Hex> {
  if (!isPinned(vault)) throw new Error(t("cw.earn.errVault"));
  if (earnDemo()) {
    onStep("approving");
    await sleep(1200);
    onStep("depositing");
    await sleep(1200);
    onStep("confirming");
    await sleep(1000);
    demoMove(vault, amount);
    return "0x";
  }
  const pc = publicClientFor(EARN_CHAIN);
  const wc = createWalletClient({ account, chain: EARN_CHAIN.chain, transport: http(rpcOf(EARN_CHAIN)) });
  const me = account.address;
  const allowance = await pc.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "allowance", args: [me, vault] });
  if (allowance < amount) {
    onStep("approving");
    const h = await wc.writeContract({ address: BASE_USDC, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
    const rc = await pc.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(t("cw.coin.errApprove"));
  }
  onStep("depositing");
  const hash = await wc.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, me] });
  onStep("confirming");
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw Object.assign(new Error(t("cw.earn.errReverted")), { hash });
  return hash;
}

/** `all` redeems every share so no dust is left behind; otherwise withdraws exactly `amount` USDC. */
export async function withdrawFromVault(account: LocalAccount, vault: Address, amount: bigint, all: boolean, onStep: (s: EarnStep) => void): Promise<Hex> {
  if (!isPinned(vault)) throw new Error(t("cw.earn.errVault"));
  if (earnDemo()) {
    onStep("withdrawing");
    await sleep(1200);
    onStep("confirming");
    await sleep(1000);
    demoMove(vault, all ? -demo.assets[VAULTS.findIndex((v) => v.address === vault)] : -amount);
    return "0x";
  }
  const pc = publicClientFor(EARN_CHAIN);
  const wc = createWalletClient({ account, chain: EARN_CHAIN.chain, transport: http(rpcOf(EARN_CHAIN)) });
  const me = account.address;
  onStep("withdrawing");
  const hash = all
    ? await wc.writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [await pc.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [me] }), me, me] })
    : await wc.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [amount, me, me] });
  onStep("confirming");
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw Object.assign(new Error(t("cw.earn.errReverted")), { hash });
  return hash;
}
