import type { AiDecision } from "./analyze.js";
import type { HlAsset, HlPosition } from "./hl.js";

/** What AI 托管 does with one decision, decided without touching the exchange (so it can be tested without money). */

export const MIN_NOTIONAL = 11;
export type Limits = { maxLeverage: number; maxPct: number; minConfidence: number };
export type Open = { isLong: boolean; lev: number; margin: number; size: number; sl: number; tp: number | null };
export type Plan = { close: boolean; open: Open | null; skip: string | null };

/**
 * `available` is the margin free *after* the close, if any (the caller re-reads the account between the two steps when
 * it matters; here the closed position's margin is added back as an estimate).
 */
export function plan(d: AiDecision, pos: HlPosition | undefined, available: number, asset: HlAsset, cfg: Limits, atr1h: number): Plan {
  const wantsOpen = d.action === "long" || d.action === "short";
  const close = !!pos && (d.action === "close" || (wantsOpen && pos.side !== d.action));
  const out: Plan = { close, open: null, skip: null };
  if (!wantsOpen || (pos && !close)) return out;

  const isLong = d.action === "long";
  const mark = asset.mark;
  const skip = (why: string) => ({ ...out, skip: why });
  if (d.confidence < cfg.minConfidence) return skip(`信心 ${d.confidence} 低于你设的 ${cfg.minConfidence}，不开仓`);
  const sl = d.stopLoss;
  if (!sl || (isLong ? sl >= mark : sl <= mark)) return skip("AI 没给有效止损，不开仓");
  if (Math.abs(mark - sl) < atr1h * 0.5) return skip("止损离现价太近（不到半个 1 小时 ATR），不开仓");
  const lev = Math.max(1, Math.min(Math.round(d.leverage), cfg.maxLeverage, asset.maxLeverage));
  const liq = isLong ? mark * (1 - 1 / lev + 0.5 / asset.maxLeverage) : mark * (1 + 1 / lev - 0.5 / asset.maxLeverage);
  if (isLong ? sl <= liq : sl >= liq) return skip("止损在强平价之外，不开仓");
  const tp = d.takeProfit && (isLong ? d.takeProfit > mark : d.takeProfit < mark) ? d.takeProfit : null;
  // Hyperliquid wants the opening fee on top of the margin; the rest of the headroom absorbs price moves
  const usable = (available * 0.995) / (1 + lev * 0.00045);
  const margin = Math.min((available * Math.max(0, Math.min(d.sizePct, cfg.maxPct))) / 100, usable);
  if (margin * lev < MIN_NOTIONAL) return skip(`仓位太小（$${(margin * lev).toFixed(2)}，Hyperliquid 每笔至少 10 美元），不开仓`);
  return { ...out, open: { isLong, lev, margin, size: (margin * lev) / mark, sl, tp } };
}
