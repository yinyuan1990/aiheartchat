/**
 * Local dedupe (boss spec 9.10 §7) — no AI. Two titles are the same event when
 *   1. the normalized keys are equal, or one contains the other (≥ 4 chars),
 *   2. their significant tokens (stop-words / very short words removed) are a subset of each other
 *      ("Happy Hump" ⊂ "Hump Day" → one card, related signals +1),
 *   3. character-bigram Dice similarity ≥ 0.85 (typos, plural/singular, "#tag" vs "tag").
 * Only candidates from the same platform seen in the last 6 hours are compared (the service passes them in).
 */
import { normKey } from "./sources.js";

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "be", "with", "at", "by", "from", "this", "that", "it", "its", "your", "you", "we", "they", "he", "she",
  "his", "her", "our", "my", "me", "us", "was", "were", "has", "have", "had", "not", "no", "so", "do", "does", "did", "can", "will", "just", "now", "new", "day", "days", "happy", "big",
  "all", "one", "two", "first", "last", "live", "official", "today", "tonight", "tomorrow", "yesterday", "week", "time", "year", "vs", "via", "about", "over", "after", "before", "into", "out", "up", "down",
  "的", "了", "是", "在", "和", "与", "被", "把", "我", "你", "他", "她", "它", "们", "这", "那", "有", "就", "都", "也", "又", "还", "很", "太", "吗", "吧", "呢", "啊", "呀",
]);

export const normalize = (title: string) => normKey(title);

/** Significant tokens: words ≥ 3 chars (Latin) or every CJK character run, minus stop-words. */
export function sigTokens(norm: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm.split(" ")) {
    if (!w) continue;
    if (/[\u4e00-\u9fff]/.test(w)) {
      // Chinese has no spaces: use 2-char shingles so "冰美式" and "冰美式咖啡" share tokens
      const chars = [...w].filter((c) => !STOP.has(c));
      if (chars.length <= 2) { if (chars.length) out.add(chars.join("")); continue; }
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    } else if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, " ");
  for (let i = 0; i + 1 < t.length; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

/** Sørensen–Dice on character bigrams, 0..1. */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const [g, n] of A) { na += n; const m = B.get(g); if (m) inter += Math.min(n, m); }
  for (const n of B.values()) nb += n;
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

const subset = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((t) => b.has(t));

export type DedupeCandidate = { id: number; norm: string; tokens: Set<string> };

/** The candidate the title should merge into, or null when it is a new event. */
export function findDuplicate(norm: string, tokens: Set<string>, candidates: DedupeCandidate[]): DedupeCandidate | null {
  for (const c of candidates) {
    if (c.norm === norm) return c;
    if (norm.length >= 4 && c.norm.length >= 4 && (c.norm.includes(norm) || norm.includes(c.norm))) return c;
    if (subset(tokens, c.tokens) || subset(c.tokens, tokens)) return c;
  }
  // similarity is the expensive check — after the cheap ones
  let best: DedupeCandidate | null = null, bestScore = 0;
  for (const c of candidates) {
    const s = dice(norm, c.norm);
    if (s >= 0.85 && s > bestScore) { best = c; bestScore = s; }
  }
  return best;
}
