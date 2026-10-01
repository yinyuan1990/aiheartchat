import type { Persona } from "@/lib/api";

/** "+$123.45" / "+$1,234" / "-$12.3K" — signed USD for the card. */
export function signedUsd(v: number): string {
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : a.toLocaleString("en-US", a >= 1e3 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "-" : "+"}$${body}`;
}

export function usdShort(v: number): string {
  const a = Math.abs(v);
  return a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(a / 1e3).toFixed(1)}K` : `$${a.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export const signedPct = (p: number) => `${p < 0 ? "-" : "+"}${Math.abs(p * 100).toLocaleString("en-US", { maximumFractionDigits: Math.abs(p) >= 10 ? 0 : 1 })}%`;

export function holdTime(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.round((sec % 86400) / 3600)}h`;
}

export const shortWallet = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The share image only ships a Latin font: keep symbols printable there. */
export const latinSymbol = (s: string, address: string) => s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 12) || address.slice(2, 6).toUpperCase();

export const PERSONA_EN: Record<Persona, [string, string]> = {
  printer: ["Money Printer", "Doubled the bag. On-chain ATM."],
  sniper: ["Sniper", "Few shots, high hit rate."],
  bagholder: ["Bag Holder", "Bought the top, still believing."],
  flipper: ["Speed Flipper", "In and out in under an hour."],
  diamond: ["Diamond Hands", "Buys. Never sells."],
  hunter: ["Degen Hunter", "Has aped into everything."],
  degen: ["Chain Surfer", "Some wins, some losses, all vibes."],
  newbie: ["Fresh Wallet", "Just landed on Arc."],
};
