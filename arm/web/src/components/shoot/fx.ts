/** The twelve "juice" layers, each switchable from the ?fx debug panel. They only change what you see and hear;
 *  scoring, combo multiplier and difficulty are the same with any of them off. */
export const FX_KEYS = ["flash", "knock", "squash", "numbers", "particles", "hitstop", "shake", "wave", "trail", "glow", "sound", "combo"] as const;
export type FxKey = (typeof FX_KEYS)[number];
export type Fx = Record<FxKey, boolean>;

export const FX_NAMES: Record<FxKey, [string, string]> = {
  flash: ["闪白", "Flash"],
  knock: ["击退", "Knockback"],
  squash: ["挤压拉伸", "Squash"],
  numbers: ["伤害飘字", "Numbers"],
  particles: ["粒子", "Particles"],
  hitstop: ["顿帧", "Hit stop"],
  shake: ["震屏", "Shake"],
  wave: ["冲击波", "Shockwave"],
  trail: ["拖尾火光", "Trails"],
  glow: ["发光", "Glow"],
  sound: ["音效", "Sound"],
  combo: ["连击分数", "Combo"],
};

export const allFx = (on: boolean): Fx => Object.fromEntries(FX_KEYS.map((k) => [k, on])) as Fx;

/** ?fx=1 → panel, all on; ?fx=0 → panel, all off; ?fx=flash,shake → panel, only those on. null = no panel. */
export function fxFromQuery(q: string | null): Fx | null {
  if (q === null) return null;
  if (q === "" || q === "1" || q === "all") return allFx(true);
  if (q === "0" || q === "none") return allFx(false);
  const on = new Set(q.split(","));
  return Object.fromEntries(FX_KEYS.map((k) => [k, on.has(k)])) as Fx;
}
