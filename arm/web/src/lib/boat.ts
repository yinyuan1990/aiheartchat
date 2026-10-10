"use client";

import { useQuery } from "@tanstack/react-query";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { API_BASE } from "@/lib/api";

// $BOAT speedboat game: ledger API (indexer boat.ts) + BoatVault / Uniswap v4 contracts on Arc.

export const V4 = {
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as Address,
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address,
};

export const vaultAbi = parseAbi([
  "function buy(uint256 usdcIn, uint256 minBoatOut, address to) returns (uint256)",
  "function sell(uint256 boatIn, uint256 minUsdcOut, address to) returns (uint256)",
  "function deposit(uint256 amount)",
  "function claim(uint256 total, uint256 deadline, bytes sig) returns (uint256)",
  "function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "function boatIsToken0() view returns (bool)",
]);

export const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export type BoatInfo = {
  enabled: boolean;
  vault: Address | null;
  boat?: Address;
  boatIsToken0?: boolean;
  poolId?: Hex;
  rewardPool?: number;
  totalPaid?: number;
  paidToday?: number;
  priceUsdc?: number;
  mcapUsdc?: number;
  rate: number;
  rules: { welcome: number; entry: number; maxReward: number; runsPerDay: number; playerDailyCap: number; globalDailyCap: number; shootPointsPerBoat?: number; towerPointsPerBoat?: number; hopBoatPerStep?: number };
};

export type BoatMe = {
  wallet: Address;
  bonus: number;
  cash: number;
  earned: number;
  best: number;
  runsToday: number;
  runsPerDay: number;
  pending: { amount: number; total: string; deadline: number } | null;
};

export type BoatRun = { id: string; ranked: boolean; practiceReason: "runs" | "ip" | "balance" | null; rate: number; me: BoatMe };
export type BoatRunEnd = { meters: number; reward: number; ranked: boolean; capped: boolean; rate: number; me: BoatMe };
export type BoatClaim = { vault: Address; amount: number; total: string; deadline: number; sig: Hex; me: BoatMe };

export const boatLoginMessage = (wallet: string, ts: number) => `Arm · Speedboat\nWallet: ${getAddress(wallet)}\nTime: ${ts}`;

const TOKEN_KEY = "arm-boat-session";
type Stored = { token: string; wallet: string };
export function boatSession(wallet?: string | null): string | null {
  try {
    const s = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null") as Stored | null;
    return s && wallet && s.wallet.toLowerCase() === wallet.toLowerCase() ? s.token : null;
  } catch {
    return null;
  }
}
export const saveBoatSession = (token: string, wallet: string) => { try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, wallet })); } catch { /* private mode */ } };
export const clearBoatSession = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

async function call<T>(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/boat${path}`, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new BoatError(j.error ?? `HTTP ${res.status}`, res.status);
  return j;
}
export class BoatError extends Error {
  constructor(msg: string, readonly status: number) { super(msg); }
}

export const boatLogin = (wallet: string, ts: number, sig: string) =>
  call<{ token: string; welcomed: boolean; me: BoatMe }>("/login", { method: "POST", body: { wallet, ts, sig } });
export type BoatGame = "boat" | "race" | "shoot" | "tower" | "hop";
export const boatRunStart = (token: string, game: BoatGame = "boat") => call<BoatRun>("/run", { method: "POST", token, body: { game } });
export const boatRunEnd = (token: string, id: string, meters: number) => call<BoatRunEnd>(`/run/${id}/end`, { method: "POST", token, body: { meters } });
export const boatWithdrawSig = (token: string) => call<BoatClaim>("/withdraw", { method: "POST", token, body: {} });

export const useBoatInfo = () => useQuery({ queryKey: ["boat", "info"], queryFn: () => call<BoatInfo>("/info"), refetchInterval: 20_000 });
export const useBoatMe = (token: string | null) =>
  useQuery({ queryKey: ["boat", "me", token], enabled: !!token, queryFn: () => call<BoatMe>("/me", { token }), refetchInterval: 15_000, retry: false });
export const useBoatBoard = (game: BoatGame = "boat") =>
  useQuery({ queryKey: ["boat", "board", game], queryFn: () => call<{ day: number; rows: { wallet: string; meters: number }[] }>(`/board?game=${game}`), refetchInterval: 30_000 });
