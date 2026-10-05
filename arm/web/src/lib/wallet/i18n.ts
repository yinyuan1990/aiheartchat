import zh from "./locales/zh.json";
import en from "./locales/en.json";
import { nativeBridge } from "./native";

/**
 * Wallet UI strings: the App's shared i18n/<lang>.json (keys `cw.*` for the wallet, plus common.* etc.), copied here by
 * `node i18n/sync.mjs`. The language is the App's (bridge `lang`), else the browser's; missing keys fall back to Chinese.
 * The wallet renders nothing on the server (WalletShell waits for the bridge), so there is no hydration to match.
 */
const tables: Record<string, Record<string, string>> = { zh, en };
const FALLBACK = "zh";
let current: string | null = null;

export function walletLang(): string {
  if (current) return current;
  if (typeof window === "undefined") return FALLBACK;
  const pick = (l?: string | null) => {
    const c = (l ?? "").toLowerCase().split("-")[0];
    return c === "zh" ? "zh" : c && c in tables ? c : null;
  };
  current = pick(nativeBridge()?.lang) ?? pick(navigator.language) ?? "en";
  return current;
}

/** t("cw.send.title") / t("cw.send.fee", { n: "0.1" }) */
export function t(key: string, args?: Record<string, string | number>): string {
  const lang = walletLang();
  let s = tables[lang]?.[key] ?? tables[FALLBACK][key] ?? key;
  if (args) for (const [k, v] of Object.entries(args)) s = s.split(`{${k}}`).join(String(v));
  // English "1 trades" → "1 trade" (words after a bare 1; -ies → -y, -s dropped, -ss kept)
  if (lang === "en" && args && Object.values(args).some((v) => String(v) === "1")) s = s.replace(/\b1 ([A-Za-z]*?[a-rt-zA-RT-Z])(ies|s)\b/g, (_, w: string, suf: string) => `1 ${w}${suf === "ies" ? "y" : ""}`);
  return s;
}
