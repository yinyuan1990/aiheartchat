"use client";

// Boss 9.12: a "bug" button that copies everything we know about the session so he can paste it into chat
// instead of describing the symptom. Keeps a ring buffer of console errors / unhandled rejections / tx failures.

type Entry = { at: number; kind: string; msg: string };
const MAX = 40;
const buf: Entry[] = [];
let installed = false;

const str = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split("\n").slice(1, 5).join("\n")}` : ""}`;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)); } catch { return String(v); }
};

export function logDebug(kind: string, ...parts: unknown[]) {
  buf.push({ at: Date.now(), kind, msg: parts.map(str).join(" ").slice(0, 2000) });
  if (buf.length > MAX) buf.shift();
}

export function installDebugLog() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => { logDebug("console.error", ...a); origErr(...a); };
  console.warn = (...a: unknown[]) => { logDebug("console.warn", ...a); origWarn(...a); };
  window.addEventListener("error", (e) => logDebug("window.error", e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : "", e.error));
  window.addEventListener("unhandledrejection", (e) => logDebug("unhandledrejection", e.reason));
  logDebug("session", "start", location.href);
}

export function buildDebugReport(extra?: Record<string, unknown>) {
  const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const w = typeof window !== "undefined" ? window : undefined;
  const eth = (w as unknown as { ethereum?: { isMetaMask?: boolean; isOkxWallet?: boolean; isTrust?: boolean; isCoinbaseWallet?: boolean; chainId?: string; selectedAddress?: string } } | undefined)?.ethereum;
  const lines = [
    `== Arm debug report ==`,
    `time: ${new Date().toISOString()}`,
    `url: ${w?.location.href ?? ""}`,
    `ua: ${nav?.userAgent ?? ""}`,
    `screen: ${w ? `${w.innerWidth}x${w.innerHeight}` : ""} online=${nav?.onLine}`,
    `locale: ${ls("arm.locale")} theme: ${ls("arm.theme")}`,
    `wallet: ${eth ? Object.entries({ metamask: eth.isMetaMask, okx: eth.isOkxWallet, trust: eth.isTrust, coinbase: eth.isCoinbaseWallet }).filter(([, v]) => v).map(([k]) => k).join(",") || "injected" : "none"} chainId=${eth?.chainId ?? "?"} addr=${eth?.selectedAddress ?? "?"}`,
    `wagmi: ${ls("wagmi.store")?.slice(0, 400) ?? ""}`,
    `build: ${process.env.NEXT_PUBLIC_BUILD_ID ?? "?"}`,
  ];
  if (extra) for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${str(v)}`);
  lines.push(`-- last ${buf.length} events --`);
  for (const e of buf) lines.push(`[${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}: ${e.msg}`);
  return lines.join("\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
