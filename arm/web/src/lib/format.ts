export function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "-";
  if (opts.compact) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  }
  if (Math.abs(n) >= 1) {
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  }
  return `$${fmtSmall(n)}`;
}

/** Prices far below $1 are shown with subscript-style zero folding: 0.0₆52 */
export function fmtSmall(n: number): string {
  if (n === 0) return "0.00";
  if (n >= 0.01) return n.toFixed(4);
  const s = n.toFixed(18);
  const m = s.match(/^0\.(0+)(\d{3})/);
  if (!m) return n.toPrecision(3);
  const zeros = m[1].length;
  if (zeros < 3) return n.toFixed(zeros + 3);
  const sub = String(zeros)
    .split("")
    .map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)])
    .join("");
  return `0.0${sub}${m[2]}`;
}

/** Money for accounting views: plain decimals, never the subscript-zero folding (0.0₃745 was read as $0.03745 by finance). */
export function fmtUsdExact(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (n === 0) return "$0.00";
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

export function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtPct(n: number, sign = true): string {
  if (!Number.isFinite(n)) return "-";
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (!sign) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

export function shortAddr(a: string, head = 6, tail = 4): string {
  if (!a) return "";
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
