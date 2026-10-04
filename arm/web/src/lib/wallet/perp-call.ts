import type { LocalAccount } from "viem";
import { nativeBridge } from "./native";
import { loadPayee } from "./payee";

/**
 * 合约喊单 (houduan perp-call.service.ts): the card goes into the perp's group chat with the caller's Hyperliquid
 * address, which the backend recovers from a main-wallet signature over `perpCallMessage` — so group members see the
 * caller's real position and nobody can post someone else's. 跟单 links open /wallet/perp with the card prefilled.
 */

export type PerpCallCard = { coin: string; side: "long" | "short"; lev: number; entry: number; orderType: "market" | "limit"; tp: number | null; sl: number | null; note?: string };

export const perpCallMessage = (userId: string, coin: string, side: string, ts: number) => `心之音合约喊单\nuser: ${userId}\ncoin: ${coin}\nside: ${side}\nts: ${ts}`;

export async function postPerpCall(main: LocalAccount, card: PerpCallCard): Promise<void> {
  const payee = await loadPayee();
  if (!payee) throw new Error("当前 App 版本不支持喊单");
  const ts = Date.now();
  const sig = await main.signMessage!({ message: perpCallMessage(payee.userId, card.coin, card.side, ts) });
  await nativeBridge()!.perpCall!({ ...card, ts, sig });
}

/** What a 跟单 link carries: the caller's setup; the follower picks their own margin */
export type Follow = { coin: string; side: "long" | "short"; lev: number; tp: number | null; sl: number | null; entry: number; name?: string };

export function parseFollow(raw: string | null): Follow | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Follow>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    if (typeof o.coin !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(o.coin) || (o.side !== "long" && o.side !== "short")) return null;
    return { coin: o.coin, side: o.side, lev: Math.max(1, Math.round(num(o.lev) ?? 1)), tp: num(o.tp), sl: num(o.sl), entry: num(o.entry) ?? 0, name: typeof o.name === "string" ? o.name.slice(0, 24) : undefined };
  } catch {
    return null;
  }
}
