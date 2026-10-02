import type { GameResult } from "@/lib/api";

export const times = (x: number) => (x >= 10 ? `${x.toFixed(1)}x` : `${x.toFixed(2)}x`);
export const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;

export type Persona = "sniper" | "good" | "early" | "held" | "bag" | "diamond";
export const PERSONA_EN: Record<Persona, string> = {
  sniper: "Top Sniper", good: "Clean Exit", early: "Paper Hands", held: "Held Strong", bag: "Exit Liquidity", diamond: "Diamond Hands (bagged)",
};

type Scored = Pick<GameResult, "up" | "held" | "capture">;

export function personaOf(r: Scored): Persona {
  if (!r.up) return r.held ? "diamond" : "bag";
  if (r.held) return "held";
  return r.capture >= 0.9 ? "sniper" : r.capture >= 0.5 ? "good" : "early";
}

/** Strip of 10: green = share of the top caught, red = share lost. Carries no timing or price level. */
export function strip(r: Pick<GameResult, "up" | "capture">): { up: boolean; filled: number } {
  return r.up ? { up: true, filled: Math.round(r.capture * 10) } : { up: false, filled: Math.min(10, Math.ceil(-r.capture * 10)) };
}

export function shareGrid(r: Pick<GameResult, "up" | "capture">): string {
  const s = strip(r);
  return (s.up ? "🟩" : "🟥").repeat(s.filled) + "⬜".repeat(10 - s.filled);
}
